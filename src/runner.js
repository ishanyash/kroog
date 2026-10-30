// Runs Claude Code chats from Kroog, without an editor. A chat Kroog runs is a normal Claude
// Code chat: same login, same settings and hooks, saved in the same history, so it can be
// opened in VS Code or Cursor later and carried on there.
//
// Three ways to start a turn:
//   new     a fresh chat in a project folder (for example from a handoff brief)
//   resume  the next turn of a chat Kroog owns (or one that was closed in the editor)
//   fork    a branch of a chat that may still be open in the editor. The editor keeps its
//           copy untouched, and the branch is a new chat linked to it in the lineage.
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import { findClaude, claudeVersion, startTurn } from './claude-cli.js';
import { truncate, clip, firstLine, titleFromPrompt, baseName } from './util.js';
import { describeTool, applyPlanTool, fileTouched } from './describe.js';
import { EditorOpener } from './editor.js';

const MAX_RUNNING = 4;
const words = (t) => String(t || '').trim().split(/\s+/).filter(Boolean).length;

export class Runner {
  constructor({ store, engine, getSettings, demo = false, opener = null, editor = null }) {
    this.store = store;
    this.engine = engine;
    this.getSettings = getSettings;
    this.demo = demo;
    this.procs = new Map();
    // Opens a vscode:// link on this Mac (Kroog runs here, so it can, without the browser).
    this.open = opener || ((url) => {
      if (demo) return;
      const cmd = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'explorer' : 'xdg-open';
      try { spawn(cmd, [url], { stdio: 'ignore', detached: true }).unref(); } catch { /* best effort */ }
    });
    // Opens folders and chats in the editor (through its command when it has one).
    this.editor = editor || new EditorOpener({ open: this.open, demo });
    this.cli = null;
    this.version = null;
    this.lastError = null;
    engine.runner = this;
  }

  async detect() {
    if (this.demo) {
      this.cli = { path: 'demo', from: 'demo' };
      this.version = 'demo';
      return this.status();
    }
    this.cli = findClaude(this.getSettings().claudePath || '');
    this.version = this.cli ? await claudeVersion(this.cli.path) : null;
    if (this.cli && !this.version) this.lastError = 'Found Claude Code but it did not start. Check the path in setup.';
    else this.lastError = null;
    return this.status();
  }

  status() {
    return {
      found: Boolean(this.cli && this.version),
      path: this.cli ? this.cli.path : null,
      from: this.cli ? this.cli.from : null,
      version: this.version,
      running: this.procs.size,
      error: this.lastError,
    };
  }

  available() {
    return Boolean(this.cli && this.version);
  }

  isRunning(id) {
    return this.procs.has(id);
  }

  // ---- start a turn -----------------------------------------------------------------

  run({ mode = 'new', id = null, from = null, cwd = '', prompt = '', title = '', input = null, label = '', permissionMode, then = '', editor = '', model = '' } = {}) {
    if (!this.available()) return { ok: false, error: 'Kroog could not find Claude Code on this Mac. See setup.' };
    const text = String(prompt || '').trim();
    if (!text) return { ok: false, error: 'Type a message first.' };
    if (text.length > 60000) return { ok: false, error: 'That is too long for one message.' };
    if (this.procs.size >= MAX_RUNNING) return { ok: false, error: `Kroog already runs ${MAX_RUNNING} chats. Wait for one to finish.` };

    const store = this.store;
    let source = null;
    if (mode === 'resume') {
      if (!id || !store.session(id)) return { ok: false, error: 'That chat is gone.' };
      if (this.procs.has(id)) return { ok: false, error: 'This chat is already running.' };
    } else if (mode === 'fork') {
      source = store.session(from);
      if (!source) return { ok: false, error: 'That chat is gone.' };
      id = randomUUID();
      cwd = source.cwd;
    } else {
      id = randomUUID();
    }
    const s = mode === 'resume' ? store.session(id) : store.ensureSession(id, cwd);
    if (!s.cwd || (!this.demo && !fs.existsSync(s.cwd))) return { ok: false, error: `The project folder ${s.cwd || '(none)'} is not on this Mac.` };

    if (mode !== 'resume') {
      Object.assign(s, {
        title: title || (source ? truncate(`${source.title || 'Untitled chat'}, continued`, 80) : titleFromPrompt(text)),
        plan: source ? [...(source.plan || [])] : [],
        files: source ? [...(source.files || [])] : [],
        startedAt: Date.now(),
      });
      if (source) this.engine.recordInput(s, { kind: 'continue', from: [source.id], words: 0 });
      if (input) this.engine.recordInput(s, input);
    }
    // A chat Kroog created is Kroog's. A chat from the editor that Kroog carries on keeps its
    // own label (VS Code, Cursor): it is still that chat, and the editor can open it again.
    if (mode !== 'resume' || !s.app || s.app === 'Unknown app') {
      Object.assign(s, { owner: 'kroog', app: 'Kroog', kind: 'kroog', place: 'Kroog', surface: 'kroog' });
    }
    Object.assign(s, {
      editor: s.editor || this.getSettings().defaultEditor || 'vscode',
      archived: false, drive: false, holding: null, stopRequested: false,
      lastPrompt: clip(input && label ? label : text, 2000), now: 'Starting', hookSeen: false, skipPromptStep: true,
    });
    store.setStatus(s, 'working', null);
    store.addStep(s, { kind: 'prompt', text: label || truncate(text, 400) });
    if (source) store.addStep(source, { kind: 'info', text: 'Kroog continued this chat as a branch' });
    if (source) store.touch(source);
    store.touch(s);

    // Start here, then hand over to the editor: open the project folder there now, so its
    // window is ready when the chat is.
    if (then === 'editor') {
      const ed = editor || s.editor || this.getSettings().defaultEditor || 'vscode';
      s.editor = ed;
      s.thenEditor = true;
      if (mode === 'new') this.editor.openFolder(ed, s.cwd);
      s.now = `Starting it here; it opens in ${ed === 'cursor' ? 'Cursor' : 'VS Code'} next`;
    }
    const pm = permissionMode || s.permissionModeKroog || this.getSettings().kroogPermissionMode || 'default';
    s.permissionModeKroog = pm;
    if (this.demo) this.fakeTurn(s, text);
    else this.spawnTurn(s, { mode, from, text, pm, model });
    return { ok: true, id, delivered: 'kroog', mode };
  }

  spawnTurn(s, { mode, from, text, pm, model = '' }) {
    let child;
    try {
      child = startTurn(this.cli.path, { mode, id: s.id, from, cwd: s.cwd, prompt: text, permissionMode: pm, model });
    } catch (error) {
      this.finish(s, { error: `Could not start Claude Code: ${error.message}` });
      return;
    }
    const run = { child, buf: '', err: '', result: null, killed: false };
    this.procs.set(s.id, run);
    child.stdout.on('data', (d) => {
      run.buf += d;
      let i;
      while ((i = run.buf.indexOf('\n')) >= 0) {
        const line = run.buf.slice(0, i).trim();
        run.buf = run.buf.slice(i + 1);
        if (line) this.onLine(s, run, line);
      }
    });
    child.stderr.on('data', (d) => { run.err = (run.err + d).slice(-4000); });
    child.on('error', (e) => { run.err += e.message; });
    child.on('close', (code) => {
      this.procs.delete(s.id);
      if (run.buf.trim()) this.onLine(s, run, run.buf.trim());
      const r = run.result;
      if (run.killed) this.finish(s, { stopped: true });
      else if (r && !r.is_error) this.finish(s, { reply: r.result || '' });
      else this.finish(s, { error: r ? String(r.result || r.subtype || 'The chat stopped with an error.') : (run.err.trim().split('\n').pop() || `Claude Code exited (${code}).`) });
    });
  }

  // The stream from Claude Code. Hooks already give Kroog every step when it is linked;
  // without hooks, Kroog fills the steps in from here.
  onLine(s, run, line) {
    let m;
    try { m = JSON.parse(line); } catch { return; }
    if (m.type === 'result') { run.result = m; return; }
    if (m.type === 'system' && m.subtype === 'init') {
      if (s.now === 'Starting') { s.now = 'Thinking'; this.store.touch(s); }
      return;
    }
    if (s.hookSeen) return;
    if (m.type === 'assistant' && m.message && Array.isArray(m.message.content) && !m.parent_tool_use_id) {
      for (const b of m.message.content) {
        if (b.type === 'tool_use') {
          const text = describeTool(b.name, b.input || {});
          s.now = text;
          this.store.addStep(s, { kind: 'tool', text, tool: b.name, toolUseId: b.id, state: 'ok' });
          s.plan = applyPlanTool(s.plan, b.name, b.input || {});
          const f = fileTouched(b.name, b.input || {});
          if (f && !s.files.includes(f)) s.files.push(f);
        }
      }
      this.store.touch(s);
    }
  }

  finish(s, { reply = '', error = '', stopped = false }) {
    const store = this.store;
    s.skipPromptStep = false;
    s.now = '';
    if (error) {
      store.setStatus(s, 'error', { kind: 'error', title: truncate(error, 220), since: Date.now() });
      store.addStep(s, { kind: 'error', text: truncate(error, 220) });
      this.lastError = truncate(error, 220);
    } else {
      if (reply && reply !== s.lastReply) {
        s.lastReply = clip(reply, 6000);
        if (!s.hookSeen) store.addStep(s, { kind: 'reply', text: firstLine(reply, 220) });
      }
      if (stopped) store.addStep(s, { kind: 'info', text: 'Stopped from Kroog' });
      if (s.status !== 'needs') store.setStatus(s, 'done', null);
    }
    store.touch(s);
    if (!error && !s.hookSeen && this.engine.notes) this.engine.notes.maybeWrite(s);
    if (!error && this.engine.ai) this.engine.ai.afterTurn(s);
    // Its first turn is done: open it in the editor, where it carries on.
    if (s.thenEditor) {
      s.thenEditor = false;
      if (!error && !stopped) {
        const r = this.toEditor(s.id, { quiet: true });
        if (r.ok) {
          // The folder was opened when the turn started, so the chat link is enough now.
          this.editor.openChat(s.editor, { sessionId: s.id }).catch(() => {});
          store.addStep(s, { kind: 'info', text: `Opened in ${s.app}. Carry on there, or from here.` });
          store.touch(s);
        }
        return;
      }
    }
    // Messages sent while it was finishing go in as the next turn.
    if (!stopped && s.queue && s.queue.length) {
      const items = s.queue.splice(0);
      for (const step of s.steps) if (step.pending) step.pending = false;
      const text = items.map((q) => q.text).join('\n\n');
      setTimeout(() => this.run({ mode: 'resume', id: s.id, prompt: text, label: 'Your waiting message' }), 50);
    }
  }

  stop(id) {
    const run = this.procs.get(id);
    if (!run) return false;
    run.killed = true;
    if (run.child) {
      run.child.kill('SIGINT');
      setTimeout(() => { if (this.procs.get(id) === run) run.child.kill('SIGTERM'); }, 4000).unref?.();
    } else if (run.fake) {
      clearTimeout(run.fake);
      this.procs.delete(id);
      const s = this.store.session(id);
      if (s) this.finish(s, { stopped: true });
    }
    return true;
  }

  stopAll() {
    for (const id of [...this.procs.keys()]) this.stop(id);
  }

  // Hand a chat Kroog ran over to the editor. From then on Kroog branches it instead of
  // writing into it, because the editor may have it open.
  toEditor(id, { quiet = false } = {}) {
    const s = this.store.session(id);
    if (!s) return { ok: false, error: 'That chat is gone.' };
    if (this.procs.has(id)) return { ok: false, error: 'It is still running. Stop it or wait for it to finish first.' };
    s.owner = 'editor';
    const ed = s.editor || this.getSettings().defaultEditor || 'vscode';
    s.app = ed === 'cursor' ? 'Cursor' : 'VS Code';
    s.kind = 'ide';
    s.place = s.app;
    s.surface = 'panel';
    if (!quiet) this.store.addStep(s, { kind: 'info', text: `Handed to ${s.app}.` });
    this.store.touch(s);
    return { ok: true, url: `${ed}://anthropic.claude-code/open?session=${encodeURIComponent(s.id)}` };
  }

  // ---- demo: a pretend turn, so the demo shows the flow without Claude Code -----------
  fakeTurn(s, text) {
    const run = { fake: null };
    this.procs.set(s.id, run);
    const steps = [
      [900, () => { s.now = `Read ${baseName(s.cwd) || 'the project'}/README.md`; this.store.addStep(s, { kind: 'tool', text: s.now, tool: 'Read', state: 'ok' }); }],
      [1400, () => { s.now = 'Searched the code for related files'; this.store.addStep(s, { kind: 'tool', text: s.now, tool: 'Grep', state: 'ok' }); }],
      [1600, () => { s.now = 'Edited a file'; this.store.addStep(s, { kind: 'tool', text: 'Edited notes/next-steps.md', tool: 'Edit', state: 'ok' }); }],
    ];
    let i = 0;
    const next = () => {
      if (i < steps.length) {
        const [ms, fn] = steps[i++];
        run.fake = setTimeout(() => { fn(); this.store.touch(s); next(); }, ms);
      } else {
        run.fake = setTimeout(() => {
          this.procs.delete(s.id);
          this.finish(s, { reply: `This is a demo reply. A real run would answer "${truncate(text, 80)}" here, working in ${baseName(s.cwd) || 'the project'}, and Kroog would show each step as it happens.` });
        }, 1200);
      }
    };
    s.hookSeen = false;
    next();
  }
}

export { words as countWords };
