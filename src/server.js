import { readTranscript } from './transcript.js';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { safeEqual, truncate, clip, baseName } from './util.js';
import { NOTE_TYPES } from './notes.js';

const PUBLIC_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'public');
const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ttf': 'font/ttf',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8',
};
// The page may only use its own files, and no other site may show it inside a frame
// (that would let a web page trick you into pressing Allow).
const PAGE_POLICY = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data:",
  "font-src 'self'",
  "connect-src 'self'",
  "base-uri 'none'",
  "form-action 'self'",
  "frame-ancestors 'none'",
].join('; ');
const MAX_BODY = 5 * 1024 * 1024;

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY) {
        reject(Object.assign(new Error('Request too large'), { status: 413 }));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function sendJson(res, status, data) {
  const body = JSON.stringify(data);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'Content-Length': Buffer.byteLength(body) });
  res.end(body);
}

export function createServer({ port, token, engine, store, mode, getSettings, updateSettings, info, actions, groups = null }) {
  const clients = new Set();
  engine.hasViewers = () => clients.size > 0;
  const allowedHosts = new Set([`127.0.0.1:${port}`, `localhost:${port}`]);
  const allowedOrigins = new Set([`http://127.0.0.1:${port}`, `http://localhost:${port}`]);

  function broadcast(event, data) {
    const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
    for (const res of clients) res.write(payload);
  }

  function snapshot() {
    return {
      sessions: Object.values(store.sessions).map((s) => engine.publicSession(s)),
      notes: store.data.notes,
      briefs: store.pendingBriefs(),
      groups: groups ? groups.current() : [],
      settings: getSettings(),
      info: info(),
    };
  }

  // A working chat changes many times a second. The browser gets each chat at most a few
  // times a second, with its latest state.
  const pendingSessions = new Map();
  let sessionTimer = null;
  function flushSessions() {
    sessionTimer = null;
    const ids = [...pendingSessions.keys()];
    pendingSessions.clear();
    for (const id of ids) {
      const s = store.session(id);
      if (s) broadcast('session', engine.publicSession(s));
    }
  }
  store.on('session', (s) => {
    pendingSessions.set(s.id, true);
    if (!sessionTimer) sessionTimer = setTimeout(flushSessions, 150);
  });
  store.on('notes', () => broadcast('notes', store.data.notes));
  store.on('briefs', () => broadcast('briefs', store.pendingBriefs()));
  store.on('groups', (list) => broadcast('groups', list));
  store.on('info', () => broadcast('info', info()));
  const heartbeat = setInterval(() => {
    for (const res of clients) res.write(': ping\n\n');
  }, 15000);

  async function handleHook(req, res, url) {
    if (req.method !== 'POST') return sendJson(res, 405, {});
    if (!safeEqual(req.headers['x-kroog-token'] || req.headers['x-crew-token'], token)) {
      res.writeHead(401);
      return res.end();
    }
    const event = decodeURIComponent(url.pathname.slice('/hook/'.length));
    let body = {};
    try {
      const raw = await readBody(req);
      body = raw ? JSON.parse(raw) : {};
    } catch {
      res.writeHead(400);
      return res.end();
    }
    const controller = new AbortController();
    res.on('close', () => {
      if (!res.writableFinished) controller.abort();
    });
    const meta = {
      entry: String(req.headers['x-kroog-entry'] || req.headers['x-crew-entry'] || ''),
      bundle: String(req.headers['x-kroog-bundle'] || req.headers['x-crew-bundle'] || ''),
      term: String(req.headers['x-kroog-term'] || req.headers['x-crew-term'] || ''),
      inbox: String(req.headers['x-kroog-inbox'] || req.headers['x-crew-inbox'] || ''),
      inboxToken: String(req.headers['x-kroog-inbox-token'] || req.headers['x-crew-inbox-token'] || ''),
    };
    let output = null;
    try {
      output = await engine.handle(event, body, meta, controller.signal);
    } catch (error) {
      console.error(`[kroog] hook ${event} failed:`, error.message);
      output = null;
    }
    if (res.destroyed || res.writableEnded) return;
    // Empty body = "no opinion", so Claude Code carries on as normal.
    if (output == null) {
      res.writeHead(204);
      return res.end();
    }
    return sendJson(res, 200, output);
  }

  async function handleApi(req, res, url) {
    const route = url.pathname.slice('/api/'.length);

    if (req.method === 'GET' && route === 'state') return sendJson(res, 200, snapshot());
    // The real conversation of one chat, from Claude Code's own history file.
    if (req.method === 'GET' && route.startsWith('transcript/')) {
      const sid = decodeURIComponent(route.slice('transcript/'.length));
      if (!store.session(sid)) return sendJson(res, 404, { ok: false, error: 'That chat is gone.' });
      try {
        return sendJson(res, 200, { ok: true, ...readTranscript(sid) });
      } catch (error) {
        return sendJson(res, 200, { ok: true, found: false, items: [], error: error.message });
      }
    }

    if (req.method === 'GET' && route === 'stream') {
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', Connection: 'keep-alive' });
      res.write(`event: snapshot\ndata: ${JSON.stringify(snapshot())}\n\n`);
      clients.add(res);
      req.on('close', () => clients.delete(res));
      return;
    }

    if (req.method !== 'POST') return sendJson(res, 405, { ok: false, error: 'Use POST.' });
    // Blocks other web pages from driving your chats: they can't set this header without
    // a CORS preflight, which Kroog never answers.
    if (req.headers['x-kroog-ui'] !== '1') return sendJson(res, 403, { ok: false, error: 'Missing header.' });
    const origin = req.headers.origin;
    if (origin && !allowedOrigins.has(origin)) return sendJson(res, 403, { ok: false, error: 'Wrong origin.' });

    let data = {};
    try {
      const raw = await readBody(req);
      data = raw ? JSON.parse(raw) : {};
    } catch {
      return sendJson(res, 400, { ok: false, error: 'Bad request.' });
    }

    const parts = route.split('/');
    if (parts[0] === 'sessions' && parts.length === 3) {
      const sid = decodeURIComponent(parts[1]);
      switch (parts[2]) {
        case 'decide':
          return sendJson(res, 200, engine.decide(sid, { behavior: data.behavior === 'allow' ? 'allow' : 'deny', message: data.message }));
        case 'release':
          return sendJson(res, 200, engine.release(sid));
        case 'send':
          return sendJson(res, 200, await engine.send(sid, data.text, { mode: ['branch', 'editor'].includes(data.mode) ? data.mode : 'auto' }));
        case 'drive':
          return sendJson(res, 200, engine.setDrive(sid, data.on));
        case 'stop':
          return sendJson(res, 200, engine.stop(sid));
        case 'archive':
          return sendJson(res, 200, engine.archive(sid, data.on));
        default:
          return sendJson(res, 404, { ok: false, error: 'Unknown action.' });
      }
    }

    if (route === 'briefs') return sendJson(res, 200, engine.createBrief(data));
    if (route === 'handoff') return sendJson(res, 200, await engine.handoff(data));

    if (route === 'notes') {
      const type = NOTE_TYPES.includes(data.type) ? data.type : 'Finding';
      const text = truncate(data.text, 400);
      if (!text) return sendJson(res, 200, { ok: false, error: 'Write the note first.' });
      const s = data.sessionId ? store.session(data.sessionId) : null;
      const cwd = s ? s.cwd : String(data.cwd || '');
      const note = store.addNote({
        sessionId: s ? s.id : null,
        chatTitle: s ? s.title || 'Untitled chat' : 'Added by you',
        project: s ? s.project : baseName(cwd) || 'No project',
        cwd,
        type,
        text,
        manual: true,
      });
      return sendJson(res, 200, note ? { ok: true, note } : { ok: false, error: 'That note is already in the Library.' });
    }

    if (parts[0] === 'notes' && parts.length === 3) {
      const id = decodeURIComponent(parts[1]);
      if (parts[2] === 'remember') {
        const note = store.updateNote(id, { remembered: Boolean(data.on) });
        return sendJson(res, 200, note ? { ok: true } : { ok: false, error: 'Note not found.' });
      }
      if (parts[2] === 'delete') {
        store.removeNote(id);
        return sendJson(res, 200, { ok: true });
      }
    }

    if (route === 'memory') {
      const cwd = String(data.cwd || '');
      const text = clip(data.text, 3000);
      if (!cwd || !text) return sendJson(res, 200, { ok: false, error: 'Pick a project folder and write something first.' });
      const note = store.addNote({ sessionId: null, chatTitle: 'Handoff', project: baseName(cwd), cwd, type: 'Brief', text, remembered: true, manual: true });
      return sendJson(res, 200, note ? { ok: true, note } : { ok: false, error: 'That is already in project memory.' });
    }

    if (route === 'settings') {
      const next = updateSettings(data);
      broadcast('settings', next);
      return sendJson(res, 200, { ok: true, settings: next });
    }

    if (actions && actions[route]) {
      try {
        const result = await actions[route](data);
        broadcast('info', info());
        return sendJson(res, 200, { ok: true, ...result });
      } catch (error) {
        return sendJson(res, 200, { ok: false, error: error.message });
      }
    }

    return sendJson(res, 404, { ok: false, error: 'Not found.' });
  }

  function serveStatic(req, res, url) {
    if (req.method !== 'GET' && req.method !== 'HEAD') return sendJson(res, 405, {});
    const rel = url.pathname === '/' ? '/index.html' : url.pathname;
    const file = path.normalize(path.join(PUBLIC_DIR, rel));
    if (!file.startsWith(PUBLIC_DIR + path.sep)) {
      res.writeHead(403);
      return res.end();
    }
    fs.readFile(file, (error, content) => {
      if (error) {
        res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
        return res.end('Not found');
      }
      res.writeHead(200, {
        'Content-Type': TYPES[path.extname(file)] || 'application/octet-stream',
        'Cache-Control': 'no-store',
        'X-Content-Type-Options': 'nosniff',
        'Referrer-Policy': 'no-referrer',
        'Content-Security-Policy': PAGE_POLICY,
        'X-Frame-Options': 'DENY',
      });
      res.end(req.method === 'HEAD' ? undefined : content);
    });
  }

  const server = http.createServer(async (req, res) => {
    try {
      // Only answer requests addressed to this Mac by name, which blocks DNS-rebinding tricks.
      if (!allowedHosts.has(String(req.headers.host || '').toLowerCase())) {
        res.writeHead(403);
        return res.end();
      }
      const url = new URL(req.url, `http://127.0.0.1:${port}`);
      if (url.pathname.startsWith('/hook/')) return await handleHook(req, res, url);
      if (url.pathname.startsWith('/api/')) return await handleApi(req, res, url);
      return serveStatic(req, res, url);
    } catch (error) {
      if (!res.headersSent) sendJson(res, error.status || 500, { ok: false, error: error.status ? error.message : 'Something went wrong in Kroog.' });
      else res.end();
      if (!error.status) console.error('[kroog]', error);
    }
  });

  server.on('close', () => clearInterval(heartbeat));
  return { server, broadcast, closeClients: () => { clearTimeout(sessionTimer); for (const res of clients) res.end(); clients.clear(); } };
}
