// Shared helpers for the Kroog page: text, time, status words, step cells, lineage.

export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
export const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
export const oneLine = (v) => String(v ?? '').replace(/\s+/g, ' ').trim();
export const trim = (v, n) => { const t = oneLine(v); return t.length > n ? `${t.slice(0, n - 1).trimEnd()}…` : t; };
export const clipText = (v, n) => { const t = String(v ?? '').trim(); return t.length > n ? `${t.slice(0, n - 1).trimEnd()}…` : t; };
export const words = (t) => (String(t || '').trim() ? String(t).trim().split(/\s+/).length : 0);
export const lowerFirst = (t) => (t ? t.charAt(0).toLowerCase() + t.slice(1) : t);
export const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

export const QUIET_AFTER = 2 * 3600 * 1000;
export const STALE_AFTER = 15 * 60 * 1000;
export const EDITORS = { vscode: 'VS Code', cursor: 'Cursor', 'vscode-insiders': 'VS Code Insiders', windsurf: 'Windsurf' };
export const NOTE_TYPES = ['Decision', 'Finding', 'How-to', 'Open question'];

// ---------------------------------------------------------------- time

export function dur(t) {
  const sec = Math.max(0, Math.round((Date.now() - (t || Date.now())) / 1000));
  if (sec < 45) return 'just now';
  const min = Math.round(sec / 60);
  if (min < 60) return `${min} min`;
  const h = Math.floor(min / 60);
  const m = min % 60;
  if (h < 24) return m ? `${h} h ${m} min` : `${h} h`;
  const d = Math.floor(h / 24);
  return d === 1 ? '1 day' : `${d} days`;
}

export function clock(t) {
  return new Date(t).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }).replace(/\s?([AP])M$/i, (m, x) => ` ${x.toLowerCase()}m`);
}

export function dayish(t) {
  const d = new Date(t);
  const today = new Date();
  const yesterday = new Date(Date.now() - 86400000);
  if (d.toDateString() === today.toDateString()) return clock(t);
  if (d.toDateString() === yesterday.toDateString()) return 'yesterday';
  return d.toLocaleDateString([], { weekday: 'long' }).toLowerCase();
}

export function countdownText(deadline, what = 'the editor asks') {
  if (!deadline) return '';
  const sec = Math.round((deadline - Date.now()) / 1000);
  if (sec <= 0) return 'handing over to the editor';
  if (sec < 60) return `${what} in ${sec}s`;
  const min = Math.floor(sec / 60);
  const rest = sec % 60;
  return rest ? `${what} in ${min} min ${rest}s` : `${what} in ${min} min`;
}

// ---------------------------------------------------------------- chats

export function edName(s) {
  return EDITORS[s.editor] || (s.kind === 'ide' ? s.app : 'the editor');
}

export function editorUrl(s, prompt) {
  if (!s.editor) return null;
  let url = `${s.editor}://anthropic.claude-code/open?session=${encodeURIComponent(s.id)}`;
  if (prompt) url += `&prompt=${encodeURIComponent(prompt)}`;
  return url;
}

// Four states. "open" means the chat is open somewhere right now and waiting for you;
// "done" means it is not open anywhere (Kroog or the editor can carry it on).
export function bucket(s) {
  if (s.status === 'needs' || s.status === 'error') return 'needs';
  if (s.status === 'working' && (s.live || Date.now() - (s.lastAt || 0) <= STALE_AFTER)) return 'working';
  if (s.live || s.holdingStop) return 'open';
  return 'done';
}

// One word for where a chat stands, and the colour family it uses.
export function look(s) {
  if (s.status === 'error') return { k: 'error', word: 'stopped' };
  const b = bucket(s);
  if (b === 'needs') return { k: 'needs', word: 'needs you' };
  if (b === 'working') return { k: 'working', word: 'working' };
  if (b === 'open') return { k: 'open', word: 'open' };
  return { k: 'done', word: 'done' };
}

export function whenText(s) {
  const b = bucket(s);
  if (b === 'needs') return dur(s.since);
  if (b === 'working') return dur(s.since);
  if (Date.now() - (s.lastAt || 0) > QUIET_AFTER) return dayish(s.lastAt);
  return clock(s.lastAt || s.since);
}

export function firstLine(text, n = 160) {
  const line = String(text || '').split('\n').map((l) => l.trim()).find((l) => l && !/^#+\s*$/.test(l)) || '';
  return trim(line.replace(/^#+\s*/, '').replace(/\*\*/g, ''), n);
}

// The one line under a chat's title.
export function lineText(s) {
  const n = s.needs || {};
  if (s.status === 'needs' && n.kind === 'permission') return `wants to ${lowerFirst(n.title || 'do something')}`;
  if (s.status === 'needs') return `asks: ${n.title || 'needs your input'}`;
  if (s.status === 'error') return `stopped: ${n.title || 'an error'}`;
  if (s.status === 'working') return s.now || 'working';
  if (s.status === 'idle' && !s.lastReply) return 'waiting for its first message';
  return firstLine(s.lastReply) || 'finished its turn';
}

// A chat with no real message in it is a panel someone opened and closed: not shown.
export function isEmptyChat(s) {
  if (s.status === 'working' || s.status === 'needs') return false;
  if (s.lastReply || (s.lastPrompt && !/^\s*</.test(s.lastPrompt))) return false;
  return !(s.steps || []).some((st) => (st.kind === 'prompt' || st.kind === 'you') && st.text && !/^\s*</.test(st.text));
}

export function visibleSessions(S) {
  const ideOnly = S.settings.ideOnly !== false;
  return [...S.sessions.values()].filter((s) => !s.archived && !isEmptyChat(s) && (!ideOnly || s.kind === 'ide' || s.kind === 'kroog' || s.kind === 'unknown'));
}

export function hiddenByScope(S) {
  if (S.settings.ideOnly === false) return 0;
  return [...S.sessions.values()].filter((s) => !s.archived && !(s.kind === 'ide' || s.kind === 'kroog' || s.kind === 'unknown')).length;
}

export function shortFile(file, cwd) {
  if (cwd && file.startsWith(cwd)) return file.slice(cwd.length).replace(/^[\\/]/, '');
  return file;
}

export function folderName(path) {
  return String(path || '').split(/[\\/]/).filter(Boolean).pop() || path || '';
}

export function tildePath(path) {
  return String(path || '').replace(/^\/Users\/[^/]+/, '~').replace(/^\/home\/[^/]+/, '~');
}

// ---------------------------------------------------------------- work, drawn in cells

// One cell per step, newest last: p prompt, o tool done, r running, f failed,
// a asked you, y you answered, e replied, h a helper's step.
// The cell a step shows as: p you asked, o a step, r the running step, h an agent's step,
// a it asked you, f it failed, y a message from you, e a reply. Null for steps with no cell.
export function cellClass(step) {
  if (!step) return null;
  if (step.kind === 'prompt') return 'p';
  if (step.kind === 'tool') return step.helper ? 'h' : step.state === 'failed' ? 'f' : step.state === 'running' ? 'r' : 'o';
  if (step.kind === 'ask') return 'a';
  if (step.kind === 'you') return 'y';
  if (step.kind === 'reply') return 'e';
  if (step.kind === 'error') return 'f';
  return null;
}

export function cellsFor(s, max = 28) {
  const out = [];
  for (const step of s.steps || []) {
    const c = cellClass(step);
    if (c) out.push(c);
  }
  // Only the newest running step shows as running.
  for (let i = 0; i < out.length - 1; i += 1) if (out[i] === 'r') out[i] = 'o';
  return out.slice(-max);
}

export function cellsHtml(s, max = 28) {
  const cells = cellsFor(s, s.status === 'working' ? max - 1 : max);
  const cursor = s.status === 'working' && look(s).k === 'working';
  if (!cells.length && !cursor) return '';
  return `<span class="cells" aria-hidden="true">${cells.map((c) => `<i class="${c}"></i>`).join('')}${cursor ? '<i class="cur"></i>' : ''}</span>`;
}

// ---------------------------------------------------------------- lineage

// Edges between chats: a brief made from one chat that another started with or was sent,
// and project memory written from one chat that a later chat started with.
export function lineageEdges(sessionsById, notesById) {
  const edges = [];
  const seen = new Set();
  for (const s of sessionsById.values()) {
    for (const input of s.inputs || []) {
      const from = new Set(input.from || []);
      for (const nid of input.notes || []) {
        const note = notesById.get(nid);
        if (note && note.sessionId) from.add(note.sessionId);
        if (note && Array.isArray(note.from)) note.from.forEach((x) => from.add(x));
      }
      for (const src of from) {
        if (!src || src === s.id || !sessionsById.has(src)) continue;
        const key = `${src}>${s.id}`;
        const kind = input.kind === 'memory' ? 'memory' : input.kind === 'continue' ? 'continue' : 'brief';
        if (seen.has(key)) {
          // A brief wins over memory when both link the same two chats.
          if (kind !== 'memory') edges.find((e) => e.key === key).kind = kind;
          continue;
        }
        seen.add(key);
        edges.push({ key, from: src, to: s.id, kind, t: input.t || 0, words: input.words || 0 });
      }
    }
  }
  return edges;
}

// Everything a chat came from and everything that came from it.
export function lineageOf(id, edges) {
  const up = new Map();
  const down = new Map();
  for (const e of edges) {
    if (!down.has(e.from)) down.set(e.from, []);
    down.get(e.from).push(e.to);
    if (!up.has(e.to)) up.set(e.to, []);
    up.get(e.to).push(e.from);
  }
  const keep = new Set([id]);
  const walk = (start, map) => {
    const stack = [start];
    while (stack.length) {
      const cur = stack.pop();
      for (const next of map.get(cur) || []) {
        if (!keep.has(next)) { keep.add(next); stack.push(next); }
      }
    }
  };
  walk(id, up);
  walk(id, down);
  return keep;
}
