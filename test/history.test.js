import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Store } from '../src/store.js';
import { readRecent, importRecent, summarise } from '../src/history.js';

const now = Date.now();
const iso = (minsAgo) => new Date(now - minsAgo * 60000).toISOString();
const base = { cwd: '/Users/me/code/shop', entrypoint: 'claude-vscode', gitBranch: 'main', sessionId: 'abc-1' };

function chat() {
  return [
    { type: 'queue-operation', operation: 'enqueue', timestamp: iso(60) },
    { ...base, type: 'user', timestamp: iso(59), message: { role: 'user', content: '<command-name>/clear</command-name>' } },
    { ...base, type: 'user', timestamp: iso(58), message: { role: 'user', content: 'Fix the checkout total rounding bug' } },
    { ...base, type: 'assistant', timestamp: iso(57), message: { role: 'assistant', content: [
      { type: 'thinking', thinking: 'hmm' },
      { type: 'text', text: 'Looking at the cart code.' },
      { type: 'tool_use', id: 't1', name: 'TodoWrite', input: { todos: [{ content: 'Find the bug', status: 'completed', activeForm: 'Finding' }, { content: 'Add a test', status: 'in_progress', activeForm: 'Adding a test' }] } },
      { type: 'tool_use', id: 't2', name: 'Edit', input: { file_path: '/Users/me/code/shop/src/cart.js', old_string: 'a', new_string: 'b' } },
      { type: 'tool_use', id: 't3', name: 'Bash', input: { command: 'npm test' } },
    ] } },
    { ...base, type: 'user', timestamp: iso(56), message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't3', is_error: true, content: 'fail' }] } },
    { ...base, type: 'assistant', timestamp: iso(55), message: { role: 'assistant', content: [{ type: 'tool_use', id: 't4', name: 'Task', input: { subagent_type: 'Explore', description: 'find tests' } }] } },
    { ...base, type: 'assistant', isSidechain: true, timestamp: iso(54), message: { role: 'assistant', content: [{ type: 'tool_use', id: 't5', name: 'Grep', input: { pattern: 'round' } }, { type: 'text', text: 'helper words' }] } },
    { ...base, type: 'user', timestamp: iso(53), isMeta: true, message: { role: 'user', content: 'Caveat: meta' } },
    { ...base, type: 'user', timestamp: iso(52), message: { role: 'user', content: [{ type: 'text', text: 'Now also round the tax' }] } },
    { ...base, type: 'assistant', timestamp: iso(50), message: { role: 'assistant', content: [{ type: 'text', text: 'Done. Totals and tax now round to 2 places.' }] } },
    { type: 'ai-title', aiTitle: 'Fix checkout rounding', sessionId: 'abc-1' },
    'not json',
  ];
}

function fakeHome(chats) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kroog-hist-'));
  const proj = path.join(dir, 'projects', '-Users-me-code-shop');
  fs.mkdirSync(proj, { recursive: true });
  for (const [id, entries, ageDays] of chats) {
    const file = path.join(proj, `${id}.jsonl`);
    fs.writeFileSync(file, entries.map((e) => (typeof e === 'string' ? e : JSON.stringify(e))).join('\n'));
    const t = (now - ageDays * 86400000) / 1000;
    fs.utimesSync(file, t, t);
  }
  return dir;
}

test('summarise reads title, prompts, plan, files, helpers and the last reply', () => {
  const sum = summarise(chat().filter((e) => typeof e === 'object'), { id: 'abc-1' });
  assert.equal(sum.aiTitle, 'Fix checkout rounding');
  assert.equal(sum.firstPrompt, 'Fix the checkout total rounding bug');
  assert.equal(sum.lastPrompt, 'Now also round the tax');
  assert.equal(sum.lastReply, 'Done. Totals and tax now round to 2 places.');
  assert.equal(sum.entry, 'claude-vscode');
  assert.equal(sum.cwd, '/Users/me/code/shop');
  assert.equal(sum.plan.length, 2);
  assert.deepEqual(sum.files, ['/Users/me/code/shop/src/cart.js']);
  assert.equal(Object.keys(sum.helpers).length, 1);
  assert.equal(sum.steps.filter((s) => s.kind === 'prompt').length, 2, 'command tags and meta lines are not prompts');
  assert.equal(sum.steps.find((s) => s.tool === 'Bash').state, 'failed');
  assert.equal(sum.steps.find((s) => s.tool === 'Grep').helper, 'helper');
});

test('import adds recent chats as finished, keeps old times, skips old files', async () => {
  const home = fakeHome([['abc-1', chat(), 0], ['old-1', chat().map((e) => (typeof e === 'object' ? { ...e, sessionId: 'old-1' } : e)), 30]]);
  const prev = process.env.CLAUDE_CONFIG_DIR;
  process.env.CLAUDE_CONFIG_DIR = home;
  try {
    const store = new Store();
    const r = await importRecent(store, { days: 7 });
    assert.equal(r.source, 'files');
    assert.equal(r.added, 1);
    const s = store.session('abc-1');
    assert.ok(s && !store.session('old-1'));
    assert.equal(s.title, 'Fix checkout rounding');
    assert.equal(s.status, 'done');
    assert.equal(s.imported, true);
    assert.equal(s.app, 'VS Code');
    assert.equal(s.editor, 'vscode');
    assert.equal(s.project, 'shop');
    assert.ok(now - s.lastAt > 45 * 60000, 'last active time comes from the history, not from now');
    assert.ok(s.steps.every((x) => x.id));
    assert.equal(s.steps[0].kind, 'info');

    // A second import does not duplicate, and a live chat keeps its live state.
    s.status = 'working';
    s.lastReply = 'live reply';
    const again = await importRecent(store, { days: 7 });
    assert.equal(again.added, 0);
    assert.equal(store.session('abc-1').status, 'working');
    assert.equal(store.session('abc-1').lastReply, 'live reply');
  } finally {
    if (prev === undefined) delete process.env.CLAUDE_CONFIG_DIR; else process.env.CLAUDE_CONFIG_DIR = prev;
  }
});

test('import is safe with no history folder', async () => {
  const prev = process.env.CLAUDE_CONFIG_DIR;
  process.env.CLAUDE_CONFIG_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'kroog-empty-'));
  try {
    const r = await readRecent({ days: 7 });
    assert.equal(r.chats.length, 0);
  } finally {
    if (prev === undefined) delete process.env.CLAUDE_CONFIG_DIR; else process.env.CLAUDE_CONFIG_DIR = prev;
  }
});
