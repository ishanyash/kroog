import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { SecondBrain } from '../src/memory/index.js';
import { tfidfModel, sparseCos, chatText } from '../src/memory/map.js';

// A fake embedder: bag of words over a fixed vocabulary, so related words match.
const VOCAB = ['deploy', 'dbt', 'cost', 'test', 'style', 'british', 'spelling', 'release', 'ship', 'warehouse', 'snowflake', 'tone', 'commit', 'npm'];
const SYN = { ship: 'deploy', release: 'deploy', warehouse: 'snowflake' };
function fakeEmbedder() {
  return {
    name: 'fake', model: 'fake-1', dims: VOCAB.length,
    async ready() { return this; },
    async embed(texts) {
      return texts.map((t) => {
        const v = new Float32Array(VOCAB.length);
        for (let w of t.toLowerCase().split(/[^a-z]+/)) { w = SYN[w] || w; const i = VOCAB.indexOf(w); if (i >= 0) v[i] += 1; }
        const n = Math.hypot(...v) || 1;
        return v.map((x) => x / n);
      });
    },
    docText: (title, text) => text,
    queryText: (q) => q,
  };
}

function fakeClaude() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kroog-map-'));
  const c = path.join(root, '.claude');
  const w = (rel, text) => { fs.mkdirSync(path.dirname(path.join(c, rel)), { recursive: true }); fs.writeFileSync(path.join(c, rel), text); };
  w('CLAUDE.md', '# Me\n\nUse British spelling everywhere.\n\n## Style\n\nShort sentences, plain words. Keep a calm tone.\n');
  w('projects/-Users-me-code-shop/memory/MEMORY.md', '- [deploys](deploys.md): our routine\n');
  w('projects/-Users-me-code-shop/memory/deploys.md', '# Deploys\n\nWe deploy the dbt models with `make release` on Fridays.\n');
  w('skills/cost-check/SKILL.md', '---\nname: cost-check\ndescription: Estimate warehouse cost before a dbt run\n---\n# Cost check\n\nRun dbt with --dry-run and stop anything over £5.\n');
  const proj = path.join(root, 'code', 'shop');
  fs.mkdirSync(path.join(proj, '.claude', 'rules'), { recursive: true });
  fs.writeFileSync(path.join(proj, 'CLAUDE.md'), '# Shop\n\nTests: run `npm test` before every commit.\n');
  fs.writeFileSync(path.join(proj, '.claude', 'rules', 'sql.md'), '# SQL\n\nUse snowflake syntax for the warehouse.\n');
  return { root, claudeDir: c, proj };
}

const chats = [
  { id: 'a', title: 'Deploy the dbt models', project: 'shop', cwd: '/x/shop', gist: 'Shipped a release of the dbt models', keywords: ['dbt', 'deploy'], lastReply: 'Released the dbt models to the warehouse.', lastPrompt: 'ship it', status: 'done', lastAt: 100, inputs: [] },
  { id: 'b', title: 'Fix the cost test', project: 'shop', cwd: '/x/shop', gist: 'cost check test on the orders model', keywords: ['cost', 'test'], lastReply: 'The cost test passes now.', lastPrompt: '', status: 'working', lastAt: 200, inputs: [{ kind: 'brief', from: ['a'] }, { kind: 'memory', from: ['a', 'zzz-unknown'] }] },
  { id: 'c', title: 'Write the post', project: 'site', cwd: '/x/site', gist: 'British spelling, calm tone', keywords: ['spelling'], lastReply: '', lastPrompt: 'Use British spelling and a calm tone.', status: 'done', lastAt: 300, inputs: [{ kind: 'continue', from: ['b'] }] },
];

test('the map has file and chat nodes, similar links, chat-to-file links and lineage', async () => {
  const { claudeDir, proj } = fakeClaude();
  const notes = [{ id: 'n1', type: 'Decision', text: 'Posts use British spelling and a calm tone.', project: 'site', t: 5 }];
  const brain = new SecondBrain({ dir: null, claudeDir, getProjects: () => [proj], getNotes: () => notes, embedder: fakeEmbedder() });
  await brain.build();
  const m = await brain.map(chats);
  assert.equal(m.mode, 'vectors');
  assert.equal(m.truncated, false);
  const files = m.nodes.filter((n) => n.type === 'file');
  const chatNodes = m.nodes.filter((n) => n.type === 'chat');
  assert.equal(files.length, 7, 'six files and one note');
  assert.equal(chatNodes.length, 3);
  const deploys = files.find((n) => n.path.endsWith('deploys.md'));
  assert.equal(deploys.kind, 'memory');
  assert.equal(deploys.project, 'shop');
  assert.equal(deploys.size, 1);
  assert.deepEqual(deploys.headings, ['Deploys']);
  const note = files.find((n) => n.kind === 'note');
  assert.ok(note && note.id.startsWith('f:kroog-note:'));
  const skill = files.find((n) => n.kind === 'skill');
  assert.match(skill.title, /^cost-check/);
  // Every weight is in range, and every edge joins two nodes that exist.
  const ids = new Set(m.nodes.map((n) => n.id));
  for (const e of m.edges) {
    assert.ok(e.w >= 0 && e.w <= 1, `weight ${e.w}`);
    assert.ok(ids.has(e.a) && ids.has(e.b), `${e.a} -> ${e.b}`);
    assert.ok(['similar', 'brief', 'continue', 'memory'].includes(e.kind));
  }
  // Files about the same thing are linked: the CLAUDE.md style rules and the note.
  const sim = m.edges.filter((e) => e.kind === 'similar');
  assert.ok(sim.some((e) => [e.a, e.b].includes(note.id) && [e.a, e.b].includes(`f:${path.join(claudeDir, 'CLAUDE.md')}`)), 'the note links to the style rules');
  // The deploy chat links to the deploy memory, the cost chat to the cost skill.
  assert.ok(sim.some((e) => e.a === 'c:a' && e.b === deploys.id), 'chat a -> deploys.md');
  assert.ok(sim.some((e) => e.a === 'c:b' && e.b === skill.id), 'chat b -> cost-check');
  // Lineage: a brief and memory from a to b, a branch from b to c; unknown chats are skipped.
  const lin = m.edges.filter((e) => e.kind !== 'similar');
  assert.deepEqual(lin.map((e) => `${e.kind}:${e.a}>${e.b}`).sort(), ['brief:c:a>c:b', 'continue:c:b>c:c', 'memory:c:a>c:b']);
  assert.ok(!lin.some((e) => e.a.includes('zzz')));
  // Cached while nothing changed; recomputed when a chat changes.
  assert.equal(await brain.map(chats), m);
  const changed = chats.map((c) => (c.id === 'c' ? { ...c, lastAt: 301 } : c));
  const m2 = await brain.map(changed);
  assert.notEqual(m2, m);
  assert.equal(m2.nodes.find((n) => n.id === 'c:c').lastAt, 301);
});

test('without vectors the map links files by keyword, and caps how many it shows', async () => {
  const { root, claudeDir, proj } = fakeClaude();
  const brain = new SecondBrain({ dir: null, claudeDir, getProjects: () => [proj], embedder: null });
  await brain.build();
  const m = await brain.map(chats);
  assert.equal(m.mode, 'keyword');
  assert.equal(m.embedder, 'keyword');
  const sim = m.edges.filter((e) => e.kind === 'similar');
  assert.ok(sim.length > 0);
  const deploys = `f:${path.join(claudeDir, 'projects', '-Users-me-code-shop', 'memory', 'deploys.md')}`;
  const index = `f:${path.join(claudeDir, 'projects', '-Users-me-code-shop', 'memory', 'MEMORY.md')}`;
  assert.ok(sim.some((e) => [e.a, e.b].includes(deploys) && [e.a, e.b].includes(index)), 'the memory index links to the deploys note it names');
  assert.ok(sim.some((e) => e.a === 'c:a' && e.b.endsWith('deploys.md')), 'chat a -> deploys.md by keyword');
  // Caps: the newest files stay, the oldest go.
  const small = await brain.map(chats, { maxFiles: 3, maxChats: 2 });
  assert.equal(small.truncated, true);
  assert.equal(small.nodes.filter((n) => n.type === 'file').length, 3);
  assert.deepEqual(small.nodes.filter((n) => n.type === 'chat').map((n) => n.chatId), ['c', 'b'], 'the two most recent chats');
  for (const e of small.edges) assert.ok(small.nodes.some((n) => n.id === e.a) && small.nodes.some((n) => n.id === e.b));
  // Chat text used for matching carries the useful parts.
  assert.match(chatText(chats[0]), /Deploy the dbt models[\s\S]*ship it/);
  // A TF-IDF model scores shared words.
  const t = tfidfModel(brain.meta);
  assert.ok(sparseCos(t.vectorFor('deploy dbt release'), t.byPath.get(path.join(claudeDir, 'projects', '-Users-me-code-shop', 'memory', 'deploys.md'))) > 0.2);
  fs.rmSync(root, { recursive: true, force: true });
});
