// Kroog's small AI helper. It writes:
//   - a short summary of each chat (shown when you hover a chat, and in its panel),
//     with one suggested next step,
//   - a brief that merges several chats into one, for a handoff,
//   - notes for the Library (see notes.js).
//
// Where the model runs, in order of preference ("auto"):
//   claude  Claude Code on this Mac with Haiku, on your Claude subscription. Hooks off,
//           no tools, nothing saved, so it never shows up as a chat.
//   api     Kroog's own Anthropic API key (~/.kroog/.env), Claude Haiku 5.5.
//   ollama  a local model through Ollama (http://127.0.0.1:11434). Free and offline.
import { ask as askClaude } from './claude-cli.js';
import { clip, truncate } from './util.js';

export const API_MODEL = 'claude-haiku-5-5';

const SUMMARY_SYSTEM = `You summarise one coding chat for its owner, who wants to know in a few seconds what has been done and what they can do from here. Be concrete: name files, commands, numbers. Plain words, no hype, no emojis, nothing made up.
Reply with only JSON: {"gist": "...", "done": ["...", "..."], "next": ["...", "..."], "keywords": ["...", "..."]}
- gist: one line, at most 10 words: what it is about and where it stands, like "Cost check added; orders model test still failing". No full stop. Do not start with "The user" or "This chat".
- done: 1 to 3 lines, each at most 14 words, what has actually been done so far (the outcome, not the steps). Empty if nothing is done yet.
- next: 0 to 2 lines, each at most 14 words, what the owner could do from here: what is left, open, failing, or a natural follow-up. Empty if nothing is left.
- keywords: 2 to 4 short lowercase keywords (files, tools, topics), each at most 2 words.`;

const BRIEF_SYSTEM = `You merge notes from one or more coding chats into a single brief for a new or running chat. The reader is another Claude Code chat that has none of this context.
Write plain text, under 300 words, with these headings on their own lines: Goal, What is done, Facts to keep (files, commands, decisions, numbers), Open questions.
Use only facts from the input. Keep names, paths and numbers exact. No preamble.`;

function parseJson(text) {
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start === -1 || end <= start) return null;
  try { return JSON.parse(text.slice(start, end + 1)); } catch { return null; }
}

export function describeChat(s, { notes = [], replyChars = 3000 } = {}) {
  const plan = (s.plan || []).map((p) => `- [${p.state}] ${p.text}`).join('\n');
  const steps = (s.steps || []).filter((x) => x.kind === 'tool' || x.kind === 'prompt' || x.kind === 'you' || x.kind === 'error').slice(-25)
    .map((x) => `- ${x.kind === 'tool' ? '' : `${x.kind}: `}${truncate(x.text, 160)}${x.state === 'failed' ? ' (failed)' : ''}`).join('\n');
  return [
    `Chat: ${s.title || 'Untitled'}`,
    `Project folder: ${s.project || ''}`,
    `Status: ${s.status}${s.needs && s.needs.title ? ` (${truncate(s.needs.title, 120)})` : ''}`,
    s.lastPrompt ? `Latest request:\n${clip(s.lastPrompt, 1200)}` : '',
    plan ? `Plan:\n${plan}` : '',
    steps ? `Recent steps:\n${steps}` : '',
    (s.files || []).length ? `Files changed: ${s.files.slice(-15).join(', ')}` : '',
    notes.length ? `Notes:\n${notes.map((n) => `- ${n.type}: ${n.text}`).join('\n')}` : '',
    s.lastReply ? `Last reply:\n${clip(s.lastReply, replyChars)}` : '',
  ].filter(Boolean).join('\n\n');
}

export class AiHelper {
  constructor({ store, engine, runner, getSettings, getKey, demo = false }) {
    this.store = store;
    this.runner = runner;
    this.getSettings = getSettings;
    this.getKey = getKey;
    this.demo = demo;
    this.queue = [];
    this.busy = 0;
    this.pending = new Set();
    this.lastError = null;
    this.day = '';
    this.used = 0;
    if (engine) engine.ai = this;
  }

  // Which helper is in use right now, after "auto" is worked out.
  provider() {
    const want = this.getSettings().aiProvider || 'auto';
    if (this.demo) return want === 'off' ? 'off' : 'demo';
    if (want === 'off') return 'off';
    if (want === 'claude') return this.runner && this.runner.available() ? 'claude' : 'off';
    if (want === 'api') return this.getKey() ? 'api' : 'off';
    if (want === 'ollama') return 'ollama';
    if (this.runner && this.runner.available()) return 'claude';
    if (this.getKey()) return 'api';
    return 'off';
  }

  status() {
    return { provider: this.provider(), want: this.getSettings().aiProvider || 'auto', usedToday: this.used, limit: this.limit(), error: this.lastError, waiting: this.queue.length + this.busy };
  }

  limit() {
    return Math.max(10, Math.min(Number(this.getSettings().aiDailyLimit) || 200, 2000));
  }

  count() {
    const day = new Date().toDateString();
    if (day !== this.day) { this.day = day; this.used = 0; }
    if (this.used >= this.limit()) throw new Error(`Kroog used its ${this.limit()} AI calls for today. Change the limit in setup.`);
    this.used += 1;
  }

  async complete({ system, prompt, maxTokens = 700 }) {
    const p = this.provider();
    if (p === 'off') throw new Error('The AI helper is off. Turn it on in setup.');
    if (p === 'demo') return null;
    this.count();
    if (p === 'claude') return askClaude(this.runner.cli.path, { system, prompt, model: this.getSettings().aiClaudeModel || 'haiku' });
    if (p === 'api') {
      const response = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: { 'x-api-key': this.getKey(), 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
        body: JSON.stringify({ model: API_MODEL, max_tokens: maxTokens, system, messages: [{ role: 'user', content: prompt }] }),
      });
      if (!response.ok) throw new Error(`The API request failed (${response.status}). ${truncate(await response.text().catch(() => ''), 160)}`);
      const data = await response.json();
      return (data.content || []).filter((b) => b.type === 'text').map((b) => b.text).join('');
    }
    // Ollama, on this Mac.
    const base = (this.getSettings().ollamaUrl || 'http://127.0.0.1:11434').replace(/\/$/, '');
    let response;
    try {
      response = await fetch(`${base}/api/chat`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ model: this.getSettings().ollamaModel || 'llama3.2', stream: false, messages: [{ role: 'system', content: system }, { role: 'user', content: prompt }], options: { num_predict: maxTokens } }),
      });
    } catch {
      throw new Error('Ollama is not running on this Mac. Start it, or pick another helper in setup.');
    }
    if (!response.ok) throw new Error(`Ollama answered ${response.status}. Is the model "${this.getSettings().ollamaModel || 'llama3.2'}" pulled?`);
    const data = await response.json();
    return String((data.message && data.message.content) || '');
  }

  // ---- summaries ----------------------------------------------------------------------

  basis(s) {
    return `${s.status}|${(s.steps || []).length}|${(s.lastReply || '').length}`;
  }

  fresh(s) {
    return Boolean(s.ai && s.ai.basis === this.basis(s));
  }

  // Ask for a summary. Runs one at a time; the result arrives with the chat's next update.
  summarize(id, { force = false } = {}) {
    const s = this.store.session(id);
    if (!s) return { ok: false, error: 'That chat is gone.' };
    const p = this.provider();
    if (p === 'off') return { ok: false, error: 'The AI helper is off. Turn it on in setup.' };
    if (!force && this.fresh(s)) return { ok: true, cached: true };
    if (!s.lastReply && !s.lastPrompt) return { ok: false, error: 'Nothing to summarise yet.' };
    if (!this.pending.has(id)) {
      this.pending.add(id);
      this.queue.push(id);
      s.aiPending = true;
      this.store.touch(s);
      this.pump();
    }
    return { ok: true, queued: true };
  }

  // After a chat finishes a turn, refresh its summary if the setting says so.
  afterTurn(s) {
    if ((this.getSettings().aiSummaries || 'finish') !== 'finish') return;
    if (this.provider() === 'off') return;
    setTimeout(() => this.summarize(s.id), 300);
  }

  pump() {
    while (this.busy < 1 && this.queue.length) {
      const id = this.queue.shift();
      this.busy += 1;
      this.summarizeNow(id)
        .catch((error) => { this.lastError = error.message; })
        .finally(() => {
          this.busy -= 1;
          this.pending.delete(id);
          const s = this.store.session(id);
          if (s) { s.aiPending = false; this.store.touch(s); }
          this.store.emit('info');
          this.pump();
        });
    }
  }

  async summarizeNow(id) {
    const s = this.store.session(id);
    if (!s) return;
    const basis = this.basis(s);
    let out;
    if (this.provider() === 'demo') {
      out = demoSummary(s);
    } else {
      const notes = this.store.data.notes.filter((n) => n.sessionId === s.id).slice(-6);
      const text = await this.complete({ system: SUMMARY_SYSTEM, prompt: describeChat(s, { notes }), maxTokens: 400 });
      out = parseJson(text || '') || { gist: '', summary: truncate(text, 400), next: '' };
    }
    const lines = (xs, max) => (Array.isArray(xs) ? xs : typeof xs === 'string' ? xs.split('\n') : [])
      .map((x) => truncate(String(x || '').replace(/^[-*\u2022]\s*/, '').trim(), 140)).filter(Boolean).slice(0, max);
    s.ai = {
      gist: truncate(String(out.gist || out.summary || '').split('\n')[0].replace(/\.$/, ''), 90),
      done: lines(out.done, 3),
      next: lines(out.next, 2),
      keywords: (Array.isArray(out.keywords) ? out.keywords : []).map((k) => truncate(String(k).toLowerCase(), 24)).filter(Boolean).slice(0, 4),
      at: Date.now(),
      basis,
      by: this.provider(),
    };
    this.lastError = null;
  }

  // ---- briefs -------------------------------------------------------------------------

  async writeBrief({ sources = [], notes = [], goal = '' }) {
    const chats = sources.map((id) => this.store.session(id)).filter(Boolean);
    const extra = this.store.data.notes.filter((n) => notes.includes(n.id));
    if (!chats.length && !extra.length) throw new Error('Add at least one chat or note first.');
    if (this.provider() === 'demo') return demoBrief(chats, extra, goal);
    const parts = [
      goal ? `Goal of the new work: ${goal}` : 'Goal of the new work: not given; infer it from the chats.',
      ...chats.map((s, i) => `--- Chat ${i + 1} ---\n${describeChat(s, { notes: this.store.data.notes.filter((n) => n.sessionId === s.id).slice(-6), replyChars: 2500 })}`),
      extra.length ? `--- Notes from the library ---\n${extra.map((n) => `- ${n.type}: ${n.text} (${n.project})`).join('\n')}` : '',
    ].filter(Boolean);
    const text = await this.complete({ system: BRIEF_SYSTEM, prompt: clip(parts.join('\n\n'), 40000), maxTokens: 900 });
    return String(text || '').trim();
  }
}

// ---- demo mode: no model, just plain text built from the chat --------------------------

function demoSummary(s) {
  const done = (s.plan || []).filter((p) => p.state === 'done');
  const todo = (s.plan || []).filter((p) => p.state !== 'done');
  return {
    gist: todo.length ? `${done.length} step${done.length === 1 ? '' : 's'} done; next: ${truncate(todo[0].text, 40)}` : truncate(s.lastReply ? s.lastReply.split('\n')[0] : s.title || 'A chat', 70),
    done: done.slice(-3).map((p) => p.text),
    next: todo.slice(0, 2).map((p) => p.text),
    keywords: [...new Set((s.files || []).slice(-3).map((f) => f.split('/').pop()).concat(s.project ? [s.project] : []))].slice(0, 4),
  };
}

function demoBrief(chats, notes, goal) {
  const lines = ['Goal', goal || 'Carry on from the chats below.', '', 'What is done'];
  for (const s of chats) lines.push(`- ${s.title}: ${truncate(s.lastReply || s.lastPrompt || '', 160)}`);
  lines.push('', 'Facts to keep');
  for (const s of chats) for (const f of (s.files || []).slice(-3)) lines.push(`- ${f}`);
  for (const n of notes) lines.push(`- ${n.type}: ${n.text}`);
  lines.push('', 'Open questions', '- (demo) A real run would list them here.');
  return lines.join('\n');
}
