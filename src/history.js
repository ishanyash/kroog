// Import recent chats from Claude Code's saved history, so chats that started before
// Kroog was linked show up too, with their title, project, plan, files and last reply.
//
// Two ways to read the history:
//   1. Claude Code's Agent SDK (listSessions, getSessionMessages), if it is installed in
//      Kroog's folder (npm install @anthropic-ai/claude-agent-sdk). This is the supported way.
//   2. Otherwise, the saved chat files in ~/.claude/projects/<folder>/<chat id>.jsonl.
//      Their format is internal to Claude Code and can change, so this reader is tolerant:
//      anything it does not recognise is skipped, never fatal.
// Kroog only reads these files. It never changes them.
import fs from 'node:fs';
import path from 'node:path';
import { claudeDir } from './config.js';
import { detectApp } from './sources.js';
import { describeTool, applyPlanTool, fileTouched } from './describe.js';
import { clip, truncate, titleFromPrompt, firstLine, shortId, cleanPrompt } from './util.js';

const HEAD_BYTES = 512 * 1024;
const TAIL_BYTES = 4 * 1024 * 1024;

function readText(file) {
  const size = fs.statSync(file).size;
  if (size <= HEAD_BYTES + TAIL_BYTES) return fs.readFileSync(file, 'utf8');
  // A very long chat: its start (for the first prompt) and its end (for what happened lately).
  const fd = fs.openSync(file, 'r');
  try {
    const head = Buffer.alloc(HEAD_BYTES);
    const tail = Buffer.alloc(TAIL_BYTES);
    fs.readSync(fd, head, 0, HEAD_BYTES, 0);
    fs.readSync(fd, tail, 0, TAIL_BYTES, size - TAIL_BYTES);
    return `${head.toString('utf8')}\n${tail.toString('utf8')}`;
  } finally {
    fs.closeSync(fd);
  }
}

// Text a person typed (not tool results, not reminders or command tags Claude Code adds).
function promptText(message) {
  if (!message) return '';
  const c = message.content;
  let text = '';
  if (typeof c === 'string') text = c;
  else if (Array.isArray(c)) {
    if (c.some((b) => b && b.type === 'tool_result')) return '';
    text = c.filter((b) => b && b.type === 'text').map((b) => b.text || '').join('\n');
  }
  text = cleanPrompt(text);
  if (!text || text.startsWith('Caveat:')) return '';
  return text;
}

function replyText(message) {
  const c = message && message.content;
  if (typeof c === 'string') return c.trim();
  if (!Array.isArray(c)) return '';
  return c.filter((b) => b && b.type === 'text').map((b) => b.text || '').join('\n').trim();
}

function ms(ts, fallback) {
  const t = Date.parse(ts || '');
  return Number.isFinite(t) ? t : fallback;
}

// Turn a chat's entries into what Kroog shows for a chat.
export function summarise(entries, { id, fallbackTime = Date.now(), info = {} } = {}) {
  const out = {
    id,
    cwd: info.cwd || '',
    gitBranch: info.gitBranch || '',
    entry: '',
    customTitle: info.customTitle || '',
    aiTitle: '',
    firstPrompt: info.firstPrompt || '',
    lastPrompt: '',
    lastReply: '',
    startedAt: info.createdAt || 0,
    lastAt: info.lastModified || 0,
    steps: [],
    plan: [],
    files: [],
    helpers: {},
  };
  const byTool = new Map();
  let t = out.startedAt || fallbackTime;
  for (const e of entries) {
    if (!e || typeof e !== 'object') continue;
    t = ms(e.timestamp, t);
    if (e.type === 'custom-title' && e.customTitle) out.customTitle = String(e.customTitle);
    if (e.type === 'ai-title' && e.aiTitle) out.aiTitle = String(e.aiTitle);
    if (e.type === 'summary' && e.summary && !out.aiTitle) out.aiTitle = String(e.summary);
    if (e.type === 'last-prompt' && e.lastPrompt) out.lastPrompt = String(e.lastPrompt);
    if (e.type !== 'user' && e.type !== 'assistant') continue;
    if (e.cwd) out.cwd = e.cwd;
    if (e.gitBranch) out.gitBranch = e.gitBranch;
    if (e.entrypoint) out.entry = e.entrypoint;
    if (!out.startedAt) out.startedAt = t;
    out.lastAt = Math.max(out.lastAt, t);
    const helper = e.isSidechain ? 'helper' : null;
    const msg = e.message || {};

    if (e.type === 'user') {
      if (Array.isArray(msg.content)) {
        for (const b of msg.content) {
          if (b && b.type === 'tool_result' && byTool.has(b.tool_use_id)) byTool.get(b.tool_use_id).state = b.is_error ? 'failed' : 'ok';
        }
      }
      if (helper || e.isMeta) continue;
      const p = promptText(msg);
      if (!p) continue;
      if (!out.firstPrompt) out.firstPrompt = p;
      out.lastPrompt = p;
      out.steps.push({ kind: 'prompt', text: truncate(p, 400), t });
      continue;
    }

    // Assistant: tool calls become steps; text is its reply.
    const blocks = Array.isArray(msg.content) ? msg.content : [];
    for (const b of blocks) {
      if (!b || b.type !== 'tool_use') continue;
      const input = b.input || {};
      const step = { kind: 'tool', text: describeTool(b.name, input), tool: b.name, toolUseId: b.id || null, state: 'ok', helper, t };
      out.steps.push(step);
      if (b.id) byTool.set(b.id, step);
      if (!helper) {
        if (b.name === 'TodoWrite') out.plan = applyPlanTool(out.plan, b.name, input);
        const f = fileTouched(b.name, input);
        if (f && !out.files.includes(f)) out.files.push(f);
        if ((b.name === 'Task' || b.name === 'Agent') && (input.subagent_type || input.description)) {
          out.helpers[b.id || `h${Object.keys(out.helpers).length}`] = { type: String(input.subagent_type || 'helper'), state: 'done', t };
        }
      }
    }
    const text = helper ? '' : replyText(msg);
    if (text) out.lastReply = text;
  }
  // After Claude Code compacts a long chat, its first prompts may be gone from the file.
  if (!out.firstPrompt) out.firstPrompt = out.lastPrompt;
  return out;
}

function toSession(sum) {
  const d = detectApp({ entry: sum.entry });
  // From history alone, VS Code and Cursor look the same.
  const place = sum.entry === 'claude-vscode' ? 'VS Code or Cursor' : d.place;
  const title = sum.customTitle || sum.aiTitle || titleFromPrompt(sum.firstPrompt) || 'Untitled chat';
  const steps = sum.steps.slice(-80);
  if (sum.lastReply) steps.push({ kind: 'reply', text: firstLine(sum.lastReply, 220), t: sum.lastAt });
  steps.unshift({ kind: 'info', text: 'Imported from Claude Code history', t: sum.startedAt || sum.lastAt });
  for (const st of steps) st.id = shortId(8);
  return {
    id: sum.id,
    title: truncate(title, 80),
    cwd: sum.cwd,
    app: d.app,
    kind: d.kind,
    place,
    editor: d.editor,
    surface: d.surface,
    entry: sum.entry,
    gitBranch: sum.gitBranch,
    lastPrompt: clip(sum.lastPrompt, 2000),
    lastReply: clip(sum.lastReply, 6000),
    startedAt: sum.startedAt || sum.lastAt,
    lastAt: sum.lastAt,
    steps,
    plan: sum.plan,
    files: sum.files.slice(-60),
    helpers: sum.helpers,
  };
}

// The saved chat files, newest first.
function listFiles(since) {
  const root = path.join(claudeDir(), 'projects');
  let dirs = [];
  try { dirs = fs.readdirSync(root, { withFileTypes: true }).filter((d) => d.isDirectory()); } catch { return []; }
  const files = [];
  for (const d of dirs) {
    let names = [];
    try { names = fs.readdirSync(path.join(root, d.name)); } catch { continue; }
    for (const name of names) {
      if (!name.endsWith('.jsonl')) continue;
      const file = path.join(root, d.name, name);
      try {
        const st = fs.statSync(file);
        if (st.mtimeMs >= since) files.push({ file, id: name.slice(0, -6), mtime: st.mtimeMs });
      } catch { /* gone */ }
    }
  }
  return files.sort((a, b) => b.mtime - a.mtime);
}

async function trySdk() {
  try {
    return await import('@anthropic-ai/claude-agent-sdk');
  } catch {
    return null;
  }
}

// Read up to `limit` chats active in the last `days` days.
export async function readRecent({ days = 7, limit = 40 } = {}) {
  const since = Date.now() - days * 86400000;
  const sdk = await trySdk();
  const found = [];
  if (sdk && typeof sdk.listSessions === 'function') {
    const infos = (await sdk.listSessions({ limit: limit * 2 })).filter((x) => (x.lastModified || 0) >= since).slice(0, limit);
    for (const info of infos) {
      try {
        const msgs = await sdk.getSessionMessages(info.sessionId, info.cwd ? { dir: info.cwd } : {});
        const entries = msgs.map((m) => ({ type: m.type, message: m.message, isSidechain: Boolean(m.parent_tool_use_id) }));
        const sum = summarise(entries, { id: info.sessionId, info });
        if (sum.firstPrompt || sum.lastReply) found.push(sum);
      } catch { /* skip this one */ }
    }
    return { source: 'sdk', chats: found };
  }
  for (const f of listFiles(since).slice(0, limit * 2)) {
    if (found.length >= limit) break;
    try {
      const entries = [];
      for (const line of readText(f.file).split('\n')) {
        if (!line.trim()) continue;
        try { entries.push(JSON.parse(line)); } catch { /* a cut line at the edge of a long file */ }
      }
      const sum = summarise(entries, { id: f.id, fallbackTime: f.mtime });
      if (!sum.lastAt) sum.lastAt = f.mtime;
      if (sum.firstPrompt || sum.lastReply) found.push(sum);
    } catch { /* unreadable file: skip */ }
  }
  return { source: 'files', chats: found };
}

// Add the chats to Kroog. A chat Kroog already knows keeps its live state;
// only the parts Kroog is missing are filled in from history.
export async function importRecent(store, opts = {}) {
  const { source, chats } = await readRecent(opts);
  let added = 0;
  let filled = 0;
  for (const sum of chats) {
    const data = toSession(sum);
    const known = store.data.sessions[data.id];
    const s = store.ensureSession(data.id, data.cwd);
    if (!known) {
      Object.assign(s, {
        title: data.title,
        app: data.app,
        kind: data.kind,
        place: data.place,
        editor: data.editor,
        surface: data.surface,
        entry: data.entry,
        status: 'done',
        since: data.lastAt,
        startedAt: data.startedAt,
        lastAt: data.lastAt,
        lastPrompt: data.lastPrompt,
        lastReply: data.lastReply,
        steps: data.steps,
        plan: data.plan,
        files: data.files,
        helpers: data.helpers,
        imported: true,
      });
      added += 1;
    } else {
      let changed = false;
      for (const key of ['lastPrompt', 'lastReply']) if (!s[key] && data[key]) { s[key] = data[key]; changed = true; }
      if ((!s.title || s.title === 'Untitled chat') && data.title) { s.title = data.title; changed = true; }
      if (!(s.plan || []).length && data.plan.length) { s.plan = data.plan; changed = true; }
      if (!(s.files || []).length && data.files.length) { s.files = data.files; changed = true; }
      // Earlier steps go before the ones Kroog saw live.
      if (s.steps.length < 4 && data.steps.length) {
        const firstLive = s.steps[0] ? s.steps[0].t : Infinity;
        s.steps = [...data.steps.filter((x) => x.t < firstLive), ...s.steps].slice(-300);
        changed = true;
      }
      if (changed) filled += 1;
      s.imported = true;
    }
    // Not store.touch: that would stamp the chat as active right now.
    store.scheduleSave();
    store.emit('session', s);
  }
  return { source, found: chats.length, added, filled };
}
