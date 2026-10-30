// Split markdown into chunks by heading, keeping the heading path as context.
import path from 'node:path';

export const CHUNK_MAX = 1200;
const OVERLAP = 120;

export function frontmatter(text) {
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(text);
  if (!m) return { data: {}, body: text };
  const data = {};
  for (const line of m[1].split(/\r?\n/)) {
    const kv = /^([A-Za-z0-9_-]+)\s*:\s*(.*)$/.exec(line);
    if (kv) data[kv[1]] = kv[2].replace(/^["']|["']$/g, '').trim();
  }
  return { data, body: text.slice(m[0].length) };
}

function splitLong(text) {
  if (text.length <= CHUNK_MAX) return [text];
  const out = [];
  const paras = text.split(/\n{2,}/);
  let cur = '';
  for (const p of paras) {
    if (cur && cur.length + p.length + 2 > CHUNK_MAX) {
      out.push(cur);
      cur = cur.slice(-OVERLAP);
    }
    if (p.length > CHUNK_MAX) {
      for (let i = 0; i < p.length; i += CHUNK_MAX - OVERLAP) {
        const piece = p.slice(i, i + CHUNK_MAX);
        if (cur) { out.push(cur); cur = ''; }
        out.push(piece);
      }
      continue;
    }
    cur = cur ? `${cur}\n\n${p}` : p;
  }
  if (cur.trim()) out.push(cur);
  return out;
}

// Returns { title, chunks: [{ heading, text }] }.
export function chunkMarkdown(text, file = '') {
  const { data, body } = frontmatter(String(text || ''));
  const base = path.basename(file || 'note');
  // Skill and agent folders are named by their folder, not SKILL.md.
  const named = /^(SKILL|README|index)\.md$/i.test(base) ? `${path.basename(path.dirname(file))}/${base}` : base;
  const title = data.name ? `${data.name}${data.description ? `: ${data.description}` : ''}` : named;
  const lines = body.split(/\r?\n/);
  const sections = [];
  const stack = [];
  let cur = { path: [], lines: [] };
  let inFence = false;
  for (const line of lines) {
    if (/^\s*(```|~~~)/.test(line)) inFence = !inFence;
    const h = !inFence && /^(#{1,6})\s+(.+?)\s*#*\s*$/.exec(line);
    if (h) {
      if (cur.lines.join('').trim()) sections.push(cur);
      const level = h[1].length;
      while (stack.length && stack[stack.length - 1].level >= level) stack.pop();
      stack.push({ level, text: h[2] });
      cur = { path: stack.map((x) => x.text), lines: [line] };
    } else cur.lines.push(line);
  }
  if (cur.lines.join('').trim()) sections.push(cur);
  const chunks = [];
  const lead = data.description && !data.name ? data.description : '';
  for (const s of sections) {
    const heading = [named, ...s.path].join(' › ');
    for (const piece of splitLong(s.lines.join('\n').trim())) {
      if (piece.trim().length < 3) continue;
      chunks.push({ heading, text: lead && !chunks.length ? `${lead}\n\n${piece}` : piece });
    }
  }
  if (!chunks.length && data.description) chunks.push({ heading: named, text: data.description });
  return { title, chunks };
}
