import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { Store } from '../src/store.js';
import { Engine } from '../src/engine.js';
import { Inbox } from '../src/inbox.js';

// A chat's inbox address for tests: a socket file on macOS and Linux, a named pipe on Windows.
const endpoint = (dir, name) => (process.platform === 'win32' ? `\\\\.\\pipe\\kroog-test-${process.pid}-${name}-${Math.random().toString(36).slice(2, 8)}` : path.join(dir, `${name}.sock`));

// A stand-in for a Claude Code chat's inbox: a Unix socket that records what arrives.
function fakeChat() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-socks-test-'));
  const socket = endpoint(dir, '4242');
  const got = [];
  const server = net.createServer((c) => {
    let buf = '';
    c.on('data', (d) => { buf += d; });
    c.on('end', () => { got.push(...buf.trim().split('\n').map((l) => JSON.parse(l))); });
  });
  return new Promise((resolve) => server.listen(socket, () => resolve({ socket, got, close: () => new Promise((r) => server.close(r)) })));
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

test('a message to an idle VS Code chat goes into its Claude Code inbox', async () => {
  const chat = await fakeChat();
  try {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'kroog-in-')), 'inboxes.json');
  const store = new Store();
  const engine = new Engine({ store, getSettings: () => ({ permissionHoldSeconds: 30 }), inbox: new Inbox({ file }) });
  const meta = { entry: 'claude-vscode', inbox: chat.socket, inboxToken: 'tok123' };
  await engine.handle('UserPromptSubmit', { session_id: 'v1', cwd: '/x', prompt: 'hi' }, meta);
  await engine.handle('Stop', { session_id: 'v1', cwd: '/x', last_assistant_message: 'All done here.' }, meta);
  assert.equal(engine.publicSession(store.session('v1')).inbox, true);
  // File modes are a macOS and Linux idea; on Windows the user folder keeps it private.
  if (process.platform !== 'win32') assert.equal((fs.statSync(file).mode & 0o777), 0o600, 'the inbox list is private');

  const r = await engine.send('v1', 'Now add a test');
  assert.equal(r.delivered, 'inbox');
  await sleep(50);
  assert.deepEqual(chat.got[0], { type: 'auth', token: 'tok123' });
  assert.equal(chat.got[1].type, 'user');
  assert.match(chat.got[1].message.content, /sent from Kroog[\s\S]*Now add a test/);
  assert.equal(store.session('v1').status, 'working');

  // A brief from another chat goes the same way.
  await engine.handle('UserPromptSubmit', { session_id: 'src', cwd: '/x', prompt: 'other' }, { entry: 'claude-vscode' });
  const h = await engine.handoff({ text: 'BRIEF', goal: 'Use this', target: 'running', sessionId: 'v1', sources: ['src'] });
  assert.equal(h.delivered, 'inbox');
  await sleep(50);
  assert.match(chat.got.at(-1).message.content, /Use this\n\nBRIEF/);
  assert.deepEqual(store.session('v1').inputs.at(-1).from, ['src']);

  // Once the chat closes, Kroog stops using the inbox and falls back.
  await chat.close();
  const later = await engine.send('v1', 'are you there');
  assert.notEqual(later.delivered, 'inbox');
  assert.equal(engine.publicSession(store.session('v1')).inbox, false);

  // Inbox addresses survive a Kroog restart.
  const again = new Inbox({ file });
  assert.equal(again.map.size, 0, 'the closed chat was forgotten');
  } finally {
    await chat.close();
  }
});

test('Kroog ignores an inbox path that is not a socket', async () => {
  const store = new Store();
  const engine = new Engine({ store, getSettings: () => ({}) });
  await engine.handle('UserPromptSubmit', { session_id: 'z', cwd: '/x', prompt: 'hi' }, { entry: 'claude-vscode', inbox: '/etc/passwd' });
  assert.equal(engine.publicSession(store.session('z')).inbox, false);
});

test('a socket file left behind by a closed chat is noticed', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-socks-probe-'));
  const socket = endpoint(dir, '7');
  const server = net.createServer(() => {});
  await new Promise((r) => server.listen(socket, r));
  const inbox = new Inbox();
  inbox.remember('a', socket, '');
  assert.equal(await inbox.probe('a'), true);
  // Stop listening but leave the file, as a crashed chat would.
  server.close();
  await new Promise((r) => setTimeout(r, 50));
  if (!fs.existsSync(socket)) { const s2 = net.createServer(); await new Promise((r) => s2.listen(socket, r)); s2.close(); await new Promise((r) => setTimeout(r, 50)); }
  const alive = await inbox.probe('a');
  assert.equal(alive, false);
  assert.equal(inbox.map.has('a'), false);
});
