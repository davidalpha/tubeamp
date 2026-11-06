'use strict';

const { app, BrowserWindow, ipcMain, shell, screen } = require('electron');
const http = require('http');
const fs = require('fs');
const path = require('path');

// Let videos start with sound when advancing through a playlist.
app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');

const ROOT = path.join(__dirname, 'renderer');
const PREFERRED_PORT = 47811;
// The window is transparent: the device body is drawn inside it with rounded
// corners and its own shadow, 10px in from each edge.
const MIN_W = 380;
const MIN_H = 540;

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
};

let win = null;
const fileCache = new Map();
let baseUrl = '';
let settings = {};
// VIDEO and MINI views size the window to their content:
//   { kind: 'fixed', h }               MINI: a fixed height
//   { kind: 'video', extra, widthPad } VIDEO: height follows width at 16:9
let fit = null;
let normalBounds = null;

function fitHeight(width) {
  if (!fit) return null;
  if (fit.kind === 'fixed') return Math.round(fit.h);
  return Math.round(fit.extra + ((width - fit.widthPad) * 9) / 16);
}

/* ---------- settings ---------- */

const settingsFile = () => path.join(app.getPath('userData'), 'settings.json');

function loadSettings() {
  try {
    settings = JSON.parse(fs.readFileSync(settingsFile(), 'utf8')) || {};
  } catch {
    settings = {};
  }
}

let saveTimer = null;
function saveSettings() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(writeSettingsNow, 250);
}

function writeSettingsNow() {
  clearTimeout(saveTimer);
  try {
    // Write to a temp file and rename, so a crash mid-write cannot corrupt settings.
    const file = settingsFile();
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file + '.tmp', JSON.stringify(settings, null, 2));
    fs.renameSync(file + '.tmp', file);
  } catch (err) {
    console.error('Could not save settings:', err);
  }
}

/* ---------- local http server ----------
   YouTube's embedded player refuses to run from file:// pages (no referrer),
   so the UI is served from a tiny loopback server instead. */

function startServer() {
  return new Promise((resolve, reject) => {
    const server = http.createServer((req, res) => {
      let pathname;
      try {
        pathname = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
      } catch {
        res.writeHead(400);
        res.end();
        return;
      }
      if (pathname === '/') pathname = '/index.html';
      const file = path.normalize(path.join(ROOT, pathname));
      if (!file.startsWith(ROOT + path.sep)) {
        res.writeHead(403);
        res.end();
        return;
      }
      const send = (data) => {
        res.writeHead(200, {
          'Content-Type': MIME[path.extname(file)] || 'application/octet-stream',
          'Cache-Control': 'no-cache',
        });
        res.end(data);
      };
      // The UI files never change while the app runs, so keep them in memory.
      if (fileCache.has(file)) { send(fileCache.get(file)); return; }
      fs.readFile(file, (err, data) => {
        if (err) {
          res.writeHead(404);
          res.end('Not found');
          return;
        }
        if (app.isPackaged) fileCache.set(file, data);
        send(data);
      });
    });

    const listen = (port) => {
      server.once('error', (err) => {
        if (err.code === 'EADDRINUSE' && port !== 0) listen(0);
        else reject(err);
      });
      server.listen(port, '127.0.0.1', () => resolve(server.address().port));
    };
    listen(PREFERRED_PORT);
  });
}

/* ---------- window ---------- */

function boundsAreVisible(b) {
  if (!b || typeof b.x !== 'number' || typeof b.y !== 'number') return false;
  return screen.getAllDisplays().some(({ workArea: w }) =>
    b.x < w.x + w.width && b.x + (b.width || 0) > w.x &&
    b.y < w.y + w.height && b.y + 30 > w.y);
}

function createWindow() {
  const saved = settings.bounds || {};
  const useXY = boundsAreVisible(saved);

  win = new BrowserWindow({
    width: Math.max(saved.width || 480, MIN_W),
    height: Math.max(saved.height || 820, MIN_H),
    x: useXY ? saved.x : undefined,
    y: useXY ? saved.y : undefined,
    minWidth: MIN_W,
    minHeight: MIN_H,
    frame: false,
    transparent: true,
    backgroundColor: '#00000000',
    hasShadow: false,
    // The window is resized from its edges by the UI. It must still be marked
    // resizable: on Windows a non-resizable window can be grown by the app but
    // not shrunk again. Native edge resizing is switched off instead (no thick
    // frame, and will-resize below rejects anything the user drags).
    resizable: true,
    thickFrame: false,
    maximizable: false,
    fullscreenable: false,
    show: false,
    title: 'Tubeamp',
    alwaysOnTop: !!settings.pinned,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      backgroundThrottling: false,
    },
  });

  win.once('ready-to-show', () => win.show());

  // Only the UI's edge zones resize the window. will-resize fires for resizes the user
  // starts at the window edge, not for the app's own setSize/setBounds calls.
  win.on('will-resize', (e) => e.preventDefault());

  // Anything YouTube tries to open (logo click, "watch on YouTube") goes to the real browser.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (e, url) => {
    if (!url.startsWith(baseUrl)) {
      e.preventDefault();
      if (/^https?:\/\//.test(url)) shell.openExternal(url);
    }
  });

  win.on('close', () => {
    const now = win.getBounds();
    settings.bounds = fit && normalBounds
      ? { ...normalBounds, x: now.x, y: now.y, width: now.width }
      : now;
    settings.pinned = win.isAlwaysOnTop();
    writeSettingsNow();
  });

  win.on('closed', () => { win = null; });

  win.loadURL(baseUrl);
}

/* ---------- ipc ---------- */

// Called after the iframe API is ready, when the final YouTube frame exists.
// Keep this function self-contained: it executes inside that frame.
function prepareYouTubeEmbed() {
  if (window.__tubeampPictureStyle &&
      document.adoptedStyleSheets.includes(window.__tubeampPictureStyle)) return true;
  // Show the picture, rather than trying to enumerate every YouTube control.
  // Visibility preserves layout and lets the video/thumbnail remain visible
  // through hidden ancestors. New controls are hidden immediately by CSS.
  // A constructed sheet avoids inline <style> restrictions in the embed.
  const style = new CSSStyleSheet();
  style.replaceSync(`
    body * { visibility: hidden !important; }
    body video,
    body .ytp-cued-thumbnail-overlay-image,
    body .ytp-error, body .ytp-error *,
    body .ytp-error-content-wrap, body .ytp-error-content-wrap *,
    body .ytp-ad-player-overlay, body .ytp-ad-player-overlay *,
    body .ytp-ad-module, body .ytp-ad-module * {
      visibility: visible !important;
    }
    body *::before, body *::after { visibility: hidden !important; }
  `);
  document.adoptedStyleSheets = [...document.adoptedStyleSheets, style];
  window.__tubeampPictureStyle = style;
  return true;
}

ipcMain.handle('player:prepare', async (event) => {
  if (!win || event.sender !== win.webContents ||
      event.senderFrame !== win.webContents.mainFrame) return false;
  const frame = win.webContents.mainFrame.framesInSubtree.find((candidate) => {
    if (candidate.isDestroyed()) return false;
    try {
      const url = new URL(candidate.url);
      return url.origin === 'https://www.youtube.com' && url.pathname.startsWith('/embed/');
    } catch { return false; }
  });
  if (!frame) throw new Error('YouTube embed frame was not found');
  return frame.executeJavaScript(`(${prepareYouTubeEmbed.toString()})()`);
});

ipcMain.handle('settings:get', () => settings.player || {});
ipcMain.handle('settings:set', (_e, patch) => {
  if (patch && typeof patch === 'object') {
    settings.player = { ...(settings.player || {}), ...patch };
    saveSettings();
  }
  return true;
});

ipcMain.handle('oembed', async (_e, id) => {
  if (typeof id !== 'string' || !/^[\w-]{11}$/.test(id)) return null;
  const url = 'https://www.youtube.com/oembed?format=json&url=' +
    encodeURIComponent('https://www.youtube.com/watch?v=' + id);
  try {
    const res = await fetch(url);
    if (!res.ok) return null;
    const json = await res.json();
    return { title: json.title || null, author: json.author_name || null };
  } catch {
    return null;
  }
});

/* ---------- playlist track list ----------
   Reads the list straight from YouTube's page data, which is more reliable
   than waiting for the embedded player to report it. */

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36';

function extractJsonAfter(html, marker) {
  const at = html.indexOf(marker);
  if (at < 0) return null;
  const start = html.indexOf('{', at);
  if (start < 0) return null;
  let depth = 0;
  let inStr = false;
  let esc = false;
  for (let i = start; i < html.length; i++) {
    const c = html[i];
    if (inStr) {
      if (esc) esc = false;
      else if (c === '\\') esc = true;
      else if (c === '"') inStr = false;
    } else if (c === '"') inStr = true;
    else if (c === '{') depth++;
    else if (c === '}' && --depth === 0) {
      try { return JSON.parse(html.slice(start, i + 1)); } catch { return null; }
    }
  }
  return null;
}

const textOf = (t) => (t && (t.simpleText || (t.runs || []).map((r) => r.text).join(''))) || null;

function collect(node, key, out) {
  if (!node || typeof node !== 'object') return;
  if (Array.isArray(node)) { node.forEach((n) => collect(n, key, out)); return; }
  for (const [k, v] of Object.entries(node)) {
    if (k === key && v && v.videoId) out.push(v);
    else collect(v, key, out);
  }
}

const contentOf = (t) => (t && (t.content || textOf(t))) || null;

function findTracks(data, listId) {
  // 1. Classic playlist rows.
  let found = [];
  collect(data, 'playlistVideoRenderer', found);
  if (found.length) {
    return found.map((r) => ({
      id: r.videoId,
      title: textOf(r.title),
      author: textOf(r.shortBylineText) || textOf(r.longBylineText),
    }));
  }

  // 2. Newer "lockup" rows.
  const lockups = [];
  (function walk(node) {
    if (!node || typeof node !== 'object') return;
    if (Array.isArray(node)) { node.forEach(walk); return; }
    for (const [k, v] of Object.entries(node)) {
      if (k === 'lockupViewModel' && v && typeof v.contentId === 'string' &&
          /^[\w-]{11}$/.test(v.contentId) && /VIDEO/.test(v.contentType || 'VIDEO')) {
        lockups.push(v);
      } else walk(v);
    }
  })(data);
  if (lockups.length) {
    return lockups.map((v) => {
      const meta = v.metadata && v.metadata.lockupMetadataViewModel;
      let author = null;
      try {
        const rows = meta.metadata.contentMetadataViewModel.metadataRows;
        author = contentOf(rows[0].metadataParts[0].text);
      } catch { /* no channel name available */ }
      return { id: v.contentId, title: meta ? contentOf(meta.title) : null, author };
    });
  }

  // 3. Layout-independent: links that play a video inside this playlist.
  const byIndex = new Map();
  (function walk(node) {
    if (!node || typeof node !== 'object') return;
    if (Array.isArray(node)) { node.forEach(walk); return; }
    const we = node.watchEndpoint;
    if (we && we.playlistId === listId && typeof we.videoId === 'string') {
      const idx = typeof we.index === 'number' ? we.index : byIndex.size + 10000;
      if (!byIndex.has(idx)) byIndex.set(idx, we.videoId);
    }
    Object.values(node).forEach(walk);
  })(data);
  return [...byIndex.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([, id]) => ({ id, title: null, author: null }));
}

function decodeEntities(str) {
  return str
    .replace(/&quot;/g, '"').replace(/&#39;|&#x27;/g, "'")
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
}

function findPlaylistName(data, html, listId) {
  let name = null;
  (function walk(node) {
    if (name || !node || typeof node !== 'object') return;
    if (Array.isArray(node)) { node.forEach(walk); return; }
    if (node.playlistMetadataRenderer && typeof node.playlistMetadataRenderer.title === 'string') {
      name = node.playlistMetadataRenderer.title;
      return;
    }
    if (node.playlistId === listId && node.title) {
      const t = typeof node.title === 'string' ? node.title : textOf(node.title);
      if (t) { name = t; return; }
    }
    Object.values(node).forEach(walk);
  })(data);
  if (!name) {
    const m = html.match(/<meta property="og:title" content="([^"]*)"/);
    if (m) name = decodeEntities(m[1]);
  }
  return name && name.trim() ? name.trim() : null;
}

ipcMain.handle('playlist', async (_e, listId, videoId) => {
  if (typeof listId !== 'string' || !/^[\w-]{2,}$/.test(listId)) return null;
  const isMix = listId.startsWith('RD');
  const vid = typeof videoId === 'string' && /^[\w-]{11}$/.test(videoId) ? videoId : null;
  const url = isMix && vid
    ? `https://www.youtube.com/watch?v=${vid}&list=${encodeURIComponent(listId)}&hl=en`
    : `https://www.youtube.com/playlist?list=${encodeURIComponent(listId)}&hl=en`;
  try {
    const res = await fetch(url, {
      headers: {
        'User-Agent': UA,
        'Accept-Language': 'en-US,en;q=0.9',
        Cookie: 'CONSENT=YES+1; SOCS=CAI',
      },
    });
    console.log(`[playlist] ${listId}: HTTP ${res.status}, landed on ${res.url}`);
    if (!res.ok) return null;
    const html = await res.text();
    const data = extractJsonAfter(html, 'ytInitialData');
    if (!data) {
      console.log(`[playlist] ${listId}: no page data found (${html.length} bytes)`);
      return null;
    }

    const items = findTracks(data, listId);
    console.log(`[playlist] ${listId}: ${items.length} tracks found`);
    if (!items.length) {
      const dump = path.join(app.getPath('userData'), 'last-playlist-page.json');
      try {
        fs.writeFileSync(dump, JSON.stringify(data, null, 1));
        console.log(`[playlist] page data saved to ${dump}`);
      } catch { /* ignore */ }
    }
    return items.length ? { items, name: findPlaylistName(data, html, listId) } : null;
  } catch (err) {
    console.log(`[playlist] ${listId}: request failed: ${err.message}`);
    return null;
  }
});

ipcMain.handle('win:close', () => win && win.close());

// Resize from any edge or corner: the UI reports which edge and where the
// pointer is. The opposite edge stays where it is.
let resizeFrom = null;
ipcMain.on('win:resize-start', (_e, x, y, edge) => {
  if (!win || (fit && fit.kind === 'fixed')) return;
  if (typeof edge !== 'string' || !/^(n|s|e|w|ne|nw|se|sw)$/.test(edge)) return;
  resizeFrom = { x, y, edge, b: win.getBounds() };
});
ipcMain.on('win:resize-move', (_e, x, y) => {
  if (!win || !resizeFrom || (fit && fit.kind === 'fixed')) return;
  const { edge, b } = resizeFrom;
  const dx = Math.round(x - resizeFrom.x);
  const dy = Math.round(y - resizeFrom.y);
  let w = b.width;
  let h = b.height;
  if (edge.includes('e')) w = b.width + dx;
  if (edge.includes('w')) w = b.width - dx;
  if (edge.includes('s')) h = b.height + dy;
  if (edge.includes('n')) h = b.height - dy;

  if (fit && fit.kind === 'video') {
    // the picture always fills its screen: one dimension follows the other
    if (edge === 'n' || edge === 's') w = Math.round(((h - fit.extra) * 16) / 9 + fit.widthPad);
    w = Math.max(MIN_W, w);
    h = fitHeight(w);
  } else {
    w = Math.max(MIN_W, w);
    h = Math.max(MIN_H, h);
  }
  const nx = edge.includes('w') ? b.x + b.width - w : b.x;
  const ny = edge.includes('n') ? b.y + b.height - h : b.y;
  win.setBounds({ x: nx, y: ny, width: w, height: h });
});
ipcMain.on('win:resize-end', () => { resizeFrom = null; });
ipcMain.handle('win:minimize', () => win && win.minimize());
ipcMain.handle('win:isPinned', () => !!(win && win.isAlwaysOnTop()));
ipcMain.handle('win:togglePin', () => {
  if (!win) return false;
  const on = !win.isAlwaysOnTop();
  win.setAlwaysOnTop(on, 'floating');
  settings.pinned = on;
  saveSettings();
  return on;
});

ipcMain.handle('win:fit', (_e, spec) => {
  if (!win) return false;
  const now = win.getBounds();
  if (spec && (spec.kind === 'fixed' || spec.kind === 'video')) {
    if (!fit) normalBounds = now;
    fit = spec;
    win.setMinimumSize(340, 60);
    const width = Math.max(now.width, Math.round(spec.minW || 0));
    win.setBounds({ x: now.x, y: now.y, width, height: fitHeight(width) });
  } else if (fit) {
    // leaving MINI restores the width it widened; leaving VIDEO keeps the width
    // the user chose there
    const width = fit.kind === 'fixed' && normalBounds ? normalBounds.width : now.width;
    fit = null;
    win.setMinimumSize(MIN_W, MIN_H);
    const h = Math.max(MIN_H, normalBounds ? normalBounds.height : 820);
    win.setBounds({ x: now.x, y: now.y, width: Math.max(MIN_W, width), height: h });
  }
  return !!fit;
});

/* ---------- lifecycle ---------- */

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (!win) return;
    if (win.isMinimized()) win.restore();
    win.focus();
  });

  app.whenReady().then(async () => {
    loadSettings();
    const port = await startServer();
    baseUrl = `http://127.0.0.1:${port}/`;
    createWindow();

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
  });

  app.on('window-all-closed', () => app.quit());
}
