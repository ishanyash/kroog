// A tiny keyword index (BM25) with a simple tokenizer.
const STOP = new Set('a an and are as at be by for from has have how i if in into is it its of on or that the this to was we were what when where which who will with you your'.split(' '));

export function tokens(text) {
  return String(text || '').toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '')
    .split(/[^a-z0-9_]+/).filter((t) => t.length > 1 && !STOP.has(t))
    .map((t) => (t.length > 3 && t.endsWith('s') && !t.endsWith('ss') ? t.slice(0, -1) : t));
}

export class Bm25 {
  constructor(docs = [], { k1 = 1.4, b = 0.75 } = {}) {
    this.k1 = k1;
    this.b = b;
    this.tf = [];
    this.len = [];
    this.df = new Map();
    for (const d of docs) this.add(d);
  }

  add(text) {
    const ts = tokens(text);
    const tf = new Map();
    for (const t of ts) tf.set(t, (tf.get(t) || 0) + 1);
    for (const t of tf.keys()) this.df.set(t, (this.df.get(t) || 0) + 1);
    this.tf.push(tf);
    this.len.push(ts.length);
  }

  // Scores for every document, as an array.
  scores(query) {
    const n = this.tf.length;
    const out = new Float64Array(n);
    if (!n) return out;
    const avg = this.len.reduce((a, b) => a + b, 0) / n || 1;
    const qs = [...new Set(tokens(query))];
    for (const q of qs) {
      const df = this.df.get(q);
      if (!df) continue;
      const idf = Math.log(1 + (n - df + 0.5) / (df + 0.5));
      for (let i = 0; i < n; i += 1) {
        const f = this.tf[i].get(q);
        if (!f) continue;
        out[i] += idf * (f * (this.k1 + 1)) / (f + this.k1 * (1 - this.b + this.b * (this.len[i] / avg)));
      }
    }
    return out;
  }
}
