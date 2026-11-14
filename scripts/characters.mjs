// Builds characters.json: who appears in each episode, from the cast lists on the
// Arrowverse wiki (arrow.fandom.com, CC BY-SA). Used by scripts/build-data.mjs.
//
// Each episode page has a "Cast" section with "Main cast", "Guest starring" and
// "Co-starring" lists of "Actor as Character" entries. Pages are cached in .cache/
// (restored by the workflow), so later builds only fetch what's new.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';

const API = 'https://arrow.fandom.com/api.php';
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

const sleep = ms => new Promise(r => setTimeout(r, ms));
const decode = s => s
  .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(+n))
  .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)))
  .replace(/&nbsp;/g, ' ').replace(/&quot;/g, '"').replace(/&apos;/g, "'")
  .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
const normCat = c => decode(String(c)).replace(/_/g, ' ').trim().toLowerCase();

async function parsePage(title) {
  const params = new URLSearchParams({
    action: 'parse', page: title, prop: 'text|categories', redirects: '1',
    format: 'json', formatversion: '2', disablelimitreport: '1', disableeditsection: '1',
  });
  for (let attempt = 0; attempt < 4; attempt++) {
    const res = await fetch(`${API}?${params}`, { headers: UA });
    if (res.status === 429 || res.status >= 500) { await sleep(1500 * (attempt + 1)); continue; }
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
    if (entry) cast.push({ id: entry.id, name: entry.name, actor: entry.actor, g: entry.cameo ? 'u' : group });
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
  return { id, name, actor, cameo };
}

async function findEpisodePage(ep, titles) {
  const series = WIKI_SERIES[ep.show].toLowerCase();
  // Categories like "Arrow episodes" or "Arrow season 1 episodes".
  const isEpisodeCatOf = (cat, name) => cat.startsWith(name + ' ') && cat.includes('episode');
  const others = Object.values(WIKI_SERIES).map(s => s.toLowerCase()).filter(s => s !== series && !s.startsWith(series + ' '));
  const tried = [];
  let fallback = null;
  for (const t of titles) {
    for (const title of [t, `${t} (${WIKI_SERIES[ep.show]})`]) {
      if (tried.includes(title)) continue;
      tried.push(title);
      const page = await parsePage(title);
      if (!page) continue;
      const cast = parseCast(page.html);
      if (!cast) continue; // e.g. a crossover event page
      if (page.categories.some(c => isEpisodeCatOf(c, series))) return { page: page.title, cast };
      const wrong = page.categories.some(c => others.some(o => isEpisodeCatOf(c, o)));
      if (!wrong) fallback ||= { page: page.title, cast };
    }
  }
  return fallback || { miss: true, tried };
}

// episodes: final ordered list; wikiTitles: Map(episode id -> arrowverse.info title)
export async function buildCharacters(episodes, wikiTitles, { concurrency = 4 } = {}) {
  let cache = { version: CACHE_VERSION, pages: {} };
  try {
    const c = JSON.parse(readFileSync(CACHE_FILE, 'utf8'));
    if (c.version === CACHE_VERSION) cache = c;
  } catch { /* no cache yet */ }

  const todo = episodes.filter(ep => !cache.pages[ep.id] || cache.pages[ep.id].miss);
  let fetched = 0, errors = [];
  const queue = [...todo];
  await Promise.all(Array.from({ length: concurrency }, async () => {
    while (queue.length) {
      const ep = queue.shift();
      const titles = [...new Set([wikiTitles.get(ep.id), ep.t].filter(Boolean))];
      try {
        cache.pages[ep.id] = await findEpisodePage(ep, titles);
        fetched++;
      } catch (err) {
        errors.push(`${ep.show} S${ep.s}E${ep.e} "${ep.t}": ${err.message}`);
      }
      await sleep(150);
    }
  }));
  mkdirSync('.cache', { recursive: true });
  writeFileSync(CACHE_FILE, JSON.stringify(cache));

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
      if (seen.has(c.id)) continue;
      seen.add(c.id);
      if (!chars.has(c.id)) chars.set(c.id, { idx: chars.size, names: [], actors: [] });
      const ch = chars.get(c.id);
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
      fetchErrors: errors.slice(0, 50),
      characters: list.length,
    },
  };
}
