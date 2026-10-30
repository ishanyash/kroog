import fs from 'node:fs';
import { EventEmitter } from 'node:events';
import { baseName, shortId, titleFromPrompt, cleanPrompt } from './util.js';

const MAX_STEPS = 300;
const KEEP_DAYS = 14;

function countWords(text) {
  return String(text || '').trim().split(/\s+/).filter(Boolean).length;
}

function emptyData() {
  return { version: 1, sessions: {}, notes: [], briefs: {}, lastEvents: {} };
}

export class Store extends EventEmitter {
  constructor({ file = null } = {}) {
    super();
    this.setMaxListeners(100);
    this.file = file;
    this.data = emptyData();
    this.saveTimer = null;
    if (file) this.load();
  }

  load() {
    try {
      const saved = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      if (saved && typeof saved === 'object' && saved.sessions) this.data = { ...emptyData(), ...saved };
    } catch {
      return;
    }
    const cutoff = Date.now() - KEEP_DAYS * 86400000;
    for (const [id, s] of Object.entries(this.data.sessions)) {
      if ((s.lastAt || 0) < cutoff) {
        delete this.data.sessions[id];
        continue;
      }
      // Chats run by Kroog when it was called Crew.
      if (s.owner === 'crew') s.owner = 'kroog';
      if (s.kind === 'crew') { s.kind = 'kroog'; s.app = 'Kroog'; s.place = 'Kroog'; s.surface = 'kroog'; }
      // Titles made from editor tags by older versions.
      if (/^\s*</.test(s.title || '')) s.title = titleFromPrompt(s.title) || titleFromPrompt(s.lastPrompt) || '';
      if (/^\s*</.test(s.lastPrompt || '')) s.lastPrompt = cleanPrompt(s.lastPrompt);
      // Requests that were waiting on an open connection can't survive a restart.
      s.holding = null;
      if (s.needs && s.needs.kind === 'permission') {
        s.needs = { ...s.needs, inEditor: true, deadline: null };
      }
    }
  }

  scheduleSave() {
    if (!this.file) return;
    clearTimeout(this.saveTimer);
    this.saveTimer = setTimeout(() => this.saveNow(), 400);
  }

  saveNow() {
    if (!this.file) return;
    clearTimeout(this.saveTimer);
    const tmp = `${this.file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(this.data), { mode: 0o600 });
    fs.renameSync(tmp, this.file);
  }

  get sessions() {
    return this.data.sessions;
  }

  session(id) {
    return this.data.sessions[id] || null;
  }

  ensureSession(id, cwd) {
    let s = this.data.sessions[id];
    if (!s) {
      const t = Date.now();
      s = {
        id,
        title: '',
        cwd: cwd || '',
        project: baseName(cwd) || 'Unknown folder',
        app: 'Unknown app',
        kind: 'unknown',
        place: 'Unknown app',
        editor: null,
        surface: 'unknown',
        status: 'idle',
        needs: null,
        since: t,
        startedAt: t,
        lastAt: t,
        now: '',
        lastPrompt: '',
        lastReply: '',
        steps: [],
        plan: [],
        helpers: {},
        files: [],
        queue: [],
        drive: false,
        holding: null,
        stopRequested: false,
        blockStreak: 0,
        turns: 0,
        archived: false,
        // What this chat was given from other chats: briefs and project memory.
        inputs: [],
      };
      this.data.sessions[id] = s;
    } else if (cwd && cwd !== s.cwd) {
      s.cwd = cwd;
      s.project = baseName(cwd) || s.project;
    }
    return s;
  }

  setStatus(s, status, needs = s.needs) {
    if (s.status !== status) s.since = Date.now();
    s.status = status;
    s.needs = needs;
  }

  addStep(s, step) {
    s.steps.push({ id: shortId(8), t: Date.now(), ...step });
    if (s.steps.length > MAX_STEPS) s.steps.splice(0, s.steps.length - MAX_STEPS);
  }

  touch(s) {
    s.lastAt = Date.now();
    this.scheduleSave();
    this.emit('session', s);
  }

  noteEvent(event) {
    this.data.lastEvents[event] = Date.now();
  }

  addNote(note) {
    const exists = this.data.notes.some((n) => n.text.toLowerCase() === note.text.toLowerCase() && n.project === note.project);
    if (exists) return null;
    const full = { id: shortId(10), t: Date.now(), remembered: false, ...note };
    this.data.notes.push(full);
    if (this.data.notes.length > 2000) this.data.notes.splice(0, this.data.notes.length - 2000);
    this.scheduleSave();
    this.emit('notes');
    return full;
  }

  updateNote(id, patch) {
    const note = this.data.notes.find((n) => n.id === id);
    if (!note) return null;
    Object.assign(note, patch);
    this.scheduleSave();
    this.emit('notes');
    return note;
  }

  removeNote(id) {
    const before = this.data.notes.length;
    this.data.notes = this.data.notes.filter((n) => n.id !== id);
    if (this.data.notes.length !== before) {
      this.scheduleSave();
      this.emit('notes');
    }
  }

  saveBrief(text, goal, extra = {}) {
    const id = shortId(6);
    this.data.briefs[id] = {
      id,
      text,
      goal,
      t: Date.now(),
      usedBy: null,
      // Lineage: the chats and notes this brief was made from, and where it was sent.
      sources: Array.isArray(extra.sources) ? extra.sources.slice(0, 20) : [],
      notes: Array.isArray(extra.notes) ? extra.notes.slice(0, 40) : [],
      target: extra.target || 'new',
      targetId: extra.targetId || null,
      editor: extra.editor || null,
    };
    const ids = Object.keys(this.data.briefs);
    if (ids.length > 200) delete this.data.briefs[ids[0]];
    this.scheduleSave();
    this.emit('briefs');
    return this.data.briefs[id];
  }

  useBrief(id, sessionId) {
    const brief = this.data.briefs[id];
    if (!brief) return null;
    brief.usedBy = sessionId;
    brief.usedAt = Date.now();
    this.scheduleSave();
    this.emit('briefs');
    return brief;
  }

  // Briefs sent in the last two hours that no chat has picked up yet.
  pendingBriefs() {
    const cutoff = Date.now() - 2 * 3600 * 1000;
    return Object.values(this.data.briefs)
      .filter((b) => !b.usedBy && b.t > cutoff)
      .map((b) => ({ id: b.id, goal: b.goal, sources: b.sources || [], notes: b.notes || [], target: b.target || 'new', targetId: b.targetId || null, editor: b.editor || null, t: b.t, words: countWords(b.text) }));
  }

  rememberedFor(cwd) {
    return this.data.notes.filter((n) => n.remembered && n.cwd && n.cwd === cwd);
  }
}
