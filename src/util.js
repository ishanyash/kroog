import crypto from 'node:crypto';

export const NO_OUTPUT = null;

export function shortId(length = 6) {
  return crypto.randomBytes(Math.ceil(length / 2) + 1).toString('hex').slice(0, length);
}

export function oneLine(value) {
  return String(value ?? '').replace(/\s+/g, ' ').trim();
}

export function truncate(value, max) {
  const text = oneLine(value);
  return text.length > max ? text.slice(0, max - 1).trimEnd() + '…' : text;
}

// Keeps line breaks, only trims the length.
export function clip(value, max) {
  const text = String(value ?? '').trim();
  return text.length > max ? text.slice(0, max - 1).trimEnd() + '…' : text;
}

export function baseName(p) {
  if (!p) return '';
  const parts = String(p).split(/[\\/]/).filter(Boolean);
  return parts.length ? parts[parts.length - 1] : String(p);
}

export function shortPath(p, segments = 2) {
  if (!p) return '';
  const parts = String(p).split(/[\\/]/).filter(Boolean);
  return parts.slice(-segments).join('/');
}

export function hostOf(url) {
  try {
    return new URL(url).host;
  } catch {
    return truncate(url, 40);
  }
}

export function wordCount(text) {
  const t = String(text ?? '').trim();
  return t ? t.split(/\s+/).length : 0;
}

export function safeEqual(a, b) {
  const x = Buffer.from(String(a ?? ''));
  const y = Buffer.from(String(b ?? ''));
  if (x.length !== y.length) return false;
  return crypto.timingSafeEqual(x, y);
}

// "Does this reply end by asking the person something?"
export function looksLikeQuestion(text) {
  const t = String(text ?? '').trim();
  if (!t) return false;
  const tail = t.slice(-320);
  const lastLine = tail.split('\n').map((l) => l.trim()).filter(Boolean).pop() || '';
  if (/\?\s*\**\s*$/.test(lastLine)) return true;
  return /\b(should I|shall I|do you want|would you like|which (one|option)|can you confirm|let me know)\b[^.]*\?/i.test(tail);
}

export function lastQuestion(text) {
  const t = String(text ?? '').trim();
  const sentences = t.split(/(?<=[.!?])\s+/).filter((s) => s.includes('?'));
  return truncate(sentences.length ? sentences[sentences.length - 1] : t.slice(-200), 220);
}

export function firstLine(text, max = 160) {
  const t = String(text ?? '').trim();
  const line = t.split('\n').map((l) => l.trim()).find((l) => l && !/^#+\s*$/.test(l)) || '';
  return truncate(line.replace(/^#+\s*/, '').replace(/\*\*/g, ''), max);
}

// Editors and Claude Code add tagged context to prompts, like <ide_opened_file>...</ide_opened_file>
// or <system-reminder>...</system-reminder>. These are not what you typed.
export const KROOG_PREFIX = 'Message from the user, sent from Kroog (their dashboard for Claude Code chats):';
// The same line from when Kroog was called Crew.
export const OLD_PREFIX = 'Message from the user, sent from Crew (their dashboard for Claude Code chats):';
export const isKroogMessage = (text) => { const t = String(text || '').trim(); return t.startsWith(KROOG_PREFIX) || t.startsWith(OLD_PREFIX); };
export function cleanPrompt(prompt) {
  let t = String(prompt ?? '');
  for (let i = 0; i < 4; i += 1) t = t.replace(/<([a-z][\w-]*)(\s[^>]*)?>[\s\S]*?<\/\1>/gi, ' ');
  t = t.replace(/<\/?[a-z][\w-]*(\s[^>]*)?\/?>/gi, ' ');
  const lead = t.trim();
  const pre = [KROOG_PREFIX, OLD_PREFIX].find((x) => lead.startsWith(x));
  if (pre) t = lead.slice(pre.length);
  return t.replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
}

export function titleFromPrompt(prompt) {
  // The first line of what was typed, then its first sentence.
  const cleaned = cleanPrompt(prompt).replace(/\[(Kroog|Crew) brief [a-z0-9]+\]/gi, '');
  const line = cleaned.split('\n').map((l) => l.trim()).find(Boolean) || '';
  const t = oneLine(line).trim();
  if (!t) return '';
  const firstSentence = t.split(/(?<=[.!?])\s/)[0];
  // A title reads better without the full stop at the end.
  return truncate(firstSentence.length > 12 ? firstSentence : t, 72).replace(/(?<!\.)\.$/, '');
}
