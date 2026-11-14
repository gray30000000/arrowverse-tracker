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
const CACHE_VERSION = 1;

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
    const entry = parseEntry(m[2]);
    if (entry) cast.push({ id: entry.id, name: entry.name, actor: entry.actor, g: entry.cameo ? 'u' : group, l: entry.linked ? 1 : 0 });
  }
  return cast;
}

function parseEntry(li) {
  let text = '', asAt = -1, href = null;
  for (const tok of li.split(/(<[^>]+>)/)) {
    if (tok.startsWith('<')) {
      const a = /^<a\s[^>]*href="(?:https?:\/\/arrow\.fandom\.com)?\/wiki\/([^"#?]+)/.exec(tok);
      if (a && asAt >= 0 && !href) href = a[1];
      continue;
    }
    text += decode(tok);
    if (asAt < 0) { const i = text.search(/\sas\s/); if (i >= 0) asAt = i; }
  }
  if (asAt < 0) return null;
  const actor = text.slice(0, asAt).replace(/\[\d+\]/g, '').trim();
  let role = text.slice(asAt).replace(/^\s+as\s+/, '').replace(/\[\d+\]/g, '').trim();
  const note = /\(([^)]*)\)\s*$/.exec(role)?.[1] || '';
  role = role.replace(/\s*\([^)]*\)\s*$/, '').trim();
  let name = role.split(/\s*\/\s*/)[0].trim();
  if (!name || !actor || name.length > 80) return null;
  if (/earth|e-\d/i.test(note)) name = `${name} (${note.trim()})`;
  // The link target groups appearances of the same character. It is never shown,
  // because it can give away a secret identity.
  const id = href ? decodeURIComponent(href).replace(/_/g, ' ') : name;
  const cameo = /archive|photo|stock|footage|picture|portrait/i.test(note);
  return { id, name, actor, cameo, linked: !!href };
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

  // Count appearances first, to keep only characters worth listing.
  const ns = ep => (ep.show === 'stargirl' ? 'sg:' : ''); // the two wikis' pages are separate
  const tally = new Map();
  for (const ep of episodes) {
    const entry = cache.pages[ep.id];
    if (!entry || entry.miss) continue;
    const seen = new Set();
    for (const c of entry.cast) {
      const id = ns(ep) + c.id;
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
      const id = ns(ep) + c.id;
      if (seen.has(id) || c.g === 'c' || c.g === 'u' || !relevant(id)) continue;
      seen.add(id);
      if (!chars.has(id)) chars.set(id, { idx: chars.size, names: [], actors: [] });
      const ch = chars.get(id);
      let ni = ch.names.indexOf(c.name); if (ni < 0) ni = ch.names.push(c.name) - 1;
      let ai = ch.actors.indexOf(c.actor); if (ai < 0) ai = ch.actors.push(c.actor) - 1;
      const code = ch.idx * 4 + GROUPS[c.g];
      eps[ep.id].push(ni || ai ? [code, ni, ai] : code);
    }
  }
  // n: credited names, a: actors (both in order of first appearance).
  const list = [...chars.values()].map(ch => ({ n: ch.names, a: ch.actors }));

  return {
    data: { built: new Date().toISOString(), source: 'arrow.fandom.com', chars: list, eps },
    report: {
      characterPagesFound: episodes.length - missing.length,
      characterPagesMissing: missing,
      fetchedThisBuild: fetched,
      exactTitlesFromLists: listStats,
      castMembersSeen: tally.size,
      fetchErrors: errors.slice(0, 50),
      characters: list.length,
    },
  };
}
