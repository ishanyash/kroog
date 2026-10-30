// The real conversation of a chat, read from Claude Code's own history file
// (~/.claude/projects/<folder>/<chat id>.jsonl) as it grows. Kroog shows it like Claude Code
// does: your messages, Claude's replies, and each tool step on one line.
// The format is internal to Claude Code, so anything unknown is skipped.
import fs from 'node:fs';
import path from 'node:path';
import { claudeDir } from './config.js';
import { describeTool } from './describe.js';
import { cleanPrompt, isKroogMessage } from './util.js';

const TAIL_BYTES = 3 * 1024 * 1024;
const MAX_ITEMS = 160;
const where = new Map();
const cache = new Map();

export function findTranscript(id) {
  if (!/^[A-Za-z0-9_-]{6,80}$/.test(String(id || ''))) return null;
  const known = where.get(id);
  if (known && fs.existsSync(known)) return known;
  const root = path.join(claudeDir(), 'projects');
  let dirs = [];
  try { dirs = fs.readdirSync(root); } catch { return null; }
  for (const d of dirs) {
    const f = path.join(root, d, `${id}.jsonl`);
    if (fs.existsSync(f)) {
      where.set(id, f);
      return f;
    }
  }
  return null;
}

function readTail(file, size) {
  if (size <= TAIL_BYTES) return { text: fs.readFileSync(file, 'utf8'), cut: false };
  const fd = fs.openSync(file, 'r');
  try {
    const buf = Buffer.alloc(TAIL_BYTES);
    fs.readSync(fd, buf, 0, TAIL_BYTES, size - TAIL_BYTES);
    const text = buf.toString('utf8');
    return { text: text.slice(text.indexOf('\n') + 1), cut: true };
  } finally {
    fs.closeSync(fd);
  }
}

// A message from another session arrives wrapped in Claude Code's own note; keep the body.
function peerBody(text) {
  const t = String(text || '');
  const start = t.indexOf(':\n');
  let body = start >= 0 && /^Another Claude session|^A peer session/.test(t) ? t.slice(start + 2) : t;
  const note = body.indexOf('\n\nThis came from another Claude session');
  if (note >= 0) body = body.slice(0, note);
  return body.trim();
}

function textOf(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content.filter((b) => b && b.type === 'text').map((b) => b.text || '').join('\n');
}

export function parse(entries) {
  const items = [];
  const tools = new Map();
  for (const e of entries) {
    if (!e || (e.type !== 'user' && e.type !== 'assistant' && e.type !== 'system')) continue;
    if (e.isSidechain) continue;
    const t = Date.parse(e.timestamp || '') || 0;
    if (e.type === 'system') {
      if (e.subtype === 'compact_boundary' || /compact/i.test(String(e.content || ''))) items.push({ kind: 'note', text: 'The conversation was compacted', t });
      continue;
    }
    const msg = e.message || {};
    if (e.type === 'user') {
      const c = msg.content;
      if (Array.isArray(c) && c.some((b) => b && b.type === 'tool_result')) {
        for (const b of c) {
          const item = b && b.type === 'tool_result' ? tools.get(b.tool_use_id) : null;
          if (item) item.state = b.is_error ? 'failed' : 'ok';
        }
        continue;
      }
      const peer = e.origin && e.origin.kind === 'peer';
      if ((e.isMeta && !peer) || e.isCompactSummary) continue;
      let text = textOf(c);
      if (peer) text = peerBody(text);
      const viaKroog = isKroogMessage(text);
      text = cleanPrompt(text);
      if (!text || text.startsWith('Caveat:')) continue;
      items.push({ kind: 'you', text, t, via: viaKroog ? 'kroog' : peer ? 'session' : '' });
      continue;
    }
    // Assistant: text and tool calls, in order.
    for (const b of Array.isArray(msg.content) ? msg.content : []) {
      if (!b) continue;
      if (b.type === 'text' && b.text && b.text.trim()) {
        const last = items[items.length - 1];
        if (last && last.kind === 'claude' && last.id === msg.id) last.text += `\n\n${b.text.trim()}`;
        else items.push({ kind: 'claude', text: b.text.trim(), t, id: msg.id || null });
      } else if (b.type === 'tool_use') {
        const item = { kind: 'tool', text: describeTool(b.name, b.input || {}), tool: b.name, state: 'running', t };
        tools.set(b.id, item);
        items.push(item);
      }
    }
  }
  return items;
}

// The last part of a chat's conversation. Cached until the file changes.
export function readTranscript(id) {
  const file = findTranscript(id);
  if (!file) return { found: false, items: [] };
  let st;
  try { st = fs.statSync(file); } catch { return { found: false, items: [] }; }
  const key = `${st.size}:${st.mtimeMs}`;
  const hit = cache.get(id);
  if (hit && hit.key === key) return hit.value;
  const { text, cut } = readTail(file, st.size);
  const entries = [];
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    try { entries.push(JSON.parse(line)); } catch { /* a line cut at the edge */ }
  }
  let items = parse(entries);
  const more = cut || items.length > MAX_ITEMS;
  items = items.slice(-MAX_ITEMS).map((x) => ({ ...x, text: x.text.length > 8000 ? `${x.text.slice(0, 8000)}…` : x.text }));
  const value = { found: true, items, more, at: st.mtimeMs };
  cache.set(id, { key, value });
  if (cache.size > 50) cache.delete(cache.keys().next().value);
  return value;
}
