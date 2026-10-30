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
