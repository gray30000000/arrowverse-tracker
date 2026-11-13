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
};
const $ = id => document.getElementById(id);
const saveWatched = () => store.set(KEYS.watched, [...state.watched]);
const saveSettings = () => store.set(KEYS.settings, state.settings);
const isShown = ep => !state.settings.hidden.includes(ep.show);
const fmtDate = d => new Date(d + 'T12:00:00').toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' });
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const showVars = key => `--c:var(--s-${key});--cc:var(--s-${key}-cc);--occ:var(--s-${key}-occ)`;
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
      if (json.episodes?.length) return json.episodes;
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
      <div class="ep-avatar"><span><b>S${ep.s}</b>E${ep.e}</span></div>
      <div class="ep-text">
        <div class="ep-title">${esc(ep.t)}</div>
        <div class="ep-meta"><span class="dot"></span>${esc(show.short)} · ${fmtDate(ep.d)}</div>
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
      ${next.img ? `<img class="upnext-img" src="${esc(next.img)}" alt="" loading="lazy">` : `<div class="upnext-img">S${next.s}·E${next.e}</div>`}
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
  if (state.settings.hideWatched && value && changed.length < 4) {
    for (const id of changed) state.rows.get(id)?.classList.add('collapsing');
    setTimeout(applyFilters, 320);
  } else {
    applyFilters();
  }
  if (announce) {
    const ep = state.byId.get(changed[0]);
    const text = message || (changed.length === 1
      ? `“${ep.t}” ${value ? 'watched' : 'unmarked'}`
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
function openSheet(html, vars = '') {
  $('sheetContent').innerHTML = html;
  $('sheet').style.cssText = vars;
  $('sheet').classList.remove('closing');
  $('scrim').classList.remove('closing');
  $('sheet').hidden = $('scrim').hidden = false;
  $('sheetContent').scrollTop = 0;
  if (!sheetOpen) history.pushState({ sheet: true }, '');
  sheetOpen = true;
}
function closeSheet(fromHistory = false) {
  if (!sheetOpen) return;
  sheetOpen = false;
  $('sheet').classList.add('closing');
  $('scrim').classList.add('closing');
  setTimeout(() => { $('sheet').hidden = $('scrim').hidden = true; $('sheet').style.transform = ''; }, 230);
  if (!fromHistory && history.state?.sheet) history.back();
}
window.addEventListener('popstate', () => { closeSheet(true); closeMenu(); });
$('scrim').addEventListener('click', () => closeSheet());
document.addEventListener('keydown', e => { if (e.key === 'Escape') { closeSheet(); closeMenu(); closeDialog(); } });

// Drag the handle down to dismiss
(() => {
  let y0 = null, dy = 0;
  const sheet = $('sheet');
  $('sheetHandle').addEventListener('pointerdown', e => { y0 = e.clientY; dy = 0; sheet.classList.add('dragging'); $('sheetHandle').setPointerCapture(e.pointerId); });
  $('sheetHandle').addEventListener('pointermove', e => {
    if (y0 == null) return;
    dy = Math.max(0, e.clientY - y0);
    sheet.style.transform = `translate(-50%, ${dy}px)`;
  });
  const end = () => {
    if (y0 == null) return;
    y0 = null;
    sheet.classList.remove('dragging');
    if (dy > 100) closeSheet();
    else { sheet.style.transition = 'transform .3s cubic-bezier(.2,0,0,1)'; sheet.style.transform = ''; setTimeout(() => { sheet.style.transition = ''; }, 300); }
  };
  $('sheetHandle').addEventListener('pointerup', end);
  $('sheetHandle').addEventListener('pointercancel', end);
})();

function openDetails(id) {
  const ep = state.byId.get(id);
  if (!ep) return;
  const s = SHOW[ep.show];
  const watched = state.watched.has(id);
  const before = state.episodes.filter(x => x.n < ep.n && isShown(x) && !state.watched.has(x.id)).length;
  openSheet(`
    ${ep.img ? `<img class="d-img" src="${esc(ep.img.replace('/medium_landscape/', '/original_untouched/'))}" alt="" onerror="this.src='${esc(ep.img)}'">` : `<div class="d-noimg">S${ep.s} · E${ep.e}</div>`}
    <div class="d-show"><span class="dot"></span>${esc(s.name)}</div>
    <h2 class="d-title">${esc(ep.t)}</h2>
    <div class="d-meta">
      <span class="d-pill"><span class="ms">tag</span>S${ep.s} · E${ep.e}</span>
      <span class="d-pill"><span class="ms">calendar_today</span>${fmtDate(ep.d)}</span>
      ${ep.rt ? `<span class="d-pill"><span class="ms">schedule</span>${ep.rt} min</span>` : ''}
      ${ep.r ? `<span class="d-pill"><span class="ms fill">star</span>${ep.r}</span>` : ''}
      <span class="d-pill"><span class="ms">format_list_numbered</span>#${ep.n} in order</span>
      ${ep.x ? `<span class="d-pill x"><span class="ms">join</span>${esc(ep.x)} crossover</span>` : ''}
    </div>
    ${ep.sum ? `<p class="d-sum">${esc(ep.sum)}</p>` : ''}
    <div class="d-actions">
      <button class="btn big ${watched ? 'tonal' : 'filled'}" data-act="toggle">
        <span class="ms">${watched ? 'undo' : 'check'}</span>${watched ? 'Mark as unwatched' : 'Mark as watched'}
      </button>
      ${before ? `<button class="btn big outlined" data-act="upto"><span class="ms">done_all</span>Mark this and ${before} earlier as watched</button>` : ''}
    </div>`, showVars(ep.show));
  $('sheetContent').querySelector('[data-act=toggle]').onclick = () => { closeSheet(); setWatched([id], !watched); };
  const upto = $('sheetContent').querySelector('[data-act=upto]');
  if (upto) upto.onclick = () => {
    closeSheet();
    const ids = state.episodes.filter(x => x.n <= ep.n && isShown(x)).map(x => x.id);
    setWatched(ids, true, { message: `Caught up to “${ep.t}”` });
  };
}

function openStats() {
  const rows = SHOWS.map(s => {
    const eps = state.episodes.filter(ep => ep.show === s.key);
    const done = eps.filter(ep => state.watched.has(ep.id)).length;
    const pct = eps.length ? (done / eps.length) * 100 : 0;
    const hidden = state.settings.hidden.includes(s.key);
    return `<div class="stat-row" style="${showVars(s.key)};${hidden ? 'opacity:.55' : ''}">
      <div class="stat-name"><span class="dot"></span>${esc(s.name)}</div>
      <div class="stat-num">${done} / ${eps.length}${hidden ? ' · hidden' : ''}</div>
      <div class="bar"><i style="width:${pct}%"></i></div>
    </div>`;
  }).join('');
  openSheet(`<div class="stats"><h2>Progress by series</h2>${rows}</div>`);
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
  $('scrim').classList.remove('closing');
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
    ${SHOWS.map(s => `<button class="chip show" data-show="${s.key}" style="${showVars(s.key)}" aria-pressed="${!hidden.includes(s.key)}"><span class="dot"></span>${esc(s.short)}</button>`).join('')}`;
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
