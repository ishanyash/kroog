// Turning text into vectors, on this Mac.
//   ollama        Ollama's /api/embed (EmbeddingGemma by default, else nomic-embed-text)
//   transformers  @huggingface/transformers, only if it is installed in Kroog's folder
//   none          no vectors; search is keyword only
const GEMMA_DOC = (title, text) => `title: ${title || 'none'} | text: ${text}`;
const GEMMA_QUERY = (q) => `task: search result | query: ${q}`;

export function normalise(v) {
  let n = 0;
  for (let i = 0; i < v.length; i += 1) n += v[i] * v[i];
  n = Math.sqrt(n) || 1;
  const out = new Float32Array(v.length);
  for (let i = 0; i < v.length; i += 1) out[i] = v[i] / n;
  return out;
}

async function getJson(url, body, timeoutMs) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const res = await fetch(url, body ? { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), signal: ctl.signal } : { signal: ctl.signal });
    if (!res.ok) {
      const t = await res.text().catch(() => '');
      throw Object.assign(new Error(`${res.status} ${t.slice(0, 160)}`), { status: res.status });
    }
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

export class OllamaEmbedder {
  constructor({ url = 'http://127.0.0.1:11434', model = 'embeddinggemma', fallbacks = ['nomic-embed-text'] } = {}) {
    this.name = 'ollama';
    this.url = url.replace(/\/$/, '');
    this.want = [model, ...fallbacks.filter((m) => m !== model)];
    this.model = null;
    this.dims = 0;
  }

  // Finds a pulled embedding model. Throws when Ollama is not running or none is pulled.
  async ready() {
    if (this.model) return this;
    const tags = await getJson(`${this.url}/api/tags`, null, 3000);
    const have = (tags.models || []).map((m) => String(m.name || m.model || ''));
    let pick = null;
    for (const w of this.want) {
      pick = have.find((h) => h === w || h.startsWith(`${w}:`));
      if (pick) break;
    }
    if (!pick) throw new Error(`No embedding model in Ollama. Run: ollama pull ${this.want[0]}`);
    this.model = pick;
    return this;
  }

  gemma() {
    return /embeddinggemma/i.test(this.model || '');
  }

  async embed(texts) {
    await this.ready();
    const out = [];
    for (let i = 0; i < texts.length; i += 32) {
      const batch = texts.slice(i, i + 32);
      const data = await getJson(`${this.url}/api/embed`, { model: this.model, input: batch }, 120000);
      for (const e of data.embeddings || []) out.push(normalise(e));
    }
    if (out.length !== texts.length) throw new Error('Ollama returned the wrong number of vectors.');
    this.dims = out[0] ? out[0].length : this.dims;
    return out;
  }

  docText(title, text) {
    return this.gemma() ? GEMMA_DOC(title, text) : text;
  }

  queryText(q) {
    return this.gemma() ? GEMMA_QUERY(q) : q;
  }
}

export class TransformersEmbedder {
  constructor({ model = 'onnx-community/embeddinggemma-300m-ONNX' } = {}) {
    this.name = 'transformers';
    this.model = model;
    this.dims = 0;
    this.pipe = null;
  }

  async ready() {
    if (this.pipe) return this;
    const lib = await import('@huggingface/transformers');
    this.pipe = await lib.pipeline('feature-extraction', this.model, { dtype: 'q8' });
    return this;
  }

  async embed(texts) {
    await this.ready();
    const out = [];
    for (const t of texts) {
      const r = await this.pipe(t, { pooling: 'mean', normalize: true });
      out.push(normalise(Float32Array.from(r.data)));
    }
    this.dims = out[0] ? out[0].length : this.dims;
    return out;
  }

  docText(title, text) { return GEMMA_DOC(title, text); }

  queryText(q) { return GEMMA_QUERY(q); }
}

// The best embedder that works now, or null for keyword-only search.
export async function pickEmbedder(settings = {}) {
  const want = settings.brainEmbedder || 'auto';
  if (want === 'none') return null;
  if (want === 'auto' || want === 'ollama') {
    try {
      return await new OllamaEmbedder({ url: settings.ollamaUrl || 'http://127.0.0.1:11434', model: settings.brainModel || 'embeddinggemma' }).ready();
    } catch (error) {
      if (want === 'ollama') throw error;
    }
  }
  if (want === 'auto' || want === 'transformers') {
    try {
      return await new TransformersEmbedder().ready();
    } catch (error) {
      if (want === 'transformers') throw error;
    }
  }
  return null;
}
