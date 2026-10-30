import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { Store } from '../src/store.js';
import { Engine } from '../src/engine.js';
import { Presence } from '../src/presence.js';
import { isJunkTitle, retitle, isEmptyChat } from '../src/titles.js';

function registry(entries) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-sessions-'));
  for (const e of entries) {
    fs.writeFileSync(path.join(dir, `${e.pid}.json`), JSON.stringify(e));
    if (e.token) fs.writeFileSync(path.join(dir, `${e.pid}.abc.key`), JSON.stringify({ peerToken: e.token }), { mode: 0o600 });
  }
  return dir;
}

test('Claude Code\'s registry tells Kroog which chats are open, busy or idle, with their inbox', async () => {
  const sockDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-socks-'));
  const socket = path.join(sockDir, '1.sock');
  const server = net.createServer(() => {});
  await new Promise((r) => server.listen(socket, r));
  const dir = registry([
    { pid: process.pid, sessionId: 'open-1', cwd: '/Users/me/code/app', entrypoint: 'claude-vscode', status: 'idle', statusUpdatedAt: Date.now(), startedAt: Date.now() - 60000, messagingSocketPath: socket, token: 'tok' },
    { pid: 999999, sessionId: 'dead-1', cwd: '/x', entrypoint: 'claude-vscode', status: 'busy', messagingSocketPath: socket },
  ]);
  const store = new Store();
  const engine = new Engine({ store, getSettings: () => ({}), presence: new Presence({ dir }) });
  try {
  const changed = engine.syncPresence();
  assert.deepEqual(changed.sort(), ['open-1']);
  const s = store.session('open-1');
  assert.equal(s.app, 'VS Code');
  assert.equal(s.project, 'app');
  assert.equal(engine.publicSession(s).live, true);
  assert.equal(engine.publicSession(s).inbox, true, 'the inbox came from the registry, not from a hook');
  assert.equal(store.session('dead-1'), null, 'a dead process is ignored');

  // Busy or idle corrects the state.
  fs.writeFileSync(path.join(dir, `${process.pid}.json`), JSON.stringify({ pid: process.pid, sessionId: 'open-1', cwd: '/Users/me/code/app', entrypoint: 'claude-vscode', status: 'busy', statusUpdatedAt: Date.now(), startedAt: Date.now() - 60000, messagingSocketPath: socket }));
  engine.syncPresence();
  assert.equal(store.session('open-1').status, 'working');

  // Gone from the registry, and its inbox closed: not live any more.
  fs.unlinkSync(path.join(dir, `${process.pid}.json`));
  await new Promise((r) => server.close(r));
  try { fs.unlinkSync(socket); } catch { /* already gone */ }
  engine.syncPresence();
  assert.equal(engine.publicSession(store.session('open-1')).live, false);
  } finally {
    try { server.close(); } catch { /* closed */ }
  }
});

test('titles made from editor tags are replaced, and empty chats are spotted', () => {
  assert.equal(isJunkTitle('<ide_opened_file>The user opened'), true);
  assert.equal(isJunkTitle('The user opened the file /x/y.md in the IDE'), true);
  assert.equal(isJunkTitle('[Browser disconnected: the pane'), true);
  assert.equal(isJunkTitle('Untitled chat'), true);
  assert.equal(isJunkTitle('Fix the RSS dates'), false);
  const s = { id: 'nope', title: 'The user opened the file /x', lastPrompt: '<ide_opened_file>x</ide_opened_file> just testing this', steps: [] };
  assert.equal(retitle(s), true);
  assert.equal(s.title, 'just testing this');
  assert.equal(isEmptyChat({ status: 'done', lastPrompt: '', lastReply: '', steps: [{ kind: 'info', text: 'Chat opened' }] }), true);
  assert.equal(isEmptyChat({ status: 'done', lastPrompt: 'hi', lastReply: 'hello', steps: [] }), false);
  assert.equal(isEmptyChat({ status: 'working', lastPrompt: '', lastReply: '', steps: [] }), false);
});

// A new chat in the editor, fed through its inbox: Kroog opens the editor, the chat shows up
// in the registry, and the context goes in as its first message.
test('a new chat in the editor gets the context through its inbox once it appears in the registry', async () => {
  const sockDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-socks-'));
  const socket = path.join(sockDir, 'new.sock');
  const got = [];
  const server = net.createServer((c) => { let buf = ''; c.on('data', (d) => { buf += d; }); c.on('end', () => got.push(buf)); });
  await new Promise((r) => server.listen(socket, r));
  const dir = registry([]);
  const store = new Store();
  const opened = [];
  const copied = [];
  const editor = {
    // When the editor "opens" a new chat, Claude Code writes it into the registry a moment later.
    openChat: async (ed, opts) => {
      opened.push({ ed, ...opts });
      setTimeout(() => {
        fs.writeFileSync(path.join(dir, `${process.pid}.json`), JSON.stringify({ pid: process.pid, sessionId: 'fresh-1', cwd: '/Users/me/code/app', entrypoint: 'claude-vscode', status: 'idle', statusUpdatedAt: Date.now(), startedAt: Date.now(), messagingSocketPath: socket }));
        fs.writeFileSync(path.join(dir, `${process.pid}.k.key`), JSON.stringify({ peerToken: 'tok' }), { mode: 0o600 });
      }, 300);
      return { ok: true, url: 'vscode://anthropic.claude-code/open', folder: 'command' };
    },
    openFolder: () => ({ ok: true, how: 'command' }),
    command: () => '/usr/local/bin/code',
  };
  const engine = new Engine({ store, getSettings: () => ({}), presence: new Presence({ dir }), editor, copy: async (t) => { copied.push(t); return true; } });
  try {
    await engine.handle('UserPromptSubmit', { session_id: 'a', cwd: '/Users/me/code/app', prompt: 'Find the cost' }, { entry: 'claude-vscode' });
    const r = await engine.handoff({ text: 'CONTEXT: about £38 a week.', goal: 'Write the FAQ', target: 'new', run: 'inbox', editor: 'vscode', cwd: '/Users/me/code/app/', sources: ['a'] });
    assert.equal(r.ok, true, r.error);
    assert.equal(r.delivered, 'inbox');
    assert.equal(r.id, 'fresh-1');
    assert.equal(opened.length, 1);
    assert.equal(opened[0].folder, '/Users/me/code/app/');
    assert.equal(opened[0].sessionId, undefined, 'no session in the link: the editor makes a fresh chat');
    assert.ok(await new Promise((res) => { const t = setInterval(() => { if (got.length) { clearInterval(t); res(true); } }, 20); setTimeout(() => { clearInterval(t); res(false); }, 3000); }), 'the message reached the inbox');
    const lines = got[0].trim().split('\n').map((l) => JSON.parse(l));
    assert.deepEqual(lines[0], { type: 'auth', token: 'tok' });
    assert.match(lines[1].message.content, /^Message from the user, sent from Kroog/);
    assert.match(lines[1].message.content, /It is background for this chat, not a task\.\n\nWhat I want to do next: Write the FAQ\n\nCONTEXT: about £38 a week\.\n\nWhat to do now: read the context[\s\S]*Do not read files, run commands, or change anything until I ask\.\n\n\[Kroog brief [a-z0-9]+\]$/);
    const s = store.session('fresh-1');
    assert.equal(s.status, 'working');
    assert.ok(s.steps.some((st) => st.kind === 'you' && /Started with the context from "Find the cost"/.test(st.text)));
    assert.deepEqual(copied, [], 'nothing on the clipboard when the inbox took it');
    // The hook then sees the message come back with the tag: lineage recorded, title from the goal.
    const out = await engine.handle('UserPromptSubmit', { session_id: 'fresh-1', cwd: '/Users/me/code/app', prompt: lines[1].message.content }, { entry: 'claude-vscode' });
    assert.equal(out, null);
    assert.deepEqual(s.inputs.find((x) => x.kind === 'brief').from, ['a']);
    assert.equal(s.title, 'Write the FAQ');
  } finally {
    server.close();
  }
});

test('when no new chat shows up, the context goes on the clipboard instead', async () => {
  const dir = registry([]);
  const store = new Store();
  const copied = [];
  const editor = { openChat: async () => ({ ok: true, url: 'x', folder: 'link' }), openFolder: () => ({ ok: true, how: 'link' }), command: () => null };
  const engine = new Engine({ store, getSettings: () => ({}), presence: new Presence({ dir }), editor, copy: async (t) => { copied.push(t); return true; } });
  const r = await engine.startInEditor({ editor: 'vscode', cwd: '/Users/me/code/app', prompt: 'Hello there', wait: 700 });
  assert.equal(r.delivered, 'paste');
  assert.equal(r.copied, true);
  assert.deepEqual(copied, ['Hello there']);
});
