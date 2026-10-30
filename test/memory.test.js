import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { SecondBrain, snippetFor } from '../src/memory/index.js';
import { chunkMarkdown } from '../src/memory/chunk.js';
import { listSources } from '../src/memory/sources.js';
import { OllamaEmbedder } from '../src/memory/embed.js';

// A fake embedder: bag of words over a small fixed vocabulary, so related words match.
const VOCAB = ['deploy', 'dbt', 'cost', 'test', 'style', 'british', 'spelling', 'release', 'ship', 'warehouse', 'snowflake', 'tone'];
const SYN = { ship: 'deploy', release: 'deploy', warehouse: 'snowflake' };
export function fakeEmbedder() {
  const e = {
    name: 'fake', model: 'fake-1', dims: VOCAB.length, calls: 0, texts: 0,
    async ready() { return e; },
    async embed(texts) {
      e.calls += 1;
      e.texts += texts.length;
      return texts.map((t) => {
        const v = new Float32Array(VOCAB.length);
        for (let w of t.toLowerCase().split(/[^a-z]+/)) { w = SYN[w] || w; const i = VOCAB.indexOf(w); if (i >= 0) v[i] += 1; }
        let n = Math.hypot(...v) || 1;
        return v.map((x) => x / n);
      });
    },
    docText: (title, text) => text,
    queryText: (q) => q,
  };
  return e;
}

function fakeClaude() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kroog-brain-'));
  const c = path.join(root, '.claude');
  const w = (rel, text) => { fs.mkdirSync(path.dirname(path.join(c, rel)), { recursive: true }); fs.writeFileSync(path.join(c, rel), text); };
  w('CLAUDE.md', '# Me\n\nUse British spelling everywhere.\n\n## Style\n\nShort sentences, plain words. Keep a calm tone.\n');
  w('settings.json', '{"env":{"SECRET":"deploy-key-123"}}');
  w('settings.local.json', '{"x":1}');
  w('.credentials.json', '{"token":"deploy"}');
  w('projects/-Users-me-code-shop/abc.jsonl', '{"deploy":"transcript"}');
  w('projects/-Users-me-code-shop/memory/MEMORY.md', '- [deploys](deploys.md): our routine\n');
  w('projects/-Users-me-code-shop/memory/deploys.md', '# Deploys\n\nWe deploy the dbt models with `make release` on Fridays.\n');
  w('skills/cost-check/SKILL.md', '---\nname: cost-check\ndescription: Estimate warehouse cost before a dbt run\n---\n# Cost check\n\nRun dbt with --dry-run and stop anything over £5.\n');
  w('plugins/cache/x/README.md', '# plugin readme deploy');
  w('shell-snapshots/a.md', 'deploy');
  const proj = path.join(root, 'code', 'shop');
  fs.mkdirSync(path.join(proj, '.claude', 'rules'), { recursive: true });
  fs.writeFileSync(path.join(proj, 'CLAUDE.md'), '# Shop\n\nTests: run `npm test` before every commit.\n');
  fs.writeFileSync(path.join(proj, '.claude', 'rules', 'sql.md'), '# SQL\n\nUse snowflake syntax.\n');
  fs.writeFileSync(path.join(proj, '.env'), 'KEY=1');
  return { root, claudeDir: c, proj };
}

test('chunking keeps the heading path and the skill name', () => {
  const { title, chunks } = chunkMarkdown('---\nname: cost-check\ndescription: Estimate cost\n---\n# A\n\nintro\n\n## B\n\nbody b\n\n```\n# not a heading\n```\n', '/x/skills/cost-check/SKILL.md');
  assert.equal(title, 'cost-check: Estimate cost');
  assert.deepEqual(chunks.map((c) => c.heading), ['cost-check/SKILL.md › A', 'cost-check/SKILL.md › A › B']);
  assert.match(chunks[1].text, /# not a heading/);
  const long = chunkMarkdown(`# Big\n\n${'word '.repeat(800)}`, 'a.md');
  assert.ok(long.chunks.length >= 3);
  assert.ok(long.chunks.every((c) => c.text.length <= 1200));
});

test('only text files are indexed: never settings, keys, transcripts or caches', () => {
  const { claudeDir, proj } = fakeClaude();
  const files = listSources({ claudeDir, projects: [proj] });
  const names = files.map((f) => path.relative(path.dirname(claudeDir), f.path)).sort();
  assert.deepEqual(names, [
    '.claude/CLAUDE.md',
    '.claude/projects/-Users-me-code-shop/memory/MEMORY.md',
    '.claude/projects/-Users-me-code-shop/memory/deploys.md',
    '.claude/skills/cost-check/SKILL.md',
    'code/shop/.claude/rules/sql.md',
    'code/shop/CLAUDE.md',
  ]);
  const byKind = Object.fromEntries(files.map((f) => [path.basename(f.path), `${f.kind}/${f.project}`]));
  assert.equal(byKind['deploys.md'], 'memory/shop');
  assert.equal(byKind['SKILL.md'], 'skill/all projects');
  assert.equal(byKind['sql.md'], 'instructions/shop');
});

test('hybrid search finds by meaning and by keyword, and rebuilds only what changed', async () => {
  const { root, claudeDir, proj } = fakeClaude();
  const dir = path.join(root, 'brain');
  const embedder = fakeEmbedder();
  const notes = [{ id: 'n1', type: 'Decision', text: 'Posts use British spelling and a calm tone.', project: 'site' }];
  const brain = new SecondBrain({ dir, claudeDir, getProjects: () => [proj], getNotes: () => notes, embedder });
  const st = await brain.build();
  assert.equal(st.files, 7);
  assert.equal(st.embedder, 'fake');
  assert.equal(st.withVectors, st.chunks);

  // "ship" never appears in the deploy memory, but means the same here.
  const r = await brain.search('how do we ship');
  assert.equal(path.basename(r[0].path), 'deploys.md');
  // Plain keywords work too, and filters apply.
  const k = await brain.search('npm test before commit');
  assert.equal(path.basename(k[0].path), 'CLAUDE.md');
  assert.equal(k[0].project, 'shop');
  const notesOnly = await brain.search('british spelling', { kinds: ['note'] });
  assert.equal(notesOnly.length, 1);
  assert.equal(notesOnly[0].kind, 'note');
  assert.equal(brain.readFile(notesOnly[0].path).includes('British'), true);
  assert.throws(() => brain.readFile(path.join(claudeDir, 'settings.json')), /not in the brain/);

  // Saved to disk, and a fresh instance can search without building.
  const again = new SecondBrain({ dir, claudeDir, embedder: fakeEmbedder() });
  assert.equal(again.status().chunks, st.chunks);
  assert.equal(path.basename((await again.search('ship it'))[0].path), 'deploys.md');

  // Change one file: only its pieces are embedded again.
  const before = embedder.texts;
  await new Promise((res) => setTimeout(res, 20));
  fs.writeFileSync(path.join(proj, 'CLAUDE.md'), '# Shop\n\nTests: run `npm test` before every commit.\n\n## Release\n\nRelease from main only.\n');
  const st2 = await brain.build();
  assert.equal(embedder.texts - before, 2, 'only the changed file was embedded');
  assert.equal(st2.withVectors, st2.chunks);
  // Delete a file: it leaves the brain.
  fs.unlinkSync(path.join(proj, '.claude', 'rules', 'sql.md'));
  const st3 = await brain.build();
  assert.equal(st3.files, 6);
  assert.equal(brain.recent(3).length, 3);
});

test('without any embedder the brain still searches by keyword', async () => {
  const { claudeDir, proj } = fakeClaude();
  const brain = new SecondBrain({ dir: null, claudeDir, getProjects: () => [proj], embedder: null });
  const st = await brain.build();
  assert.equal(st.embedder, 'none');
  const r = await brain.search('dry-run');
  assert.equal(r[0].kind, 'skill');
  assert.match(snippetFor('a '.repeat(300) + 'needle here', 'needle'), /needle/);
});

test('the Ollama client finds a pulled model and uses EmbeddingGemma prefixes', async () => {
  const seen = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (d) => { body += d; });
    req.on('end', () => {
      res.setHeader('content-type', 'application/json');
      if (req.url === '/api/tags') return res.end(JSON.stringify({ models: [{ name: 'nomic-embed-text:latest' }, { name: 'embeddinggemma:latest' }] }));
      if (req.url === '/api/embed') {
        const b = JSON.parse(body);
        seen.push(b);
        return res.end(JSON.stringify({ embeddings: b.input.map((t, i) => [3, 4 + i]) }));
      }
      res.statusCode = 404;
      res.end('{}');
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const url = `http://127.0.0.1:${server.address().port}`;
  try {
    const e = await new OllamaEmbedder({ url }).ready();
    assert.equal(e.model, 'embeddinggemma:latest');
    const [v] = await e.embed([e.queryText('deploy')]);
    assert.equal(seen[0].input[0], 'task: search result | query: deploy');
    assert.ok(Math.abs(Math.hypot(...v) - 1) < 1e-6, 'vectors are normalised');
    assert.equal(e.docText('T', 'x'), 'title: T | text: x');
    // Only the fallback is pulled.
    const f = await new OllamaEmbedder({ url, model: 'missing-model' }).ready();
    assert.equal(f.model, 'nomic-embed-text:latest');
    assert.equal(f.queryText('q'), 'q');
  } finally {
    server.close();
  }
  await assert.rejects(new OllamaEmbedder({ url: 'http://127.0.0.1:9' }).ready());
});
