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

test('a message to a chat Kroog runs continues the same chat; an editor chat is branched', async () => {
  const { dir, store, engine, runner, calls } = await setup();
  const r = runner.run({ mode: 'new', cwd: dir, prompt: 'first' });
  const s = store.session(r.id);
  await until(() => s.status === 'done');
  const again = await engine.send(r.id, 'second');
  assert.equal(again.delivered, 'kroog');
  assert.equal(again.mode, 'resume');
  await until(() => s.status === 'done' && s.lastReply.includes('second'));
  assert.ok(calls()[1].args.includes('--resume'));
  assert.equal(calls()[1].args[calls()[1].args.indexOf('--resume') + 1], r.id);

  // An idle chat from the editor.
  await engine.handle('UserPromptSubmit', { session_id: 'ed1', cwd: dir, prompt: 'hello' }, { entry: 'claude-vscode' });
  await engine.handle('Stop', { session_id: 'ed1', cwd: dir, last_assistant_message: 'Hi there, all done with the setup work.' }, { entry: 'claude-vscode' });
  const plain = await engine.send('ed1', 'more please');
  assert.equal(plain.delivered, 'editor', 'without a mode the editor link stays the default');
  assert.ok(plain.url.startsWith('vscode://'));
  const branch = await engine.send('ed1', 'more please', { mode: 'branch' });
  assert.ok(branch.ok, branch.error);
  assert.equal(branch.mode, 'fork');
  const child = store.session(branch.id);
  assert.notEqual(branch.id, 'ed1');
  assert.deepEqual(child.inputs.find((x) => x.kind === 'continue').from, ['ed1']);
  assert.match(child.title, /continued/);
  await until(() => calls().length >= 3);
  const c = calls().at(-1);
  assert.ok(c.args.includes('--fork-session'));
  assert.equal(c.args[c.args.indexOf('--resume') + 1], 'ed1');
  assert.equal(c.args[c.args.indexOf('--session-id') + 1], branch.id);
  await until(() => child.status === 'done');
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

test('handoff runs a new chat in Kroog with the brief and records the lineage', async () => {
  const { dir, store, engine, calls } = await setup();
  await engine.handle('UserPromptSubmit', { session_id: 'a', cwd: dir, prompt: 'x' }, { entry: 'claude-vscode' });
  const r = await engine.handoff({ text: 'BRIEF BODY', goal: 'Write the post', target: 'new', run: 'kroog', cwd: dir, sources: ['a'] });
  assert.ok(r.ok, r.error);
  const s = store.session(r.id);
  assert.equal(s.title, 'Write the post');
  assert.deepEqual(s.inputs.find((x) => x.kind === 'brief').from, ['a']);
  await until(() => s.status === 'done' && calls().length >= 1);
  assert.match(calls().at(-1).input, /^Write the post\n\nBRIEF BODY/);
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

test('combining chats into a new chat starts it, then opens the folder and the chat in VS Code', async () => {
  const { dir, store, engine, calls, opened } = await setup();
  await engine.handle('UserPromptSubmit', { session_id: 'a', cwd: dir, prompt: 'x' }, { entry: 'claude-vscode' });
  const r = await engine.handoff({ text: 'BRIEF', goal: 'Write the FAQ', target: 'new', run: 'editor', editor: 'vscode', cwd: dir, sources: ['a'] });
  assert.ok(r.ok, r.error);
  assert.equal(opened[0], `vscode://file${dir}/`, 'the project folder opens first');
  const s = store.session(r.id);
  assert.ok(await until(() => opened.length === 2));
  assert.equal(opened[1], `vscode://anthropic.claude-code/open?session=${r.id}`);
  assert.equal(s.owner, 'editor');
  assert.equal(s.app, 'VS Code');
  assert.deepEqual(s.inputs.find((x) => x.kind === 'brief').from, ['a']);
  await until(() => calls().length >= 1);
  assert.match(calls().at(-1).input, /Write the FAQ\n\nBRIEF[\s\S]*carries on with you in VS Code/);
});
