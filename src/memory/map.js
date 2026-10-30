// The brain as a map: one node per indexed file and one per recent chat, joined by
// similarity (vectors when the index has them, else TF-IDF over the chunk text) and by
// lineage (briefs, branches, project memory). The page draws it; this only computes it.
import { tokens } from './bm25.js';

export const MAX_FILES = 600;
export const MAX_CHATS = 200;
const TOP_SIMILAR = 3;
const MIN_VEC = 0.35;
const MIN_TFIDF = 0.12;
const EDGES_PER_NODE = 3;
const MAX_DEGREE = 6;
const NOTE_PREFIX = 'kroog-note:';

// ---- vectors ------------------------------------------------------------------------

function unit(v) {
  let n = 0;
  for (let i = 0; i < v.length; i += 1) n += v[i] * v[i];
  n = Math.sqrt(n);
  if (!n) return null;
  const out = new Float32Array(v.length);
  for (let i = 0; i < v.length; i += 1) out[i] = v[i] / n;
  return out;
}

function dot(a, b) {
  let s = 0;
  for (let i = 0; i < a.length; i += 1) s += a[i] * b[i];
  return s;
}

// One vector per file: the mean of its chunk vectors (unit length). Files with no vectors
// are left out, so they fall back to keyword similarity.
export function fileVectors(meta, vectors) {
  const dims = meta.embedder && meta.embedder.dims;
  const out = new Map();
  if (!dims || !vectors.length) return out;
  const sums = new Map();
  for (const c of meta.chunks) {
    if (c.v < 0) continue;
    let acc = sums.get(c.path);
    if (!acc) {
      acc = new Float32Array(dims);
      sums.set(c.path, acc);
    }
    const off = c.v * dims;
    for (let d = 0; d < dims; d += 1) acc[d] += vectors[off + d];
  }
  for (const [p, acc] of sums) {
    const u = unit(acc);
    if (u) out.set(p, u);
  }
  return out;
}

// ---- TF-IDF, sparse ------------------------------------------------------------------

export function tfidfModel(meta) {
  const docs = new Map();
  for (const c of meta.chunks) {
    const bag = docs.get(c.path) || new Map();
    // The words of the text and its headings, not the file's own name.
    const base = String(c.path || '').split('/').pop();
    const title = c.title && c.title !== base && !String(c.title).endsWith(`/${base}`) ? c.title : '';
    const heads = String(c.heading || '').split(' › ').slice(1).join(' ');
    for (const t of tokens(`${title} ${heads} ${c.text}`)) bag.set(t, (bag.get(t) || 0) + 1);
    docs.set(c.path, bag);
  }
  const df = new Map();
  for (const bag of docs.values()) for (const t of bag.keys()) df.set(t, (df.get(t) || 0) + 1);
  const n = docs.size || 1;
  const idf = new Map();
  for (const [t, d] of df) idf.set(t, Math.log(1 + n / d));
  const weigh = (bag) => {
    let norm = 0;
    const vec = new Map();
    for (const [t, tf] of bag) {
      const w = (1 + Math.log(tf)) * (idf.get(t) || 0);
      if (w <= 0) continue;
      vec.set(t, w);
      norm += w * w;
    }
    norm = Math.sqrt(norm) || 1;
    for (const [t, w] of vec) vec.set(t, w / norm);
    return vec;
  };
  const byPath = new Map();
  for (const [p, bag] of docs) byPath.set(p, weigh(bag));
  return {
    idf,
    byPath,
    // A query vector in the same space, from free text.
    vectorFor(text) {
      const bag = new Map();
      for (const t of tokens(text)) if (idf.has(t)) bag.set(t, (bag.get(t) || 0) + 1);
      return weigh(bag);
    },
  };
}

export function sparseCos(a, b) {
  if (!a || !b || !a.size || !b.size) return 0;
  const [small, big] = a.size <= b.size ? [a, b] : [b, a];
  let s = 0;
  for (const [t, w] of small) {
    const v = big.get(t);
    if (v) s += w * v;
  }
  return s;
}

// ---- nearest neighbours --------------------------------------------------------------

// For each item, its strongest links to the others. `score(i, j)` must be symmetric.
function nearest(ids, score, min, top = TOP_SIMILAR) {
  const n = ids.length;
  const best = new Map();
  for (let i = 0; i < n; i += 1) {
    const cands = [];
    for (let j = 0; j < n; j += 1) {
      if (j === i) continue;
      const w = score(i, j);
      if (w >= min) cands.push([j, w]);
    }
    cands.sort((x, y) => y[1] - x[1]);
    for (const [j, w] of cands.slice(0, top)) {
      const key = i < j ? `${i}|${j}` : `${j}|${i}`;
      if (!best.has(key) || best.get(key).w < w) best.set(key, { a: ids[i < j ? i : j], b: ids[i < j ? j : i], w });
    }
  }
  return [...best.values()];
}

function clip01(x) {
  return Math.max(0, Math.min(1, Number(x) || 0));
}

function headingsOf(chunks, named) {
  const out = [];
  for (const c of chunks) {
    const last = String(c.heading || '').split(' › ').pop();
    if (!last || last === named || out.includes(last)) continue;
    out.push(last);
    if (out.length >= 3) break;
  }
  return out;
}

// Text that stands for a chat when comparing it with files.
export function chatText(c) {
  return [c.title, c.gist, (c.keywords || []).join(' '), String(c.lastReply || '').slice(0, 800), String(c.lastPrompt || '').slice(0, 300)].filter(Boolean).join('\n');
}

// ---- the map -------------------------------------------------------------------------

// `embedChats(texts)` resolves to an array of unit vectors in the index's space, or null.
export async function buildMap({ meta, vectors, chats = [], embedChats = null, maxFiles = MAX_FILES, maxChats = MAX_CHATS, fileSim = null }) {
  const byPath = new Map();
  for (const c of meta.chunks) {
    const list = byPath.get(c.path) || [];
    list.push(c);
    byPath.set(c.path, list);
  }
  let files = Object.entries(meta.files).map(([p, f]) => ({ path: p, ...f }));
  files.sort((a, b) => (b.mtime || 0) - (a.mtime || 0));
  const truncated = files.length > maxFiles;
  files = files.slice(0, maxFiles);

  const nodes = [];
  for (const f of files) {
    const chunks = byPath.get(f.path) || [];
    const named = f.path.startsWith(NOTE_PREFIX) ? f.title : f.path.split('/').pop();
    nodes.push({
      id: `f:${f.path}`,
      type: 'file',
      kind: f.kind,
      title: f.title || named,
      project: f.project || 'all projects',
      path: f.path,
      size: chunks.length,
      mtime: f.mtime || 0,
      headings: headingsOf(chunks, named),
    });
  }

  const liveChats = (Array.isArray(chats) ? chats : []).filter((c) => c && c.id).sort((a, b) => (b.lastAt || 0) - (a.lastAt || 0)).slice(0, maxChats);
  for (const c of liveChats) {
    nodes.push({
      id: `c:${c.id}`,
      type: 'chat',
      chatId: c.id,
      title: c.title || 'Untitled chat',
      project: c.project || 'no project',
      cwd: c.cwd || '',
      status: c.status || 'done',
      lastAt: c.lastAt || 0,
      gist: c.gist || '',
      keywords: Array.isArray(c.keywords) ? c.keywords.slice(0, 4) : [],
    });
  }

  // File to file. Reused across calls while the index is the same (fileSim).
  const paths = files.map((f) => f.path);
  const sim = fileSim || fileSimilarity(meta, vectors, paths);
  const edges = sim.edges.map((e) => ({ a: `f:${e.a}`, b: `f:${e.b}`, w: clip01(e.w), kind: 'similar' }));

  // Chat to file.
  if (liveChats.length && paths.length) {
    let chatVecs = null;
    if (sim.mode === 'vectors' && embedChats) {
      try { chatVecs = await embedChats(liveChats.map(chatText)); } catch { chatVecs = null; }
    }
    const vecPaths = sim.mode === 'vectors' ? paths.filter((p) => sim.fileVec.has(p)) : [];
    liveChats.forEach((c, i) => {
      const cands = [];
      const qv = chatVecs && chatVecs[i] ? unit(chatVecs[i]) : null;
      if (qv && vecPaths.length) {
        for (const p of vecPaths) {
          const w = dot(qv, sim.fileVec.get(p));
          if (w >= MIN_VEC) cands.push([p, w]);
        }
      } else {
        const tv = sim.tfidf.vectorFor(chatText(c));
        for (const p of paths) {
          const w = sparseCos(tv, sim.tfidf.byPath.get(p));
          if (w >= MIN_TFIDF) cands.push([p, w]);
        }
      }
      cands.sort((x, y) => y[1] - x[1]);
      for (const [p, w] of cands.slice(0, TOP_SIMILAR)) edges.push({ a: `c:${c.id}`, b: `f:${p}`, w: clip01(w), kind: 'similar' });
    });
  }

  // Lineage, from what each chat was given.
  const chatIds = new Set(liveChats.map((c) => c.id));
  const seen = new Set();
  for (const c of liveChats) {
    for (const input of Array.isArray(c.inputs) ? c.inputs : []) {
      const kind = input && ['brief', 'continue', 'memory'].includes(input.kind) ? input.kind : null;
      if (!kind) continue;
      for (const from of Array.isArray(input.from) ? input.from : []) {
        if (!chatIds.has(from) || from === c.id) continue;
        const key = `${from}>${c.id}:${kind}`;
        if (seen.has(key)) continue;
        seen.add(key);
        edges.push({ a: `c:${from}`, b: `c:${c.id}`, w: 1, kind });
      }
    }
  }

  // Keep the map calm: strongest links first, no node with more than a few, and a cap on
  // the total. A node keeps its one best link even when its neighbour is already busy.
  const similar = edges.filter((e) => e.kind === 'similar').sort((x, y) => y.w - x.w);
  const cap = Math.max(20, EDGES_PER_NODE * nodes.length);
  const degree = new Map();
  const kept = [];
  for (const e of similar) {
    if (kept.length >= cap) break;
    const da = degree.get(e.a) || 0;
    const db = degree.get(e.b) || 0;
    if (da >= MAX_DEGREE || db >= MAX_DEGREE) continue;
    kept.push(e);
    degree.set(e.a, da + 1);
    degree.set(e.b, db + 1);
  }
  for (const e of similar) {
    if (kept.length >= cap) break;
    if (!degree.get(e.a) || !degree.get(e.b)) {
      kept.push(e);
      degree.set(e.a, (degree.get(e.a) || 0) + 1);
      degree.set(e.b, (degree.get(e.b) || 0) + 1);
    }
  }
  const final = [...edges.filter((e) => e.kind !== 'similar'), ...kept];

  return { nodes, edges: final, truncated, builtAt: Date.now(), embedder: sim.mode === 'vectors' ? (meta.embedder ? meta.embedder.name : 'vectors') : 'keyword', mode: sim.mode };
}

// File similarity for one state of the index: which way (vectors or keywords), the file
// vectors, the TF-IDF model, and the file-to-file edges.
export function fileSimilarity(meta, vectors, paths) {
  const fileVec = fileVectors(meta, vectors);
  const tfidf = tfidfModel(meta);
  const withVec = paths.filter((p) => fileVec.has(p));
  // Use vectors when most files have them; the rest join by keyword.
  const mode = withVec.length >= Math.max(2, paths.length * 0.6) ? 'vectors' : 'keyword';
  let edges = [];
  if (mode === 'vectors') {
    const vecs = withVec.map((p) => fileVec.get(p));
    edges = nearest(withVec, (i, j) => dot(vecs[i], vecs[j]), MIN_VEC);
    const rest = paths.filter((p) => !fileVec.has(p));
    if (rest.length) {
      // Files without vectors: link them to anything by keyword.
      const all = paths;
      const sv = all.map((p) => tfidf.byPath.get(p));
      const restSet = new Set(rest);
      const more = nearest(all, (i, j) => (restSet.has(all[i]) || restSet.has(all[j]) ? sparseCos(sv[i], sv[j]) : 0), MIN_TFIDF);
      edges = edges.concat(more);
    }
  } else {
    const sv = paths.map((p) => tfidf.byPath.get(p));
    edges = nearest(paths, (i, j) => sparseCos(sv[i], sv[j]), MIN_TFIDF);
  }
  return { mode, fileVec, tfidf, edges };
}
