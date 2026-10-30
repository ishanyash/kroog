// Writes short reusable notes from a chat's last reply, with Kroog's AI helper (ai.js):
// Claude Code on your subscription, Kroog's own API key, or a local model.
import { clip, truncate } from './util.js';

export const NOTE_TYPES = ['Decision', 'Finding', 'How-to', 'Open question'];
export const NOTES_MODEL = 'claude-haiku-5-5';

const SYSTEM = `You turn one reply from a coding assistant into short notes for a personal library.
Note types:
- Decision: a choice that was made
- Finding: a fact learned about the code, data or tools
- How-to: a command or step that works
- Open question: something still undecided
Rules: at most 4 notes. Each is one plain sentence under 25 words and names the specific file, command, number or tool. Skip anything generic or obvious.
Reply with only a JSON array, for example [{"type":"Finding","text":"..."}]. Reply [] if nothing is worth keeping.`;

function parseNotes(text) {
  const start = text.indexOf('[');
  const end = text.lastIndexOf(']');
  if (start === -1 || end <= start) return [];
  try {
    const arr = JSON.parse(text.slice(start, end + 1));
    return Array.isArray(arr) ? arr : [];
  } catch {
    return [];
  }
}

export class NoteWriter {
  constructor({ store, getKey, getSettings }) {
    this.store = store;
    this.getKey = getKey;
    this.getSettings = getSettings;
    this.lastError = null;
    this.lastRun = new Map();
    this.ai = null;
  }

  enabled() {
    if (!this.getSettings().notesEnabled) return false;
    if (this.ai) return !['off', 'demo'].includes(this.ai.provider());
    return Boolean(this.getKey());
  }

  maybeWrite(session) {
    if (!this.enabled()) return;
    if ((session.lastReply || '').length < 160) return;
    const last = this.lastRun.get(session.id) || 0;
    if (Date.now() - last < 45000) return;
    this.lastRun.set(session.id, Date.now());
    this.write(session).catch((error) => {
      this.lastError = error.message;
      this.store.emit('info');
    });
  }

  async write(session) {
    if (!this.ai && !this.getKey()) return [];
    const plan = (session.plan || []).map((p) => `- [${p.state}] ${p.text}`).join('\n');
    const files = (session.files || []).slice(0, 15).join(', ');
    const input = [
      `Chat: ${session.title || 'Untitled'}`,
      `Project folder: ${session.project}`,
      plan ? `Plan:\n${plan}` : '',
      files ? `Files changed: ${files}` : '',
      `Last reply:\n${clip(session.lastReply, 6000)}`,
    ].filter(Boolean).join('\n\n');

    let text = '';
    if (this.ai) {
      text = (await this.ai.complete({ system: SYSTEM, prompt: input, maxTokens: 700 })) || '';
    } else {
      const response = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: { 'x-api-key': this.getKey(), 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
        body: JSON.stringify({ model: NOTES_MODEL, max_tokens: 700, system: SYSTEM, messages: [{ role: 'user', content: input }] }),
      });
      if (!response.ok) {
        const body = await response.text().catch(() => '');
        throw new Error(`The notes request failed (${response.status}). ${truncate(body, 160)}`);
      }
      const data = await response.json();
      text = (data.content || []).filter((b) => b.type === 'text').map((b) => b.text).join('');
    }
    const added = [];
    for (const n of parseNotes(text).slice(0, 4)) {
      if (!n || !NOTE_TYPES.includes(n.type) || !n.text) continue;
      const note = this.store.addNote({
        sessionId: session.id,
        chatTitle: session.title || 'Untitled chat',
        project: session.project,
        cwd: session.cwd,
        type: n.type,
        text: truncate(n.text, 300),
      });
      if (note) added.push(note);
    }
    this.lastError = null;
    this.store.emit('info');
    return added;
  }
}
