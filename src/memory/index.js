// Kroog's second brain: your ~/.claude world (instructions, rules, skills, agents, commands,
// plans, Claude Code's auto memory, each project's .claude docs) and Kroog's notes, split into
// chunks and made searchable by meaning and by keyword. Everything stays on this Mac in
// ~/.kroog/brain/: meta.json (files and chunks) and vectors.bin (one Float32 row per chunk).
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { listSources } from './sources.js';
import { chunkMarkdown } from './chunk.js';
import { Bm25, tokens } from './bm25.js';
import { pickEmbedder, OllamaEmbedder } from './embed.js';
import { buildMap, fileSimilarity, MAX_FILES, MAX_CHATS } from './map.js';

export const KINDS = ['instructions', 'skill', 'agent', 'command', 'plan', 'memory', 'project-doc', 'note'];
const RRF_K = 60;
const NOTE_PREFIX = 'kroog-note:';

const hash = (text) => crypto.createHash('sha1').update(text).digest('hex').slice(0, 16);

function writeAtomic(file, data) {
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, data, { mode: 0o600 });
  fs.renameSync(tmp, file);
}

function emptyMeta() {
  return { version: 1, embedder: null, files: {}, chunks: [], lastBuilt: 0 };
}

export function loadIndex(dir) {
  let meta = emptyMeta();
  let vectors = new Float32Array(0);
  try {
    meta = { ...emptyMeta(), ...JSON.parse(fs.readFileSync(path.join(dir, 'meta.json'), 'utf8')) };
    const buf = fs.readFileSync(path.join(dir, 'vectors.bin'));
    vectors = new Float32Array(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength));
  } catch { /* no index yet */ }
  const dims = meta.embedder && meta.embedder.dims;
  if (!dims || vectors.length % dims !== 0) {
    vectors = new Float32Array(0);
    for (const c of meta.chunks) c.v = -1;
  }
  return { meta, vectors };
}

// A short piece of the text around the first place the query words appear.
export function snippetFor(text, query, size = 240) {
  const t = String(text || '').replace(/\s+/g, ' ').trim();
  if (t.length <= size) return t;
  const words = tokens(query);
  const lower = t.toLowerCase();
  let at = -1;
  for (const w of words) {
    const i = lower.indexOf(w);
    if (i !== -1 && (at === -1 || i < at)) at = i;
  }
  if (at === -1) return `${t.slice(0, size - 1)}…`;
  const start = Math.max(0, at - Math.floor(size / 3));
  const end = Math.min(t.length, start + size);
  return `${start > 0 ? '…' : ''}${t.slice(start, end)}${end < t.length ? '…' : ''}`;
}

export class SecondBrain {
  constructor({ dir, claudeDir = '', getSettings = () => ({}), getProjects = () => [], getNotes = () => [], embedder = undefined } = {}) {
    this.dir = dir;
    this.claudeDir = claudeDir;
    this.getSettings = getSettings;
    this.getProjects = getProjects;
    this.getNotes = getNotes;
    // undefined: pick one when building. null: keyword only. An object: use it (tests).
    this.fixedEmbedder = embedder;
    this.embedder = embedder || null;
    this.building = null;
    this.progress = null;
    this.error = null;
    this.timer = null;
    this.embedCalls = 0;
    const { meta, vectors } = dir ? loadIndex(dir) : { meta: emptyMeta(), vectors: new Float32Array(0) };
    this.meta = meta;
    this.vectors = vectors;
    this.reindexKeywords();
    this.mapCache = null;
    this.simCache = null;
  }

  // Changes only when the indexed content or its vectors change (not on every rebuild).
  indexKey() {
    const parts = Object.entries(this.meta.files).map(([p, f]) => `${p}:${f.hash}`).sort();
    const e = this.meta.embedder;
    return hash(`${parts.join('|')}|${e ? `${e.name}/${e.model}/${e.dims}` : 'none'}|${this.meta.chunks.filter((c) => c.v >= 0).length}`);
  }

  // The brain as a map: file and chat nodes, joined by similarity and lineage. Cached until
  // the index or the chats change. chats: [{ id, title, project, cwd, gist, keywords,
  // lastReply, lastPrompt, status, lastAt, inputs }].
  map(chats = [], { maxFiles = MAX_FILES, maxChats = MAX_CHATS } = {}) {
    const list = (Array.isArray(chats) ? chats : []).filter((c) => c && c.id);
    const indexKey = this.indexKey();
    const key = `${indexKey}|${maxFiles}|${maxChats}|${list.map((c) => `${c.id}:${c.lastAt || 0}:${(c.inputs || []).length}`).sort().join(',')}`;
    if (this.mapCache && this.mapCache.key === key) return this.mapCache.promise;
    const promise = (async () => {
      const paths = Object.entries(this.meta.files).sort((a, b) => (b[1].mtime || 0) - (a[1].mtime || 0)).slice(0, maxFiles).map(([p]) => p);
      const simKey = `${indexKey}|${maxFiles}`;
      if (!this.simCache || this.simCache.key !== simKey) this.simCache = { key: simKey, sim: fileSimilarity(this.meta, this.vectors, paths) };
      const sim = this.simCache.sim;
      let embedChats = null;
      if (sim.mode === 'vectors') {
        const emb = await this.queryEmbedder();
        const dims = this.meta.embedder && this.meta.embedder.dims;
        if (emb && dims && (!emb.model || !this.meta.embedder.model || emb.model === this.meta.embedder.model)) {
          embedChats = async (texts) => {
            const out = [];
            for (let i = 0; i < texts.length; i += 32) {
              const vecs = await emb.embed(texts.slice(i, i + 32).map((t) => emb.docText('chat', t)));
              for (const v of vecs) out.push(v && v.length === dims ? v : null);
            }
            return out;
          };
        }
      }
      return buildMap({ meta: this.meta, vectors: this.vectors, chats: list, embedChats, maxFiles, maxChats, fileSim: sim });
    })();
    this.mapCache = { key, promise };
    promise.catch(() => { if (this.mapCache && this.mapCache.promise === promise) this.mapCache = null; });
    return promise;
  }

  reindexKeywords() {
    this.bm25 = new Bm25(this.meta.chunks.map((c) => `${c.title} ${c.heading} ${c.text}`));
  }

  status() {
    const counts = {};
    for (const f of Object.values(this.meta.files)) counts[f.kind] = (counts[f.kind] || 0) + 1;
    const e = this.meta.embedder;
    return {
      files: Object.keys(this.meta.files).length,
      chunks: this.meta.chunks.length,
      withVectors: this.meta.chunks.filter((c) => c.v >= 0).length,
      embedder: e ? e.name : 'none',
      model: e ? e.model : null,
      dims: e ? e.dims : 0,
      building: Boolean(this.building),
      progress: this.progress,
      lastBuilt: this.meta.lastBuilt || 0,
      error: this.error,
      sources: KINDS.filter((k) => counts[k]).map((kind) => ({ kind, count: counts[kind] })),
    };
  }

  async chooseEmbedder() {
    if (this.fixedEmbedder !== undefined) return this.fixedEmbedder;
    try {
      return await pickEmbedder(this.getSettings() || {});
    } catch (error) {
      this.error = error.message;
      return null;
    }
  }

  build(opts = {}) {
    if (this.building) return this.building;
    this.building = this.buildNow(opts).finally(() => {
      this.building = null;
      this.progress = null;
    });
    return this.building;
  }

  async buildNow({ onProgress } = {}) {
    this.error = null;
    const report = (p) => { this.progress = p; if (onProgress) onProgress(p); };
    report({ phase: 'reading', done: 0, total: 0 });

    const embedder = await this.chooseEmbedder();
    this.embedder = embedder;
    const old = this.meta;
    const oldVec = this.vectors;
    const sameEmbedder = embedder && old.embedder && old.embedder.name === embedder.name && old.embedder.model === embedder.model;

    // Every source now: files on disk, and Kroog notes as virtual files.
    const sources = listSources({ claudeDir: this.claudeDir, projects: this.getProjects() || [] });
    for (const n of this.getNotes() || []) {
      if (!n || !n.id || !n.text) continue;
      sources.push({ path: `${NOTE_PREFIX}${n.id}`, mtime: n.t || 0, size: n.text.length, kind: 'note', project: n.project || 'no project', note: n });
    }

    const files = {};
    const chunks = [];
    const keepRows = [];
    const todo = [];
    let readCount = 0;
    for (const src of sources) {
      readCount += 1;
      if (readCount % 50 === 0) report({ phase: 'reading', done: readCount, total: sources.length });
      const prev = old.files[src.path];
      let text = null;
      let fileHash = prev ? prev.hash : '';
      const unchanged = prev && prev.mtime === src.mtime && prev.size === src.size && !src.note;
      if (!unchanged) {
        try {
          text = src.note ? `${src.note.type || 'Note'}: ${src.note.text}` : fs.readFileSync(src.path, 'utf8');
        } catch { continue; }
        if (text.includes('\u0000')) continue;
        fileHash = hash(text);
      }
      const reuse = prev && prev.hash === fileHash;
      const entry = { mtime: src.mtime, size: src.size, hash: fileHash, kind: src.kind, project: src.project, title: prev ? prev.title : '' };
      files[src.path] = entry;
      if (reuse) {
        for (const c of old.chunks.filter((x) => x.path === src.path)) {
          const next = { ...c, kind: src.kind, project: src.project };
          if (sameEmbedder && c.v >= 0) {
            next.v = keepRows.length;
            keepRows.push(c.v);
          } else {
            next.v = -1;
            if (embedder) todo.push(next);
          }
          chunks.push(next);
        }
        continue;
      }
      const name = src.note ? `note: ${(src.note.type || 'note').toLowerCase()}` : src.path;
      const { title, chunks: parts } = chunkMarkdown(text, name);
      entry.title = src.note ? `${src.note.type || 'Note'} (${src.note.project || 'no project'})` : title;
      parts.forEach((p, i) => {
        const c = { id: `${hash(src.path)}-${i}`, path: src.path, title: entry.title, heading: src.note ? entry.title : p.heading, kind: src.kind, project: src.project, text: p.text, v: -1 };
        chunks.push(c);
        if (embedder) todo.push(c);
      });
    }

    // Vectors: keep the old rows, then embed what is new or changed.
    let dims = sameEmbedder ? old.embedder.dims : 0;
    const newRows = [];
    if (embedder && todo.length) {
      try {
        for (let i = 0; i < todo.length; i += 32) {
          report({ phase: 'embedding', done: i, total: todo.length });
          const batch = todo.slice(i, i + 32);
          const vecs = await embedder.embed(batch.map((c) => embedder.docText(c.title, `${c.heading}\n${c.text}`)));
          this.embedCalls += 1;
          vecs.forEach((v, j) => { newRows.push({ c: batch[j], v }); });
          if (!dims && vecs[0]) dims = vecs[0].length;
        }
      } catch (error) {
        this.error = `Embedding stopped: ${error.message}. Keyword search still works.`;
      }
    }
    if (!dims && embedder && embedder.dims) dims = embedder.dims;
    const total = keepRows.length + newRows.length;
    const vectors = new Float32Array(dims ? total * dims : 0);
    if (dims) {
      keepRows.forEach((row, i) => vectors.set(oldVec.subarray(row * dims, row * dims + dims), i * dims));
      newRows.forEach(({ c, v }, j) => {
        const row = keepRows.length + j;
        if (v.length !== dims) return;
        vectors.set(v, row * dims);
        c.v = row;
      });
    }

    this.meta = {
      version: 1,
      embedder: embedder && dims ? { name: embedder.name, model: embedder.model || null, dims } : null,
      files,
      chunks,
      lastBuilt: Date.now(),
    };
    this.vectors = vectors;
    this.reindexKeywords();
    if (this.dir) {
      fs.mkdirSync(this.dir, { recursive: true, mode: 0o700 });
      writeAtomic(path.join(this.dir, 'vectors.bin'), Buffer.from(vectors.buffer, vectors.byteOffset, vectors.byteLength));
      writeAtomic(path.join(this.dir, 'meta.json'), JSON.stringify(this.meta));
    }
    report({ phase: 'done', done: total, total });
    return this.status();
  }

  // An embedder for queries when this index was built elsewhere (the MCP server).
  async queryEmbedder() {
    if (this.embedder) return this.embedder;
    const e = this.meta.embedder;
    if (!e || this.fixedEmbedder === null) return null;
    if (e.name === 'ollama') {
      try {
        const s = this.getSettings() || {};
        this.embedder = await new OllamaEmbedder({ url: s.ollamaUrl || 'http://127.0.0.1:11434', model: e.model, fallbacks: [] }).ready();
        return this.embedder;
      } catch {
        return null;
      }
    }
    return null;
  }

  async search(query, { limit = 12, kinds = null, project = null } = {}) {
    const q = String(query || '').trim();
    if (!q) return [];
    const chunks = this.meta.chunks;
    const allowed = (c) => (!kinds || !kinds.length || kinds.includes(c.kind)) && (!project || c.project === project);
    const fused = new Map();
    const addRanks = (scores) => {
      const ranked = [];
      scores.forEach((s, i) => { if (s > 0 && allowed(chunks[i])) ranked.push(i); });
      ranked.sort((a, b) => scores[b] - scores[a]);
      ranked.slice(0, 80).forEach((i, r) => fused.set(i, (fused.get(i) || 0) + 1 / (RRF_K + r + 1)));
    };
    addRanks(this.bm25.scores(q));

    const dims = this.meta.embedder && this.meta.embedder.dims;
    if (dims && this.vectors.length) {
      const emb = await this.queryEmbedder();
      if (emb && (!emb.model || !this.meta.embedder.model || emb.model === this.meta.embedder.model)) {
        try {
          const [qv] = await emb.embed([emb.queryText(q)]);
          if (qv && qv.length === dims) {
            const scores = new Float64Array(chunks.length);
            for (let i = 0; i < chunks.length; i += 1) {
              const row = chunks[i].v;
              if (row < 0) continue;
              let s = 0;
              const off = row * dims;
              for (let d = 0; d < dims; d += 1) s += qv[d] * this.vectors[off + d];
              scores[i] = s > 0.2 ? s : 0;
            }
            addRanks(scores);
          }
        } catch { /* keyword results only */ }
      }
    }

    const perFile = new Map();
    const results = [];
    for (const [i, score] of [...fused.entries()].sort((a, b) => b[1] - a[1])) {
      const c = chunks[i];
      const n = perFile.get(c.path) || 0;
      if (n >= 2) continue;
      perFile.set(c.path, n + 1);
      results.push({ id: c.id, path: c.path, title: c.title, heading: c.heading, kind: c.kind, project: c.project, snippet: snippetFor(c.text, q), score: Number(score.toFixed(5)) });
      if (results.length >= limit) break;
    }
    return results;
  }

  // The latest files, newest first, shaped like search results.
  recent(limit = 10) {
    return Object.entries(this.meta.files)
      .filter(([p]) => !p.startsWith(NOTE_PREFIX))
      .sort((a, b) => b[1].mtime - a[1].mtime)
      .slice(0, limit)
      .map(([p, f]) => {
        const first = this.meta.chunks.find((c) => c.path === p);
        return { id: first ? first.id : p, path: p, title: f.title || path.basename(p), heading: first ? first.heading : '', kind: f.kind, project: f.project, snippet: first ? snippetFor(first.text, '') : '', mtime: f.mtime, score: 0 };
      });
  }

  // Only a file that is in the index can be read.
  readFile(p) {
    const f = this.meta.files[p];
    if (!f) throw new Error('That file is not in the brain.');
    if (p.startsWith(NOTE_PREFIX)) return this.meta.chunks.filter((c) => c.path === p).map((c) => c.text).join('\n\n');
    return fs.readFileSync(p, 'utf8');
  }

  start({ everyMs = 120000 } = {}) {
    this.stop();
    this.build().catch((e) => { this.error = e.message; });
    this.timer = setInterval(() => { this.build().catch((e) => { this.error = e.message; }); }, everyMs);
    if (this.timer.unref) this.timer.unref();
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }
}
