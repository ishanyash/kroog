import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Store } from '../src/store.js';
import { Engine } from '../src/engine.js';
import { Runner } from '../src/runner.js';
import { AiHelper } from '../src/ai.js';

const FAKE = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'fake-claude.mjs');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const until = async (fn, ms = 4000) => { const end = Date.now() + ms; while (Date.now() < end) { if (fn()) return true; await sleep(20); } return false; };

async function setup(extra = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kroog-run-'));
  const log = path.join(dir, 'calls.jsonl');
  process.env.FAKE_LOG = log;
  const settings = { permissionHoldSeconds: 30, driveMinutes: 5, claudePath: FAKE, aiProvider: 'claude', aiSummaries: 'hover', ...extra };
  const store = new Store();
  const engine = new Engine({ store, getSettings: () => settings });
  const opened = [];
  const runner = new Runner({ store, engine, getSettings: () => settings, opener: (url) => opened.push(url) });
  const ai = new AiHelper({ store, engine, runner, getSettings: () => settings, getKey: () => null });
  await runner.detect();
  const calls = () => (fs.existsSync(log) ? fs.readFileSync(log, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []);
  return { dir, store, engine, runner, ai, calls, settings, opened };
}

test('finds Claude Code and starts a new chat that Kroog runs', async () => {
  const { dir, store, runner, calls } = await setup();
  assert.equal(runner.status().version, '9.9.9');
  const r = runner.run({ mode: 'new', cwd: dir, prompt: 'Write the readme' });
  assert.ok(r.ok, r.error);
  const s = store.session(r.id);
  assert.equal(s.owner, 'kroog');
  assert.equal(s.kind, 'kroog');
  assert.equal(s.status, 'working');
  assert.ok(await until(() => s.status === 'done'));
  assert.equal(s.lastReply, 'fake reply to: Write the readme');
  assert.ok(s.steps.some((x) => x.kind === 'tool' && x.tool === 'Read'), 'steps come from the stream when no hooks arrive');
  const c = calls()[0];
  assert.deepEqual(c.args.slice(c.args.indexOf('--session-id'), c.args.indexOf('--session-id') + 2), ['--session-id', r.id]);
  assert.equal(c.input, 'Write the readme');
  assert.equal(c.kroogRun, '1');
  assert.equal(fs.realpathSync(c.cwd), fs.realpathSync(dir));
});

test('a message never makes Kroog run a chat: no resume, no branch', async () => {
  const { dir, store, engine, runner, calls } = await setup();
  const r = runner.run({ mode: 'new', cwd: dir, prompt: 'first' });
  const s = store.session(r.id);
  await until(() => s.status === 'done');
  const before = calls().length;
  const again = await engine.send(r.id, 'second');
  assert.notEqual(again.delivered, 'kroog', 'a finished chat is not carried on by Kroog');

  // An idle chat from the editor.
  await engine.handle('UserPromptSubmit', { session_id: 'ed1', cwd: dir, prompt: 'hello' }, { entry: 'claude-vscode' });
  await engine.handle('Stop', { session_id: 'ed1', cwd: dir, last_assistant_message: 'Hi there, all done with the setup work.' }, { entry: 'claude-vscode' });
  const plain = await engine.send('ed1', 'more please');
  assert.equal(plain.delivered, 'editor', 'the editor opens it instead');
  assert.ok(plain.url.startsWith('vscode://'));
  const branch = await engine.send('ed1', 'more please', { mode: 'branch' });
  assert.notEqual(branch.mode, 'fork', 'no branch is started');
  await new Promise((resolve) => setTimeout(resolve, 200));
  assert.equal(calls().length, before, 'no claude process was started for a message');
  assert.equal(store.session('ed1').owner, undefined, 'the editor chat is left alone');
});

test('hooks from a chat Kroog runs keep its label and do not repeat the prompt', async () => {
  const { dir, store, engine, runner } = await setup();
  process.env.FAKE_DELAY = '300';
  try {
    const r = runner.run({ mode: 'new', cwd: dir, prompt: 'go' });
    await engine.handle('UserPromptSubmit', { session_id: r.id, cwd: dir, prompt: 'go' }, { entry: 'sdk-cli' });
    const s = store.session(r.id);
    assert.equal(s.app, 'Kroog');
    assert.equal(s.steps.filter((x) => x.kind === 'prompt').length, 1);
    assert.equal(s.hookSeen, true);
    await until(() => s.status === 'done');
  } finally {
    delete process.env.FAKE_DELAY;
  }
});


test('errors and stop are shown on the chat', async () => {
  const { dir, store, engine, runner } = await setup();
  const r = runner.run({ mode: 'new', cwd: dir, prompt: 'please fail' });
  const s = store.session(r.id);
  assert.ok(await until(() => s.status === 'error'));
  assert.match(s.needs.title, /It broke/);

  process.env.FAKE_DELAY = '3000';
  try {
    const r2 = runner.run({ mode: 'new', cwd: dir, prompt: 'long job' });
    const s2 = store.session(r2.id);
    await sleep(150);
    const st = engine.stop(r2.id);
    assert.ok(st.ok);
    assert.ok(await until(() => s2.status === 'done' && !runner.isRunning(r2.id)));
    assert.ok(s2.steps.some((x) => x.text === 'Stopped from Kroog'));
  } finally {
    delete process.env.FAKE_DELAY;
  }
});

test('the AI helper summarises a chat and writes a brief through Claude Code', async () => {
  const { dir, store, engine, ai } = await setup();
  await engine.handle('UserPromptSubmit', { session_id: 'b', cwd: dir, prompt: 'fix rounding' }, { entry: 'claude-vscode' });
  await engine.handle('Stop', { session_id: 'b', cwd: dir, last_assistant_message: 'Fixed the rounding in cart.js and checked the totals.' }, { entry: 'claude-vscode' });
  assert.equal(ai.provider(), 'claude');
  const r = ai.summarize('b');
  assert.ok(r.queued);
  const s = store.session('b');
  assert.ok(await until(() => s.ai && s.ai.gist));
  assert.equal(s.ai.gist, 'Rounding fixed in cart.js');
  assert.deepEqual(s.ai.keywords, ['cart.js', 'rounding']);
  assert.ok(ai.summarize('b').cached, 'a summary is reused until the chat changes');
  const text = await ai.writeBrief({ sources: ['b'], goal: 'ship' });
  assert.match(text, /^Goal/);
  assert.equal(ai.status().usedToday, 2);
});

test('without Claude Code, a key or a local model the helper is off and Kroog says so', async () => {
  const store = new Store();
  const settings = { claudePath: '/nope/claude', aiProvider: 'auto' };
  const engine = new Engine({ store, getSettings: () => settings });
  const runner = new Runner({ store, engine, getSettings: () => settings });
  runner.cli = null;
  const ai = new AiHelper({ store, engine, runner, getSettings: () => settings, getKey: () => null });
  assert.equal(ai.provider(), 'off');
  const r = runner.run({ mode: 'new', cwd: os.tmpdir(), prompt: 'x' });
  assert.equal(r.ok, false);
  assert.match(r.error, /could not find Claude Code/);
});

