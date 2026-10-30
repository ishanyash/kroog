// Which Claude Code chats are open right now, and whether each is busy or idle.
//
// Claude Code keeps a small registry of its running chats in ~/.claude/sessions/:
// one <pid>.json per chat (session id, folder, busy or idle, its inbox socket) and a
// <pid>.<hash>.key file with the inbox token, readable only by you. Kroog reads it, so it
// knows about chats that were open before Kroog started, without waiting for a hook.
// The format is internal to Claude Code and can change: anything unexpected is skipped,
// and hooks still work without it.
import fs from 'node:fs';
import path from 'node:path';

const STALE_MS = 6 * 3600000;

function pidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e.code === 'EPERM';
  }
}

export class Presence {
  constructor({ dir }) {
    this.dir = dir;
    this.map = new Map();   // sessionId -> entry
    this.available = false; // the registry folder exists and can be read
    this.lastRead = 0;
  }

  readKey(pid) {
    let names = [];
    try { names = fs.readdirSync(this.dir); } catch { return ''; }
    const key = names.find((n) => n.startsWith(`${pid}.`) && n.endsWith('.key'));
    if (!key) return '';
    try {
      const data = JSON.parse(fs.readFileSync(path.join(this.dir, key), 'utf8'));
      return String(data.peerToken || '');
    } catch {
      return '';
    }
  }

  // Re-read the registry. Returns the session ids whose entry appeared, changed or went.
  refresh() {
    let names = [];
    try {
      names = fs.readdirSync(this.dir);
      this.available = true;
    } catch {
      this.available = false;
      const gone = [...this.map.keys()];
      this.map.clear();
      return gone;
    }
    const seen = new Map();
    for (const name of names) {
      if (!/^\d+\.json$/.test(name)) continue;
      let d;
      try { d = JSON.parse(fs.readFileSync(path.join(this.dir, name), 'utf8')); } catch { continue; }
      if (!d || typeof d.sessionId !== 'string' || !pidAlive(Number(d.pid))) continue;
      if (d.updatedAt && Date.now() - d.updatedAt > STALE_MS) continue;
      const socket = typeof d.messagingSocketPath === 'string' ? d.messagingSocketPath : '';
      let hasSocket = false;
      try { hasSocket = Boolean(socket) && fs.statSync(socket).isSocket(); } catch { hasSocket = false; }
      const prev = this.map.get(d.sessionId);
      const entry = {
        pid: Number(d.pid),
        cwd: String(d.cwd || ''),
        entry: String(d.entrypoint || ''),
        kind: String(d.kind || ''),
        name: String(d.name || ''),
        busy: d.status === 'busy',
        statusAt: Number(d.statusUpdatedAt || d.updatedAt || 0),
        startedAt: Number(d.startedAt || 0),
        socket: hasSocket ? socket : '',
        token: prev && prev.pid === Number(d.pid) ? prev.token : this.readKey(Number(d.pid)),
      };
      // A chat resumed in a second process: keep the newer one.
      const other = seen.get(d.sessionId);
      if (!other || other.startedAt < entry.startedAt) seen.set(d.sessionId, entry);
    }
    const changed = [];
    for (const [sid, entry] of seen) {
      const prev = this.map.get(sid);
      if (!prev || prev.pid !== entry.pid || prev.busy !== entry.busy || prev.socket !== entry.socket) changed.push(sid);
      this.map.set(sid, entry);
    }
    for (const sid of [...this.map.keys()]) {
      if (!seen.has(sid)) {
        this.map.delete(sid);
        changed.push(sid);
      }
    }
    this.lastRead = Date.now();
    return changed;
  }

  get(sid) {
    return this.map.get(sid) || null;
  }

  isOpen(sid) {
    return this.map.has(sid);
  }

  all() {
    return [...this.map.entries()].map(([sid, e]) => ({ sid, ...e }));
  }
}
