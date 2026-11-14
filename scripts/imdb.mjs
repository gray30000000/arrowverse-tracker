// IMDb ratings for every episode, from IMDb's non-commercial datasets
// (https://developer.imdb.com/non-commercial-datasets/, personal and non-commercial use).
// The files are streamed and filtered on the fly, so nothing big is kept in memory.
import { createGunzip } from 'node:zlib';
import { Readable } from 'node:stream';
import readline from 'node:readline';

const BASE = 'https://datasets.imdbws.com/';

async function* rows(file) {
  const res = await fetch(BASE + file);
  if (!res.ok) throw new Error(`${file}: HTTP ${res.status}`);
  const rl = readline.createInterface({ input: Readable.fromWeb(res.body).pipe(createGunzip()), crlfDelay: Infinity });
  let header = true;
  for await (const line of rl) {
    if (header) { header = false; continue; }
    yield line;
  }
}

const NUM = { one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10 };
const norm = t => String(t || '').toLowerCase()
  .replace(/&/g, ' and ').replace(/\b(one|two|three|four|five|six|seven|eight|nine|ten)\b/g, w => NUM[w])
  .replace(/\bpart\b|\bpt\b/g, ' ').replace(/[^a-z0-9]+/g, '');

// showImdb: Map(show key -> IMDb series id, e.g. "tt2193021")
// Returns Map(episode id -> { r, v, im }) and a report.
export async function imdbRatings(episodes, showImdb, altTitles = new Map()) {
  const parents = new Map([...showImdb].map(([show, tt]) => [tt, show]));
  const imdbEps = new Map(); // tconst -> { show, s, e }
  for await (const line of rows('title.episode.tsv.gz')) {
    const [tconst, parent, s, e] = line.split('\t');
    const show = parents.get(parent);
    if (show) imdbEps.set(tconst, { show, s: +s || 0, e: +e || 0 });
  }
  for await (const line of rows('title.ratings.tsv.gz')) {
    const tab = line.indexOf('\t');
    const ep = imdbEps.get(line.slice(0, tab));
    if (!ep) continue;
    const [, r, v] = line.split('\t');
    ep.r = +r; ep.v = +v;
  }
  for await (const line of rows('title.basics.tsv.gz')) {
    const tab = line.indexOf('\t');
    const ep = imdbEps.get(line.slice(0, tab));
    if (ep) ep.t = line.split('\t')[2];
  }

  // Match by title within the series (numbering differs between sources in places),
  // then by season and episode number.
  const result = new Map();
  const unmatched = [];
  const byShow = new Map();
  for (const [tconst, ep] of imdbEps) {
    if (!byShow.has(ep.show)) byShow.set(ep.show, []);
    byShow.get(ep.show).push({ tconst, ...ep });
  }
  const used = new Set();
  const pass = (ep, pick) => {
    const pool = (byShow.get(ep.show) || []).filter(x => !used.has(x.tconst));
    return pick(pool);
  };
  const assign = (ep, x) => { used.add(x.tconst); if (x.r) result.set(ep.id, { r: x.r, v: x.v, im: x.tconst }); else result.set(ep.id, { im: x.tconst }); };
  const titleOf = ep => [ep.t, altTitles.get(ep.id)].filter(Boolean).map(norm);
  // 1. same title, same season  2. same title anywhere  3. same season and number
  for (const ep of episodes) {
    const x = pass(ep, pool => pool.find(p => p.s === ep.s && titleOf(ep).includes(norm(p.t))));
    if (x) assign(ep, x);
  }
  for (const ep of episodes) {
    if (result.has(ep.id)) continue;
    const x = pass(ep, pool => pool.find(p => titleOf(ep).includes(norm(p.t))));
    if (x) assign(ep, x);
  }
  for (const ep of episodes) {
    if (result.has(ep.id)) continue;
    const x = pass(ep, pool => pool.find(p => p.s === ep.s && p.e === ep.e));
    if (x) assign(ep, x);
    else unmatched.push(`${ep.show} S${ep.s}E${ep.e} "${ep.t}"`);
  }
  return {
    ratings: result,
    report: {
      imdbEpisodesFound: imdbEps.size,
      matched: result.size,
      withRating: [...result.values()].filter(x => x.r).length,
      unmatched,
      seriesIds: Object.fromEntries(showImdb),
    },
  };
}
