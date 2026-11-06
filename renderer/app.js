'use strict';

const $ = (s) => document.querySelector(s);
const api = window.tubeamp;

const els = {
  shell: $('#shell'),
  videoEmpty: $('#videoEmpty'),
  time: $('#lcdTime'),
  marquee: $('#marquee'),
  title: $('#lcdTitle'),
  track: $('#lcdTrack'),
  dur: $('#lcdDur'),
  volLabel: $('#lcdVol'),
  ledShuffle: $('#ledShuffle'),
  ledRepeat: $('#ledRepeat'),
  seek: $('#seek'),
  vol: $('#vol'),
  btnPlay: $('#btnPlay'),
  btnMute: $('#btnMute'),
  btnShuffle: $('#btnShuffle'),
  btnRepeat: $('#btnRepeat'),
  repeatLabel: $('#repeatLabel'),
  btnPin: $('#btnPin'),
  url: $('#url'),
  list: $('#list'),
  count: $('#count'),
  activeName: $('#activeName'),
  btnClear: $('#btnClear'),
  loadBar: $('#loadBar'),
  field: $('#field'),
  btnLoad: $('#btnLoad'),
  btnRecent: $('#btnRecent'),
  recentMenu: $('#recentMenu'),
  volMeter: $('#volMeter'),
  btnPict: $('#btnPict'),
  btnAdd: $('#btnAdd'),
  btnSave: $('#btnSave'),
  btnColor: $('#btnColor'),
  colorCard: $('#colorCard'),
  pictColor: $('#pictColor'),
  pictLcd: $('#pictLcd'),
};

const S = {
  ready: false,
  ids: [],
  titles: {},          // videoId -> { title, author }
  bad: new Set(),      // indexes that cannot be embedded
  idx: -1,
  history: [],
  shuffle: false,
  repeat: 'off',       // off | all | one
  volume: 70,
  muted: false,
  remaining: false,
  seeking: false,
  loading: false,
  loadToken: 0,
  titleGen: 0,
  errStreak: 0,
  mode: 'list',        // list | video | mini
  pict: 'normal',      // picture: 'normal' (color) or 'lcd'
  color: 'navy',       // body finish, see FINISHES
  source: null,        // { list, v, name } of what is loaded now
  recents: [],         // up to 5 { list, v, name, count }
  savedLists: [],      // { id, name, items: [{ id, title, author }] }
  // S.source describes what is loaded:
  //   { kind: 'yt', list, v, name }        a YouTube playlist
  //   { kind: 'single', v }                one video
  //   { kind: 'custom', name, savedId, dirty }  a list built or saved here
};

let player = null;
let saved = {};
const shown = { seek: -1, time: '', dur: '', playing: null };   // last values written to the display
let prefetch = null;   // { list, promise } for the playlist restored at startup
let bootDone;
const booted = new Promise((r) => { bootDone = r; });

(() => {
  const tag = document.createElement('script');
  tag.src = 'https://www.youtube.com/iframe_api';
  tag.onerror = () => setStatus('Cannot reach YouTube. Check your connection and restart.');
  document.head.append(tag);
})();

/* ---------- helpers ---------- */

function fmt(sec) {
  if (!isFinite(sec) || sec < 0) sec = 0;
  sec = Math.floor(sec);
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = String(sec % 60).padStart(2, '0');
  return h ? `${h}:${String(m).padStart(2, '0')}:${s}` : `${m}:${s}`;
}

function paintRange(input) {
  const pct = ((input.value - input.min) / (input.max - input.min)) * 100;
  input.style.setProperty('--p', pct + '%');
}

function debounce(fn, ms) {
  let t;
  return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); };
}

const save = debounce(() => {
  api.setSettings({
    lastSource: !S.source ? (saved.lastSource || null)
      : S.source.kind === 'custom' ? null
      : { list: S.source.list || null, v: S.source.v || null },
    custom: S.source && S.source.kind === 'custom'
      ? { name: S.source.name, savedId: S.source.savedId, dirty: S.source.dirty, items: queueItems() }
      : null,
    recents: S.recents,
    lists: S.savedLists,
    mode: S.mode,
    pict: S.pict,
    color: S.color,
    lastIndex: S.idx >= 0 ? S.idx : (saved.lastIndex || 0),
    volume: S.volume,
    shuffle: S.shuffle,
    repeat: S.repeat,
  });
}, 400);

function parseInput(str) {
  str = (str || '').trim();
  if (!str) return null;
  try {
    const u = new URL(str);
    const list = u.searchParams.get('list');
    let v = u.searchParams.get('v');
    if (!v && u.hostname.endsWith('youtu.be')) v = u.pathname.slice(1, 12);
    if (!v) {
      const m = u.pathname.match(/\/(?:shorts|embed|live)\/([\w-]{11})/);
      if (m) v = m[1];
    }
    if (list) return { list, v: v || null };
    if (v) return { v };
  } catch {
    // not a URL, fall through to raw ids
  }
  if (/^(PL|OL|RD|UU|FL|LL|OLAK)[\w-]{10,}$/.test(str)) return { list: str };
  if (/^[\w-]{11}$/.test(str)) return { v: str };
  return null;
}

/* ---------- LCD ---------- */

function setTitle(text) {
  if (els.title.dataset.text === text) return;
  els.title.dataset.text = text;
  els.marquee.classList.remove('scroll');
  els.title.textContent = text;
  requestAnimationFrame(() => {
    if (els.title.scrollWidth <= els.marquee.clientWidth + 2) return;
    els.title.textContent = '';
    const a = document.createElement('span');
    a.textContent = text + '\u2003\u2003\u2003';
    els.title.append(a, a.cloneNode(true));
    els.marquee.style.setProperty('--dur', Math.max(8, a.offsetWidth / 32) + 's');
    els.marquee.classList.add('scroll');
  });
}

function refreshTitle() {
  const t = els.title.dataset.text || '';
  els.title.dataset.text = '';
  setTitle(t);
}

function setStatus(text) { setTitle(text); }

function updateNowPlaying() {
  if (S.idx < 0 || !S.ids.length) return;
  const id = S.ids[S.idx];
  const meta = S.titles[id];
  const title = (meta && meta.title) || 'Loading title\u2026';
  setTitle(`${S.idx + 1}. ${title}`);
  els.track.textContent = `${S.idx + 1}/${S.ids.length}`;
  document.title = meta && meta.title ? `${meta.title} | Tubeamp` : 'Tubeamp';
}

function updateFlags() {
  els.ledShuffle.classList.toggle('on', S.shuffle);
  els.btnShuffle.classList.toggle('on', S.shuffle);
  const rep = S.repeat !== 'off';
  els.ledRepeat.classList.toggle('on', rep);
  els.ledRepeat.textContent = S.repeat === 'one' ? 'RPT1' : 'RPT';
  els.btnRepeat.classList.toggle('on', rep);
  els.repeatLabel.textContent = S.repeat === 'one' ? 'Repeat one' : S.repeat === 'all' ? 'Repeat all' : 'Repeat';
}

// Ten-segment volume bar on the LCD.
function paintVolMeter() {
  if (!els.volMeter.children.length) {
    for (let i = 0; i < 10; i++) {
      const b = document.createElement('i');
      b.style.height = (3 + i * 0.9) + 'px';
      els.volMeter.append(b);
    }
  }
  const lit = S.muted ? 0 : Math.ceil(S.volume / 10);
  [...els.volMeter.children].forEach((b, i) => b.classList.toggle('on', i < lit));
}

function updatePlayButton() {
  if (!player || !S.ready) return;
  const st = player.getPlayerState();
  const playing = st === YT.PlayerState.PLAYING || st === YT.PlayerState.BUFFERING;
  if (playing === shown.playing) return;
  shown.playing = playing;
  els.btnPlay.classList.toggle('playing', playing);
  els.btnPlay.setAttribute('aria-label', playing ? 'Pause' : 'Play');
}

/* ---------- playlist UI ---------- */

function renderList() {
  els.list.textContent = '';
  if (!S.ids.length) {
    const li = document.createElement('li');
    li.className = 'empty';
    li.textContent = S.source && S.source.kind === 'custom'
      ? 'Press LOAD, paste a video link and press ADD to build this list.'
      : 'Press LOAD below and paste a YouTube playlist link.';
    els.list.append(li);
    els.count.textContent = '';
    updateActiveName();
    return;
  }
  const frag = document.createDocumentFragment();
  S.ids.forEach((id, i) => {
    const li = document.createElement('li');
    li.dataset.i = i;
    li.dataset.id = id;
    li.tabIndex = -1;
    const n = document.createElement('span');
    n.className = 'n';
    n.textContent = i + 1;
    const t = document.createElement('span');
    t.className = 't';
    const x = document.createElement('button');
    x.className = 'x';
    x.tabIndex = -1;
    x.title = 'Remove from list (Delete)';
    x.setAttribute('aria-label', 'Remove from list');
    x.textContent = '\u00d7';
    li.append(n, t, x);
    fillRow(li);
    frag.append(li);
  });
  els.list.append(frag);
  els.count.textContent = `${S.ids.length} ${S.ids.length === 1 ? 'track' : 'tracks'}`;
  updateActiveName();
  if (S.idx >= 0) markCurrent();
}

function updateActiveName() {
  let name = '';
  const src = S.source;
  if (src && src.kind === 'yt') name = src.name || 'Untitled playlist';
  else if (src && src.kind === 'custom') name = src.name || 'New list';
  else if (src && S.ids.length) {
    const meta = S.titles[S.ids[0]];
    name = (meta && meta.title) || 'Single video';
  }
  if (!els.activeName.querySelector('input')) {
    els.activeName.textContent = name;
    els.activeName.title = name;
  }
  updateSaveTag();
}

// SAVE when there is something unsaved, SAVED when this exact list is stored.
function updateSaveTag() {
  const src = S.source;
  const clean = src && src.kind === 'custom' && src.savedId && !src.dirty;
  els.btnSave.hidden = !S.ids.length;
  els.btnSave.textContent = clean ? 'SAVED' : 'SAVE';
  els.btnSave.classList.toggle('clean', !!clean);
  els.btnSave.title = clean ? 'Saved. Click to rename' : 'Save this list';
}

function fillRow(li) {
  const meta = S.titles[li.dataset.id];
  const t = li.querySelector('.t');
  t.textContent = '';
  if (meta && meta.title) {
    t.append(meta.title);
    if (meta.author) {
      const a = document.createElement('span');
      a.className = 'a';
      a.textContent = meta.author;
      t.append(a);
    }
  } else {
    t.append(meta ? 'Untitled video' : 'Loading\u2026');
  }
}

function refreshRows(id) {
  els.list.querySelectorAll(`li[data-id="${CSS.escape(id)}"]`).forEach(fillRow);
  if (S.ids[S.idx] === id) updateNowPlaying();
  if (S.source && S.source.kind === 'single') updateActiveName();
}

function rowAt(i) { return S.ids.length ? els.list.children[i] || null : null; }

function markCurrent() {
  const prevLi = els.list.querySelector('li.current');
  if (prevLi) prevLi.classList.remove('current');
  const li = rowAt(S.idx);
  if (li) {
    li.classList.add('current');
    li.scrollIntoView({ block: 'nearest' });
  }
}

function select(i) {
  els.list.querySelectorAll('li.sel').forEach((li) => li.classList.remove('sel'));
  const li = rowAt(i);
  if (li) {
    li.classList.add('sel');
    li.focus({ preventScroll: true });
    li.scrollIntoView({ block: 'nearest' });
  }
}

async function fetchTitles() {
  const gen = ++S.titleGen;
  const queue = [...new Set(S.ids)].filter((id) => !S.titles[id]);
  const worker = async () => {
    while (queue.length && gen === S.titleGen) {
      const id = queue.shift();
      const meta = await api.oembed(id).catch(() => null);
      if (gen !== S.titleGen) return;
      if (!S.titles[id] || !S.titles[id].title) S.titles[id] = meta || { title: null };
      refreshRows(id);
    }
  };
  await Promise.all([worker(), worker(), worker(), worker()]);
}

/* ---------- loading ---------- */

function waitForPlaylist(token, maxTries) {
  return new Promise((resolve) => {
    let tries = 0;
    const t = setInterval(() => {
      if (token !== S.loadToken) { clearInterval(t); resolve(null); return; }
      const p = player.getPlaylist && player.getPlaylist();
      if (p && p.length) { clearInterval(t); resolve(p.slice()); }
      else if (++tries > maxTries) { clearInterval(t); resolve(null); }
    }, 250);
  });
}

// Backup path: ask the embedded player. Some player versions only report the
// list once playback starts, so if a quiet cue returns nothing, start it and pause.
async function idsFromPlayer(src, token) {
  player.cuePlaylist({ listType: 'playlist', list: src.list });
  let ids = await waitForPlaylist(token, 20);
  if (ids || token !== S.loadToken) return ids;
  player.mute();
  player.loadPlaylist({ listType: 'playlist', list: src.list });
  ids = await waitForPlaylist(token, 40);
  player.pauseVideo();
  if (!S.muted) player.unMute();
  return ids;
}

async function loadSource(src, { autoplay = true, startIndex = 0 } = {}) {
  if (!S.ready || !src) return false;
  const token = ++S.loadToken;

  if (!src.list) {
    S.source = { kind: 'single', v: src.v };
    setQueue([src.v], 0, autoplay);
    return true;
  }

  S.loading = true;
  setStatus('Loading playlist\u2026');

  let ids = null;
  let name = null;
  const pending = prefetch && prefetch.list === src.list ? prefetch.promise : null;
  prefetch = null;
  const page = await (pending || api.playlist(src.list, src.v).catch(() => null));
  if (token !== S.loadToken) return false;
  if (page && page.items && page.items.length) {
    ids = page.items.map((x) => x.id);
    name = page.name || null;
    for (const x of page.items) {
      if (x.title) S.titles[x.id] = { title: x.title, author: x.author || null };
    }
  } else {
    ids = await idsFromPlayer(src, token);
    if (token !== S.loadToken) return false;
  }
  S.loading = false;

  if (!ids || !ids.length) {
    setStatus('Playlist not found. It may be private or deleted.');
    return false;
  }
  let start = startIndex;
  if (src.v && ids.includes(src.v)) start = ids.indexOf(src.v);
  if (start < 0 || start >= ids.length) start = 0;

  // Keep the name a recent entry already has if this load could not find one.
  const known = S.recents.find((r) => r.list === src.list);
  name = name || (known && known.name) || null;
  const v = src.list.startsWith('RD') ? src.v || null : null;
  S.source = { kind: 'yt', list: src.list, v, name };
  addRecent({ list: src.list, v, name: name || 'Untitled playlist', count: ids.length });
  setQueue(ids, start, autoplay);
  return true;
}

/* ---------- recent playlists ---------- */

function addRecent(entry) {
  S.recents = [entry, ...S.recents.filter((r) => r.list !== entry.list)].slice(0, 5);
  save();
}

function menuLabel(text) {
  const d = document.createElement('div');
  d.className = 'menu-label';
  d.textContent = text;
  return d;
}

function menuEntry(name, count, active, onPick) {
  const b = document.createElement('button');
  b.setAttribute('role', 'menuitem');
  b.className = 'pick';
  b.title = name;
  if (active) b.classList.add('active');
  const n = document.createElement('span');
  n.className = 'rn';
  n.textContent = name;
  const c = document.createElement('span');
  c.className = 'rc';
  c.textContent = `${count} ${count === 1 ? 'track' : 'tracks'}`;
  b.append(n, c);
  b.addEventListener('click', () => { closeRecent(false); onPick(); });
  return b;
}

function renderRecent() {
  els.recentMenu.textContent = '';
  const nb = document.createElement('button');
  nb.setAttribute('role', 'menuitem');
  nb.className = 'pick new-list';
  nb.innerHTML = '<span class="rn">+ New list</span>';
  nb.addEventListener('click', () => { closeRecent(false); newList(); });
  els.recentMenu.append(nb);

  if (S.savedLists.length) {
    els.recentMenu.append(menuLabel('Saved'));
    for (const l of S.savedLists) {
      const row = document.createElement('div');
      row.className = 'mrow';
      const active = S.source && S.source.kind === 'custom' && S.source.savedId === l.id;
      row.append(menuEntry(l.name, l.items.length, active, () => loadSaved(l.id)));
      // two-step delete: the first click arms it, the second deletes
      const del = document.createElement('button');
      del.className = 'del';
      del.title = 'Delete this saved list';
      del.setAttribute('aria-label', `Delete ${l.name}`);
      del.textContent = '\u00d7';
      del.addEventListener('click', (e) => {
        e.stopPropagation();
        if (!del.classList.contains('armed')) {
          del.classList.add('armed');
          del.textContent = 'DELETE?';
          return;
        }
        deleteSaved(l.id);
        renderRecent();
        const first = els.recentMenu.querySelector('button');
        if (first) first.focus();
      });
      row.append(del);
      els.recentMenu.append(row);
    }
  }

  if (S.recents.length) {
    els.recentMenu.append(menuLabel('Recent playlists'));
    for (const r of S.recents) {
      const active = S.source && S.source.kind === 'yt' && S.source.list === r.list;
      els.recentMenu.append(menuEntry(r.name, r.count, active, () => loadSource({ list: r.list, v: r.v || null })));
    }
  }
}

function openRecent() {
  renderRecent();
  els.recentMenu.hidden = false;
  els.btnRecent.setAttribute('aria-expanded', 'true');
  const first = els.recentMenu.querySelector('button');
  if (first) first.focus();
}

function closeRecent(refocus = true) {
  if (els.recentMenu.hidden) return;
  els.recentMenu.hidden = true;
  els.btnRecent.setAttribute('aria-expanded', 'false');
  if (refocus) els.btnRecent.focus();
}

function moveRecentFocus(step) {
  const items = [...els.recentMenu.querySelectorAll('button')];
  if (!items.length) return;
  const i = items.indexOf(document.activeElement);
  items[(i + step + items.length) % items.length].focus();
}

/* ---------- your own lists ---------- */

function queueItems() {
  return S.ids.map((id) => {
    const m = S.titles[id] || {};
    return { id, title: m.title || null, author: m.author || null };
  });
}

// Editing a YouTube playlist or a single video turns it into your own list.
function makeCustom() {
  const src = S.source;
  if (src && src.kind === 'custom') return;
  let name = 'New list';
  if (src && src.kind === 'yt') name = src.name || 'Untitled playlist';
  else if (src && src.kind === 'single') {
    const m = S.titles[S.ids[0]];
    name = (m && m.title) || 'New list';
  }
  S.source = { kind: 'custom', name, savedId: null, dirty: true };
}

function markDirty() {
  if (S.source && S.source.kind === 'custom') S.source.dirty = true;
  updateSaveTag();
  save();
}

function clearQueue() {
  S.ids = [];
  S.idx = -1;
  S.bad = new Set();
  S.history = [];
  if (S.ready) player.stopVideo();
  els.videoEmpty.hidden = false;
  els.track.textContent = '--/--';
}

function newList() {
  S.source = { kind: 'custom', name: 'New list', savedId: null, dirty: false };
  clearQueue();
  renderList();
  setTitle('NEW LIST');
  openLoad();
  save();
}

function loadCustom(l, { autoplay = true, startIndex = 0 } = {}) {
  const items = Array.isArray(l.items) ? l.items.filter((x) => x && x.id) : [];
  for (const x of items) if (x.title && !S.titles[x.id]) S.titles[x.id] = { title: x.title, author: x.author || null };
  S.source = { kind: 'custom', name: l.name || 'New list', savedId: l.savedId || null, dirty: !!l.dirty };
  if (!items.length) {
    clearQueue();
    renderList();
    setTitle(S.source.name.toUpperCase());
    return;
  }
  const start = startIndex >= 0 && startIndex < items.length ? startIndex : 0;
  setQueue(items.map((x) => x.id), start, autoplay);
}

function loadSaved(id) {
  const l = S.savedLists.find((x) => x.id === id);
  if (!l) return;
  loadCustom({ name: l.name, savedId: l.id, dirty: false, items: l.items });
  save();
}

function deleteSaved(id) {
  S.savedLists = S.savedLists.filter((x) => x.id !== id);
  if (S.source && S.source.kind === 'custom' && S.source.savedId === id) {
    S.source.savedId = null;
    S.source.dirty = true;
  }
  updateSaveTag();
  save();
}

async function addFromInput() {
  const src = parseInput(els.url.value);
  if (!src) {
    setStatus('That is not a YouTube playlist or video link.');
    return;
  }
  let items = [];
  if (src.list) {
    flashLCD('ADDING\u2026');
    const page = await api.playlist(src.list, src.v).catch(() => null);
    if (!page || !page.items || !page.items.length) {
      flashLCD('PLAYLIST NOT FOUND');
      return;
    }
    items = page.items;
  } else {
    items = [{ id: src.v }];
  }
  for (const x of items) if (x.title && !S.titles[x.id]) S.titles[x.id] = { title: x.title, author: x.author || null };

  // a single video already in the list is skipped; a playlist adds everything
  if (!src.list && S.ids.includes(src.v)) {
    flashLCD('ALREADY IN LIST');
    els.url.value = '';
    updateClear();
    return;
  }
  const wasEmpty = !S.ids.length;
  makeCustom();
  S.ids = S.ids.concat(items.map((x) => x.id));
  els.url.value = '';
  updateClear();
  if (wasEmpty) {
    setQueue(S.ids, 0, true);
  } else {
    renderList();
    fetchTitles();
    els.track.textContent = `${S.idx + 1}/${S.ids.length}`;
  }
  flashLCD(`ADDED ${items.length} ${items.length === 1 ? 'TRACK' : 'TRACKS'}`);
  els.url.focus();
  markDirty();
}

function removeAt(i) {
  if (i < 0 || i >= S.ids.length) return;
  makeCustom();
  const st = S.ready ? player.getPlayerState() : -1;
  const wasPlaying = st === YT.PlayerState.PLAYING || st === YT.PlayerState.BUFFERING;
  S.ids.splice(i, 1);
  S.bad = new Set([...S.bad].filter((b) => b !== i).map((b) => (b > i ? b - 1 : b)));
  S.history = [];
  if (!S.ids.length) {
    clearQueue();
    renderList();
    setTitle((S.source.name || 'NEW LIST').toUpperCase());
  } else if (i < S.idx) {
    S.idx -= 1;
    renderList();
  } else if (i === S.idx) {
    S.idx = -1;
    renderList();
    playIndex(Math.min(i, S.ids.length - 1), wasPlaying);
  } else {
    renderList();
  }
  updateNowPlaying();
  select(Math.min(i, S.ids.length - 1));
  markDirty();
}

// SAVE turns the list name into an editable field; Enter stores the list.
function startSaving() {
  if (!S.ids.length || els.activeName.querySelector('input')) return;
  const input = document.createElement('input');
  input.className = 'name-edit';
  input.maxLength = 60;
  input.spellcheck = false;
  input.value = els.activeName.textContent || 'New list';
  els.activeName.textContent = '';
  els.activeName.append(input);
  els.btnSave.textContent = 'OK';
  input.focus();
  input.select();
  let done = false;
  const finish = (commit) => {
    if (done) return;
    done = true;
    const name = input.value.trim();
    input.remove();
    if (commit && name) commitSave(name);
    updateActiveName();
  };
  input.addEventListener('keydown', (e) => {
    e.stopPropagation();
    if (e.key === 'Enter') { e.preventDefault(); finish(true); }
    else if (e.key === 'Escape') { e.preventDefault(); finish(false); }
  });
  input.addEventListener('blur', () => finish(false));
  // pressing the tag again while naming confirms
  els.btnSave.onmousedown = (e) => { e.preventDefault(); finish(true); els.btnSave.onmousedown = null; };
}

function commitSave(name) {
  makeCustom();
  const items = queueItems();
  const existing = S.source.savedId && S.savedLists.find((x) => x.id === S.source.savedId);
  if (existing) {
    existing.name = name;
    existing.items = items;
  } else {
    const id = 's' + Date.now().toString(36);
    S.savedLists.unshift({ id, name, items });
    S.savedLists = S.savedLists.slice(0, 50);
    S.source.savedId = id;
  }
  S.source.name = name;
  S.source.dirty = false;
  flashLCD('SAVED');
  updateActiveName();
  save();
}

/* ---------- load field ---------- */

function updateClear() {
  els.btnClear.hidden = !els.url.value;
}

function openLoad() {
  if (S.mode !== 'list') setMode('list');
  els.loadBar.classList.add('open');
  els.field.inert = false;
  els.btnLoad.setAttribute('aria-expanded', 'true');
  els.url.placeholder = S.source && S.source.kind === 'custom'
    ? 'Paste a video link, Enter adds it'
    : 'Paste a YouTube playlist or video link';
  els.url.focus();
  els.url.select();
}

function closeLoad() {
  els.loadBar.classList.remove('open');
  els.field.inert = true;
  els.btnLoad.setAttribute('aria-expanded', 'false');
  if (document.activeElement === els.url) els.url.blur();
}

// LOAD opens the field; pressed again it loads what is there, or closes if empty.
function pressLoad() {
  if (!els.loadBar.classList.contains('open')) openLoad();
  else if (els.url.value.trim()) loadFromInput();
  else closeLoad();
}

function setQueue(ids, start, autoplay) {
  S.ids = ids;
  S.bad = new Set();
  S.history = [];
  S.errStreak = 0;
  S.idx = -1;
  S.loading = false;
  els.videoEmpty.hidden = true;
  renderList();
  fetchTitles();
  playIndex(start, autoplay);
}

async function loadFromInput() {
  const src = parseInput(els.url.value);
  if (!src) {
    setStatus('That is not a YouTube playlist or video link.');
    return;
  }
  const ok = await loadSource(src);
  if (ok) {
    els.url.value = '';
    updateClear();
    closeLoad();
  }
  save();
}

/* ---------- playback ---------- */

function playIndex(i, autoplay = true) {
  if (i < 0 || i >= S.ids.length) return;
  S.idx = i;
  const id = S.ids[i];
  if (autoplay) {
    player.loadVideoById(id);
  } else {
    player.cueVideoById(id);
  }
  markCurrent();
  updateNowPlaying();
  save();
}

function pickNext(wrap) {
  const n = S.ids.length;
  const ok = (i) => !S.bad.has(i);
  if (S.shuffle) {
    const pool = [];
    for (let i = 0; i < n; i++) if (ok(i) && (i !== S.idx || n === 1)) pool.push(i);
    return pool.length ? pool[Math.floor(Math.random() * pool.length)] : -1;
  }
  for (let k = 1; k <= n; k++) {
    let i = S.idx + k;
    if (i >= n) {
      if (!wrap) return -1;
      i %= n;
    }
    if (ok(i)) return i;
  }
  return -1;
}

function next({ auto = false, skip = false } = {}) {
  if (!S.ids.length) return;
  if (auto && !skip && S.repeat === 'one') {
    player.seekTo(0, true);
    player.playVideo();
    return;
  }
  const i = pickNext(!auto || S.repeat !== 'off');
  if (i < 0) {
    player.pauseVideo();
    player.seekTo(0, true);
    setStatus('End of playlist');
    return;
  }
  if (S.idx >= 0) S.history.push(S.idx);
  if (S.history.length > 300) S.history.shift();
  playIndex(i);
}

function prev() {
  if (!S.ids.length) return;
  if ((player.getCurrentTime() || 0) > 3) {
    player.seekTo(0, true);
    return;
  }
  let i = -1;
  while (S.history.length) {
    const h = S.history.pop();
    if (h < S.ids.length && !S.bad.has(h)) { i = h; break; }
  }
  if (i < 0) {
    const n = S.ids.length;
    for (let k = 1; k <= n; k++) {
      const j = (((S.idx - k) % n) + n) % n;
      if (!S.bad.has(j)) { i = j; break; }
    }
  }
  if (i >= 0) playIndex(i);
}

function togglePlay() {
  if (!S.ready) return;
  if (!S.ids.length) { openLoad(); return; }
  const st = player.getPlayerState();
  if (st === YT.PlayerState.PLAYING || st === YT.PlayerState.BUFFERING) player.pauseVideo();
  else if (S.idx < 0) playIndex(0);
  else player.playVideo();
}

function stop() {
  if (!S.ready || S.idx < 0) return;
  player.pauseVideo();
  player.seekTo(0, true);
}

function seekBy(sec) {
  if (!S.ready || S.idx < 0) return;
  const t = (player.getCurrentTime() || 0) + sec;
  player.seekTo(Math.max(0, t), true);
}

function setVolume(v) {
  S.volume = Math.max(0, Math.min(100, Math.round(v)));
  els.vol.value = S.volume;
  paintRange(els.vol);
  els.volLabel.textContent = S.muted ? 'MUTE' : `VOL ${S.volume}`;
  paintVolMeter();
  if (player && S.ready) {
    player.setVolume(S.volume);
    if (S.muted && S.volume > 0) setMuted(false);
  }
  save();
}

function setMuted(m) {
  S.muted = m;
  if (player && S.ready) (m ? player.mute() : player.unMute());
  els.btnMute.classList.toggle('muted', m);
  els.volLabel.textContent = m ? 'MUTE' : `VOL ${S.volume}`;
  paintVolMeter();
}

/* ---------- picture modes ---------- */

let flashTimer = 0;

// Show a short message on the LCD, then go back to the track title.
function flashLCD(text) {
  setTitle(text);
  clearTimeout(flashTimer);
  flashTimer = setTimeout(() => {
    if (S.idx >= 0) updateNowPlaying();
    else setTitle('NO DISC');
  }, 1600);
}

// Picture: full color, or tinted like the device's own LCD.
function setPict(p, announce = false) {
  p = p === 'lcd' ? 'lcd' : 'normal';
  S.pict = p;
  const lcd = p === 'lcd';
  if (lcd) document.body.dataset.pict = 'lcd';
  else delete document.body.dataset.pict;
  els.btnPict.classList.toggle('on', lcd);
  els.btnPict.setAttribute('aria-checked', String(lcd));
  els.btnPict.title = lcd ? 'Picture: LCD (V)' : 'Picture: color (V)';
  els.pictColor.classList.toggle('lit', !lcd);
  els.pictLcd.classList.toggle('lit', lcd);
  if (announce) flashLCD(lcd ? 'PICT LCD' : 'PICT COLOR');
  save();
}

function cyclePict() { setPict(S.pict === 'lcd' ? 'normal' : 'lcd', true); }

/* ---------- body colour ----------
   One table drives everything: the stylesheet reads these as --m-* variables,
   and the swatches, LED and every coloured part follow. */

const FINISHES = [
  // anodised metals
  { id: 'navy', name: 'Navy', kind: 'metal',
    top: '#4250a0', c1: '#2d3976', c2: '#242e66', c3: '#182050', deep: '#0d1233', pit: '#03051a',
    lit: '#34418a', sheen: '#6d7bc4', spec: '#6d80dc', edge: '#0a0e26', silk: '#c4cbec', dim: '#7d88bd' },
  { id: 'champagne', name: 'Champagne', kind: 'metal',
    top: '#efe2c0', c1: '#dccb9f', c2: '#cbb68a', c3: '#ae9868', deep: '#5a4a2a', pit: '#2a2213',
    lit: '#e3d3a8', sheen: '#fff6dc', spec: '#fff4d6', edge: '#3d311b', silk: '#4b3d22', dim: '#7f6c48' },
  { id: 'crimson', name: 'Crimson', kind: 'metal',
    top: '#c0384f', c1: '#9a2238', c2: '#84192f', c3: '#5e1022', deep: '#31060f', pit: '#170206',
    lit: '#a93049', sheen: '#e8899a', spec: '#f0798e', edge: '#1e0409', silk: '#f5d3d9', dim: '#c98a95' },
  { id: 'graphite', name: 'Graphite', kind: 'metal',
    top: '#74787f', c1: '#585c63', c2: '#484b51', c3: '#313338', deep: '#18191c', pit: '#09090b',
    lit: '#63676e', sheen: '#b0b4bb', spec: '#b4b8bf', edge: '#0b0c0e', silk: '#e1e3e7', dim: '#9a9ea6' },
  { id: 'violet', name: 'Violet', kind: 'metal',
    top: '#7458bd', c1: '#5a3f9c', c2: '#4c3486', c3: '#352464', deep: '#1b1135', pit: '#0b0618',
    lit: '#6449ab', sheen: '#b29ced', spec: '#ab93ee', edge: '#10091f', silk: '#e2d9f7', dim: '#a594cf' },
  { id: 'ice', name: 'Ice Blue', kind: 'metal',
    top: '#6cc3d4', c1: '#44a1b5', c2: '#348b9f', c3: '#22687a', deep: '#0f3a46', pit: '#051a20',
    lit: '#57b2c5', sheen: '#b6ecf5', spec: '#b2eef8', edge: '#072128', silk: '#e6f8fb', dim: '#a4d6e0' },
  // plastics
  { id: 'beige', name: 'Beige', kind: 'plastic',
    top: '#ede6d3', c1: '#e2d9c2', c2: '#d6ccb1', c3: '#c2b698', deep: '#5f5747', pit: '#2f2a21',
    lit: '#e4dcc7', sheen: '#fffaf0', spec: '#f6efe0', edge: '#6d6553', silk: '#554d3e', dim: '#8a806c' },
  { id: 'ivory', name: 'Ivory', kind: 'plastic',
    top: '#fbfaf6', c1: '#f2efe7', c2: '#e8e4da', c3: '#d3cec1', deep: '#5b5850', pit: '#2c2a26',
    lit: '#f4f1ea', sheen: '#ffffff', spec: '#ffffff', edge: '#8e897d', silk: '#57534b', dim: '#938e83' },
  { id: 'atomic', name: 'Atomic Purple', kind: 'plastic',
    top: 'rgba(160,120,230,.86)', c1: 'rgba(128,88,206,.82)', c2: 'rgba(112,72,190,.8)', c3: 'rgba(88,52,162,.86)',
    deep: '#24143f', pit: '#120a22', lit: 'rgba(150,110,225,.85)', sheen: '#dccbff', spec: '#cdb7ff',
    edge: 'rgba(45,22,90,.9)', silk: '#f1e9ff', dim: '#c6b3ea' },
];
const FINISH_VARS = { top: '--m-top', c1: '--m-1', c2: '--m-2', c3: '--m-3', deep: '--m-deep', pit: '--m-pit',
  lit: '--m-lit', sheen: '--m-sheen', spec: '--m-spec', edge: '--edge', silk: '--silk', dim: '--silk-dim' };

function swatchOf(f) { return `linear-gradient(180deg, ${f.top} 0%, ${f.c1} 45%, ${f.c3} 100%)`; }

function setColor(id) {
  const f = FINISHES.find((x) => x.id === id) || FINISHES[0];
  S.color = f.id;
  const st = document.documentElement.style;
  for (const [k, v] of Object.entries(FINISH_VARS)) st.setProperty(v, f[k]);
  document.body.dataset.finish = f.kind;
  els.btnColor.title = `Body colour: ${f.name}`;
  els.colorCard.querySelectorAll('.chip').forEach((ch) => ch.classList.toggle('on', ch.dataset.id === f.id));
  save();
}

function buildColorCard() {
  for (const f of FINISHES) {
    const b = document.createElement('button');
    b.className = `chip ${f.kind}`;
    b.dataset.id = f.id;
    b.title = f.name;
    const sw = document.createElement('span');
    sw.className = 'sw';
    sw.style.background = swatchOf(f);
    const nm = document.createElement('span');
    nm.className = 'nm';
    nm.textContent = f.name;
    b.append(sw, nm);
    b.addEventListener('click', () => setColor(f.id));
    $(f.kind === 'metal' ? '#chipsMetal' : '#chipsPlastic').append(b);
  }
}

function openColorCard() {
  els.colorCard.hidden = false;
  els.btnColor.setAttribute('aria-expanded', 'true');
  const on = els.colorCard.querySelector('.chip.on') || els.colorCard.querySelector('.chip');
  if (on) on.focus();
}

function closeColorCard(refocus = false) {
  if (els.colorCard.hidden) return;
  els.colorCard.hidden = true;
  els.btnColor.setAttribute('aria-expanded', 'false');
  if (refocus) els.btnColor.focus();
}

function toggleShuffle() { S.shuffle = !S.shuffle; updateFlags(); save(); }

function cycleRepeat() {
  S.repeat = S.repeat === 'off' ? 'all' : S.repeat === 'all' ? 'one' : 'off';
  updateFlags();
  save();
}

/* ---------- YouTube player ---------- */

window.onYouTubeIframeAPIReady = () => {
  player = new YT.Player('video', {
    width: '100%',
    height: '100%',
    playerVars: {
      controls: 0,
      disablekb: 1,
      rel: 0,
      playsinline: 1,
      iv_load_policy: 3,
      fs: 0,
      origin: location.origin,
    },
    events: { onReady, onStateChange, onError, onApiChange: disableCaptions },
  });
};

function disableCaptions() {
  // Caption preferences can be restored when the module loads for each video.
  // Only unload an active module, since unloading also fires onApiChange.
  if (player && typeof player.unloadModule === 'function' &&
      typeof player.getOptions === 'function' &&
      player.getOptions().includes('captions')) {
    player.unloadModule('captions');
  }
}

async function onReady() {
  await booted;
  try {
    if (!await api.prepareVideo()) throw new Error('Embed preparation was rejected');
    player.getIframe().classList.add('embed-ready');
  } catch (err) {
    console.error('Could not prepare YouTube embed:', err);
    setStatus('Could not prepare video. Close Tubeamp and restart.');
    return;
  }
  S.ready = true;
  disableCaptions();
  player.setVolume(S.volume);
  if (S.muted) player.mute();
  const last = saved.lastSource || (saved.lastUrl ? parseInput(saved.lastUrl) : null);
  if (saved.custom) {
    loadCustom(saved.custom, { autoplay: false, startIndex: saved.lastIndex || 0 });
  } else if (last && (last.list || last.v)) {
    loadSource(last, { autoplay: false, startIndex: saved.lastIndex || 0 });
  } else {
    setStatus('No playlist loaded');
  }
}

function onStateChange(e) {
  const st = e.data;
  if (S.loading) return;
  if (st === YT.PlayerState.PLAYING) {
    S.errStreak = 0;
    const id = S.ids[S.idx];
    const vd = player.getVideoData && player.getVideoData();
    if (id && vd && vd.title && !(S.titles[id] && S.titles[id].title)) {
      S.titles[id] = { title: vd.title, author: vd.author || null };
      refreshRows(id);
    }
    updateNowPlaying();
  } else if (st === YT.PlayerState.ENDED) {
    next({ auto: true });
  }
  updatePlayButton();
}

function onError() {
  if (S.loading || S.idx < 0) return;
  S.bad.add(S.idx);
  const li = rowAt(S.idx);
  if (li) li.classList.add('bad');
  S.errStreak++;
  if (S.errStreak >= S.ids.length || S.bad.size >= S.ids.length) {
    setStatus('None of these videos allow playback outside YouTube.');
    return;
  }
  setStatus(`${S.idx + 1}. Not playable here, skipping`);
  setTimeout(() => next({ auto: true, skip: true }), 600);
}

/* ---------- tick ----------
   Runs 4x a second but only writes to the page when a value actually changed,
   and does nothing while the window is minimized or hidden. */


setInterval(() => {
  if (document.hidden || !S.ready || S.idx < 0 || !player.getCurrentTime) return;
  const t = player.getCurrentTime() || 0;
  const d = player.getDuration() || 0;
  if (!S.seeking) {
    const v = d ? Math.round((t / d) * 1000) : 0;
    if (v !== shown.seek) {
      shown.seek = v;
      els.seek.value = v;
      paintRange(els.seek);
    }
  }
  const at = S.seeking && d ? (els.seek.value / 1000) * d : t;
  const time = S.remaining && d ? '-' + fmt(d - at) : fmt(at);
  if (time !== shown.time) { shown.time = time; els.time.textContent = time; }
  const dur = d ? fmt(d) : '--:--';
  if (dur !== shown.dur) { shown.dur = dur; els.dur.textContent = dur; }
  updatePlayButton();
}, 250);

/* ---------- view modes ---------- */

const MODES = ['list', 'video', 'mini'];
const OLD_MODES = { full: 'list', compact: 'list' };

async function setMode(mode) {
  mode = OLD_MODES[mode] || mode;
  if (!MODES.includes(mode)) mode = 'list';
  closeRecent(false);
  closeColorCard();
  if (mode !== 'list') closeLoad();
  S.mode = mode;
  document.body.classList.remove('mode-list', 'mode-video', 'mode-mini');
  document.body.classList.add('mode-' + mode);
  document.querySelectorAll('.modes button').forEach((b) =>
    b.classList.toggle('on', b.dataset.mode === mode));
  if (!S.ids.length) renderList();
  await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));

  // VIDEO and MINI size the window to their content; LIST is freely sized.
  // The body sits inside a transparent margin, so include it top and bottom.
  let fit = null;
  const r = els.shell.getBoundingClientRect();
  const outerH = Math.ceil(r.height + r.top * 2);
  if (mode === 'mini') {
    fit = { kind: 'fixed', h: outerH, minW: 620 };
  } else if (mode === 'video') {
    const g = document.querySelector('.glass').getBoundingClientRect();
    fit = { kind: 'video', extra: Math.ceil(outerH - g.height), widthPad: Math.round(window.innerWidth - g.width) };
  }
  await api.setFit(fit);
  if (S.idx >= 0) markCurrent();
  refreshTitle();
  save();
}

function cycleMode() {
  setMode(MODES[(MODES.indexOf(S.mode) + 1) % MODES.length]);
}

/* ---------- events ---------- */

$('#btnPrev').addEventListener('click', prev);
$('#btnNext').addEventListener('click', () => next());
$('#btnStop').addEventListener('click', stop);
els.btnPlay.addEventListener('click', togglePlay);
els.btnMute.addEventListener('click', () => setMuted(!S.muted));
els.btnShuffle.addEventListener('click', toggleShuffle);
els.btnRepeat.addEventListener('click', cycleRepeat);
els.btnPict.addEventListener('click', cyclePict);
els.btnColor.addEventListener('click', () => {
  if (els.colorCard.hidden) openColorCard();
  else closeColorCard();
});
document.addEventListener('mousedown', (e) => {
  if (!els.colorCard.hidden && !e.target.closest('#colorCard, #btnColor')) closeColorCard();
});
els.pictColor.addEventListener('click', () => { if (S.pict === 'lcd') cyclePict(); });
els.pictLcd.addEventListener('click', () => { if (S.pict !== 'lcd') cyclePict(); });

// Keep the side switch level with the middle of the screen as the window resizes.
(() => {
  const wrap = document.querySelector('.video-wrap');
  const place = () => {
    const r = wrap.getBoundingClientRect();
    document.documentElement.style.setProperty('--screen-mid', Math.round(r.top + r.height / 2) + 'px');
  };
  new ResizeObserver(place).observe(wrap);
  window.addEventListener('resize', place);
  place();
})();
els.ledShuffle.addEventListener('click', toggleShuffle);
els.ledRepeat.addEventListener('click', cycleRepeat);
els.btnLoad.addEventListener('click', pressLoad);
els.url.addEventListener('keydown', (e) => {
  if (e.key !== 'Enter') return;
  if (S.source && S.source.kind === 'custom') addFromInput();
  else loadFromInput();
});
els.btnAdd.addEventListener('click', () => {
  if (els.url.value.trim()) addFromInput();
  else els.url.focus();
});
els.btnSave.addEventListener('click', () => {
  if (!els.activeName.querySelector('input')) startSaving();
});
els.url.addEventListener('input', updateClear);
els.btnClear.addEventListener('click', () => {
  els.url.value = '';
  updateClear();
  els.url.focus();
});
els.btnRecent.addEventListener('click', () => {
  if (els.recentMenu.hidden) openRecent();
  else closeRecent();
});
document.addEventListener('mousedown', (e) => {
  if (!els.recentMenu.hidden && !e.target.closest('.recent')) closeRecent(false);
});

// Resize from any edge or corner: report the pointer to the main process
// once per frame.
(() => {
  let pending = null;
  let raf = 0;
  const flush = () => { raf = 0; if (pending) api.resizeMove(pending.x, pending.y); };
  document.querySelectorAll('.rz').forEach((zone) => {
    zone.addEventListener('pointerdown', (e) => {
      if (e.button !== 0) return;
      e.preventDefault();
      zone.setPointerCapture(e.pointerId);
      api.resizeStart(e.screenX, e.screenY, zone.dataset.edge);
    });
    zone.addEventListener('pointermove', (e) => {
      if (!zone.hasPointerCapture(e.pointerId)) return;
      pending = { x: e.screenX, y: e.screenY };
      if (!raf) raf = requestAnimationFrame(flush);
    });
    const end = (e) => {
      if (zone.hasPointerCapture(e.pointerId)) zone.releasePointerCapture(e.pointerId);
      api.resizeEnd();
    };
    zone.addEventListener('pointerup', end);
    zone.addEventListener('pointercancel', end);
  });
})();

$('#timeBtn').addEventListener('click', () => { S.remaining = !S.remaining; });
$('#btnVolDown').addEventListener('click', () => setVolume(S.volume - 5));
$('#btnVolUp').addEventListener('click', () => setVolume(S.volume + 5));

els.seek.addEventListener('input', () => { S.seeking = true; paintRange(els.seek); });
els.seek.addEventListener('change', () => {
  const d = (player && player.getDuration()) || 0;
  if (d) player.seekTo((els.seek.value / 1000) * d, true);
  S.seeking = false;
  shown.seek = -1;
});

els.vol.addEventListener('input', () => setVolume(+els.vol.value));

const onWheelVolume = (e) => {
  e.preventDefault();
  setVolume(S.volume + (e.deltaY < 0 ? 5 : -5));
};
$('#lcd').addEventListener('wheel', onWheelVolume, { passive: false });
$('#transport').addEventListener('wheel', onWheelVolume, { passive: false });

els.list.addEventListener('click', (e) => {
  if (e.target.closest('.x')) {
    e.stopPropagation();
    removeAt(+e.target.closest('li[data-i]').dataset.i);
    return;
  }
  const li = e.target.closest('li[data-i]');
  if (li) select(+li.dataset.i);
});
els.list.addEventListener('dblclick', (e) => {
  if (e.target.closest('.x')) return;
  const li = e.target.closest('li[data-i]');
  if (!li) return;
  if (S.idx >= 0) S.history.push(S.idx);
  playIndex(+li.dataset.i);
});
els.list.addEventListener('keydown', (e) => {
  const cur = els.list.querySelector('li.sel');
  const i = cur ? +cur.dataset.i : S.idx;
  if (e.key === 'ArrowDown') { e.preventDefault(); e.stopPropagation(); select(Math.min(S.ids.length - 1, i + 1)); }
  else if (e.key === 'ArrowUp') { e.preventDefault(); e.stopPropagation(); select(Math.max(0, i - 1)); }
  else if (e.key === 'Enter' && cur) { e.preventDefault(); e.stopPropagation(); playIndex(i); }
  else if ((e.key === 'Delete' || e.key === 'Backspace') && cur) { e.preventDefault(); e.stopPropagation(); removeAt(i); }
});

$('#btnClose').addEventListener('click', () => api.close());
$('#btnMin').addEventListener('click', () => api.minimize());
els.btnPin.addEventListener('click', async () => {
  els.btnPin.classList.toggle('on', await api.togglePin());
});
document.querySelectorAll('.modes button').forEach((b) =>
  b.addEventListener('click', () => setMode(b.dataset.mode)));

document.addEventListener('keydown', (e) => {
  if (!els.colorCard.hidden && e.key === 'Escape') { e.preventDefault(); closeColorCard(true); return; }
  if (!els.recentMenu.hidden) {
    if (e.key === 'Escape') { e.preventDefault(); closeRecent(); }
    else if (e.key === 'ArrowDown') { e.preventDefault(); moveRecentFocus(1); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); moveRecentFocus(-1); }
    return;
  }
  if (e.target === els.url) {
    if (e.key === 'Escape') {
      if (els.url.value) { els.url.value = ''; updateClear(); }
      else closeLoad();
    }
    return;
  }
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'l') {
    e.preventDefault();
    openLoad();
    return;
  }
  if ((e.ctrlKey || e.metaKey) && ['1', '2', '3'].includes(e.key)) { e.preventDefault(); setMode(MODES[+e.key - 1]); return; }
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'm') { e.preventDefault(); cycleMode(); return; }
  if (e.ctrlKey || e.metaKey || e.altKey) return;

  switch (e.key) {
    case ' ': e.preventDefault(); togglePlay(); break;
    case 'ArrowRight': e.preventDefault(); e.shiftKey ? next() : seekBy(5); break;
    case 'ArrowLeft': e.preventDefault(); e.shiftKey ? prev() : seekBy(-5); break;
    case 'ArrowUp': e.preventDefault(); setVolume(S.volume + 5); break;
    case 'ArrowDown': e.preventDefault(); setVolume(S.volume - 5); break;
    case 'n': case 'N': next(); break;
    case 'p': case 'P': case 'b': case 'B': prev(); break;
    case 's': case 'S': toggleShuffle(); break;
    case 'r': case 'R': cycleRepeat(); break;
    case 'm': case 'M': setMuted(!S.muted); break;
    case 'v': case 'V': cyclePict(); break;
  }
});

window.addEventListener('resize', debounce(refreshTitle, 150));

/* ---------- boot ---------- */

(async () => {
  saved = (await api.getSettings()) || {};
  const ls = saved.lastSource;
  if (ls && ls.list) prefetch = { list: ls.list, promise: api.playlist(ls.list, ls.v || null).catch(() => null) };
  S.shuffle = !!saved.shuffle;
  S.repeat = ['off', 'all', 'one'].includes(saved.repeat) ? saved.repeat : 'off';
  S.recents = Array.isArray(saved.recents) ? saved.recents.filter((r) => r && r.list).slice(0, 5) : [];
  S.savedLists = Array.isArray(saved.lists) ? saved.lists.filter((l) => l && l.id && Array.isArray(l.items)) : [];
  updateClear();
  setVolume(typeof saved.volume === 'number' ? saved.volume : 70);
  updateFlags();
  buildColorCard();
  setColor(saved.color || 'navy');
  setPict(saved.pict || 'normal');
  renderList();
  paintRange(els.seek);
  els.btnPin.classList.toggle('on', await api.isPinned());
  await setMode(saved.mode || 'list');
  if (!S.ready) setStatus('Connecting to YouTube\u2026');
  bootDone();
})();
