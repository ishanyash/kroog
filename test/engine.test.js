import test from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../src/store.js';
import { Engine } from '../src/engine.js';
import { detectApp } from '../src/sources.js';
import { looksLikeQuestion } from '../src/util.js';

const VSCODE = { entry: 'claude-vscode', bundle: 'com.microsoft.VSCode', term: '' };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function setup(settings = {}) {
  const store = new Store();
  const all = { permissionHoldSeconds: 30, driveMinutes: 5, driveEnabled: true, ...settings };
  const engine = new Engine({ store, getSettings: () => all });
  const hook = (event, extra = {}, sid = 's1') => engine.handle(event, { session_id: sid, cwd: '/Users/me/code/app', ...extra }, VSCODE);
  return { store, engine, hook, settings: all };
}

test('a prompt starts a chat, titles it and marks it working', async () => {
  const { store, hook } = setup();
  await hook('SessionStart', { source: 'startup' });
  await hook('UserPromptSubmit', { prompt: 'Add branch search. Then add tests.' });
  const s = store.session('s1');
  assert.equal(s.status, 'working');
  assert.equal(s.title, 'Add branch search');
  assert.equal(s.project, 'app');
  assert.equal(s.app, 'VS Code');
  assert.equal(s.editor, 'vscode');
});

test('allow from Kroog answers the held permission request', async () => {
  const { store, engine, hook } = setup();
  await hook('UserPromptSubmit', { prompt: 'Run the tests' });
  const pending = hook('PermissionRequest', { tool_name: 'Bash', tool_input: { command: 'npm test' } });
  await sleep(5);
  const s = store.session('s1');
  assert.equal(s.status, 'needs');
  assert.equal(s.needs.kind, 'permission');
  assert.equal(engine.publicSession(s).waitingPermission, true);
  assert.deepEqual(engine.decide('s1', { behavior: 'allow' }), { ok: true });
  const out = await pending;
  assert.deepEqual(out, { hookSpecificOutput: { hookEventName: 'PermissionRequest', decision: { behavior: 'allow' } } });
  assert.equal(s.status, 'working');
});

test('deny with a reason passes the reason to Claude', async () => {
  const { engine, hook } = setup();
  const pending = hook('PermissionRequest', { tool_name: 'Bash', tool_input: { command: 'rm -rf build' } });
  await sleep(5);
  engine.decide('s1', { behavior: 'deny', message: 'Use the dev target' });
  const out = await pending;
  assert.equal(out.hookSpecificOutput.decision.behavior, 'deny');
  assert.match(out.hookSpecificOutput.decision.message, /Use the dev target/);
});

test('an unanswered request goes back to the editor after the hold time', async () => {
  const { store, hook } = setup({ permissionHoldSeconds: 0.05 });
  const out = await hook('PermissionRequest', { tool_name: 'Edit', tool_input: { file_path: '/x/a.ts' } });
  assert.equal(out, null);
  assert.equal(store.session('s1').needs.inEditor, true);
});

test('hold 0 means Kroog only shows the request', async () => {
  const { store, hook } = setup({ permissionHoldSeconds: 0 });
  const out = await hook('PermissionRequest', { tool_name: 'Edit', tool_input: { file_path: '/x/a.ts' } });
  assert.equal(out, null);
  assert.equal(store.session('s1').needs.inEditor, true);
});

test('"Answer in the editor" releases the hold at once', async () => {
  const { engine, hook } = setup();
  const pending = hook('PermissionRequest', { tool_name: 'Bash', tool_input: { command: 'ls' } });
  await sleep(5);
  engine.release('s1');
  assert.equal(await pending, null);
});

test('a message to a working chat arrives after its current step', async () => {
  const { store, engine, hook } = setup();
  await hook('UserPromptSubmit', { prompt: 'Write the post' });
  await hook('PreToolUse', { tool_name: 'Edit', tool_input: { file_path: '/x/post.md' }, tool_use_id: 't1' });
  const r = await engine.send('s1', 'Use British spelling');
  assert.equal(r.delivered, 'queued');
  const out = await hook('PostToolUse', { tool_name: 'Edit', tool_input: { file_path: '/x/post.md' }, tool_use_id: 't1', tool_response: {} });
  assert.equal(out.hookSpecificOutput.hookEventName, 'PostToolUse');
  assert.match(out.hookSpecificOutput.additionalContext, /Use British spelling/);
  assert.equal(store.session('s1').queue.length, 0);
  assert.deepEqual(store.session('s1').files, ['/x/post.md']);
});

test('a message sent while it writes its answer goes in at Stop', async () => {
  const { engine, hook } = setup();
  await hook('UserPromptSubmit', { prompt: 'Explain the bug' });
  await engine.send('s1', 'Also suggest a fix');
  const out = await hook('Stop', { last_assistant_message: 'The bug is in the parser.', stop_hook_active: false });
  assert.equal(out.decision, 'block');
  assert.match(out.reason, /Also suggest a fix/);
});

test('without Drive, a reply to a finished chat opens the editor', async () => {
  const { store, engine, hook } = setup();
  await hook('UserPromptSubmit', { prompt: 'Fix it' });
  await hook('Stop', { last_assistant_message: 'Fixed. Should I also add a test?' });
  const s = store.session('s1');
  assert.equal(s.status, 'needs');
  assert.equal(s.needs.kind, 'question');
  const r = await engine.send('s1', 'Yes please');
  assert.equal(r.delivered, 'editor');
  assert.equal(r.url, 'vscode://anthropic.claude-code/open?session=s1&prompt=Yes%20please');
});

test('with Drive, Kroog holds the finished chat and a message continues it now', async () => {
  const { store, engine, hook } = setup();
  await hook('UserPromptSubmit', { prompt: 'Fix it' });
  engine.setDrive('s1', true);
  const pending = hook('Stop', { last_assistant_message: 'Fixed. Should I also add a test?' });
  await sleep(5);
  const s = store.session('s1');
  assert.ok(s.holding);
  assert.equal(engine.publicSession(s).holdingStop, true);
  assert.equal((await engine.send('s1', 'Yes, add one')).delivered, 'now');
  const out = await pending;
  assert.equal(out.decision, 'block');
  assert.match(out.reason, /Yes, add one/);
  assert.equal(s.status, 'working');
});

test('turning Drive off lets a held chat go', async () => {
  const { engine, hook } = setup();
  engine.setDrive('s1', true);
  const pending = hook('Stop', { last_assistant_message: 'All done.' });
  await sleep(5);
  engine.setDrive('s1', false);
  assert.equal(await pending, null);
});

test('Stop from Kroog ends the turn at the next step', async () => {
  const { store, engine, hook } = setup();
  await hook('UserPromptSubmit', { prompt: 'Refactor everything' });
  await hook('PreToolUse', { tool_name: 'Read', tool_input: { file_path: '/x/a.ts' }, tool_use_id: 't1' });
  assert.equal(engine.stop('s1').ok, true);
  const out = await hook('PostToolUse', { tool_name: 'Read', tool_input: { file_path: '/x/a.ts' }, tool_use_id: 't1', tool_response: {} });
  assert.deepEqual(out, { continue: false, stopReason: 'Stopped from Kroog.' });
  assert.equal(store.session('s1').status, 'done');
});

test('Stop during a held permission request denies it and interrupts', async () => {
  const { engine, hook } = setup();
  const pending = hook('PermissionRequest', { tool_name: 'Bash', tool_input: { command: 'deploy' } });
  await sleep(5);
  engine.stop('s1');
  const out = await pending;
  assert.equal(out.hookSpecificOutput.decision.behavior, 'deny');
  assert.equal(out.hookSpecificOutput.decision.interrupt, true);
});

test('a brief reaches a new chat through its first prompt', async () => {
  const { engine, hook } = setup();
  const brief = engine.createBrief({ text: 'Background: the cost gate stops runs over £5.', goal: 'Write the post', editor: 'cursor' });
  assert.ok(brief.url.startsWith('cursor://anthropic.claude-code/open?prompt='));
  const out = await hook('UserPromptSubmit', { prompt: brief.prompt }, 'new1');
  assert.match(out.hookSpecificOutput.additionalContext, /cost gate stops runs/);
});

test('remembered notes go into new chats in that folder', async () => {
  const { store, hook } = setup();
  const note = store.addNote({ sessionId: null, chatTitle: 'x', project: 'app', cwd: '/Users/me/code/app', type: 'Decision', text: 'Use pnpm, not npm.' });
  store.updateNote(note.id, { remembered: true });
  const out = await hook('SessionStart', { source: 'startup' }, 'fresh');
  assert.match(out.hookSpecificOutput.additionalContext, /Use pnpm, not npm/);
  const other = await engine2();
  assert.equal(other, null);
  async function engine2() {
    return setup().hook('SessionStart', { source: 'startup' }, 'fresh2');
  }
});

test('the plan follows TodoWrite and the task tools', async () => {
  const { store, hook } = setup();
  await hook('PreToolUse', { tool_name: 'TodoWrite', tool_input: { todos: [
    { content: 'Find it', status: 'completed' },
    { content: 'Fix it', status: 'in_progress' },
    { content: 'Test it', status: 'pending' },
  ] }, tool_use_id: 'p1' });
  assert.deepEqual(store.session('s1').plan.map((p) => p.state), ['done', 'now', 'todo']);
  await hook('PreToolUse', { tool_name: 'TaskCreate', tool_input: { subject: 'Write docs' }, tool_use_id: 'p2' }, 's2');
  await hook('PostToolUse', { tool_name: 'TaskCreate', tool_input: { subject: 'Write docs' }, tool_use_id: 'p2', tool_response: { result: 'Task #7 created successfully' } }, 's2');
  await hook('PreToolUse', { tool_name: 'TaskUpdate', tool_input: { taskId: '7', status: 'completed' }, tool_use_id: 'p3' }, 's2');
  assert.deepEqual(store.session('s2').plan, [{ id: '7', text: 'Write docs', state: 'done' }]);
});

test('helpers and failures show up in the steps', async () => {
  const { store, hook } = setup();
  await hook('SubagentStart', { agent_id: 'a1', agent_type: 'Explore' });
  await hook('PreToolUse', { tool_name: 'Bash', tool_input: { command: 'npm test', description: 'Run tests' }, tool_use_id: 'b1' });
  await hook('PostToolUseFailure', { tool_name: 'Bash', tool_input: { command: 'npm test' }, tool_use_id: 'b1', error: '3 tests failed' });
  await hook('SubagentStop', { agent_id: 'a1', agent_type: 'Explore', stop_hook_active: false });
  const s = store.session('s1');
  const tool = s.steps.find((x) => x.toolUseId === 'b1');
  assert.equal(tool.state, 'failed');
  assert.equal(tool.detail, '3 tests failed');
  assert.equal(s.helpers.a1.state, 'done');
});

test('which app a chat runs in', () => {
  assert.equal(detectApp(VSCODE).place, 'VS Code');
  assert.equal(detectApp({ entry: 'claude-vscode', bundle: 'com.todesktop.230313mzl4w4u92' }).editor, 'cursor');
  const term = detectApp({ entry: 'cli', bundle: 'com.microsoft.VSCode', term: 'vscode' });
  assert.equal(term.place, 'VS Code terminal');
  assert.equal(term.editor, null);
  assert.equal(detectApp({ entry: 'claude-desktop', bundle: 'com.anthropic.claudefordesktop' }).kind, 'desktop');
  assert.equal(detectApp({ entry: 'cli', bundle: 'com.apple.Terminal' }).kind, 'terminal');
  assert.equal(detectApp({}).kind, 'unknown');
});

test('spotting a question at the end of a reply', () => {
  assert.equal(looksLikeQuestion('Done. Should I also update the README?'), true);
  assert.equal(looksLikeQuestion('Done. All 60 tests pass.'), false);
  assert.equal(looksLikeQuestion('Fixed it.\n\n**Want me to push the branch?**'), true);
});

test('the browser is told about a held request only once the buttons can work', async () => {
  const { store, engine, hook } = setup({ driveMinutes: 1 });
  const seen = [];
  store.on('session', (s) => {
    const p = engine.publicSession(s);
    seen.push({ status: p.status, waiting: p.waitingPermission, holding: p.holdingStop });
  });
  const pending = hook('PermissionRequest', { tool_name: 'Bash', tool_input: { command: 'npm test' } });
  await sleep(5);
  const last = seen.at(-1);
  assert.equal(last.status, 'needs');
  assert.equal(last.waiting, true, 'the last update must say the request is waiting');
  engine.decide('s1', { behavior: 'allow' });
  await pending;

  engine.setDrive('s1', true);
  seen.length = 0;
  const held = hook('Stop', { stop_hook_active: false, last_assistant_message: 'Done. Should it also cover tags?' });
  await sleep(5);
  assert.equal(seen.at(-1).holding, true, 'the last update must say the chat is held');
  await engine.send('s1', 'Yes, cover tags too.');
  const out = await held;
  assert.equal(out.decision, 'block');
});

test('with no Kroog tab open, nothing is held and the editor asks at once', async () => {
  const { store, engine, hook } = setup();
  engine.hasViewers = () => false;
  const started = Date.now();
  const out = await hook('PermissionRequest', { tool_name: 'Bash', tool_input: { command: 'npm test' } });
  assert.equal(out, null);
  assert.ok(Date.now() - started < 200, 'it must not wait');
  const s = store.session('s1');
  assert.equal(s.needs.inEditor, true);

  engine.setDrive('s1', true);
  const stopOut = await hook('Stop', { stop_hook_active: false, last_assistant_message: 'Done. Want tags too?' });
  assert.equal(stopOut, null);
  assert.equal(engine.publicSession(s).holdingStop, false);
  assert.match(s.steps.at(-1).text, /No Kroog tab was open/);
});

test('lineage: a brief made from one chat is recorded on the chat that starts with it', async () => {
  const { store, engine, hook } = setup();
  await hook('UserPromptSubmit', { prompt: 'Add a cost check to dbt runs.' }, 'a');
  await hook('Stop', { last_assistant_message: 'Done. Runs over £5 stop.' }, 'a');
  const r = await engine.handoff({ text: 'Brief: runs over £5 stop.', goal: 'Fix the failing cost test', target: 'new', editor: 'cursor', sources: ['a'] });
  assert.equal(r.ok, true);
  assert.match(r.url, /^cursor:\/\/anthropic\.claude-code\/open\?prompt=/);
  assert.equal(store.pendingBriefs().length, 1);
  await hook('UserPromptSubmit', { prompt: r.prompt }, 'b');
  const b = store.session('b');
  assert.equal(b.title, 'Fix the failing cost test');
  assert.equal(b.inputs.length, 1);
  assert.equal(b.inputs[0].kind, 'brief');
  assert.deepEqual(b.inputs[0].from, ['a']);
  assert.equal(store.pendingBriefs().length, 0, 'a used brief is no longer waiting');
});

test('lineage: project memory records which chats the notes came from', async () => {
  const { store, hook } = setup();
  await hook('UserPromptSubmit', { prompt: 'Draft the FAQ.' }, 'faq');
  const note = store.addNote({ sessionId: 'faq', chatTitle: 'Draft the FAQ', project: 'app', cwd: '/Users/me/code/app', type: 'Decision', text: 'Answers use only facts on the site.' });
  store.updateNote(note.id, { remembered: true });
  const out = await hook('SessionStart', { source: 'startup' }, 'post');
  assert.match(out.hookSpecificOutput.additionalContext, /facts on the site/);
  const post = store.session('post');
  assert.equal(post.inputs[0].kind, 'memory');
  assert.deepEqual(post.inputs[0].from, ['faq']);
  await hook('SessionStart', { source: 'resume' }, 'post');
  assert.equal(post.inputs.filter((x) => x.kind === 'memory').length, 1, 'a resume does not add a second memory record');
});

test('lineage: a brief sent to a working chat is queued and recorded', async () => {
  const { store, engine, hook } = setup();
  await hook('UserPromptSubmit', { prompt: 'Write the post.' }, 'post');
  const r = await engine.handoff({ text: 'Use British spelling.', target: 'running', sessionId: 'post', sources: ['src1'] });
  assert.equal(r.delivered, 'queued');
  const s = store.session('post');
  assert.equal(s.inputs.at(-1).kind, 'brief');
  assert.deepEqual(s.inputs.at(-1).from, ['src1']);
  const out = await hook('PostToolUse', { tool_name: 'Read', tool_input: { file_path: '/x' }, tool_response: {} }, 'post');
  assert.match(out.hookSpecificOutput.additionalContext, /British spelling/);
});

test('lineage: a brief to project memory keeps its sources', async () => {
  const { store, engine } = setup();
  const r = await engine.handoff({ text: 'Posts use the house style.', target: 'memory', cwd: '/Users/me/code/app', sources: ['x'] });
  assert.equal(r.ok, true);
  const note = store.data.notes.at(-1);
  assert.equal(note.remembered, true);
  assert.deepEqual(note.from, ['x']);
});
