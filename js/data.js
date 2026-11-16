// Shared between the browser app and scripts/build-data.mjs.
// Episode data comes from the TVmaze API (https://www.tvmaze.com/api, CC BY-SA).

export const SHOWS = [
  { key: 'arrow',          tvmaze: 4, icon: 'target',     name: 'Arrow',                        short: 'Arrow' },
  { key: 'flash',          tvmaze: 13, icon: 'bolt',    name: 'The Flash',                    short: 'Flash' },
  { key: 'constantine',    tvmaze: 15, icon: 'local_fire_department',    name: 'Constantine',                  short: 'Constantine' },
  { key: 'vixen',          tvmaze: 2752, icon: 'pets',  name: 'Vixen',                        short: 'Vixen' },
  { key: 'supergirl',      tvmaze: 1850, icon: 'flight',  name: 'Supergirl',                    short: 'Supergirl' },
  { key: 'legends',        tvmaze: 1851, icon: 'hourglass_top',  name: "DC's Legends of Tomorrow",     short: 'Legends' },
  { key: 'ray',            tvmaze: 20003, icon: 'flare', name: 'Freedom Fighters: The Ray',    short: 'The Ray' },
  { key: 'blacklightning', tvmaze: 20683, icon: 'electric_bolt', name: 'Black Lightning',              short: 'Black Lightning' },
  { key: 'batwoman',       tvmaze: 37776, icon: 'dark_mode', name: 'Batwoman',                     short: 'Batwoman' },
  { key: 'stargirl',       tvmaze: 37809, icon: 'star', name: 'Stargirl',                     short: 'Stargirl' },
  { key: 'supermanlois',   tvmaze: 44751, icon: 'family_restroom', name: 'Superman & Lois',              short: 'Superman & Lois' },
];

// Crossover events, keyed "show:season:episode" (TVmaze numbering).
const CROSSOVERS = {
  'flash:1:8': 'Flash vs. Arrow', 'arrow:3:8': 'Flash vs. Arrow',
  'flash:2:8': 'Heroes Join Forces', 'arrow:4:8': 'Heroes Join Forces',
  'supergirl:1:18': "World's Finest",
  'supergirl:2:8': 'Invasion!', 'flash:3:8': 'Invasion!', 'arrow:5:8': 'Invasion!', 'legends:2:7': 'Invasion!',
  'supergirl:2:16': 'Duet', 'flash:3:17': 'Duet',
  'supergirl:3:8': 'Crisis on Earth-X', 'arrow:6:8': 'Crisis on Earth-X',
  'flash:4:8': 'Crisis on Earth-X', 'legends:3:8': 'Crisis on Earth-X',
  'flash:5:9': 'Elseworlds', 'arrow:7:9': 'Elseworlds', 'supergirl:4:9': 'Elseworlds',
  'supergirl:5:9': 'Crisis on Infinite Earths', 'batwoman:1:9': 'Crisis on Infinite Earths',
  'flash:6:9': 'Crisis on Infinite Earths', 'arrow:8:8': 'Crisis on Infinite Earths',
  'legends:5:1': 'Crisis on Infinite Earths',
  'flash:8:1': 'Armageddon', 'flash:8:2': 'Armageddon', 'flash:8:3': 'Armageddon',
  'flash:8:4': 'Armageddon', 'flash:8:5': 'Armageddon',
};

const stripHtml = html => (html || '')
  .replace(/<[^>]*>/g, '')
  .replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#39;/g, "'")
  .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&nbsp;/g, ' ')
  .trim();

const toHttps = url => url ? url.replace(/^http:/, 'https:') : null;

// Turns TVmaze episode arrays into one compact list in air order.
export function buildEpisodes(byShow) {
  const order = Object.fromEntries(SHOWS.map((s, i) => [s.key, i]));
  const all = [];
  for (const show of SHOWS) {
    for (const ep of byShow[show.key] || []) {
      if (ep.type && ep.type !== 'regular') continue;
      if (ep.number == null || !ep.airdate) continue;
      all.push({
        id: ep.id,
        show: show.key,
        s: ep.season,
        e: ep.number,
        t: ep.name,
        d: ep.airdate,
        ts: ep.airstamp || `${ep.airdate}T12:00:00+00:00`,
        rt: ep.runtime || null,
        r: ep.rating?.average ?? null,
        img: toHttps(ep.image?.medium),
        sum: stripHtml(ep.summary),
        x: CROSSOVERS[`${show.key}:${ep.season}:${ep.number}`] || null,
      });
    }
  }
  all.sort((a, b) =>
    a.ts.localeCompare(b.ts) || order[a.show] - order[b.show] || a.s - b.s || a.e - b.e);
  return all;
}

// Corrections to the watch order, applied on top of arrowverse.info's order (or air-time
// order when that's unavailable). Each one moves an episode to right after another,
// taking along any later episodes of its show that would otherwise land before it.
// Keys are "show:season:episode" in TVmaze numbering, like CROSSOVERS.
export const ORDER_FIXES = [
  // "World's Finest" takes place while Barry is gone in "Versus Zoom", which aired four
  // weeks later. Supergirl S1E19 and S1E20 aired in between, so they move with it.
  { move: 'supergirl:1:18', after: 'flash:2:18' },
];

export function applyOrderFixes(episodes, fixes = ORDER_FIXES) {
  const key = ep => `${ep.show}:${ep.s}:${ep.e}`;
  const log = [];
  let list = episodes;
  for (const fix of fixes) {
    const from = list.findIndex(ep => key(ep) === fix.move);
    const to = list.findIndex(ep => key(ep) === fix.after);
    const what = `${fix.move} after ${fix.after}`;
    if (from < 0 || to < 0) { log.push(`${what}: episode not found`); continue; }
    if (list[from].show === list[to].show) { log.push(`${what}: same show, skipped`); continue; }
    if (from > to) { log.push(`${what}: already in place`); continue; }
    const block = list.slice(from, to + 1).filter(ep => ep.show === list[from].show);
    const rest = list.filter(ep => !block.includes(ep));
    rest.splice(rest.indexOf(list[to]) + 1, 0, ...block);
    list = rest;
    log.push(`${what}: moved${block.length > 1 ? ` with ${block.length - 1} later episode(s) of its show` : ''}`);
  }
  return { episodes: list, log };
}

// Fetches everything straight from TVmaze (the API allows cross-origin requests).
export async function fetchFromTvmaze(fetchFn = fetch) {
  const byShow = {};
  await Promise.all(SHOWS.map(async show => {
    const res = await fetchFn(`https://api.tvmaze.com/shows/${show.tvmaze}/episodes`);
    if (!res.ok) throw new Error(`TVmaze ${show.name}: HTTP ${res.status}`);
    byShow[show.key] = await res.json();
  }));
  return applyOrderFixes(buildEpisodes(byShow)).episodes;
}
