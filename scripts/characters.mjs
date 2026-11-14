// Builds characters.json: who appears in each episode, from the cast lists on the
// Arrowverse wiki (arrow.fandom.com, CC BY-SA). Used by scripts/build-data.mjs.
//
// Each episode page has a "Cast" section with "Main cast", "Guest starring" and
// "Co-starring" lists of "Actor as Character" entries. Pages are cached in .cache/
// (restored by the workflow), so later builds only fetch what's new.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';

const ARROW_API = 'https://arrow.fandom.com/api.php';
const STARGIRL_API = 'https://stargirl.fandom.com/api.php';
const UA = { 'User-Agent': 'arrowverse-tracker build (github.com/gray30000000/arrowverse-tracker)' };
const CACHE_FILE = '.cache/fandom.json';
const CACHE_VERSION = 2; // bump when parseCast output changes

// How the wiki names each series, for "Title (Series)" pages and "<Series> episodes" categories.
export const WIKI_SERIES = {
  arrow: 'Arrow', flash: 'The Flash', constantine: 'Constantine', vixen: 'Vixen',
  supergirl: 'Supergirl', legends: "DC's Legends of Tomorrow", ray: 'Freedom Fighters: The Ray',
  blacklightning: 'Black Lightning', batwoman: 'Batwoman', stargirl: 'Stargirl', supermanlois: 'Superman & Lois',
};
export const GROUPS = { m: 0, g: 1, c: 2, u: 3 }; // main, guest, co-starring, uncredited

// Each series' episode list on its wiki. The links in those tables are the exact
// episode page titles (arrowverse.info reads the same pages for its order).
const LIST_PAGES = {
  arrow: 'List of Arrow episodes', flash: 'List of The Flash (The CW) episodes',
  constantine: 'List of Constantine episodes', vixen: 'List of Vixen episodes',
  supergirl: 'List of Supergirl episodes', legends: "List of DC's Legends of Tomorrow episodes",
  ray: 'List of Freedom Fighters: The Ray episodes', blacklightning: 'List of Black Lightning episodes',
  batwoman: 'List of Batwoman episodes', supermanlois: 'List of Superman & Lois episodes',
};
// Stargirl's episodes are covered by its own wiki.
const apiFor = show => (show === 'stargirl' ? STARGIRL_API : ARROW_API);

// Who counts as a character worth listing: named (has their own wiki page) and
// either in the main cast or seen in at least this many episodes.
const MIN_APPEARANCES = 3;

const sleep = ms => new Promise(r => setTimeout(r, ms));
const decode = s => s
  .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(+n))
  .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)))
  .replace(/&nbsp;/g, ' ').replace(/&quot;/g, '"').replace(/&apos;/g, "'")
  .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
const normCat = c => decode(String(c)).replace(/_/g, ' ').trim().toLowerCase();

async function parsePage(title, api = ARROW_API) {
  const params = new URLSearchParams({
    action: 'parse', page: title, prop: 'text|categories', redirects: '1',
    format: 'json', formatversion: '2', disablelimitreport: '1', disableeditsection: '1',
  });
  for (let attempt = 0; attempt < 6; attempt++) {
    const res = await fetch(`${api}?${params}`, { headers: UA });
    if (res.status === 429 || res.status >= 500) {
      const retryAfter = +res.headers.get('retry-after') || 0;
      await sleep(Math.max(retryAfter * 1000, 2000 * 2 ** attempt)); // 2s, 4s, 8s… so the wiki can breathe
      continue;
    }
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const json = await res.json();
    if (json.error) return json.error.code === 'missingtitle' ? null : Promise.reject(new Error(json.error.code));
    return { title: json.parse.title, html: json.parse.text, categories: (json.parse.categories || []).map(c => normCat(c.category)) };
  }
  throw new Error('gave up after retries');
}

// Pulls the cast entries out of an episode page's HTML.
export function parseCast(html) {
  const at = html.search(/id="Cast"/);
  if (at < 0) return null;
  let section = html.slice(at);
  const end = section.slice(10).search(/<h2[\s>]/);
  if (end >= 0) section = section.slice(0, end + 10);

  const cast = [];
  let group = 'm';
  const re = /<h[3-5][^>]*>([\s\S]*?)<\/h[3-5]>|<li[^>]*>([\s\S]*?)<\/li>/g;
  let m;
  while ((m = re.exec(section))) {
    if (m[1] != null) {
      const h = decode(m[1].replace(/<[^>]+>/g, '')).toLowerCase();
      if (/uncredited/.test(h)) group = 'u';
      else if (/co-?\s?star/.test(h)) group = 'c';
      else if (/guest/.test(h)) group = 'g';
      else if (/main|starring|cast/.test(h)) group = 'm';
      continue;
    }
    for (const entry of parseEntry(m[2])) {
      cast.push({ id: entry.id, name: entry.name, actor: entry.actor, g: entry.cameo ? 'u' : group, l: entry.linked ? 1 : 0 });
    }
  }
  return cast;
}

// One credit line ("Actor as Character", sometimes "as A and B") -> one entry per character.
function parseEntry(li) {
  const toks = li.split(/(<[^>]+>)/);
  let actor = '', i = 0, rest = null;
  for (; i < toks.length; i++) {
    const t = toks[i];
    if (t.startsWith('<')) continue;
    const text = decode(t);
    const at = text.search(/\sas\s/);
    if (at < 0) { actor += text; continue; }
    actor += text.slice(0, at);
    rest = [text.slice(at).replace(/^\s+as\s+/, ''), ...toks.slice(i + 1)];
    break;
  }
  if (!rest) return [];
  actor = actor.replace(/\[\d+\]/g, '').trim();
  if (!actor) return [];

  // Split into one segment per character at " and " / ", " / " & " outside links.
  const segments = [[]];
  let inLink = false;
  for (const t of rest) {
    if (t.startsWith('<')) {
      if (/^<a\s/i.test(t)) inLink = true;
      else if (/^<\/a>/i.test(t)) inLink = false;
      segments[segments.length - 1].push(t);
      continue;
    }
    const parts = inLink ? [t] : t.split(/\s*,\s*(?:and\s+)?|\s+and\s+|\s+(?:&|&amp;)\s+/);
    parts.forEach((part, k) => { if (k > 0) segments.push([]); segments[segments.length - 1].push(part); });
  }

  const out = [];
  for (const seg of segments) {
    // Before a top-level "/" is the character; after it come aliases ("Oliver Queen/Green Arrow").
    const main = [];
    let depth = 0;
    for (const t of seg) {
      if (t.startsWith('<')) { if (/^<a\s/i.test(t)) depth++; else if (/^<\/a>/i.test(t)) depth--; main.push(t); continue; }
      if (depth === 0 && t.includes('/')) { main.push(t.split('/')[0]); break; }
      main.push(t);
    }
    const text = decode(main.filter(t => !t.startsWith('<')).join('')).replace(/\[\d+\]/g, '').replace(/\s+/g, ' ').trim();
    const segText = decode(seg.filter(t => !t.startsWith('<')).join(''));
    const note = /\(([^)]*)\)/.exec(segText)?.[1] || '';
    let name = text.replace(/\s*\([^)]*\)/g, '').split(/\s*\/\s*/)[0].replace(/^and\s+/i, '').trim();
    if (!name || name.length > 80 || /^(himself|herself|themselves|uncredited)$/i.test(name)) continue;
    if (/earth|e-\d/i.test(note)) name = `${name} (${note.trim()})`;
    // The last link before the "/" is the character's page ("Detective [[Joe West]]").
    let href = null;
    for (const t of main) {
      const a = /^<a\s[^>]*href="(?:https?:\/\/[a-z]+\.fandom\.com)?\/wiki\/([^"#?]+)/i.exec(t);
      if (a) href = a[1];
    }
    // The link target groups appearances of the same character. It is never shown,
    // because it can give away a secret identity.
    const id = href ? decodeURIComponent(href).replace(/_/g, ' ') : name;
    const cameo = /archive|photo|stock|footage|picture|portrait/i.test(note);
    out.push({ id, name, actor, cameo, linked: !!href });
  }
  return out;
}

// Same title stripping the app does, so names can be compared the way they're shown.
const TITLE_RE = /^(?:(?:assistant|deputy|vice|acting|former|interim|special|co-)\s*)*(?:dr|doctor|mr|mrs|ms|miss|professor|prof|detective|det|officer|captain|capt|lieutenant|lt|sergeant|sgt|agent|major|general|colonel|commander|admiral|mayor|senator|councilman|councilwoman|governor|president|director|chief|sheriff|district attorney|attorney general|judge|commissioner|warden|coach|principal|nurse|private|corporal)\.?\s+/i;
const cleanName = name => {
  let x = name;
  for (;;) { const y = x.replace(TITLE_RE, ''); if (y === x || !y.trim()) return x; x = y; }
};
const plain = n => cleanName(n).replace(/["“”]/g, '').replace(/\s+/g, ' ').trim().toLowerCase();

// Links can point at redirects ("Barry Allen" -> "Barry Allen (Earth-1)"); resolve them so
// one character isn't split in two. Redirects into a section of a list page keep the
// section, so minor characters on "List of …" pages stay separate.
async function resolveRedirects(titles, api, known) {
  const todo = [...new Set(titles)].filter(t => !(t in known));
  for (let i = 0; i < todo.length; i += 50) {
    const batch = todo.slice(i, i + 50);
    const params = new URLSearchParams({ action: 'query', titles: batch.join('|'), redirects: '1', format: 'json', formatversion: '2' });
    let json = null;
    for (let attempt = 0; attempt < 5 && !json; attempt++) {
      const res = await fetch(`${api}?${params}`, { headers: UA });
      if (res.ok) json = await res.json();
      else await sleep(2000 * 2 ** attempt);
    }
    if (!json) continue;
    const norm = Object.fromEntries((json.query?.normalized || []).map(n => [n.from, n.to]));
    const redir = Object.fromEntries((json.query?.redirects || []).map(r => [r.from, r.tofragment ? `${r.to}#${r.tofragment}` : r.to]));
    for (const t of batch) {
      const n = norm[t] || t;
      known[t] = redir[n] || n;
    }
    await sleep(400);
  }
  return known;
}

const normTitle = t => decode(String(t || '')).toLowerCase()
  .replace(/&/g, ' and ').replace(/\bpart\b/g, ' ')
  .replace(/\b(one|two|three|four|five|six|seven|eight|nine|ten)\b/g, w => ({ one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10 })[w])
  .replace(/[^a-z0-9]+/g, '');

// Links to episode pages from a "List of … episodes" page, in table order.
async function listEpisodeLinks(show) {
  if (!LIST_PAGES[show]) return [];
  const page = await parsePage(LIST_PAGES[show]);
  if (!page) return [];
  const links = [];
  // Episode titles in these tables are quoted links: "<a href="/wiki/Pilot_(Arrow)" …>Pilot</a>"
  const re = /(?:"|&quot;|“)\s*<a\s[^>]*href="(?:https?:\/\/arrow\.fandom\.com)?\/wiki\/([^"#?]+)"[^>]*>([\s\S]*?)<\/a>\s*(?:"|&quot;|”)/g;
  let m;
  while ((m = re.exec(page.html))) {
    links.push({ page: decodeURIComponent(m[1]).replace(/_/g, ' '), text: decode(m[2].replace(/<[^>]+>/g, '')) });
  }
  return links;
}

// Maps each episode id to its exact wiki page title where the episode list allows.
async function exactTitles(episodes) {
  const map = new Map();
  const stats = {};
  for (const show of Object.keys(LIST_PAGES)) {
    const eps = episodes.filter(e => e.show === show).sort((a, b) => a.s - b.s || a.e - b.e);
    if (!eps.length) continue;
    let links = [];
    try { links = await listEpisodeLinks(show); } catch (err) { stats[show] = `error: ${err.message}`; continue; }
    await sleep(400);
    if (links.length === eps.length) {
      eps.forEach((ep, i) => map.set(ep.id, links[i].page)); // same count: zip in order
      stats[show] = `${links.length} by order`;
      continue;
    }
    const used = new Set();
    let n = 0;
    for (const ep of eps) {
      const l = links.find((x, i) => !used.has(i) && normTitle(x.text) === normTitle(ep.wt || ep.t));
      if (l) { used.add(links.indexOf(l)); map.set(ep.id, l.page); n++; }
    }
    stats[show] = `${n}/${eps.length} by title (list had ${links.length} links)`;
  }
  return { map, stats };
}

async function findEpisodePage(ep, exact, titles) {
  const api = apiFor(ep.show);
  const tried = [];
  if (exact) {
    tried.push(exact);
    const page = await parsePage(exact, api);
    const cast = page && parseCast(page.html);
    if (cast) return { page: page.title, cast };
  }
  const series = WIKI_SERIES[ep.show].toLowerCase();
  // Categories like "Arrow episodes" or "Arrow season 1 episodes".
  const isEpisodeCatOf = (cat, name) => cat.startsWith(name + ' ') && cat.includes('episode');
  const others = Object.values(WIKI_SERIES).map(s => s.toLowerCase()).filter(s => s !== series && !s.startsWith(series + ' '));
  let fallback = null;
  for (const t of titles) {
    for (const title of [t, `${t} (${WIKI_SERIES[ep.show]})`]) {
      if (tried.includes(title)) continue;
      tried.push(title);
      await sleep(200);
      const page = await parsePage(title, api);
      if (!page) continue;
      const cast = parseCast(page.html);
      if (!cast) continue; // e.g. a crossover event page
      if (api === STARGIRL_API || page.categories.some(c => isEpisodeCatOf(c, series))) return { page: page.title, cast };
      const wrong = page.categories.some(c => others.some(o => isEpisodeCatOf(c, o)));
      if (!wrong) fallback ||= { page: page.title, cast };
    }
  }
  return fallback || { miss: true, tried, at: Date.now() };
}

// episodes: final ordered list; wikiTitles: Map(episode id -> arrowverse.info title)
export async function buildCharacters(episodes, wikiTitles, { concurrency = 2 } = {}) {
  let cache = { version: CACHE_VERSION, pages: {} };
  try {
    const c = JSON.parse(readFileSync(CACHE_FILE, 'utf8'));
    if (c.version === CACHE_VERSION) cache = c;
  } catch { /* no cache yet */ }

  // Misses are retried after a few days, in case the wiki gained the page.
  const stale = e => !e || (e.miss && Date.now() - (e.at || 0) > 3 * 864e5);
  const todo = episodes.filter(ep => stale(cache.pages[ep.id]));
  for (const ep of episodes) ep.wt = wikiTitles.get(ep.id);
  const { map: exact, stats: listStats } = todo.length ? await exactTitles(episodes) : { map: new Map(), stats: 'skipped (all cached)' };
  let fetched = 0, errors = [];
  const queue = [...todo];
  await Promise.all(Array.from({ length: concurrency }, async () => {
    while (queue.length) {
      const ep = queue.shift();
      const titles = [...new Set([wikiTitles.get(ep.id), ep.t].filter(Boolean))];
      try {
        cache.pages[ep.id] = await findEpisodePage(ep, exact.get(ep.id), titles);
        fetched++;
      } catch (err) {
        errors.push(`${ep.show} S${ep.s}E${ep.e} "${ep.t}": ${err.message}`);
      }
      await sleep(350);
    }
  }));
  mkdirSync('.cache', { recursive: true });
  writeFileSync(CACHE_FILE, JSON.stringify(cache));

  // Resolve redirects for every linked character page (cached).
  cache.redirects ||= { arrow: {}, stargirl: {} };
  const linkedIds = { arrow: [], stargirl: [] };
  for (const ep of episodes) {
    const entry = cache.pages[ep.id];
    if (!entry || entry.miss) continue;
    for (const c of entry.cast) if (c.l) linkedIds[ep.show === 'stargirl' ? 'stargirl' : 'arrow'].push(c.id);
  }
  try {
    await resolveRedirects(linkedIds.arrow, ARROW_API, cache.redirects.arrow);
    await resolveRedirects(linkedIds.stargirl, STARGIRL_API, cache.redirects.stargirl);
  } catch (err) { errors.push(`redirects: ${err.message}`); }
  writeFileSync(CACHE_FILE, JSON.stringify(cache));
  const canon = (ep, c) => {
    if (!c.l) return c.id;
    const map = cache.redirects[ep.show === 'stargirl' ? 'stargirl' : 'arrow'];
    return map[c.id] || c.id;
  };

  // Count appearances first, to keep only characters worth listing.
  const ns = ep => (ep.show === 'stargirl' ? 'sg:' : ''); // the two wikis' pages are separate
  const tally = new Map();
  for (const ep of episodes) {
    const entry = cache.pages[ep.id];
    if (!entry || entry.miss) continue;
    const seen = new Set();
    for (const c of entry.cast) {
      const id = ns(ep) + canon(ep, c);
      if (seen.has(id) || c.g === 'c' || c.g === 'u') continue;
      seen.add(id);
      const t = tally.get(id) || { main: 0, all: 0, linked: false };
      if (c.g === 'm') t.main++;
      t.all++;
      t.linked ||= !!c.l;
      tally.set(id, t);
    }
  }
  const relevant = id => { const t = tally.get(id); return t && t.linked && (t.main > 0 || t.all >= MIN_APPEARANCES); };

  // Merge into a character table. The wiki link target identifies a character, so
  // "Oliver Queen" in Arrow and in a Flash crossover is the same person. Names and
  // actors are kept per episode, so the app only shows what was credited in episodes
  // already watched.
  const chars = new Map();
  const eps = {};
  const missing = [];
  for (const ep of episodes) {
    const entry = cache.pages[ep.id];
    if (!entry || entry.miss) { missing.push(`${ep.show} S${ep.s}E${ep.e} "${ep.t}"${entry?.tried ? ` (tried: ${entry.tried.join(' | ')})` : ''}`); continue; }
    const seen = new Set();
    eps[ep.id] = [];
    for (const c of entry.cast) {
      const id = ns(ep) + canon(ep, c);
      if (seen.has(id) || c.g === 'c' || c.g === 'u' || !relevant(id)) continue;
      seen.add(id);
      if (!chars.has(id)) chars.set(id, { idx: chars.size, names: [], actors: [], id: id.replace(/^sg:/, '') });
      const ch = chars.get(id);
      let ni = ch.names.indexOf(c.name); if (ni < 0) ni = ch.names.push(c.name) - 1;
      let ai = ch.actors.indexOf(c.actor); if (ai < 0) ai = ch.actors.push(c.actor) - 1;
      const code = ch.idx * 4 + GROUPS[c.g];
      eps[ep.id].push(ni || ai ? [code, ni, ai] : code);
    }
  }
  // n: credited names, a: actors (both in order of first appearance).
  // q: a label like "Earth-2" for telling versions of a character apart. It's taken
  // from the wiki page title only when the rest of that title is a name the character
  // is credited with, so it can't give away who someone really is.
  const list = [...chars.values()].map(ch => {
    const out = { n: ch.names, a: ch.actors };
    const m = /^(.*?)\s*\(([^)]+)\)$/.exec(ch.id.split('#')[0]);
    if (m && ch.names.some(n => plain(n.replace(/\s*\([^)]*\)$/, '')) === plain(m[1]))) out.q = m[2];
    return out;
  });

  return {
    data: { built: new Date().toISOString(), source: 'arrow.fandom.com', chars: list, eps },
    report: {
      characterPagesFound: episodes.length - missing.length,
      characterPagesMissing: missing,
      fetchedThisBuild: fetched,
      exactTitlesFromLists: listStats,
      castMembersSeen: tally.size,
      redirectsResolved: Object.values(cache.redirects).reduce((n, m) => n + Object.entries(m).filter(([a, b]) => a !== b).length, 0),
      withVersionLabel: list.filter(c => c.q).length,
      fetchErrors: errors.slice(0, 50),
      characters: list.length,
    },
  };
}
