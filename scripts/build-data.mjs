// Run by the GitHub Pages workflow: node scripts/build-data.mjs
//
// Order comes from arrowverse.info (its /api), so the watch order is the same as that
// site. Episode details (summary, image, runtime, rating) come from TVmaze.
// Every arrowverse.info row is matched to a TVmaze episode; its duplicate and broken
// rows are dropped, and TVmaze episodes it lacks are slotted in by air date.
// Writes data.json for the app and report.json with what differed.
import { writeFileSync } from 'node:fs';
import { SHOWS, buildEpisodes } from '../js/data.js';
import { buildCharacters } from './characters.mjs';
import { imdbRatings } from './imdb.mjs';

const AV_SERIES = {
  'Arrow': 'arrow', 'The Flash': 'flash', 'Constantine': 'constantine', 'Vixen': 'vixen',
  'Supergirl': 'supergirl', "DC's Legends of Tomorrow": 'legends', 'Freedom Fighters: The Ray': 'ray',
  'Black Lightning': 'blacklightning', 'Batwoman': 'batwoman', 'Superman & Lois': 'supermanlois',
  'Stargirl': 'stargirl',
};
const NUM_WORDS = { one: '1', two: '2', three: '3', four: '4', five: '5', six: '6', seven: '7', eight: '8', nine: '9', ten: '10' };

const norm = t => (t || '').toLowerCase()
  .replace(/&/g, ' and ')
  .replace(/\b(one|two|three|four|five|six|seven|eight|nine|ten)\b/g, w => NUM_WORDS[w])
  .replace(/\bpart\b|\bpt\b/g, ' ')
  .replace(/[^a-z0-9]+/g, '');

function dice(a, b) {
  if (!a || !b) return 0;
  if (a === b) return 1;
  const grams = s => { const m = new Map(); for (let i = 0; i < s.length - 1; i++) { const g = s.slice(i, i + 2); m.set(g, (m.get(g) || 0) + 1); } return m; };
  const A = grams(a), B = grams(b);
  let overlap = 0;
  for (const [g, n] of A) overlap += Math.min(n, B.get(g) || 0);
  return (2 * overlap) / (Math.max(1, a.length - 1) + Math.max(1, b.length - 1));
}
const dayDiff = (a, b) => Math.abs((new Date(a) - new Date(b)) / 864e5);

async function getJson(url) {
  const res = await fetch(url, { headers: { 'User-Agent': 'arrowverse-tracker build (github.com/gray30000000/arrowverse-tracker)' } });
  if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
  return res.json();
}

// 1. TVmaze, in air-time order.
const byShow = {};
const showImdb = new Map(); // show key -> IMDb series id (TVmaze lists it)
for (const show of SHOWS) {
  byShow[show.key] = await getJson(`https://api.tvmaze.com/shows/${show.tvmaze}/episodes`);
  const info = await getJson(`https://api.tvmaze.com/shows/${show.tvmaze}`);
  if (info.externals?.imdb) showImdb.set(show.key, info.externals.imdb);
}
const tvmaze = buildEpisodes(byShow);
const tvOrder = new Map(tvmaze.map((ep, i) => [ep.id, i]));

// 2. arrowverse.info order.
let av = null;
try {
  av = await getJson('https://arrowverse.info/api');
  if (!Array.isArray(av) || av.length < 500) throw new Error(`unexpected response (${av?.length} rows)`);
} catch (err) {
  console.warn('arrowverse.info unavailable, falling back to TVmaze air-time order:', err.message);
  av = null;
}

const report = { built: new Date().toISOString(), orderSource: av ? 'arrowverse.info' : 'tvmaze', tvmazeCount: tvmaze.length };
let episodes = tvmaze;
const wikiTitles = new Map(); // episode id -> arrowverse.info title (taken from the wiki's episode lists)

if (av) {
  const used = new Set();
  const pool = {};
  for (const ep of tvmaze) (pool[ep.show] ||= []).push(ep);
  const unmatched = [];
  const ordered = [];

  for (const row of av) {
    const show = AV_SERIES[row.series];
    const date = new Date(`${row.air_date} 12:00 UTC`).toISOString().slice(0, 10);
    const title = norm(row.episode_name);
    const season = +(/S(\d+)/.exec(row.episode_id)?.[1] || 0);
    const candidates = (pool[show] || []).filter(ep => !used.has(ep.id));
    const match =
      candidates.find(ep => norm(ep.t) === title && dayDiff(ep.d, date) <= 7) ||
      candidates.find(ep => norm(ep.t) === title) ||
      candidates.find(ep => ep.d === date && (ep.s === season || dice(norm(ep.t), title) > 0.4)) ||
      candidates
        .filter(ep => dayDiff(ep.d, date) <= 3)
        .map(ep => ({ ep, score: dice(norm(ep.t), title) }))
        .filter(x => x.score > 0.5)
        .sort((a, b) => b.score - a.score)[0]?.ep;
    if (match) {
      used.add(match.id);
      ordered.push(match);
      wikiTitles.set(match.id, row.episode_name.replace(/^"|"$/g, '').trim());
    } else {
      unmatched.push(row);
    }
  }

  // TVmaze episodes arrowverse.info doesn't list: insert by air time.
  const extra = tvmaze.filter(ep => !used.has(ep.id));
  for (const ep of extra) {
    const at = ordered.findIndex(o => o.ts > ep.ts);
    ordered.splice(at === -1 ? ordered.length : at, 0, ep);
  }
  episodes = ordered;

  // Places where arrowverse.info's order differs from plain TVmaze air-time order.
  const swaps = [];
  for (let i = 0; i < episodes.length - 1; i++) {
    const a = episodes[i], b = episodes[i + 1];
    if (tvOrder.get(a.id) > tvOrder.get(b.id)) swaps.push(`${a.d}: ${a.show} S${a.s}E${a.e} "${a.t}" before ${b.show} S${b.s}E${b.e} "${b.t}"`);
  }
  // Each show must still run in its own episode order.
  const outOfOrder = [];
  const last = {};
  for (const ep of episodes) {
    const k = ep.s * 1000 + ep.e;
    if (last[ep.show] != null && k < last[ep.show]) outOfOrder.push(`${ep.show} S${ep.s}E${ep.e} "${ep.t}"`);
    last[ep.show] = k;
  }

  Object.assign(report, {
    arrowverseRows: av.length,
    matched: used.size,
    arrowverseRowsDropped: unmatched.map(r => `${r.row_number}. ${r.series} ${r.episode_id} "${r.episode_name}" (${r.air_date})`),
    tvmazeOnlyInserted: extra.map(ep => `${ep.show} S${ep.s}E${ep.e} "${ep.t}" (${ep.d})`),
    differsFromAirTimeOrder: swaps,
    showOrderViolations: outOfOrder,
  });
}

report.finalCount = episodes.length;
report.perShow = Object.fromEntries(SHOWS.map(s => [s.short, episodes.filter(e => e.show === s.key).length]));
if (episodes.length < 600) throw new Error(`Only ${episodes.length} episodes, something is off`);

// IMDb ratings replace TVmaze's. If IMDb can't be reached, TVmaze's stay.
let ratingSource = 'tvmaze';
try {
  const t0 = Date.now();
  const { ratings, report: imdbReport } = await imdbRatings(episodes, showImdb, wikiTitles);
  if (imdbReport.withRating > 500) {
    for (const ep of episodes) {
      const x = ratings.get(ep.id);
      ep.r = x?.r ?? null;
      ep.v = x?.v ?? null;
      ep.im = x?.im ?? null;
    }
    ratingSource = 'imdb';
  }
  report.imdb = { ...imdbReport, seconds: Math.round((Date.now() - t0) / 1000) };
} catch (err) {
  console.warn('IMDb step failed, keeping TVmaze ratings:', err);
  report.imdb = { error: String(err) };
}

writeFileSync('data.json', JSON.stringify({ built: report.built, orderSource: report.orderSource, ratingSource, episodes }));

// Characters per episode (optional: the site still works without them).
try {
  const t0 = Date.now();
  const { data, report: charReport } = await buildCharacters(episodes, wikiTitles);
  if (data.chars.length > 50) writeFileSync('characters.json', JSON.stringify(data));
  report.characters = { ...charReport, seconds: Math.round((Date.now() - t0) / 1000) };
} catch (err) {
  console.warn('Characters step failed:', err);
  report.characters = { error: String(err) };
}
report.withImages = episodes.filter(e => e.img).length;
report.crossoverEpisodes = episodes.filter(e => e.x).map(e => `${e.x}: ${e.show} S${e.s}E${e.e}`);
writeFileSync('report.json', JSON.stringify(report, null, 2));
console.log(JSON.stringify(report, null, 2));
