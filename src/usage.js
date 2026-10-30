// Plan usage ("burn"): what Claude Code knows about the account's rate-limit windows and
// each chat's cost, sent in by Kroog's mod after every turn (see mod/hooks/register.ts).
//
// A reading is {t, sid, cwd, windows: {five_hour: {pct, resetsAt}, seven_day: {...}},
// cost: {usd}, context: {percent, tokens, window}}. The windows belong to the account, so
// the newest reading from any chat is the truth for all of them; the cost belongs to the
// chat. Readings are kept for 30 days in ~/.kroog/usage.jsonl, thinned to one every ten
// minutes per window state so the file stays small, and the pace chart has a history.
import fs from 'node:fs';
import { EventEmitter } from 'node:events';

const KEEP_MS = 30 * 86400000;
const THIN_MS = 10 * 60000;
const WINDOWS = ['five_hour', 'seven_day', 'spend_limit'];

function num(x) {
  const n = Number(x);
  return Number.isFinite(n) ? n : null;
}

// A reading as the mod sends it (SessionRateLimit[] and SessionCost), or as the status
// line has it (rate_limits.*.used_percentage, resets_at in seconds), into one shape.
export function normalize(body, now = Date.now()) {
  const windows = {};
  const list = Array.isArray(body.rateLimits) ? body.rateLimits : [];
  for (const w of list) {
    if (!w || !WINDOWS.includes(w.kind)) continue;
    const pct = num(w.percentUsed);
    if (pct == null) continue;
    const resetsAt = w.resetsAt ? Date.parse(w.resetsAt) : null;
    windows[w.kind] = { pct: Math.max(0, Math.min(200, Math.round(pct * 10) / 10)), resetsAt: Number.isFinite(resetsAt) ? resetsAt : null };
  }
  const rl = body.rate_limits && typeof body.rate_limits === 'object' ? body.rate_limits : null;
  if (rl) {
    for (const k of WINDOWS) {
      const w = rl[k];
      const pct = w && num(w.used_percentage);
      if (pct == null) continue;
      const resetsAt = num(w.resets_at);
      windows[k] = { pct: Math.max(0, Math.min(200, Math.round(pct * 10) / 10)), resetsAt: resetsAt ? resetsAt * 1000 : null };
    }
  }
  const cost = body.cost && num(body.cost.usd ?? body.cost.total_cost_usd);
  const ctx = body.context && typeof body.context === 'object' ? body.context : (body.context_window || null);
  return {
    t: now,
    sid: String(body.sessionId || body.session_id || '').slice(0, 80),
    cwd: String(body.cwd || '').slice(0, 400),
    model: String(body.model || '').slice(0, 80),
    windows,
    cost: cost == null ? null : { usd: Math.round(cost * 10000) / 10000 },
    context: ctx ? { percent: num(ctx.percent ?? ctx.used_percentage), tokens: num(ctx.tokens ?? ctx.total_input_tokens), window: num(ctx.window ?? ctx.context_window_size) } : null,
  };
}

export class Usage extends EventEmitter {
  constructor({ file = null } = {}) {
    super();
    this.file = file;
    this.readings = [];
    this.latest = null;          // the newest reading with any window
    this.perChat = new Map();    // sid -> { usd, t, cwd, model }
    this.lastKept = new Map();   // window state key -> t of the last reading written
    this.load();
  }

  load() {
    if (!this.file || !fs.existsSync(this.file)) return;
    const cutoff = Date.now() - KEEP_MS;
    let lines = [];
    try { lines = fs.readFileSync(this.file, 'utf8').split('\n').filter(Boolean); } catch { return; }
    for (const line of lines) {
      let r;
      try { r = JSON.parse(line); } catch { continue; }
      if (!r || !r.t || r.t < cutoff) continue;
      this.absorb(r, false);
    }
  }

  absorb(r, write = true) {
    this.readings.push(r);
    if (Object.keys(r.windows || {}).length) this.latest = r;
    if (r.sid && r.cost && r.cost.usd != null) this.perChat.set(r.sid, { usd: r.cost.usd, t: r.t, cwd: r.cwd, model: r.model });
    if (write) this.append(r);
  }

  // Keeps one reading per ten minutes unless a window moved, so the file stays small.
  add(body) {
    const r = normalize(body);
    if (!r.sid && !Object.keys(r.windows).length) return null;
    const key = Object.entries(r.windows).map(([k, w]) => `${k}:${w.pct}`).join('|') || 'none';
    const last = this.lastKept.get(key) || 0;
    const costMoved = r.sid && r.cost && (!this.perChat.has(r.sid) || Math.abs(this.perChat.get(r.sid).usd - r.cost.usd) >= 0.001);
    if (r.t - last < THIN_MS && !costMoved) {
      // Same state as recently: update what is live, write nothing.
      if (Object.keys(r.windows).length) this.latest = r;
      this.emit('usage', this.summary());
      return r;
    }
    this.lastKept.set(key, r.t);
    this.absorb(r, true);
    this.prune();
    this.emit('usage', this.summary());
    return r;
  }

  append(r) {
    if (!this.file) return;
    try { fs.appendFileSync(this.file, `${JSON.stringify(r)}\n`, { mode: 0o600 }); } catch { /* not fatal */ }
  }

  prune() {
    const cutoff = Date.now() - KEEP_MS;
    if (this.readings.length && this.readings[0].t < cutoff) {
      this.readings = this.readings.filter((r) => r.t >= cutoff);
      if (this.file) {
        try { fs.writeFileSync(`${this.file}.tmp`, this.readings.map((r) => JSON.stringify(r)).join('\n') + (this.readings.length ? '\n' : ''), { mode: 0o600 }); fs.renameSync(`${this.file}.tmp`, this.file); } catch { /* keep going */ }
      }
    }
  }

  costOf(sid) {
    return this.perChat.get(sid) || null;
  }

  // The windows as they stand, with how far through each one is and whether the account
  // is ahead of an even pace.
  summary(now = Date.now()) {
    const l = this.latest;
    if (!l) return { at: null, windows: {}, stale: true };
    const windows = {};
    for (const [k, w] of Object.entries(l.windows)) {
      const length = k === 'five_hour' ? 5 * 3600000 : k === 'seven_day' ? 7 * 86400000 : null;
      let elapsedPct = null;
      let ahead = null;
      if (length && w.resetsAt) {
        const start = w.resetsAt - length;
        elapsedPct = Math.max(0, Math.min(100, ((now - start) / length) * 100));
        ahead = w.pct > elapsedPct + 5;
      }
      windows[k] = { pct: w.pct, resetsAt: w.resetsAt, elapsedPct: elapsedPct == null ? null : Math.round(elapsedPct), ahead, gone: w.resetsAt ? w.resetsAt <= now : false };
    }
    return { at: l.t, windows, stale: now - l.t > 6 * 3600000, fromChat: l.sid || '' };
  }

  // Points for the pace chart of one window: [t, pct] over the window's current span.
  history(kind = 'seven_day', now = Date.now()) {
    const l = this.latest;
    const w = l && l.windows[kind];
    if (!w || !w.resetsAt) return [];
    const length = kind === 'five_hour' ? 5 * 3600000 : 7 * 86400000;
    const start = w.resetsAt - length;
    const points = [];
    for (const r of this.readings) {
      const x = r.windows && r.windows[kind];
      if (!x || r.t < start) continue;
      points.push([r.t, x.pct]);
    }
    if (l.t >= start && (!points.length || points[points.length - 1][0] !== l.t)) points.push([l.t, w.pct]);
    return points.slice(-400);
  }

  // Cost per chat as Claude Code counted it, for chats seen since `since`.
  costs(since = 0) {
    const out = [];
    for (const [sid, c] of this.perChat) if (c.t >= since) out.push({ sid, ...c });
    return out;
  }
}
