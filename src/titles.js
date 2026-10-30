// Chat titles people can read. Editors and Claude Code add tagged context to prompts
// ("<ide_opened_file>The user opened the file…", "[Browser disconnected…"), and older
// Kroog versions turned those into titles. This picks the first real message instead.
import { titleFromPrompt, cleanPrompt } from './util.js';
import { readTranscript } from './transcript.js';

const JUNK = [
  /^\s*</,
  /^\s*\[?browser (dis)?connect/i,
  /^the user opened the file/i,
  /^the user selected the/i,
  /^caveat:/i,
  /^untitled chat$/i,
  /^new chat$/i,
  /^<?command-name/i,
  /^\/(clear|compact|init|help|status|model|login)\b/i,
];

export function isJunkTitle(title) {
  const t = String(title || '').trim();
  if (!t) return true;
  return JUNK.some((re) => re.test(t));
}

// The first real thing the user asked in this chat, from its history file.
export function firstPromptOf(id) {
  try {
    const tx = readTranscript(id);
    if (!tx.found) return '';
    const first = tx.items.find((x) => x.kind === 'you' && x.via !== 'kroog' && !isJunkTitle(x.text));
    return first ? first.text : '';
  } catch {
    return '';
  }
}

// Gives a chat a readable title when its current one is junk. Returns true if changed.
export function retitle(s) {
  if (!isJunkTitle(s.title)) return false;
  const candidates = [firstPromptOf(s.id), cleanPrompt(s.lastPrompt || '')];
  for (const c of candidates) {
    const t = titleFromPrompt(c);
    if (t && !isJunkTitle(t)) {
      s.title = t;
      return true;
    }
  }
  if (s.title) {
    s.title = '';
    return true;
  }
  return false;
}

// A chat with no real message in it is a panel someone opened and closed. Not worth showing.
export function isEmptyChat(s) {
  if (s.status === 'working' || s.status === 'needs') return false;
  if (s.lastReply || (s.lastPrompt && !isJunkTitle(s.lastPrompt))) return false;
  return !(s.steps || []).some((st) => (st.kind === 'prompt' || st.kind === 'you') && !isJunkTitle(st.text));
}
