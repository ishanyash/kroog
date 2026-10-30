// Suggested groups: chats that are about the same piece of work, found by Kroog and named
// by the AI helper (Haiku on your plan), so you can start one new chat from all of them.
//
// Two passes. First, a cheap one with no model: each chat's words (title, summary, keywords,
// what was asked, its last reply, its files) compared pairwise, joined above a threshold.
// Then, when the AI helper is on, one small call names each group and says why; with more
// than a couple of chats the helper also gets to propose the groups itself, which reads
// better than word overlap. Results are cached until the chats change.
import { truncate, clip } from './util.js';

const MAX_CHATS = 80;
const MAX_GROUP = 8;
const SIM_THRESHOLD = 0.2;
const RECENT_DAYS = 14;
// The AI helper is asked again only when the set of chats changes, and not more often than
// this while they merely keep working.
const AI_EVERY = 10 * 60000;

const SYSTEM = `You look at a person's recent Claude Code chats and group the ones that are about the same piece of work or the same topic, so they can be combined into one new chat with shared context.
Rules: only group chats that clearly belong together (same feature, same bug, same project area, same deliverable). 2 to 8 chats per group. A chat is in at most one group. Chats from different project folders can share a group only if they are clearly the same topic. Leave out chats that stand alone.
Reply with only JSON: [{"name": "...", "why": "...", "chats": [numbers]}]
- name: 2 to 4 plain words, lowercase, no punctuation, like a folder name ("terraform rollout", "slack cost agent")
- why: at most 12 words on what they share, no full stop
- chats: the numbers of the chats in the group`;

const STOP = new Set('the a an and or of to in on for with from by at as is are was were be been it its this that these those we you i they he she our your their not no yes do does did done can could should would will just also then than so if into over under about after before more most less very all any some each other same new old up out off'.split(' '));

export function tokens(text) {
  const out = new Map();
  for (const raw of String(text || '').toLowerCase().split(/[^a-z0-9_.-]+/)) {
    let w = raw.replace(/^[._-]+|[._-]+$/g, '');
    if (w.length < 3 || STOP.has(w) || /^\d+$/.test(w)) continue;
    if (w.length > 4 && w.endsWith('s') && !w.endsWith('ss')) w = w.slice(0, -1);
    out.set(w, (out.get(w) || 0) + 1);
  }
  return out;
}

export function chatText(s) {
  const files = (s.files || []).slice(-12).map((f) => String(f).split('/').pop()).join(' ');
  const ai = s.ai || {};
  return [s.title, s.title, ai.gist, (ai.keywords || []).join(' '), (ai.keywords || []).join(' '), truncate(s.lastPrompt || '', 400), truncate(s.lastReply || '', 700), files, files].filter(Boolean).join('\n');
}

// Pairwise similarity by words (tf-idf cosine), then union above the threshold.
export function similarityGroups(sessions, threshold = SIM_THRESHOLD) {
  const docs = sessions.map((s) => tokens(chatText(s)));
  const df = new Map();
  for (const d of docs) for (const w of d.keys()) df.set(w, (df.get(w) || 0) + 1);
  const n = docs.length;
  const vecs = docs.map((d) => {
    const v = new Map();
    let norm = 0;
    for (const [w, tf] of d) {
      const idf = Math.log(1 + n / (df.get(w) || 1));
      const x = (1 + Math.log(tf)) * idf;
      v.set(w, x);
      norm += x * x;
    }
    norm = Math.sqrt(norm) || 1;
    for (const [w, x] of v) v.set(w, x / norm);
    return v;
  });
  const cos = (a, b) => {
    let sum = 0;
    const [small, big] = a.size < b.size ? [a, b] : [b, a];
    for (const [w, x] of small) { const y = big.get(w); if (y) sum += x * y; }
    return sum;
  };
  const parent = sessions.map((_, i) => i);
  const find = (i) => (parent[i] === i ? i : (parent[i] = find(parent[i])));
  const pairs = [];
  for (let i = 0; i < n; i += 1) {
    for (let j = i + 1; j < n; j += 1) {
      const c = cos(vecs[i], vecs[j]);
      if (c >= threshold) pairs.push([c, i, j]);
    }
  }
  pairs.sort((a, b) => b[0] - a[0]);
  const size = new Map();
  for (const [, i, j] of pairs) {
    const a = find(i);
    const b = find(j);
    if (a === b) continue;
    if ((size.get(a) || 1) + (size.get(b) || 1) > MAX_GROUP) continue;
    parent[b] = a;
    size.set(a, (size.get(a) || 1) + (size.get(b) || 1));
  }
  const byRoot = new Map();
  sessions.forEach((s, i) => {
    const r = find(i);
    if (!byRoot.has(r)) byRoot.set(r, []);
    byRoot.get(r).push(s);
  });
  const groups = [];
  for (const members of byRoot.values()) {
    if (members.length < 2) continue;
    // A name from the words they share most.
    const counts = new Map();
    for (const s of members) for (const w of new Set(tokens(chatText(s)).keys())) counts.set(w, (counts.get(w) || 0) + 1);
    const shared = [...counts.entries()].filter(([, c]) => c >= Math.max(2, Math.ceil(members.length * 0.6))).sort((a, b) => b[1] - a[1]).slice(0, 3).map(([w]) => w);
    groups.push({ name: shared.join(' ') || 'related chats', why: shared.length ? `They all mention ${shared.join(', ')}.` : 'They use similar words.', chats: members.map((s) => s.id), by: 'words' });
  }
  return groups;
}

function parseJson(text) {
  const start = text.indexOf('[');
  const end = text.lastIndexOf(']');
  if (start === -1 || end <= start) return null;
  try { return JSON.parse(text.slice(start, end + 1)); } catch { return null; }
}

export class Groups {
  constructor({ store, ai = null, getSettings = () => ({}) }) {
    this.store = store;
    this.ai = ai;
    this.getSettings = getSettings;
    this.cache = { key: '', groups: [], at: 0, by: 'none' };
    this.busy = null;
  }

  candidates() {
    const since = Date.now() - RECENT_DAYS * 86400000;
    return Object.values(this.store.data.sessions)
      .filter((s) => !s.archived && (s.lastAt || 0) >= since && (s.lastPrompt || s.lastReply) && s.title)
      .sort((a, b) => (b.lastAt || 0) - (a.lastAt || 0))
      .slice(0, MAX_CHATS);
  }

  // What the groups depend on: which chats there are and what they are called. A chat
  // working away does not change the key; its new title or summary does.
  key(sessions) {
    return sessions.map((s) => `${s.id}:${truncate(s.title || '', 40)}:${s.ai && s.ai.gist ? truncate(s.ai.gist, 30) : ''}:${(s.files || []).length}`).join('|');
  }

  // The chats alone, for deciding whether the AI helper needs asking again.
  idKey(sessions) {
    return sessions.map((s) => s.id).sort().join('|');
  }

  current() {
    return this.cache.groups;
  }

  // Groups for the chats as they are now. Cached until a chat changes; `force` asks the
  // AI helper again even so.
  async refresh({ force = false } = {}) {
    const sessions = this.candidates();
    const key = this.key(sessions);
    if (!force && key === this.cache.key) return this.cache.groups;
    if (this.busy) return this.busy;
    this.busy = this.compute(sessions, key, force).finally(() => { this.busy = null; });
    return this.busy;
  }

  async compute(sessions, key, force = false) {
    const byId = new Map(sessions.map((s) => [s.id, s]));
    let groups = similarityGroups(sessions);
    let by = groups.length ? 'words' : 'none';
    const aiOn = this.ai && !['off', 'demo'].includes(this.ai.provider());
    const ids = this.idKey(sessions);
    const sameChats = ids === this.cache.ids && Array.isArray(this.cache.aiGroups);
    const recent = Date.now() - (this.cache.aiAt || 0) < AI_EVERY;
    if (aiOn && sessions.length >= 2 && (force || !sameChats || !recent)) {
      try {
        const proposed = await this.askAi(sessions);
        if (proposed) {
          groups = proposed;
          by = 'ai';
          this.cache.aiGroups = proposed;
          this.cache.aiAt = Date.now();
          this.cache.ids = ids;
        }
      } catch (error) {
        // The word groups stand; the error is shown in the status.
        this.cache.error = error.message;
      }
    } else if (aiOn && sameChats) {
      // The same chats as last time: keep the AI helper's groups, re-read against them.
      groups = this.cache.aiGroups;
      by = 'ai';
    }
    groups = groups
      .map((g) => ({ ...g, chats: [...new Set(g.chats)].filter((id) => byId.has(id)) }))
      .filter((g) => g.chats.length >= 2)
      .map((g) => {
        const members = g.chats.map((id) => byId.get(id));
        const folders = new Map();
        for (const s of members) if (s.cwd) folders.set(s.cwd, (folders.get(s.cwd) || 0) + 1);
        const cwd = [...folders.entries()].sort((a, b) => b[1] - a[1]).map(([f]) => f)[0] || '';
        const lastAt = Math.max(...members.map((s) => s.lastAt || 0));
        return { id: g.chats.slice().sort().join('+').slice(0, 200), name: truncate(String(g.name || 'related chats').toLowerCase(), 48), why: truncate(String(g.why || ''), 160), chats: g.chats, cwd, lastAt, by: g.by || by };
      })
      .sort((a, b) => b.lastAt - a.lastAt);
    this.cache = { ...this.cache, key, groups, at: Date.now(), by, error: this.cache.error && by !== 'ai' ? this.cache.error : null };
    this.store.emit('groups', groups);
    return groups;
  }

  async askAi(sessions) {
    const lines = sessions.map((s, i) => {
      const ai = s.ai || {};
      return `${i + 1}. [${s.project}] ${truncate(s.title, 90)}${ai.gist ? ` — ${ai.gist}` : ''}${(ai.keywords || []).length ? ` (${ai.keywords.join(', ')})` : ''}${(s.files || []).length ? ` files: ${s.files.slice(-4).map((f) => String(f).split('/').pop()).join(', ')}` : ''}`;
    });
    const text = await this.ai.complete({ system: SYSTEM, prompt: clip(lines.join('\n'), 24000), maxTokens: 900 });
    const arr = parseJson(text || '');
    if (!Array.isArray(arr)) return null;
    const used = new Set();
    const out = [];
    for (const g of arr) {
      if (!g || !Array.isArray(g.chats)) continue;
      const ids = g.chats.map((n) => sessions[Number(n) - 1]).filter(Boolean).map((s) => s.id).filter((id) => !used.has(id));
      if (ids.length < 2) continue;
      ids.forEach((id) => used.add(id));
      out.push({ name: String(g.name || ''), why: String(g.why || ''), chats: ids.slice(0, MAX_GROUP), by: 'ai' });
    }
    return out;
  }

  status() {
    return { count: this.cache.groups.length, by: this.cache.by, at: this.cache.at, error: this.cache.error || null, busy: Boolean(this.busy) };
  }
}
