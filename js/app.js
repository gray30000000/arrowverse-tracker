import { THEMES, SHOW_COLORS } from './theme-data.js';
import { SHOWS, fetchFromTvmaze } from './data.js';

/* ---------- Storage ---------- */
const KEYS = { watched: 'av.watched', settings: 'av.settings', cache: 'av.cache' };
const store = {
  get(k, fallback) { try { const v = localStorage.getItem(k); return v ? JSON.parse(v) : fallback; } catch { return fallback; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* storage full or blocked */ } },
};

const SHOW = Object.fromEntries(SHOWS.map(s => [s.key, s]));
const state = {
  episodes: [],
  byId: new Map(),
  rows: new Map(),
  watched: new Set(store.get(KEYS.watched, [])),
  settings: { seed: 'emerald', mode: 'system', hidden: [], hideWatched: false, ...store.get(KEYS.settings, {}) },
  query: '',
  ratingSource: 'tvmaze',
  heat: null,
};
const $ = id => document.getElementById(id);
const saveWatched = () => store.set(KEYS.watched, [...state.watched]);
const saveSettings = () => store.set(KEYS.settings, state.settings);
const isShown = ep => !state.settings.hidden.includes(ep.show);
const fmtDate = d => new Date(d + 'T12:00:00').toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' });
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const showVars = key => `--c:var(--s-${key});--cc:var(--s-${key}-cc);--occ:var(--s-${key}-occ)`;
const fmtVotes = v => v >= 1000 ? `${(v / 1000).toFixed(v >= 10000 ? 0 : 1)}k votes` : `${v} votes`;
const buzz = ms => { try { navigator.vibrate?.(ms); } catch { /* not supported */ } };

/* ---------- Theme ---------- */
const darkMq = matchMedia('(prefers-color-scheme: dark)');
function applyTheme() {
  const { seed, mode } = state.settings;
  const dark = mode === 'dark' || (mode === 'system' && darkMq.matches);
  const m = dark ? 'dark' : 'light';
  const theme = THEMES[seed] || THEMES.emerald;
  const shows = SHOW_COLORS[seed] || SHOW_COLORS.emerald;
  const root = document.documentElement;
  for (const [k, v] of Object.entries(theme[m])) root.style.setProperty(`--${k}`, v);
  for (const [show, c] of Object.entries(shows)) {
    root.style.setProperty(`--s-${show}`, c[m].c);
    root.style.setProperty(`--s-${show}-cc`, c[m].cc);
    root.style.setProperty(`--s-${show}-occ`, c[m].occ);
  }
  root.dataset.mode = m;
  state.heat = theme[m].heat;
  if (typeof currentView !== 'undefined' && currentView === 'ratings') renderRatings();
  document.querySelector('meta[name=theme-color]').content =
    $('appbar').classList.contains('scrolled') ? theme[m]['surface-container'] : theme[m].surface;
}
darkMq.addEventListener('change', applyTheme);

/* ---------- Data ---------- */
async function loadEpisodes() {
  try {
    const res = await fetch('data.json', { cache: 'no-cache' });
    if (res.ok) {
      const json = await res.json();
      if (json.episodes?.length) { state.ratingSource = json.ratingSource || 'tvmaze'; return json.episodes; }
    }
  } catch { /* fall through to TVmaze */ }
  const cached = store.get(KEYS.cache, null);
  if (cached?.episodes?.length && Date.now() - cached.at < 14 * 864e5) return cached.episodes;
  $('loadingText').textContent = 'Fetching episodes from TVmaze…';
  try {
    const episodes = await fetchFromTvmaze();
    store.set(KEYS.cache, { at: Date.now(), episodes });
    return episodes;
  } catch (err) {
    if (cached?.episodes?.length) return cached.episodes;
    throw err;
  }
}

/* ---------- Rendering ---------- */
function rowHtml(ep) {
  const show = SHOW[ep.show];
  return `
    <div class="swipe-bg" aria-hidden="true">
      <span class="bg-watch"><span class="ms fill">check_circle</span>Watched</span>
      <span class="bg-unwatch">Unwatch<span class="ms">undo</span></span>
    </div>
    <div class="ep-fg">
      <div class="ep-avatar"><span class="ms">${show.icon}</span></div>
      <div class="ep-text">
        <div class="ep-title">${esc(ep.t)}</div>
        <div class="ep-meta">${esc(show.short)} · S${ep.s} E${ep.e} · ${fmtDate(ep.d)}</div>
        ${ep.x ? `<div class="ep-x"><span class="ms">join</span>${esc(ep.x)}</div>` : ''}
      </div>
      <span class="ep-n">#${ep.n}</span>
    </div>`;
}

function renderList() {
  const list = $('list');
  list.textContent = '';
  const frag = document.createDocumentFragment();
  let year = null;
  for (const ep of state.episodes) {
    const y = ep.d.slice(0, 4);
    if (y !== year) {
      year = y;
      const h = document.createElement('li');
      h.className = 'year';
      h.dataset.year = y;
      h.innerHTML = `<span>${y}</span><small></small>`;
      frag.append(h);
    }
    const li = document.createElement('li');
    li.className = 'ep';
    li.dataset.id = ep.id;
    li.style.cssText = showVars(ep.show);
    li.innerHTML = rowHtml(ep);
    li.classList.toggle('watched', state.watched.has(ep.id));
    li.setAttribute('aria-label', `${ep.t}, ${SHOW[ep.show].name} season ${ep.s} episode ${ep.e}`);
    state.rows.set(ep.id, li);
    frag.append(li);
  }
  list.append(frag);
}

function matchesQuery(ep) {
  const q = state.query;
  if (!q) return true;
  const s = SHOW[ep.show];
  return `${ep.t} ${s.name} ${s.short} s${ep.s}e${ep.e} ${ep.x || ''} ${ep.d.slice(0, 4)}`.toLowerCase().includes(q);
}

function applyFilters() {
  const { hideWatched } = state.settings;
  let header = null, headerVisible = 0, headerWatched = 0, headerTotal = 0, lastVisible = null, shown = 0;
  const closeHeader = () => {
    if (!header) return;
    header.hidden = headerVisible === 0;
    header.querySelector('small').textContent = `${headerWatched} / ${headerTotal} watched`;
    if (lastVisible) lastVisible.classList.add('last');
  };
  for (const li of $('list').children) {
    if (li.classList.contains('year')) {
      closeHeader();
      header = li; headerVisible = headerWatched = headerTotal = 0; lastVisible = null;
      continue;
    }
    const ep = state.byId.get(+li.dataset.id);
    const watched = state.watched.has(ep.id);
    const inShow = isShown(ep);
    if (inShow) { headerTotal++; if (watched) headerWatched++; }
    const visible = inShow && matchesQuery(ep) && !(hideWatched && watched);
    li.hidden = !visible;
    li.classList.remove('last', 'collapsing');
    if (visible) {
      if (lastVisible) lastVisible.classList.remove('last');
      lastVisible = li; headerVisible++; shown++;
    }
  }
  closeHeader();
  $('empty').hidden = shown > 0 || !state.episodes.length;
  $('emptyText').textContent = state.query
    ? `No episodes match “${state.query}”`
    : hideWatched ? 'All caught up. Nothing left to watch!' : 'No series selected';
}

/* ---------- Progress + up next ---------- */
function nextUp() {
  return state.episodes.find(ep => isShown(ep) && !state.watched.has(ep.id));
}

function updateSummary() {
  const eps = state.episodes.filter(isShown);
  const total = eps.length;
  const watchedEps = eps.filter(ep => state.watched.has(ep.id));
  const done = watchedEps.length;
  const pct = total ? done / total : 0;
  $('pWatched').textContent = done.toLocaleString();
  $('pTotal').textContent = total.toLocaleString();
  $('pPct').textContent = `${Math.floor(pct * 100)}%`;
  const leftMin = eps.filter(ep => !state.watched.has(ep.id)).reduce((t, ep) => t + (ep.rt || 42), 0);
  const leftH = Math.round(leftMin / 60);
  $('pTime').textContent = total === done ? 'All caught up' : `About ${leftH.toLocaleString()} h left`;
  drawWave(pct);

  const next = nextUp();
  $('upnext').hidden = !next;
  $('fab').classList.toggle('away', !next);
  if (next) {
    const s = SHOW[next.show];
    $('upnext').style.cssText = showVars(next.show);
    $('upnextBody').innerHTML = `
      ${next.img ? `<img class="upnext-img" src="${esc(next.img)}" alt="" loading="lazy">` : `<div class="upnext-img"><span class="ms fill">${s.icon}</span></div>`}
      <div>
        <div class="upnext-title">${esc(next.t)}</div>
        <div class="upnext-meta">${esc(s.short)} · S${next.s} E${next.e} · ${fmtDate(next.d)}</div>
        ${next.x ? `<div class="ep-x"><span class="ms">join</span>${esc(next.x)}</div>` : ''}
      </div>`;
    $('upnext').dataset.id = next.id;
  }
}

let wavePct = 0;
function drawWave(pct = wavePct) {
  wavePct = pct;
  const el = $('wavy');
  const w = el.clientWidth;
  if (!w) return;
  const h = 20, mid = h / 2, amp = 3.2, wl = 28, gap = 8;
  const filled = Math.max(0, Math.min(w, w * pct));
  let d = '';
  if (filled > 2) {
    for (let x = -wl; x <= filled + wl; x += 2) {
      const y = mid + amp * Math.sin((x / wl) * Math.PI * 2);
      d += `${d ? 'L' : 'M'}${x.toFixed(1)} ${y.toFixed(2)}`;
    }
  }
  const trackStart = filled > 2 ? Math.min(w, filled + gap) : 2;
  el.innerHTML = `
    <svg viewBox="0 0 ${w} ${h}" style="--wl:${wl}px">
      <defs><clipPath id="wclip"><rect x="0" y="0" width="${Math.max(0, filled - 2)}" height="${h}"/></clipPath></defs>
      ${trackStart < w - 4 ? `<line class="track" x1="${trackStart}" y1="${mid}" x2="${w - 2}" y2="${mid}"/>` : ''}
      ${d ? `<g clip-path="url(#wclip)"><path class="wave" d="${d}"/></g>` : ''}
      ${pct < 1 ? `<circle class="stop" cx="${w - 2}" cy="${mid}" r="2"/>` : ''}
    </svg>`;
}
new ResizeObserver(() => drawWave()).observe($('wavy'));

/* ---------- Watching ---------- */
function setWatched(ids, value, { announce = true, message } = {}) {
  const changed = ids.filter(id => state.watched.has(id) !== value);
  if (!changed.length) return;
  for (const id of changed) value ? state.watched.add(id) : state.watched.delete(id);
  saveWatched();
  for (const id of changed) {
    const li = state.rows.get(id);
    if (!li) continue;
    li.classList.toggle('watched', value);
    if (changed.length < 4) { li.classList.remove('pop'); void li.offsetWidth; li.classList.add('pop'); }
  }
  updateSummary();
  if (currentView === 'characters') renderCharacters();
  if (currentView === 'ratings') renderRatings();
  if (state.settings.hideWatched && value && changed.length < 4) {
    for (const id of changed) state.rows.get(id)?.classList.add('collapsing');
    setTimeout(applyFilters, 320);
  } else {
    applyFilters();
  }
  if (announce) {
    const ep = state.byId.get(changed[0]);
    const fresh = value && changed.length === 1 ? newCharactersIn(ep) : 0;
    const text = message || (changed.length === 1
      ? `“${ep.t}” ${value ? 'watched' : 'unmarked'}${fresh ? ` · ${fresh} new character${fresh > 1 ? 's' : ''}` : ''}`
      : `${changed.length} episodes ${value ? 'marked watched' : 'unmarked'}`);
    snackbar(text, () => setWatched(changed, !value, { announce: false }));
  }
}

/* ---------- Swipe gestures ---------- */
function setupSwipe(list) {
  let s = null;
  let suppressClick = false;
  const reset = row => {
    row.classList.remove('dragging', 'armed');
    row.classList.add('settling');
    row.querySelector('.ep-fg').style.transform = '';
    setTimeout(() => row.classList.remove('settling'), 380);
  };
  list.addEventListener('pointerdown', e => {
    const row = e.target.closest('.ep');
    if (!row || (e.pointerType === 'mouse' && e.button !== 0)) return;
    s = { row, fg: row.querySelector('.ep-fg'), x0: e.clientX, y0: e.clientY, dx: 0, id: e.pointerId, w: row.offsetWidth, dragging: false, armed: false };
  });
  list.addEventListener('pointermove', e => {
    if (!s || e.pointerId !== s.id) return;
    const dx = e.clientX - s.x0, dy = e.clientY - s.y0;
    if (!s.dragging) {
      if (Math.abs(dy) > 10 && Math.abs(dy) > Math.abs(dx)) { s = null; return; }
      if (Math.abs(dx) < 10 || Math.abs(dx) < Math.abs(dy) * 1.2) return;
      s.dragging = true;
      try { s.row.setPointerCapture(e.pointerId); } catch { /* ignore */ }
      s.row.classList.add('dragging');
    }
    e.preventDefault();
    const limit = s.w * 0.9;
    s.dx = Math.max(-limit, Math.min(limit, dx));
    s.fg.style.transform = `translateX(${s.dx}px)`;
    s.row.dataset.dir = s.dx > 0 ? 'right' : 'left';
    const watched = state.watched.has(+s.row.dataset.id);
    const meaningful = s.dx > 0 ? !watched : watched;
    const armed = meaningful && Math.abs(s.dx) > Math.min(140, s.w * 0.3);
    if (armed !== s.armed) {
      s.armed = armed;
      s.row.classList.toggle('armed', armed);
      if (armed) buzz(10);
    }
  });
  const finish = (e, cancelled) => {
    if (!s || e.pointerId !== s.id) return;
    const st = s; s = null;
    if (!st.dragging) return;
    suppressClick = true;
    setTimeout(() => { suppressClick = false; }, 0);
    if (!cancelled && st.armed) {
      buzz(18);
      setWatched([+st.row.dataset.id], st.dx > 0);
    }
    reset(st.row);
  };
  list.addEventListener('pointerup', e => finish(e, false));
  list.addEventListener('pointercancel', e => finish(e, true));
  list.addEventListener('click', e => {
    if (suppressClick) { e.stopPropagation(); e.preventDefault(); return; }
    const row = e.target.closest('.ep');
    if (row) openDetails(+row.dataset.id);
  }, true);
}

/* ---------- Snackbar ---------- */
let snackTimer, snackUndo;
function snackbar(text, undo) {
  $('snackText').textContent = text;
  $('snackAction').hidden = !undo;
  snackUndo = undo;
  $('snackbar').classList.add('open');
  document.body.classList.add('snack-open');
  clearTimeout(snackTimer);
  snackTimer = setTimeout(closeSnack, 4500);
}
function closeSnack() {
  $('snackbar').classList.remove('open');
  document.body.classList.remove('snack-open');
}
$('snackAction').addEventListener('click', () => { snackUndo?.(); snackUndo = null; closeSnack(); });

/* ---------- Bottom sheet ---------- */
let sheetOpen = false;
let sheetCloseTimer;
function openSheet(html, vars = '') {
  clearTimeout(sheetCloseTimer);
  $('sheetContent').innerHTML = html;
  $('sheet').style.cssText = vars;
  $('sheet').classList.remove('dragging');
  $('scrim').style.cssText = '';
  $('sheet').hidden = $('scrim').hidden = false;
  $('sheetContent').scrollTop = 0;
  $('sheetContent').onclick = null;
  if (!sheetOpen) history.pushState({ sheet: true, view: currentView }, '');
  sheetOpen = true;
}
function closeSheet(fromHistory = false) {
  if (!sheetOpen) return;
  sheetOpen = false;
  const sheet = $('sheet'), scrim = $('scrim');
  sheet.classList.remove('dragging');
  // Slide out from wherever the sheet currently is (also mid-drag).
  sheet.style.transition = 'transform .25s cubic-bezier(.3, 0, .8, .15)';
  sheet.style.transform = 'translate(-50%, 105%)';
  scrim.style.transition = 'opacity .25s';
  scrim.style.opacity = '0';
  sheetCloseTimer = setTimeout(() => {
    sheet.hidden = true;
    if ($('dialog').hidden) scrim.hidden = true;
    scrim.style.cssText = '';
  }, 260);
  if (!fromHistory && history.state?.sheet) history.back();
}
window.addEventListener('popstate', () => {
  closeMenu();
  if (sheetOpen) { closeSheet(true); return; }
  const view = history.state?.view || 'episodes';
  if (view !== currentView) setView(view, false);
});
$('scrim').addEventListener('click', () => closeSheet());
document.addEventListener('keydown', e => { if (e.key === 'Escape') { closeSheet(); closeMenu(); closeDialog(); } });

// Drag the sheet down from anywhere inside it. If its content is scrolled,
// it scrolls back to the top first and then the drag takes over (like Android).
(() => {
  const sheet = $('sheet'), content = $('sheetContent'), scrim = $('scrim');
  let g = null;
  let suppressClick = false;

  const begin = (x, y, target) => {
    if (!sheetOpen) return;
    // Pulls that start on the handle area always drag, even if the content is scrolled.
    g = { x0: x, anchor: y, lastY: y, lastT: performance.now(), v: 0, dy: 0, dragging: false, fromHandle: !content.contains(target) };
  };
  // Returns true when the sheet is being dragged (caller blocks native scrolling).
  const move = (x, y) => {
    if (!g) return false;
    const now = performance.now();
    const dt = Math.max(1, now - g.lastT);
    g.v = 0.7 * ((y - g.lastY) / dt) + 0.3 * g.v;
    g.lastY = y; g.lastT = now;
    if (!g.dragging) {
      const atTop = g.fromHandle || content.scrollTop <= 0;
      const d = y - g.anchor;
      if (!atTop || d < 0) { g.anchor = y; return false; } // let the content scroll
      if (Math.abs(x - g.x0) > d) { g.anchor = y; g.x0 = x; return false; } // sideways, not a pull
      if (d < 14) return false; // needs a deliberate pull before the sheet moves
      g.dragging = true;
      g.anchor = y;
      sheet.classList.add('dragging');
    }
    let dy = y - g.anchor;
    if (dy < 0) dy = Math.max(-24, dy / 4); // a little resistance when pulled up
    g.dy = dy;
    sheet.style.transform = `translate(-50%, ${dy}px)`;
    scrim.style.opacity = String(1 - Math.max(0, dy) / sheet.offsetHeight);
    return true;
  };
  const finish = () => {
    if (!g) return;
    const st = g; g = null;
    if (!st.dragging) return;
    suppressClick = true;
    setTimeout(() => { suppressClick = false; }, 0);
    sheet.classList.remove('dragging');
    // A quick flick closes it; a pause before lifting the finger cancels the flick.
    const v = performance.now() - st.lastT > 100 ? 0 : st.v;
    const flung = v > 0.9 && st.dy > 56;
    if (flung || st.dy > Math.max(160, sheet.offsetHeight * 0.4)) {
      closeSheet();
    } else {
      sheet.style.transition = 'transform .3s cubic-bezier(.2, .9, .3, 1)';
      sheet.style.transform = '';
      scrim.style.transition = 'opacity .25s';
      scrim.style.opacity = '';
      setTimeout(() => { if (sheetOpen) { sheet.style.transition = ''; scrim.style.transition = ''; } }, 360);
    }
  };

  // Touch: listeners must be non-passive so a pull-down can stop native scrolling.
  sheet.addEventListener('touchstart', e => { if (e.touches.length === 1) begin(e.touches[0].clientX, e.touches[0].clientY, e.target); else g = null; }, { passive: true });
  sheet.addEventListener('touchmove', e => { if (g && move(e.touches[0].clientX, e.touches[0].clientY) && e.cancelable) e.preventDefault(); }, { passive: false });
  sheet.addEventListener('touchend', finish);
  sheet.addEventListener('touchcancel', finish);

  // Mouse: drag anywhere too.
  sheet.addEventListener('pointerdown', e => { if (e.pointerType === 'mouse' && e.button === 0) begin(e.clientX, e.clientY, e.target); });
  window.addEventListener('pointermove', e => { if (e.pointerType === 'mouse' && g && move(e.clientX, e.clientY)) e.preventDefault(); });
  window.addEventListener('pointerup', e => { if (e.pointerType === 'mouse') finish(); });
  sheet.addEventListener('click', e => { if (suppressClick) { e.stopPropagation(); e.preventDefault(); } }, true);
})();

function openDetails(id) {
  const ep = state.byId.get(id);
  if (!ep) return;
  const s = SHOW[ep.show];
  const watched = state.watched.has(id);
  const before = state.episodes.filter(x => x.n < ep.n && isShown(x) && !state.watched.has(x.id)).length;
  openSheet(`
    ${ep.img ? `<img class="d-img" src="${esc(ep.img.replace('/medium_landscape/', '/original_untouched/'))}" alt="" onerror="this.src='${esc(ep.img)}'">` : `<div class="d-noimg"><span class="ms fill" style="font-size:56px">${s.icon}</span></div>`}
    <div class="d-show"><span class="ms fill sm">${s.icon}</span>${esc(s.name)}</div>
    <h2 class="d-title">${esc(ep.t)}</h2>
    <div class="d-meta">
      <span class="d-pill"><span class="ms">tag</span>S${ep.s} · E${ep.e}</span>
      <span class="d-pill"><span class="ms">calendar_today</span>${fmtDate(ep.d)}</span>
      ${ep.rt ? `<span class="d-pill"><span class="ms">schedule</span>${ep.rt} min</span>` : ''}
      ${ep.r ? (ep.im
        ? `<a class="d-pill" href="https://www.imdb.com/title/${esc(ep.im)}/" target="_blank" rel="noopener"><span class="ms fill">star</span>${ep.r} IMDb${ep.v ? ` · ${fmtVotes(ep.v)}` : ''}</a>`
        : `<span class="d-pill"><span class="ms fill">star</span>${ep.r}</span>`) : ''}
      <span class="d-pill"><span class="ms">format_list_numbered</span>#${ep.n} in order</span>
      ${ep.x ? `<span class="d-pill x"><span class="ms">join</span>${esc(ep.x)} crossover</span>` : ''}
    </div>
    ${ep.sum ? `<p class="d-sum">${esc(ep.sum)}</p>` : ''}
    <div class="d-actions">
      <button class="btn big ${watched ? 'tonal' : 'filled'}" data-act="toggle">
        <span class="ms">${watched ? 'undo' : 'check'}</span>${watched ? 'Mark as unwatched' : 'Mark as watched'}
      </button>
      ${before ? `<button class="btn big outlined" data-act="upto"><span class="ms">done_all</span>Mark this and ${before} earlier as watched</button>` : ''}
    </div>
    ${castHtml(ep)}`, showVars(ep.show));
  $('sheetContent').onclick = e => {
    const act = e.target.closest('[data-act]')?.dataset.act;
    if (act === 'reveal' || act === 'minor') {
      $('castBox').outerHTML = castHtml(ep, { reveal: true, all: act === 'minor' });
      return;
    }
    const ch = e.target.closest('[data-char]');
    if (ch) openCharacter(+ch.dataset.char, ep);
  };
  $('sheetContent').querySelector('[data-act=toggle]').onclick = () => { closeSheet(); setWatched([id], !watched); };
  const upto = $('sheetContent').querySelector('[data-act=upto]');
  if (upto) upto.onclick = () => {
    closeSheet();
    const ids = state.episodes.filter(x => x.n <= ep.n && isShown(x)).map(x => x.id);
    setWatched(ids, true, { message: `Caught up to “${ep.t}”` });
  };
}

function openStats() {
  const selected = SHOWS.filter(s => !state.settings.hidden.includes(s.key));
  const rows = selected.map(s => {
    const eps = state.episodes.filter(ep => ep.show === s.key);
    const done = eps.filter(ep => state.watched.has(ep.id)).length;
    const pct = eps.length ? (done / eps.length) * 100 : 0;
    return `<div class="stat-row" style="${showVars(s.key)}">
      <div class="stat-name"><span class="ms fill sm" style="color:var(--c)">${s.icon}</span>${esc(s.name)}</div>
      <div class="stat-num">${done} / ${eps.length}</div>
      <div class="bar"><i style="width:${pct}%"></i></div>
    </div>`;
  }).join('');
  openSheet(`<div class="stats"><h2>Progress by series</h2>${rows || '<p class="stat-empty">No series selected. Turn some on with the filter chips.</p>'}</div>`);
}

function openTheme() {
  const { mode, seed } = state.settings;
  const dark = document.documentElement.dataset.mode;
  const modes = [['system', 'brightness_auto', 'Auto'], ['light', 'light_mode', 'Light'], ['dark', 'dark_mode', 'Dark']];
  openSheet(`<div class="theme">
    <h2>Theme</h2>
    <div class="seg" role="group" aria-label="Brightness">
      ${modes.map(([v, icon, label]) => `<button data-mode="${v}" aria-pressed="${mode === v}"><span class="ms sm">${icon}</span>${label}</button>`).join('')}
    </div>
    <p class="label">Color</p>
    <div class="swatches">
      ${Object.entries(THEMES).map(([name, t]) => {
        const c = t[dark];
        return `<button class="swatch" data-seed="${name}" aria-pressed="${seed === name}" aria-label="${name}">
          <span class="disc"><i style="background:${c.primary}"></i><i style="background:${c['secondary-container']}"></i><i style="background:${c['tertiary-container']}"></i></span>
        </button>`;
      }).join('')}
    </div>
  </div>`);
  $('sheetContent').querySelectorAll('[data-mode]').forEach(b => b.onclick = () => {
    state.settings.mode = b.dataset.mode; saveSettings(); applyTheme(); openTheme();
  });
  $('sheetContent').querySelectorAll('[data-seed]').forEach(b => b.onclick = () => {
    state.settings.seed = b.dataset.seed; saveSettings(); applyTheme(); openTheme();
  });
}

/* ---------- Dialog ---------- */
let dialogOk;
function confirmDialog({ icon, title, text, ok }) {
  $('dialogIcon').textContent = icon;
  $('dialogTitle').textContent = title;
  $('dialogText').textContent = text;
  $('dialogOk').textContent = ok;
  $('dialog').hidden = false;
  clearTimeout(sheetCloseTimer);
  $('scrim').style.cssText = '';
  $('scrim').hidden = false;
  return new Promise(resolve => { dialogOk = resolve; });
}
function closeDialog(result = false) {
  if ($('dialog').hidden) return;
  $('dialog').hidden = true;
  if (!sheetOpen) $('scrim').hidden = true;
  dialogOk?.(result); dialogOk = null;
}
$('dialogCancel').onclick = () => closeDialog(false);
$('dialogOk').onclick = () => closeDialog(true);

/* ---------- Menu ---------- */
function closeMenu() { $('menu').hidden = true; }
$('menuBtn').addEventListener('click', e => { e.stopPropagation(); $('menu').hidden = !$('menu').hidden; });
document.addEventListener('click', e => { if (!$('menu').contains(e.target)) closeMenu(); });
$('menu').addEventListener('click', async e => {
  const action = e.target.closest('[data-action]')?.dataset.action;
  if (!action) return;
  closeMenu();
  if (action === 'stats') openStats();
  if (action === 'theme') openTheme();
  if (action === 'export') {
    const blob = new Blob([JSON.stringify({ app: 'arrowverse-tracker', version: 1, exported: new Date().toISOString(), watched: [...state.watched], settings: state.settings }, null, 2)], { type: 'application/json' });
    const a = Object.assign(document.createElement('a'), { href: URL.createObjectURL(blob), download: `arrowverse-progress-${new Date().toISOString().slice(0, 10)}.json` });
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
    snackbar('Backup downloaded');
  }
  if (action === 'import') $('importFile').click();
  if (action === 'reset') {
    const ok = await confirmDialog({ icon: 'restart_alt', title: 'Reset progress?', text: `This unmarks all ${state.watched.size} watched episodes on this device. You can undo right after.`, ok: 'Reset' });
    if (ok) setWatched([...state.watched], false, { message: 'Progress reset' });
  }
});
$('importFile').addEventListener('change', async e => {
  const file = e.target.files[0];
  e.target.value = '';
  if (!file) return;
  try {
    const json = JSON.parse(await file.text());
    if (!Array.isArray(json.watched)) throw new Error('bad file');
    const prev = [...state.watched];
    state.watched = new Set(json.watched.map(Number));
    if (json.settings) { state.settings = { ...state.settings, ...json.settings }; saveSettings(); applyTheme(); renderChips(); }
    saveWatched();
    for (const [id, li] of state.rows) li.classList.toggle('watched', state.watched.has(id));
    updateSummary(); applyFilters();
    snackbar(`Restored ${state.watched.size} watched episodes`, () => {
      state.watched = new Set(prev); saveWatched();
      for (const [id, li] of state.rows) li.classList.toggle('watched', state.watched.has(id));
      updateSummary(); applyFilters();
    });
  } catch {
    snackbar('That file isn’t a valid backup');
  }
});

/* ---------- Filter chips ---------- */
function renderChips() {
  const { hidden, hideWatched } = state.settings;
  $('chips').innerHTML = `
    <button class="chip" data-chip="unwatched" aria-pressed="${hideWatched}"><span class="ms">${hideWatched ? 'check' : 'visibility_off'}</span>Unwatched only</button>
    <span class="chip-sep"></span>
    ${SHOWS.map(s => `<button class="chip show" data-show="${s.key}" style="${showVars(s.key)}" aria-pressed="${!hidden.includes(s.key)}"><span class="ms sicon">${s.icon}</span>${esc(s.short)}</button>`).join('')}`;
}
$('chips').addEventListener('click', e => {
  const chip = e.target.closest('.chip');
  if (!chip) return;
  if (chip.dataset.chip === 'unwatched') {
    state.settings.hideWatched = !state.settings.hideWatched;
  } else {
    const key = chip.dataset.show;
    const hidden = new Set(state.settings.hidden);
    hidden.has(key) ? hidden.delete(key) : hidden.add(key);
    state.settings.hidden = [...hidden];
  }
  saveSettings();
  const left = $('chips').scrollLeft;
  renderChips();
  $('chips').scrollLeft = left;
  applyFilters();
  updateSummary();
  if (currentView === 'ratings') renderRatings();
});

/* ---------- Search ---------- */
function openSearch() {
  $('appbar').classList.add('searching');
  $('searchbar').hidden = false;
  $('searchInput').focus();
}
function closeSearch() {
  $('appbar').classList.remove('searching');
  $('searchbar').hidden = true;
  $('searchInput').value = '';
  state.query = '';
  $('searchClear').hidden = true;
  applyFilters();
}
let searchTimer;
$('searchBtn').onclick = openSearch;
$('searchClose').onclick = closeSearch;
$('searchClear').onclick = () => { $('searchInput').value = ''; $('searchInput').dispatchEvent(new Event('input')); $('searchInput').focus(); };
$('searchInput').addEventListener('input', () => {
  $('searchClear').hidden = !$('searchInput').value;
  clearTimeout(searchTimer);
  searchTimer = setTimeout(() => {
    state.query = $('searchInput').value.trim().toLowerCase();
    applyFilters();
    if (state.query) $('list').scrollIntoView({ block: 'start' });
  }, 120);
});

/* ---------- Scrolling: app bar, FAB ---------- */
function scrollToNext() {
  const next = nextUp();
  if (!next) return;
  if (state.query) closeSearch();
  const li = state.rows.get(next.id);
  const top = li.getBoundingClientRect().top + scrollY - $('appbar').offsetHeight - 56;
  scrollTo({ top, behavior: 'smooth' });
  li.classList.remove('flash-hl'); void li.offsetWidth; li.classList.add('flash-hl');
  setTimeout(() => li.classList.remove('flash-hl'), 1500);
}
$('fab').onclick = scrollToNext;
$('upnextWatched').onclick = () => { const id = +$('upnext').dataset.id; if (id) setWatched([id], true); };
$('upnextDetails').onclick = () => { const id = +$('upnext').dataset.id; if (id) openDetails(id); };
$('progressCard').onclick = openStats;
$('progressCard').onkeydown = e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openStats(); } };

new IntersectionObserver(([entry]) => {
  $('appbar').classList.toggle('scrolled', !entry.isIntersecting);
  applyTheme();
}, { rootMargin: '-64px 0px 0px 0px' }).observe($('bigTitle'));

let lastY = scrollY;
addEventListener('scroll', () => {
  const y = scrollY;
  if (Math.abs(y - lastY) > 6) { $('fab').classList.toggle('shrunk', y > lastY && y > 200); lastY = y; }
}, { passive: true });

new ResizeObserver(() => {
  document.documentElement.style.setProperty('--header-h', `${$('appbar').offsetHeight}px`);
}).observe($('appbar'));

/* ---------- Characters ---------- */
// characters.json: chars[i] = { n: [credited names], a: [actors] }; eps[episodeId] = entries.
// Only what was credited in watched episodes is shown, so nothing gets spoiled.
const cast = { chars: null, eps: null, appear: null, loaded: false, failed: false };
const GROUP_LABEL = ['Main cast', 'Guest starring', 'Co-starring', 'Also appearing'];
const decodeEntry = x => Array.isArray(x)
  ? { c: x[0] >> 2, g: x[0] & 3, ni: x[1] || 0, ai: x[2] || 0 }
  : { c: x >> 2, g: x & 3, ni: 0, ai: 0 };
const charName = (c, ni) => cast.chars[c].n[ni] ?? cast.chars[c].n[0];
// Credits often carry a job title that changes ("Detective/Captain/Mayor Quentin Lance");
// the character list shows the name without it.
const TITLE_RE = /^(?:(?:assistant|deputy|vice|acting|former|interim|special|co-)\s*)*(?:dr|doctor|mr|mrs|ms|miss|professor|prof|detective|det|officer|captain|capt|lieutenant|lt|sergeant|sgt|agent|major|general|colonel|commander|admiral|mayor|senator|councilman|councilwoman|governor|president|director|chief|sheriff|district attorney|attorney general|judge|commissioner|warden|coach|principal|nurse|private|corporal)\.?\s+/i;
const cleanName = name => {
  let x = name;
  for (;;) {
    const y = x.replace(TITLE_RE, '');
    if (y === x || !y.trim()) return x;
    x = y;
  }
};
const initialsOf = name => name
  .replace(/\(.*?\)/g, '').replace(/^(dr|mr|mrs|ms|miss)\.?\s+/i, '').trim()
  .split(/\s+/).filter(w => /^[\p{L}\p{N}]/u.test(w)).slice(0, 2)
  .map(w => w[0].toUpperCase()).join('') || '?';
// Portrait from imageUrl in characters.json (a wiki image URL, or null), laid over the
// initials. If it fails to load, it removes itself and isn't asked for again this
// session, so the initials show instead.
const missingImages = new Set();
const avatarHtml = (c, name, { show = null, big = false } = {}) => {
  const url = cast.chars[c].imageUrl;
  const img = url && !missingImages.has(url)
    ? `<img class="ch-img" src="${esc(url)}" alt="" loading="lazy" decoding="async" referrerpolicy="no-referrer">` : '';
  const badge = show ? `<span class="ms badge">${SHOW[show].icon}</span>` : '';
  return `<span class="initials${big ? ' big' : ''}">${esc(initialsOf(name))}${img}${badge}</span>`;
};
document.addEventListener('error', e => {
  const img = e.target;
  if (!(img instanceof HTMLImageElement) || !img.classList.contains('ch-img')) return;
  missingImages.add(img.getAttribute('src'));
  img.remove();
}, true); // error events don't bubble, so listen in the capture phase
const epByN = n => state.episodes[n - 1];
// Series a character first appeared in (only used for color and badge).
const homeShow = (c, fallback) => { const n = cast.appear.get(c)?.[0]; return n ? epByN(n).show : fallback; };
const isNewIn = (c, ep) => !(cast.appear.get(c) || []).some(n => n < ep.n && isShown(epByN(n)));

async function loadCharacters() {
  try {
    const res = await fetch('characters.json', { cache: 'no-cache' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const json = await res.json();
    cast.chars = json.chars;
    cast.eps = {};
    for (const [id, list] of Object.entries(json.eps)) cast.eps[id] = list.map(decodeEntry);
    cast.appear = new Map(); // character -> episode numbers (main/guest credits), in order
    for (const ep of state.episodes) {
      for (const e of cast.eps[ep.id] || []) {
        if (e.g > 1) continue;
        if (!cast.appear.has(e.c)) cast.appear.set(e.c, []);
        cast.appear.get(e.c).push(ep.n);
      }
    }
    cast.loaded = true;
  } catch (err) {
    console.warn('No character data:', err);
    cast.failed = true;
  }
  if (currentView === 'characters') renderCharacters();
  const box = document.getElementById('castBox');
  if (box && sheetOpen) box.outerHTML = castHtml(state.byId.get(+box.dataset.ep));
}

function metCharacters() {
  const met = new Map();
  if (!cast.loaded) return met;
  for (const ep of state.episodes) {
    if (!state.watched.has(ep.id)) continue;
    for (const e of cast.eps[ep.id] || []) {
      if (e.g > 1) continue;
      let m = met.get(e.c);
      if (!m) met.set(e.c, m = { c: e.c, first: ep, last: ep, count: 0, actors: new Set(), names: new Map() });
      m.last = ep; m.count++; m.actors.add(e.ai);
      m.names.set(e.ni, (m.names.get(e.ni) || 0) + 1);
      m.ni = e.ni;
    }
  }
  for (const m of met.values()) {
    // The name they're credited with most often in watched episodes (latest wins a tie),
    // so a one-off credit like "NPC Dreamer" doesn't take over.
    let best = m.ni;
    for (const [ni, n] of m.names) if (n > (m.names.get(best) || 0)) best = ni;
    m.name = cleanName(charName(m.c, best));
    m.actor = [...m.actors].map(i => cast.chars[m.c].a[i]).join(' / ');
  }
  // Different versions of a character can share a name (Earth-1 and Earth-2 Barry Allen).
  // When two you've met would look the same, add the version label from the wiki.
  const seenNames = new Map();
  for (const m of met.values()) seenNames.set(m.name.toLowerCase(), (seenNames.get(m.name.toLowerCase()) || 0) + 1);
  for (const m of met.values()) {
    const q = cast.chars[m.c].q;
    if (q && seenNames.get(m.name.toLowerCase()) > 1 && !/\)$/.test(m.name)) m.name += ` (${q})`;
  }
  return met;
}

function newCharactersIn(ep) {
  if (!cast.loaded) return 0;
  return (cast.eps[ep.id] || []).filter(e => e.g <= 1 &&
    !(cast.appear.get(e.c) || []).some(n => n !== ep.n && state.watched.has(epByN(n).id))).length;
}

let charSort = 'recent';
function renderCharacters() {
  const list = $('charList'), empty = $('charEmpty');
  list.textContent = '';
  if (!cast.loaded) {
    empty.hidden = false;
    $('charEmptyText').textContent = cast.failed ? 'Character data isn’t available right now.' : 'Loading characters…';
    $('heroSub').textContent = 'Who you’ve met so far';
    return;
  }
  const met = [...metCharacters().values()];
  $('heroSub').textContent = met.length ? `${met.length.toLocaleString()} characters met so far` : 'Who you’ve met so far';
  const q = $('charSearch').value.trim().toLowerCase();
  let rows = q ? met.filter(m => `${m.name} ${m.actor}`.toLowerCase().includes(q)) : met;
  const sorters = {
    recent: (a, b) => b.first.n - a.first.n || b.count - a.count,
    first: (a, b) => a.first.n - b.first.n || b.count - a.count,
    most: (a, b) => b.count - a.count || a.first.n - b.first.n,
    az: (a, b) => a.name.localeCompare(b.name),
  };
  rows.sort(sorters[charSort]);
  empty.hidden = rows.length > 0;
  if (!rows.length) {
    $('charEmptyText').textContent = q ? `No characters match “${q}”` : 'Mark episodes as watched and the characters you meet show up here.';
    return;
  }
  list.innerHTML = rows.map(m => {
    const s = SHOW[m.first.show];
    return `<li class="ch" style="${showVars(m.first.show)}"><button class="ch-row" data-char="${m.c}">
      ${avatarHtml(m.c, m.name, { show: m.first.show })}
      <span class="ch-text">
        <span class="ch-name">${esc(m.name)}</span>
        <span class="ch-sub">${esc(m.actor)}</span>
        <span class="ch-sub">Met in ${esc(s.short)} S${m.first.s} E${m.first.e}</span>
      </span>
      <span class="ch-count"><b>${m.count}</b>${m.count === 1 ? 'episode' : 'episodes'}</span>
    </button></li>`;
  }).join('');
}
$('charList').addEventListener('click', e => {
  const b = e.target.closest('[data-char]');
  if (b) openCharacter(+b.dataset.char);
});
let charSearchTimer;
$('charSearch').addEventListener('input', () => { clearTimeout(charSearchTimer); charSearchTimer = setTimeout(renderCharacters, 120); });
$('charSort').addEventListener('click', e => {
  const b = e.target.closest('[data-sort]');
  if (!b) return;
  charSort = b.dataset.sort;
  $('charSort').querySelectorAll('[data-sort]').forEach(x => x.setAttribute('aria-pressed', x === b));
  renderCharacters();
});

// Searches the credited name, so the link itself doesn't give away who someone really is.
const wikiSearch = (name, show) =>
  `https://${show === 'stargirl' ? 'stargirl' : 'arrow'}.fandom.com/wiki/Special:Search?query=${encodeURIComponent(name.replace(/\s*\(.*\)$/, ''))}`;

const epMini = ep => {
  const s = SHOW[ep.show];
  return `<button class="ep-mini" data-ep="${ep.id}" style="${showVars(ep.show)}">
    <span class="ep-avatar"><span class="ms">${s.icon}</span></span>
    <span><span class="ep-mini-t">${esc(ep.t)}</span><span class="ep-mini-m">${esc(s.short)} · S${ep.s} E${ep.e} · ${fmtDate(ep.d)}</span></span>
  </button>`;
};

function openCharacter(c, fromEp) {
  const m = metCharacters().get(c);
  if (!m) {
    // Not met yet: show only this episode's credit, nothing about later appearances.
    const e = fromEp && (cast.eps[fromEp.id] || []).find(x => x.c === c);
    const name = e ? cleanName(charName(c, e.ni)) : 'Unknown';
    const show = fromEp ? fromEp.show : homeShow(c, 'arrow');
    openSheet(`<div class="ch-head">
        <span class="initials big">${esc(initialsOf(name))}<span class="ms badge">${SHOW[show].icon}</span></span>
        <h2>${esc(name)}</h2>
        ${e ? `<p>${esc(cast.chars[c].a[e.ai])}</p>` : ''}
      </div>
      <p class="cast-note" style="text-align:center;margin-top:16px">You haven’t met this character yet. Their appearances show up here once you’ve watched them.</p>`, showVars(show));
    return;
  }
  const s = SHOW[m.first.show];
  const seen = state.episodes.filter(ep => state.watched.has(ep.id) && (cast.eps[ep.id] || []).some(x => x.c === c && x.g <= 1)).reverse();
  openSheet(`<div class="ch-head">
      ${avatarHtml(c, m.name, { show: m.first.show, big: true })}
      <h2>${esc(m.name)}</h2>
      <p>${esc(m.actor)}</p>
      <div class="d-meta">
        <span class="d-pill"><span class="ms">visibility</span>${m.count} ${m.count === 1 ? 'episode' : 'episodes'} watched</span>
        <span class="d-pill"><span class="ms fill" style="color:var(--c)">${s.icon}</span>Met in ${esc(s.short)} S${m.first.s} E${m.first.e}</span>
      </div>
    </div>
    <div class="d-actions">
      <a class="btn big outlined" href="${wikiSearch(m.name, m.first.show)}" target="_blank" rel="noopener"><span class="ms">open_in_new</span>Look up on the wiki</a>
      <p class="cast-note" style="text-align:center">Wiki pages cover the whole series, so they can contain spoilers.</p>
    </div>
    <div class="cast"><h3>Appearances you’ve watched <small>newest first</small></h3>${seen.map(epMini).join('')}</div>`, showVars(m.first.show));
  $('sheetContent').onclick = e => {
    const b = e.target.closest('[data-ep]');
    if (b) openDetails(+b.dataset.ep);
  };
}

function castRow(e, ep) {
  const name = charName(e.c, e.ni); // as credited in this episode, title and all
  const show = homeShow(e.c, ep.show);
  const isNew = e.g <= 1 && isNewIn(e.c, ep);
  return `<button class="cast-row" data-char="${e.c}" style="${showVars(show)}">
    <span class="initials">${esc(initialsOf(name))}</span>
    <span><span class="cast-name">${esc(name)}${isNew ? '<span class="new-badge">NEW</span>' : ''}</span><span class="cast-actor">${esc(cast.chars[e.c].a[e.ai])}</span></span>
  </button>`;
}

function castHtml(ep, { reveal = false, all = false } = {}) {
  if (!cast.loaded) return cast.failed ? '' : `<div class="cast" id="castBox" data-ep="${ep.id}"><h3>Cast</h3><p class="cast-note">Loading cast…</p></div>`;
  const list = cast.eps[ep.id];
  if (!list?.length) return '';
  const named = list.filter(e => e.g <= 1);
  const fresh = named.filter(e => isNewIn(e.c, ep)).length;
  const head = `<h3>Cast <small>${named.length} characters${fresh ? ` · ${fresh} new` : ''}</small></h3>`;
  if (!state.watched.has(ep.id) && !reveal) {
    return `<div class="cast" id="castBox" data-ep="${ep.id}">${head}
      <button class="btn tonal cast-reveal" data-act="reveal"><span class="ms">visibility</span>Show cast</button>
      <p class="cast-note">Hidden until you’ve watched it, in case it spoils a surprise appearance.</p></div>`;
  }
  let html = '';
  for (const g of [0, 1]) {
    const rows = list.filter(e => e.g === g);
    if (rows.length) html += `<div class="cast-group">${GROUP_LABEL[g]}</div>${rows.map(e => castRow(e, ep)).join('')}`;
  }
  const minor = list.filter(e => e.g > 1);
  if (minor.length) {
    html += all
      ? `<div class="cast-group">Co-starring</div>${minor.map(e => castRow(e, ep)).join('')}`
      : `<button class="btn text cast-reveal" data-act="minor">Show ${minor.length} co-stars</button>`;
  }
  return `<div class="cast" id="castBox" data-ep="${ep.id}" data-reveal="1">${head}${html}</div>`;
}

/* ---------- Ratings grid ---------- */
// Eight steps of half a point: under 6, 6–6.4, …, 8.5–8.9, 9 and up.
const BINS = [6.0, 6.5, 7.0, 7.5, 8.0, 8.5, 9.0];
const binOf = r => BINS.filter(b => r >= b).length;
const heatVars = r => { const [bg, fg] = state.heat[binOf(r)]; return `--bg:${bg};--fg:${fg}`; };
const mean = xs => xs.reduce((a, b) => a + b, 0) / xs.length;

function renderRatings() {
  if (!state.heat || !state.episodes.length) return;
  const source = state.ratingSource === 'imdb' ? 'IMDb' : 'TVmaze';
  $('heroSub').textContent = `${source} ratings by season`;
  const labels = ['<6', '6', '6.5', '7', '7.5', '8', '8.5', '9+'];
  $('heatLegend').innerHTML = `<span>Low</span><span class="scale">${labels.map((l, i) =>
    `<i style="background:${state.heat[i][0]};color:${state.heat[i][1]}">${l}</i>`).join('')}</span><span>High</span>
    <span class="watched-key"><b></b>watched</span>`;

  const shows = SHOWS.filter(s => !state.settings.hidden.includes(s.key));
  $('ratingsEmpty').hidden = shows.length > 0;
  $('ratingGrids').innerHTML = shows.map(show => {
    const eps = state.episodes.filter(e => e.show === show.key);
    if (!eps.length) return '';
    const seasons = [...new Set(eps.map(e => e.s))].sort((a, b) => a - b);
    const maxE = Math.max(...eps.map(e => e.e));
    const at = {};
    for (const e of eps) (at[e.s] ||= {})[e.e] = e;
    const rated = eps.filter(e => e.r);
    const best = rated.reduce((a, b) => (b.r > (a?.r ?? -1) ? b : a), null);
    const worst = rated.reduce((a, b) => (b.r < (a?.r ?? 99) ? b : a), null);
    const cell = e => {
      if (!e) return '<span></span>';
      const label = `${show.short} S${e.s} E${e.e}, ${e.t}${e.r ? `, rated ${e.r}` : ', no rating'}${state.watched.has(e.id) ? ', watched' : ''}`;
      const w = state.watched.has(e.id) ? ' watched' : '';
      return e.r
        ? `<button class="cell${w}" data-ep="${e.id}" style="${heatVars(e.r)}" title="${esc(label)}" aria-label="${esc(label)}">${e.r.toFixed(1)}</button>`
        : `<button class="cell none${w}" data-ep="${e.id}" title="${esc(label)}" aria-label="${esc(label)}">–</button>`;
    };
    let grid = `<span></span>${seasons.map(n => `<span class="hd">S${n}</span>`).join('')}`;
    for (let n = 1; n <= maxE; n++) grid += `<span class="rl">${n}</span>${seasons.map(sn => cell(at[sn]?.[n])).join('')}`;
    grid += `<span class="gap"></span>${seasons.map(() => '<span class="gap"></span>').join('')}`;
    grid += `<span class="avg-label" title="Season average">avg</span>${seasons.map(sn => {
      const rs = Object.values(at[sn]).filter(e => e.r).map(e => e.r);
      if (!rs.length) return '<span></span>';
      const a = mean(rs);
      return `<span class="cell avg" style="${heatVars(a)}" title="Season ${sn} average: ${a.toFixed(2)}">${a.toFixed(1)}</span>`;
    }).join('')}`;
    const pill = (e, icon, text) => e ? `<button class="d-pill" data-ep="${e.id}"><span class="ms fill" style="font-size:16px">${icon}</span>${text} S${e.s} E${e.e} · ${e.r}</button>` : '';
    return `<section class="rating-card" style="${showVars(show.key)}">
      <div class="rating-head">
        <span class="ep-avatar"><span class="ms">${show.icon}</span></span>
        <div><div class="rating-name">${esc(show.name)}</div>
        <div class="rating-sub">${rated.length ? `Average ${mean(rated.map(e => e.r)).toFixed(2)} · ${rated.length} of ${eps.length} episodes rated` : 'No ratings yet'}</div></div>
      </div>
      <div class="rating-best">${pill(best, 'arrow_upward', 'Best')}${pill(worst, 'arrow_downward', 'Lowest')}</div>
      <div class="heat-scroll"><div class="heat" style="grid-template-columns: 26px repeat(${seasons.length}, minmax(34px, 1fr))">${grid}</div></div>
    </section>`;
  }).join('');
}
$('ratingGrids').addEventListener('click', e => {
  const b = e.target.closest('[data-ep]');
  if (b) openDetails(+b.dataset.ep);
});

/* ---------- Views (bottom navigation) ---------- */
const VIEWS = { episodes: ['viewEpisodes', 'Arrowverse'], ratings: ['viewRatings', 'Ratings'], characters: ['viewCharacters', 'Characters'] };
let currentView = 'episodes';
const scrollPos = { episodes: 0, ratings: 0, characters: 0 };
function setView(view, push = true) {
  if (view === currentView) { scrollTo({ top: 0, behavior: 'smooth' }); return; }
  scrollPos[currentView] = scrollY;
  currentView = view;
  for (const [v, [id]] of Object.entries(VIEWS)) $(id).hidden = v !== view;
  document.body.classList.remove('view-characters', 'view-ratings');
  if (view !== 'episodes') document.body.classList.add(`view-${view}`);
  $('bigTitle').textContent = $('smallTitle').textContent = VIEWS[view][1];
  $('heroSub').textContent = 'Every episode in watch order';
  document.querySelectorAll('#navbar [data-view]').forEach(b =>
    b.dataset.view === view ? b.setAttribute('aria-current', 'page') : b.removeAttribute('aria-current'));
  if (state.query) closeSearch();
  closeMenu();
  if (view === 'characters') renderCharacters();
  if (view === 'ratings') renderRatings();
  if (push) {
    // One history entry for "away from Episodes", so Android back always returns there.
    if (history.state?.view && history.state.view !== 'episodes') history.replaceState({ view }, '');
    else history.pushState({ view }, '');
  }
  requestAnimationFrame(() => scrollTo(0, scrollPos[view]));
}
$('navbar').addEventListener('click', e => {
  const b = e.target.closest('[data-view]');
  if (!b) return;
  if (b.dataset.view === 'episodes' && currentView !== 'episodes' && history.state?.view === currentView) history.back();
  else setView(b.dataset.view);
});

/* ---------- Boot ---------- */
async function boot() {
  applyTheme();
  renderChips();
  setupSwipe($('list'));
  try {
    const episodes = await loadEpisodes();
    state.episodes = episodes.map((ep, i) => ({ ...ep, n: i + 1 }));
    state.byId = new Map(state.episodes.map(ep => [ep.id, ep]));
    $('loading').hidden = true;
    renderList();
    applyFilters();
    updateSummary();
    if (state.watched.size > 0) $('hint').hidden = true;
    loadCharacters();
  } catch (err) {
    console.error(err);
    $('loadingText').textContent = 'Couldn’t load episodes. Check your connection and reload.';
    document.querySelector('.loader').hidden = true;
  }
}
boot();

if ('serviceWorker' in navigator && location.protocol === 'https:') {
  navigator.serviceWorker.register('sw.js').catch(() => {});
}
