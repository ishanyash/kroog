// Kroog's connector into running Claude Code chats.
//
// Since v2.1.224, every Claude Code chat (VS Code, Cursor, Terminal, or `claude -p`) opens a
// private inbox: a Unix socket (a named pipe on Windows) only your user can reach. Claude Code tells hooks where it is
// (CLAUDE_CODE_MESSAGING_SOCKET, plus a per-chat token), and Kroog's hook passes that on.
// A message written to the inbox reaches the chat between tool calls, or, if the chat is idle,
// starts a new turn right away. Claude Code labels it as a message from another session, never
// as your own typing, so it can't approve anything on your behalf.
//
// Kroog keeps the inbox addresses in ~/.kroog/inboxes.json (only your user can read it).
import fs from 'node:fs';
import net from 'node:net';
import { inboxAddressValid, inboxPresent } from './platform.js';

const MAX_AGE = 14 * 86400000;

export class Inbox {
  constructor({ file = null } = {}) {
    this.file = file;
    this.map = new Map();
    this.load();
  }

  load() {
    if (!this.file) return;
    try {
      const data = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      for (const [sid, v] of Object.entries(data || {})) {
        if (v && v.socket && Date.now() - (v.t || 0) < MAX_AGE) this.map.set(sid, v);
      }
    } catch { /* none yet */ }
  }

  save() {
    if (!this.file) return;
    try {
      const tmp = `${this.file}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(Object.fromEntries(this.map)), { mode: 0o600 });
      fs.renameSync(tmp, this.file);
    } catch { /* not fatal */ }
  }

  remember(sid, socket, token = '') {
    if (!sid || !socket || !valid(socket)) return false;
    const old = this.map.get(sid);
    if (old && old.socket === socket && old.token === token) {
      old.t = Date.now();
      return true;
    }
    this.map.set(sid, { socket, token: String(token || ''), t: Date.now() });
    this.save();
    return true;
  }

  forget(sid) {
    if (this.map.delete(sid)) this.save();
  }

  // Known and the socket file is still there (the chat process is probably running).
  has(sid) {
    const v = this.map.get(sid);
    if (!v) return false;
    const ok = inboxPresent(v.socket);
    // The chat closed: its socket is gone, so forget it.
    if (!ok) this.forget(sid);
    return ok;
  }

  // Is anyone listening? A closed chat can leave its socket file behind. Connects and
  // closes at once, without sending anything.
  probe(sid) {
    const v = this.map.get(sid);
    if (!v || !this.has(sid)) return Promise.resolve(false);
    return new Promise((resolve) => {
      const sock = net.createConnection(v.socket);
      const done = (alive) => { sock.destroy(); if (!alive) this.forget(sid); resolve(alive); };
      sock.setTimeout(1500, () => done(true));
      sock.on('connect', () => done(true));
      sock.on('error', (e) => done(!['ENOENT', 'ECONNREFUSED'].includes(e.code)));
    });
  }

  async probeAll() {
    const gone = [];
    for (const sid of [...this.map.keys()]) if (!(await this.probe(sid))) gone.push(sid);
    return gone;
  }

  // Resolves when the message is handed over. Rejects with code 'CLOSED' when the chat is
  // no longer running, so the caller can fall back to another way.
  send(sid, text) {
    const v = this.map.get(sid);
    if (!v) return Promise.reject(Object.assign(new Error('Kroog does not know this chat\'s inbox yet.'), { code: 'UNKNOWN' }));
    if (!this.has(sid)) {
      this.forget(sid);
      return Promise.reject(Object.assign(new Error('The chat is not running any more.'), { code: 'CLOSED' }));
    }
    const lines = [];
    if (v.token) lines.push(JSON.stringify({ type: 'auth', token: v.token }));
    lines.push(JSON.stringify({ type: 'user', message: { role: 'user', content: String(text) } }));
    return new Promise((resolve, reject) => {
      const sock = net.createConnection(v.socket);
      let done = false;
      const finish = (err) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        if (err) {
          if (['ENOENT', 'ECONNREFUSED'].includes(err.code)) {
            this.forget(sid);
            reject(Object.assign(new Error('The chat is not running any more.'), { code: 'CLOSED' }));
          } else reject(err);
        } else resolve(true);
      };
      const timer = setTimeout(() => { sock.destroy(); finish(new Error('The chat did not take the message in time.')); }, 5000);
      sock.on('connect', () => {
        // Written and flushed: close our end. A Windows pipe has no half-close, so this is how
        // the chat sees the end of the message there.
        sock.end(`${lines.join('\n')}\n`, () => { sock.destroy(); finish(null); });
      });
      sock.on('error', finish);
    });
  }
}

// Only a socket file owned by you, with Claude Code's naming (or, on Windows, a local pipe).
export function valid(socket) {
  return inboxAddressValid(socket);
}

// What the chat reads. Claude Code adds its own note that the message came from another
// session; this line tells Claude it is really you, writing from Kroog.
export function framed(text) {
  return `Message from the user, sent from Kroog (their dashboard for Claude Code chats):\n\n${String(text).trim()}`;
}
