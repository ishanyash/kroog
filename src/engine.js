// The core: turns Claude Code hook events into chat state, and turns what you do in the
// browser into hook answers. Shared by the live server and demo mode.
//
// How each control reaches a chat in your editor:
//   Allow / Deny  -> answers the PermissionRequest hook, which Kroog holds open for a short time.
//   Send message  -> working chat: added after its current step (PostToolUse additionalContext).
//                    chat Kroog is holding (Drive): continues it now (Stop hook "block" + reason).
//                    other finished chats: opens the editor with your text typed in (deep link).
//   Stop          -> ends the turn at its next step (continue: false).
import { NO_OUTPUT, truncate, clip, firstLine, looksLikeQuestion, lastQuestion, titleFromPrompt, shortId, cleanPrompt, isKroogMessage } from './util.js';
import { describeTool, describePermission, applyPlanTool, fileTouched } from './describe.js';
import { detectApp } from './sources.js';
import { Inbox, framed } from './inbox.js';
import { Presence } from './presence.js';
import { isJunkTitle, retitle } from './titles.js';

const BRIEF_RE = /\[(?:Kroog|Crew) brief ([a-z0-9]{4,12})\]/i;
// Claude Code ends a turn anyway after 8 Stop-hook blocks in a row with no tool call.
const BLOCK_CAP = 7;

function instructionText(items) {
  const lines = items.map((q) => String(q.text || '').trim()).filter(Boolean);
  const body = lines.length === 1 ? lines[0] : lines.map((l, i) => `${i + 1}. ${l}`).join('\n');
  return `The user sent this from Kroog, their dashboard for these chats. Treat it as a message from them:\n${body}`;
}

function countWords(text) {
  return String(text || '').trim().split(/\s+/).filter(Boolean).length;
}

const uniq = (list) => [...new Set(list.filter(Boolean))];
const editorName = (e) => ({ cursor: 'Cursor', 'vscode-insiders': 'VS Code Insiders', windsurf: 'Windsurf' }[e] || 'VS Code');

function lowerFirst(text) {
  const t = String(text || '');
  return t ? t.charAt(0).toLowerCase() + t.slice(1) : t;
}

export class Engine {
  constructor({ store, getSettings, notes = null, hasViewers = () => true, inbox = null, presence = null }) {
    this.store = store;
    // Each chat's Claude Code inbox, for messages from Kroog (see inbox.js).
    this.inbox = inbox || new Inbox();
    // Claude Code's own registry of open chats (see presence.js).
    this.presence = presence || new Presence({ dir: '' });
    // Set by Runner and AiHelper when they are created.
    this.runner = null;
    this.ai = null;
    this.getSettings = getSettings;
    this.notes = notes;
    // Holding only makes sense while someone has a Kroog tab open to answer.
    this.hasViewers = hasViewers;
    this.waiters = new Map();
  }

  // ---- open hook requests Kroog is holding -------------------------------------------

  waiter(sid, kind) {
    const all = this.waiters.get(sid);
    return all ? all[kind] || null : null;
  }

  setWaiter(sid, kind, w) {
    const all = this.waiters.get(sid) || {};
    all[kind] = w;
    this.waiters.set(sid, all);
  }

  clearWaiter(sid, kind) {
    const all = this.waiters.get(sid);
    if (!all || !all[kind]) return null;
    const w = all[kind];
    clearTimeout(w.timer);
    delete all[kind];
    if (!all.permission && !all.stop) this.waiters.delete(sid);
    return w;
  }

  resolveWaiter(sid, kind, output) {
    const w = this.clearWaiter(sid, kind);
    if (w) w.resolve(output);
    return Boolean(w);
  }

  releaseAll() {
    for (const sid of [...this.waiters.keys()]) {
      this.resolveWaiter(sid, 'permission', NO_OUTPUT);
      this.resolveWaiter(sid, 'stop', NO_OUTPUT);
    }
  }

  // Open somewhere right now: Claude Code's registry says so, or we have a working inbox.
  isLive(s) {
    if (s.demoLive) return true;
    if (this.runner && this.runner.isRunning(s.id)) return true;
    if (this.presence.isOpen(s.id)) return true;
    return s.status !== 'ended' && this.inbox.has(s.id);
  }

  publicSession(s) {
    const { blockStreak, ...rest } = s;
    const live = this.isLive(s);
    return {
      ...rest,
      waitingPermission: Boolean(this.waiter(s.id, 'permission')),
      inbox: live && (this.inbox.has(s.id) || Boolean(this.runner && this.runner.isRunning(s.id)) || Boolean(s.demoLive)),
      live,
      kroogRunning: Boolean(this.runner && this.runner.isRunning(s.id)),
      holdingStop: Boolean(this.waiter(s.id, 'stop')),
    };
  }

  // Bring Claude Code's registry into the chats: new chats it knows about, busy or idle,
  // and the inbox of each. Returns the ids that changed, for the browser.
  syncPresence() {
    const changed = new Set(this.presence.refresh());
    const store = this.store;
    for (const e of this.presence.all()) {
      const known = store.session(e.sid);
      // Scripts (the Agent SDK, `claude -p`, Kroog's own AI helper calls) are not chats of
      // yours unless Kroog already knows them.
      if (!known && /^sdk/.test(e.entry)) continue;
      const s = store.ensureSession(e.sid, e.cwd);
      if (!known) {
        this.applyMeta(s, { entry: e.entry });
        s.startedAt = e.startedAt || Date.now();
        s.lastAt = e.statusAt || Date.now();
        s.status = e.busy ? 'working' : 'idle';
        s.since = s.lastAt;
        changed.add(e.sid);
      }
      if (e.socket) this.inbox.remember(e.sid, e.socket, e.token);
      if (isJunkTitle(s.title) && retitle(s)) changed.add(e.sid);
      // The registry's busy or idle corrects what the hooks may have missed.
      const running = this.runner && this.runner.isRunning(e.sid);
      if (e.busy && !running && (s.status === 'done' || s.status === 'idle' || s.status === 'ended')) {
        s.now = s.now || 'Working';
        store.setStatus(s, 'working', null);
        changed.add(e.sid);
      } else if (!e.busy && s.status === 'working' && !running && Date.now() - (s.lastAt || 0) > 20000 && !s.queue.length) {
        s.now = '';
        store.setStatus(s, 'done', null);
        changed.add(e.sid);
      } else if (!e.busy && s.status === 'ended') {
        store.setStatus(s, 'done', null);
        changed.add(e.sid);
      }
    }
    for (const sid of changed) {
      const s = store.session(sid);
      if (s) store.emit('session', s);
    }
    if (changed.size) store.scheduleSave();
    return [...changed];
  }

  applyMeta(s, meta) {
    // A chat Kroog runs keeps its label; the hooks of its `claude -p` turn would call it a script.
    if (s.owner === 'kroog' || (this.runner && this.runner.isRunning(s.id))) return;
    if (!meta || !(meta.entry || meta.bundle || meta.term)) return;
    const d = detectApp(meta);
    Object.assign(s, {
      app: d.app,
      kind: d.kind,
      place: d.place,
      editor: d.editor,
      surface: d.surface,
      entry: meta.entry || '',
      bundle: meta.bundle || '',
      term: meta.term || '',
    });
  }

  // Lineage: remember what a chat was given from other chats.
  recordInput(s, input) {
    const list = Array.isArray(s.inputs) ? s.inputs : [];
    // A chat starts with project memory once; a resume replaces the old record.
    const kept = input.kind === 'memory' ? list.filter((x) => x.kind !== 'memory') : list;
    kept.push({ t: Date.now(), from: [], notes: [], words: 0, ...input });
    s.inputs = kept.slice(-20);
  }

  takeQueue(s) {
    const items = s.queue.splice(0);
    for (const step of s.steps) if (step.pending) step.pending = false;
    return items;
  }

  // ---- hook events ------------------------------------------------------------------

  async handle(event, body = {}, meta = {}, signal = null) {
    const sid = body && body.session_id;
    if (!sid || typeof sid !== 'string') return NO_OUTPUT;
    const store = this.store;
    store.noteEvent(event);
    const s = store.ensureSession(sid, body.cwd);
    this.applyMeta(s, meta);
    if (meta && meta.inbox && event !== 'SessionEnd') this.inbox.remember(sid, meta.inbox, meta.inboxToken);
    const byKroog = Boolean(this.runner && this.runner.isRunning(sid));
    if (byKroog) s.hookSeen = true;
    if (body.permission_mode) s.permissionMode = body.permission_mode;
    if (s.archived && event === 'UserPromptSubmit') s.archived = false;
    const helper = body.agent_type || null;

    switch (event) {
      case 'SessionStart': {
        s.source = body.source || '';
        if (body.session_title) s.title = truncate(body.session_title, 80);
        if (s.status === 'ended') store.setStatus(s, 'idle', null);
        if (byKroog) { /* each turn Kroog runs opens and closes the chat; no need to say so */ } else if (body.source === 'resume') store.addStep(s, { kind: 'info', text: 'Chat resumed' });
        else if (s.steps.length === 0) store.addStep(s, { kind: 'info', text: 'Chat opened' });
        store.touch(s);
        const memory = store.rememberedFor(s.cwd);
        if (!memory.length) return NO_OUTPUT;
        const text = ['Notes from earlier chats in this project, kept by Kroog (the user\'s dashboard):', ...memory.map((n) => `- ${n.type}: ${n.text}`)].join('\n');
        this.recordInput(s, {
          kind: 'memory',
          notes: memory.map((n) => n.id),
          from: uniq(memory.flatMap((n) => [n.sessionId, ...(n.from || [])]).filter((id) => id !== s.id)),
          words: countWords(text),
        });
        store.touch(s);
        return { hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: clip(text, 9000) } };
      }

      case 'UserPromptSubmit': {
        const raw = String(body.prompt || '');
        // A message Kroog put in the chat's inbox: Kroog already showed it as "you".
        const viaKroog = isKroogMessage(raw);
        const prompt = cleanPrompt(raw) || raw;
        const fromUser = (!body.source || body.source === 'user') && !viaKroog;
        if (fromUser && isJunkTitle(s.title)) {
          const t = titleFromPrompt(prompt);
          if (t && !isJunkTitle(t)) s.title = t;
        }
        // Kroog already showed the prompt of a chat it runs (shorter, for a brief).
        if (!s.skipPromptStep) s.lastPrompt = clip(prompt, 2000);
        s.blockStreak = 0;
        s.holding = null;
        s.now = 'Thinking';
        store.setStatus(s, 'working', null);
        const shown = s.skipPromptStep;
        s.skipPromptStep = false;
        if (fromUser && !shown) store.addStep(s, { kind: 'prompt', text: truncate(prompt.replace(BRIEF_RE, '').trim() || prompt, 400) });
        const context = [];
        const match = BRIEF_RE.exec(prompt);
        if (match) {
          const brief = store.data.briefs[match[1].toLowerCase()];
          if (brief) {
            // When the brief itself is in the message (typed in from Kroog), only record it.
            if (!prompt.includes(brief.text.slice(0, 160))) context.push(brief.text);
            store.useBrief(brief.id, s.id);
            if (fromUser && brief.goal && !s.turns) s.title = truncate(brief.goal, 80);
            this.recordInput(s, { kind: 'brief', brief: brief.id, from: (brief.sources || []).filter((id) => id !== s.id), notes: brief.notes || [], words: countWords(brief.text) });
            store.addStep(s, { kind: 'info', text: s.turns ? 'Got a brief from Kroog' : 'Started with a brief from Kroog' });
          }
        }
        if (s.queue.length) {
          context.push(instructionText(this.takeQueue(s)));
          store.addStep(s, { kind: 'info', text: 'Your waiting message went in with this one' });
        }
        store.touch(s);
        if (!context.length) return NO_OUTPUT;
        return { hookSpecificOutput: { hookEventName: 'UserPromptSubmit', additionalContext: clip(context.join('\n\n'), 9500) } };
      }

      case 'PreToolUse': {
        const name = body.tool_name;
        const input = body.tool_input || {};
        s.blockStreak = 0;
        if (s.stopRequested) {
          s.stopRequested = false;
          s.now = '';
          store.setStatus(s, 'done', null);
          store.addStep(s, { kind: 'info', text: 'Stopped from Kroog' });
          store.touch(s);
          return { continue: false, stopReason: 'Stopped from Kroog.' };
        }
        const text = describeTool(name, input);
        s.now = helper ? `${helper}: ${text}` : text;
        // An agent is about to start: remember what it was asked, for the SubagentStart hook.
        if ((name === 'Task' || name === 'Agent') && !helper) {
          s.pendingAgents = [...(s.pendingAgents || []), { type: String(input.subagent_type || ''), task: truncate(input.description || firstLine(input.prompt || '', 140), 160), t: Date.now() }].slice(-6);
        }
        const waitingHere = s.needs && s.needs.kind === 'permission' && this.waiter(sid, 'permission');
        if (!waitingHere) store.setStatus(s, 'working', null);
        store.addStep(s, { kind: 'tool', text, toolUseId: body.tool_use_id || null, tool: name, state: 'running', helper });
        if (!helper) s.plan = applyPlanTool(s.plan, name, input);
        const file = fileTouched(name, input);
        if (file && !s.files.includes(file)) {
          s.files.push(file);
          if (s.files.length > 60) s.files.shift();
        }
        store.touch(s);
        return NO_OUTPUT;
      }

      case 'PermissionRequest': {
        const name = body.tool_name;
        const p = describePermission(name, body.tool_input || {});
        // A chat Kroog runs has no editor to ask instead, so Kroog waits longer for you.
        const kroogRun = byKroog;
        const hold = !this.hasViewers() ? 0 : kroogRun ? 600 : Math.max(0, Math.min(Number(this.getSettings().permissionHoldSeconds) || 0, 540));
        // A newer request replaces an older one that is still waiting.
        this.resolveWaiter(sid, 'permission', NO_OUTPUT);
        const requestId = shortId(8);
        const t = Date.now();
        store.setStatus(s, 'needs', {
          kind: 'permission', requestId, tool: name, title: p.title, detail: p.detail, note: p.note, helper,
          since: t, deadline: hold ? t + hold * 1000 : null, inEditor: hold === 0 && !kroogRun, kroog: kroogRun,
        });
        store.addStep(s, { kind: 'ask', text: `Asked to ${lowerFirst(p.title)}`, helper });
        if (!hold) {
          if (kroogRun) {
            store.setStatus(s, 'working', null);
            store.addStep(s, { kind: 'info', text: 'No Kroog tab was open to answer, so it was not allowed' });
          }
          store.touch(s);
          return NO_OUTPUT;
        }
        return new Promise((resolve) => {
          const timer = setTimeout(() => {
            // Nobody answered here, so the editor asks as usual.
            this.clearWaiter(sid, 'permission');
            if (s.needs && s.needs.requestId === requestId && kroogRun) {
              store.setStatus(s, 'working', null);
              store.addStep(s, { kind: 'info', text: 'Nobody answered, so it was not allowed' });
              store.touch(s);
            } else if (s.needs && s.needs.requestId === requestId) {
              s.needs = { ...s.needs, inEditor: true, deadline: null };
              store.touch(s);
            }
            resolve(NO_OUTPUT);
          }, hold * 1000);
          this.setWaiter(sid, 'permission', { resolve, timer, requestId });
          // Tell the browser only now, so it sees the Allow and Deny buttons.
          store.touch(s);
          if (signal) {
            signal.addEventListener('abort', () => {
              const w = this.waiter(sid, 'permission');
              if (!w || w.requestId !== requestId) return;
              this.clearWaiter(sid, 'permission');
              if (s.needs && s.needs.requestId === requestId) {
                s.now = '';
                store.setStatus(s, 'idle', null);
                store.addStep(s, { kind: 'info', text: 'The request was cancelled in the editor' });
                store.touch(s);
              }
              resolve(NO_OUTPUT);
            }, { once: true });
          }
        });
      }

      case 'PostToolUse':
      case 'PostToolUseFailure': {
        const name = body.tool_name;
        const input = body.tool_input || {};
        const failed = event === 'PostToolUseFailure';
        const detail = failed ? truncate(body.error, 220) : undefined;
        const step = body.tool_use_id ? [...s.steps].reverse().find((x) => x.toolUseId === body.tool_use_id) : null;
        if (step) {
          step.state = failed ? 'failed' : 'ok';
          if (detail) step.detail = detail;
        } else {
          store.addStep(s, { kind: 'tool', text: describeTool(name, input), toolUseId: body.tool_use_id || null, tool: name, state: failed ? 'failed' : 'ok', detail, helper });
        }
        if (s.needs && s.needs.kind === 'permission' && !this.waiter(sid, 'permission')) store.setStatus(s, 'working', null);
        if (!helper && !failed) {
          if (name === 'TaskCreate') s.plan = applyPlanTool(s.plan, name, input, body.tool_response || {});
          else if (name === 'TodoWrite' || name === 'TaskUpdate') s.plan = applyPlanTool(s.plan, name, input);
        }
        if (s.stopRequested) {
          s.stopRequested = false;
          s.now = '';
          store.setStatus(s, 'done', null);
          store.addStep(s, { kind: 'info', text: 'Stopped from Kroog' });
          store.touch(s);
          return { continue: false, stopReason: 'Stopped from Kroog.' };
        }
        if (s.queue.length && !helper) {
          const text = instructionText(this.takeQueue(s));
          store.addStep(s, { kind: 'info', text: 'Your message reached the chat' });
          store.touch(s);
          return { hookSpecificOutput: { hookEventName: event, additionalContext: clip(text, 9500) } };
        }
        store.touch(s);
        return NO_OUTPUT;
      }

      case 'Notification': {
        const type = body.notification_type || '';
        const message = truncate(body.message || '', 240);
        if (type === 'permission_prompt') {
          if (!this.waiter(sid, 'permission') && !(s.needs && s.needs.kind === 'permission')) {
            store.setStatus(s, 'needs', { kind: 'permission', title: message || 'Needs your permission', detail: '', note: '', since: Date.now(), deadline: null, inEditor: true });
          }
        } else if (type === 'elicitation_dialog' || type === 'agent_needs_input') {
          store.setStatus(s, 'needs', { kind: 'question', title: message || 'Needs your input', since: Date.now(), inEditor: true });
        } else if (type === 'idle_prompt') {
          if (s.status === 'working') store.setStatus(s, 'done', null);
          s.now = '';
        } else {
          return NO_OUTPUT;
        }
        store.touch(s);
        return NO_OUTPUT;
      }

      case 'Stop': {
        const reply = clip(body.last_assistant_message || '', 6000);
        if (reply) s.lastReply = reply;
        s.turns = (s.turns || 0) + 1;
        s.now = '';
        s.stopRequested = false;
        if (reply) store.addStep(s, { kind: 'reply', text: firstLine(reply, 220) });
        for (const h of Object.values(s.helpers)) if (h.state === 'working') h.state = 'done';

        // A message you sent while it was writing its answer goes in now.
        if (s.queue.length && s.blockStreak < BLOCK_CAP) {
          const text = instructionText(this.takeQueue(s));
          s.blockStreak += 1;
          store.setStatus(s, 'working', null);
          store.addStep(s, { kind: 'info', text: 'Your message reached the chat' });
          store.touch(s);
          return { decision: 'block', reason: clip(text, 9500) };
        }

        const asked = looksLikeQuestion(reply);
        const capped = s.drive && s.blockStreak >= BLOCK_CAP;
        const unwatched = s.drive && !capped && !this.hasViewers();
        const holdHere = s.drive && Boolean(this.getSettings().driveEnabled) && !capped && !unwatched;
        store.setStatus(s, asked ? 'needs' : 'done', asked ? { kind: 'question', title: lastQuestion(reply), since: Date.now(), inEditor: !holdHere } : null);
        if (this.notes) this.notes.maybeWrite(s);
        if (this.ai) this.ai.afterTurn(s);
        if (!holdHere) {
          if (capped) store.addStep(s, { kind: 'info', text: 'Claude Code limits how many messages in a row Kroog can pass while the chat uses no tools. Reply in the editor this time.' });
          if (unwatched) store.addStep(s, { kind: 'info', text: 'No Kroog tab was open, so the chat went back to the editor.' });
          s.holding = null;
          store.touch(s);
          return NO_OUTPUT;
        }
        const limit = Math.min(Math.max(1, Number(this.getSettings().driveMinutes) || 5) * 60, 540) * 1000;
        const t = Date.now();
        s.holding = { since: t, deadline: t + limit };
        return new Promise((resolve) => {
          const timer = setTimeout(() => {
            this.clearWaiter(sid, 'stop');
            s.holding = null;
            if (s.needs && s.needs.kind === 'question') s.needs = { ...s.needs, inEditor: true };
            store.addStep(s, { kind: 'info', text: 'Kroog let go of the chat after waiting. Reply in the editor, or send from here to open it there.' });
            store.touch(s);
            resolve(NO_OUTPUT);
          }, limit);
          this.setWaiter(sid, 'stop', { resolve, timer });
          // Tell the browser only now, so it sees that the chat is held.
          store.touch(s);
          if (signal) {
            signal.addEventListener('abort', () => {
              if (this.clearWaiter(sid, 'stop')) {
                s.holding = null;
                store.touch(s);
                resolve(NO_OUTPUT);
              }
            }, { once: true });
          }
        });
      }

      case 'StopFailure': {
        const why = truncate(body.error_details || body.error || 'The chat stopped with an error.', 220);
        s.now = '';
        store.setStatus(s, 'error', { kind: 'error', title: why, since: Date.now(), inEditor: true });
        store.addStep(s, { kind: 'error', text: why });
        store.touch(s);
        return NO_OUTPUT;
      }

      case 'SubagentStart': {
        const type = body.agent_type || 'agent';
        const pending = s.pendingAgents || [];
        const i = pending.findIndex((p) => !p.type || p.type === type);
        const asked = i >= 0 ? pending.splice(i, 1)[0] : null;
        s.pendingAgents = pending;
        s.helpers[body.agent_id || shortId(8)] = { type, state: 'working', t: Date.now(), task: asked ? asked.task : '' };
        store.addStep(s, { kind: 'helper', text: `Agent "${type}" started${asked && asked.task ? `: ${asked.task}` : ''}` });
        store.touch(s);
        return NO_OUTPUT;
      }

      case 'SubagentStop': {
        const known = s.helpers[body.agent_id];
        const type = (known && known.type) || body.agent_type || 'agent';
        const result = body.last_assistant_message ? firstLine(body.last_assistant_message, 200) : '';
        if (known) {
          known.state = 'done';
          known.result = result;
          known.endedAt = Date.now();
        } else s.helpers[body.agent_id || shortId(8)] = { type, state: 'done', t: Date.now(), result };
        store.addStep(s, { kind: 'helper', text: `Agent "${type}" finished${result ? `: ${result}` : ''}` });
        store.touch(s);
        return NO_OUTPUT;
      }

      case 'SessionEnd': {
        this.inbox.forget(sid);
        this.resolveWaiter(sid, 'permission', NO_OUTPUT);
        this.resolveWaiter(sid, 'stop', NO_OUTPUT);
        s.holding = null;
        s.now = '';
        if (byKroog) {
          store.touch(s);
          return NO_OUTPUT;
        }
        store.setStatus(s, 'ended', null);
        store.addStep(s, { kind: 'info', text: 'Chat closed' });
        store.touch(s);
        return NO_OUTPUT;
      }

      default:
        store.touch(s);
        return NO_OUTPUT;
    }
  }

  // ---- what you do in the browser ---------------------------------------------------

  decide(sid, { behavior, message } = {}) {
    const s = this.store.session(sid);
    if (!s) return { ok: false, error: 'That chat is gone.' };
    if (!this.waiter(sid, 'permission')) return { ok: false, error: 'This request is no longer waiting in Kroog. Answer it in the editor.' };
    const reason = String(message || '').trim();
    const decision = behavior === 'allow'
      ? { behavior: 'allow' }
      : { behavior: 'deny', ...(reason ? { message: `The user answered from Kroog: ${reason}` } : {}) };
    const what = s.needs && s.needs.title ? lowerFirst(s.needs.title) : 'go ahead';
    this.resolveWaiter(sid, 'permission', { hookSpecificOutput: { hookEventName: 'PermissionRequest', decision } });
    s.now = behavior === 'allow' ? 'Carrying on' : 'Rethinking after your answer';
    this.store.setStatus(s, 'working', null);
    this.store.addStep(s, { kind: 'you', text: behavior === 'allow' ? `You allowed it to ${what}` : `You said no to: ${what}${reason ? `. "${truncate(reason, 200)}"` : ''}` });
    this.store.touch(s);
    return { ok: true };
  }

  release(sid) {
    const s = this.store.session(sid);
    if (!s) return { ok: false, error: 'That chat is gone.' };
    const had = this.resolveWaiter(sid, 'permission', NO_OUTPUT);
    if (s.needs && s.needs.kind === 'permission') {
      s.needs = { ...s.needs, inEditor: true, deadline: null };
      this.store.touch(s);
    }
    return { ok: true, released: had };
  }

  async send(sid, text, { label = '', mode = 'auto' } = {}) {
    const s = this.store.session(sid);
    const body = String(text || '').trim();
    const stepText = label || truncate(body, 400);
    if (!s) return { ok: false, error: 'That chat is gone.' };
    if (!body) return { ok: false, error: 'Type a message first.' };
    if (body.length > 8000) return { ok: false, error: 'That message is too long. The limit is 8,000 characters.' };

    if (this.waiter(sid, 'stop')) {
      s.blockStreak = (s.blockStreak || 0) + 1;
      this.resolveWaiter(sid, 'stop', { decision: 'block', reason: instructionText([{ text: body }]) });
      s.holding = null;
      s.now = 'Reading your message';
      this.store.setStatus(s, 'working', null);
      this.store.addStep(s, { kind: 'you', text: stepText });
      this.store.touch(s);
      return { ok: true, delivered: 'now' };
    }
    // The chat is running somewhere (VS Code, Cursor, a terminal) and has an inbox: the
    // message goes straight in, between its steps or as a new turn if it is idle.
    if (mode === 'auto' && this.inbox.has(sid)) {
      try {
        await this.inbox.send(sid, framed(body));
        this.store.addStep(s, { kind: 'you', text: stepText });
        if (s.status !== 'working') {
          s.now = 'Reading your message';
          this.store.setStatus(s, 'working', null);
        }
        this.store.touch(s);
        return { ok: true, delivered: 'inbox' };
      } catch (error) {
        if (error.code !== 'CLOSED' && error.code !== 'UNKNOWN') return { ok: false, error: `Kroog could not reach the chat: ${error.message}` };
        // Closed: fall through to the other ways below.
      }
    }
    const runner = this.runner;
    const running = runner && runner.isRunning(sid);
    const live = running || s.status === 'working' || (s.status === 'needs' && s.needs && s.needs.kind === 'permission');
    if (live) {
      s.queue.push({ id: shortId(6), text: body, t: Date.now() });
      this.store.addStep(s, { kind: 'you', text: stepText, pending: true });
      this.store.touch(s);
      return { ok: true, delivered: 'queued' };
    }

    // Not running anywhere. Kroog carries the same chat on here, one turn at a time; the
    // editor can open it again afterwards. (With the registry we know it is not open; without
    // it, only chats Kroog ran or saw close are safe to continue.)
    const canRun = runner && runner.available();
    if (canRun && mode === 'branch') return runner.run({ mode: 'fork', from: sid, prompt: body, label: stepText });
    const surelyClosed = this.presence.available ? !this.presence.isOpen(sid) : (s.owner === 'kroog' || s.status === 'ended');
    if (canRun && mode !== 'editor' && surelyClosed) {
      return runner.run({ mode: 'resume', id: sid, prompt: body, label: stepText });
    }
    if (s.status === 'ended') return { ok: false, error: 'This chat is closed. Open it in the editor first.' };

    // It's waiting for you and Kroog isn't holding it, so hand over to the editor.
    const url = this.deepLink(s, body);
    if (url) return { ok: true, delivered: 'editor', url };
    s.queue.push({ id: shortId(6), text: body, t: Date.now() });
    this.store.addStep(s, { kind: 'you', text: stepText, pending: true });
    this.store.touch(s);
    return { ok: true, delivered: 'next-turn' };
  }

  deepLink(s, prompt) {
    if (!s.editor) return null;
    let url = `${s.editor}://anthropic.claude-code/open?session=${encodeURIComponent(s.id)}`;
    if (prompt) url += `&prompt=${encodeURIComponent(prompt)}`;
    return url;
  }

  setDrive(sid, on) {
    const s = this.store.session(sid);
    if (!s) return { ok: false, error: 'That chat is gone.' };
    s.drive = Boolean(on);
    if (!s.drive && this.resolveWaiter(sid, 'stop', NO_OUTPUT)) s.holding = null;
    if (s.drive) s.blockStreak = 0;
    if (s.needs && s.needs.kind === 'question' && !s.drive) s.needs = { ...s.needs, inEditor: true };
    this.store.addStep(s, {
      kind: 'info',
      text: s.drive
        ? 'Drive on: when it finishes a turn, Kroog holds it for your next message'
        : 'Drive off: the chat is back to normal in the editor',
    });
    this.store.touch(s);
    return { ok: true };
  }

  stop(sid) {
    const s = this.store.session(sid);
    if (!s) return { ok: false, error: 'That chat is gone.' };
    if (this.runner && this.runner.isRunning(sid)) {
      this.resolveWaiter(sid, 'permission', {
        hookSpecificOutput: { hookEventName: 'PermissionRequest', decision: { behavior: 'deny', message: 'The user stopped this chat from Kroog.', interrupt: true } },
      });
      this.runner.stop(sid);
      this.store.addStep(s, { kind: 'you', text: 'You stopped the chat' });
      this.store.touch(s);
      return { ok: true, note: 'Stopped.' };
    }
    if (this.waiter(sid, 'stop')) {
      this.resolveWaiter(sid, 'stop', NO_OUTPUT);
      s.holding = null;
      if (s.needs && s.needs.kind === 'question') s.needs = { ...s.needs, inEditor: true };
      this.store.addStep(s, { kind: 'you', text: 'You let the chat go back to the editor' });
      this.store.touch(s);
      return { ok: true, note: 'Released to the editor.' };
    }
    if (this.waiter(sid, 'permission')) {
      this.resolveWaiter(sid, 'permission', {
        hookSpecificOutput: { hookEventName: 'PermissionRequest', decision: { behavior: 'deny', message: 'The user stopped this chat from Kroog.', interrupt: true } },
      });
      s.now = '';
      this.store.setStatus(s, 'done', null);
      this.store.addStep(s, { kind: 'you', text: 'You stopped the chat' });
      this.store.touch(s);
      return { ok: true, note: 'Stopped.' };
    }
    if (s.status === 'working') {
      s.stopRequested = true;
      this.store.addStep(s, { kind: 'you', text: 'You asked it to stop. It stops at its next step.' });
      this.store.touch(s);
      return { ok: true, note: 'It stops at its next step.' };
    }
    return { ok: false, error: 'This chat is not running.' };
  }

  archive(sid, on) {
    const s = this.store.session(sid);
    if (!s) return { ok: false, error: 'That chat is gone.' };
    s.archived = Boolean(on);
    this.store.touch(s);
    return { ok: true };
  }

  // A brief for a new chat in the editor. `typed`: the whole brief goes into the first
  // message, so it is readable in the chat; otherwise only a short line with a tag goes in
  // and the hook attaches the brief. Either way Kroog records where the new chat came from.
  createBrief({ text, goal, editor, sources = [], notes = [], typed = false }) {
    const body = String(text || '').trim();
    if (!body) return { ok: false, error: 'The brief is empty.' };
    const scheme = ['vscode', 'cursor', 'vscode-insiders', 'windsurf'].includes(editor) ? editor : 'vscode';
    const brief = this.store.saveBrief(clip(body, 9000), String(goal || '').trim(), { sources, notes, target: 'new', editor: scheme });
    const prompt = typed
      ? `${brief.goal || 'Context for this chat, from Kroog.'}\n\n${brief.text}\n\n[Kroog brief ${brief.id}]`
      : `${brief.goal || 'Pick up from the brief.'} [Kroog brief ${brief.id}]`;
    return { ok: true, id: brief.id, prompt, typed, url: `${scheme}://anthropic.claude-code/open?prompt=${encodeURIComponent(prompt)}` };
  }

  // One entry point for Handoff: a brief made from chats and notes goes to a new chat,
  // a running chat, or project memory. Kroog records where it came from (lineage).
  async handoff({ text, goal = '', target = 'new', editor, sessionId, cwd, sources = [], notes = [], run = 'editor' } = {}) {
    const body = String(text || '').trim();
    if (!body) return { ok: false, error: 'The brief is empty. Tick at least one thing to send.' };
    const from = uniq(Array.isArray(sources) ? sources.map(String) : []);
    const noteIds = uniq(Array.isArray(notes) ? notes.map(String) : []);
    const inKroog = run === 'kroog' && this.runner && this.runner.available();
    if (run === 'kroog' && !inKroog) return { ok: false, error: 'Kroog could not find Claude Code on this Mac, so it cannot run the chat here. See setup.' };
    const input = { kind: 'brief', from, notes: noteIds, words: countWords(body) };
    const promptFor = () => `${String(goal || '').trim() || 'Pick up from this brief.'}\n\n${body}`;
    if (target === 'new' && inKroog) {
      const folder = String(cwd || '');
      if (!folder) return { ok: false, error: 'Pick a project folder for the new chat.' };
      const goalLine = String(goal || '').trim();
      return this.runner.run({ mode: 'new', cwd: folder, prompt: promptFor(), title: goalLine ? truncate(goalLine, 80) : '', input, label: goalLine ? `${truncate(goalLine, 200)} (with a brief from Kroog)` : 'Started with a brief from Kroog' });
    }
    // The brief typed into a new chat in the editor: nothing runs until you press Enter.
    if (target === 'new' && run === 'typed') return { ...this.createBrief({ text: body, goal, editor, sources: from, notes: noteIds, typed: true }), delivered: 'typed', cwd: String(cwd || '') };
    // A new chat that lives in VS Code: Kroog starts it in the project folder with the brief
    // (one short turn), then opens it in the editor, where you carry on.
    if (target === 'new' && this.runner && this.runner.available()) {
      const folder = String(cwd || '');
      if (!folder) return { ok: false, error: 'Pick a project folder for the new chat.' };
      const goalLine = String(goal || '').trim();
      const seed = `${promptFor()}\n\n(Started from Kroog. Read the brief, then reply with a short summary of what you understood and your first steps. Then stop and wait: the user carries on with you in ${editorName(editor)}.)`;
      return this.runner.run({ mode: 'new', cwd: folder, prompt: seed, title: goalLine ? truncate(goalLine, 80) : '', input, label: goalLine ? `${truncate(goalLine, 200)} (with a brief from Kroog)` : 'Started with a brief from Kroog', then: 'editor', editor });
    }
    if (target === 'new') return { ...this.createBrief({ text: body, goal, editor, sources: from, notes: noteIds }), delivered: 'editor' };

    if (target === 'memory') {
      const folder = String(cwd || '');
      if (!folder) return { ok: false, error: 'Pick a project folder first.' };
      const name = folder.split(/[\\/]/).filter(Boolean).pop() || folder;
      const note = this.store.addNote({ sessionId: null, chatTitle: 'Handoff', project: name, cwd: folder, type: 'Brief', text: clip(body, 3000), remembered: true, manual: true, from });
      return note ? { ok: true, delivered: 'memory', note } : { ok: false, error: 'That is already in project memory.' };
    }

    const s = this.store.session(String(sessionId || ''));
    if (!s) return { ok: false, error: 'That chat is gone.' };
    input.from = from.filter((id) => id !== s.id);
    // A running chat with an inbox gets the brief straight away, wherever it runs.
    if (this.inbox.has(s.id) && !this.waiter(s.id, 'stop')) {
      const names0 = input.from.map((id) => this.store.session(id)).filter(Boolean).map((x) => `"${truncate(x.title || 'a chat', 60)}"`);
      const label0 = names0.length ? `You sent a brief made from ${names0.join(' and ')}` : 'You sent a brief from Kroog';
      const goalLine = String(goal || '').trim();
      const r = await this.send(s.id, goalLine ? `${goalLine}\n\n${body}` : body, { label: label0 });
      if (r.ok && r.delivered === 'inbox') {
        this.recordInput(s, input);
        this.store.touch(s);
        return r;
      }
    }
    const live = s.status === 'working' || (s.status === 'needs' && s.needs && s.needs.kind === 'permission');
    if (this.waiter(s.id, 'stop') || live) {
      const names = input.from.map((id) => this.store.session(id)).filter(Boolean).map((x) => `"${truncate(x.title || 'a chat', 60)}"`);
      const label = names.length ? `You sent a brief made from ${names.join(' and ')}` : 'You sent a brief from Kroog';
      const r = await this.send(s.id, body, { label });
      if (r.ok && (r.delivered === 'now' || r.delivered === 'queued')) {
        this.recordInput(s, input);
        this.store.touch(s);
      }
      return r;
    }
    if (inKroog) {
      const names = input.from.map((id) => this.store.session(id)).filter(Boolean).map((x) => `"${truncate(x.title || 'a chat', 60)}"`);
      const label = names.length ? `You sent a brief made from ${names.join(' and ')}` : 'You sent a brief from Kroog';
      const resume = this.presence.available ? !this.presence.isOpen(s.id) : (s.owner === 'kroog' || s.status === 'ended');
      const r = this.runner.run(resume
        ? { mode: 'resume', id: s.id, prompt: promptFor(), label }
        : { mode: 'fork', from: s.id, prompt: promptFor(), label, input: { ...input, from: input.from.filter((x) => x !== s.id) } });
      if (r.ok && resume) { this.recordInput(s, input); this.store.touch(s); }
      return r;
    }
    // Closed in the editor: Kroog runs one turn with the brief, then opens it in the editor again.
    if (s.status === 'ended' && this.runner && this.runner.available()) {
      const r = this.runner.run({ mode: 'resume', id: s.id, prompt: promptFor(), label: 'You sent a brief from Kroog', then: 'editor', editor: s.editor || editor });
      if (r.ok) { this.recordInput(s, input); this.store.touch(s); }
      return r;
    }
    if (s.status === 'ended') return { ok: false, error: 'This chat is closed. Resume it in the editor first.' };
    // Waiting for you in the editor: open it there with a short tag, and the brief goes in with your message.
    const scheme = s.editor || (['vscode', 'cursor', 'vscode-insiders', 'windsurf'].includes(editor) ? editor : null);
    const brief = this.store.saveBrief(clip(body, 9000), String(goal || '').trim(), { sources: input.from, notes: noteIds, target: 'running', targetId: s.id, editor: scheme });
    const prompt = `${brief.goal || 'Pick up from the brief.'} [Kroog brief ${brief.id}]`;
    // Kroog can't reach it (no inbox): open the chat, and you paste the short line with the tag.
    // The link carries no prompt: VS Code refuses one for a chat it has open.
    if (scheme) return { ok: true, delivered: 'paste', id: brief.id, prompt, url: `${scheme}://anthropic.claude-code/open?session=${encodeURIComponent(s.id)}` };
    return { ok: true, delivered: 'copy', id: brief.id, prompt };
  }
}
