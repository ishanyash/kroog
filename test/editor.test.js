import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EditorOpener, findEditorCommand, chatUrl, folderUrl, editorName } from '../src/editor.js';
import { copyText } from '../src/clipboard.js';

test('links for folders and chats', () => {
  assert.equal(folderUrl('vscode', '/Users/me/code/app'), 'vscode://file/Users/me/code/app/');
  assert.equal(folderUrl('cursor', '/Users/me/code/app/'), 'cursor://file/Users/me/code/app/');
  assert.equal(chatUrl('vscode', 'abc123'), 'vscode://anthropic.claude-code/open?session=abc123');
  assert.equal(chatUrl('vscode', '', 'hello there'), 'vscode://anthropic.claude-code/open?prompt=hello%20there');
  assert.equal(chatUrl('nonsense', 'x'), 'vscode://anthropic.claude-code/open?session=x');
  assert.equal(editorName('cursor'), 'Cursor');
  assert.equal(editorName('whatever'), 'VS Code');
});

test('the editor command is found on the PATH or in the app, and a folder opens through it', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kroog-ed-'));
  const fake = path.join(dir, 'code');
  fs.writeFileSync(fake, '#!/bin/sh\necho "$@" > "$0.log"\n', { mode: 0o755 });
  assert.equal(findEditorCommand('vscode', { env: { PATH: dir }, home: dir }), fake);
  assert.equal(findEditorCommand('vscode', { env: { PATH: '/nowhere' }, home: dir }), null);
  // In the app bundle under the home folder.
  const app = path.join(dir, 'Applications/Cursor.app/Contents/Resources/app/bin');
  fs.mkdirSync(app, { recursive: true });
  fs.writeFileSync(path.join(app, 'cursor'), '#!/bin/sh\n', { mode: 0o755 });
  assert.equal(findEditorCommand('cursor', { env: { PATH: '' }, home: dir }), path.join(app, 'cursor'));

  const opened = [];
  const ed = new EditorOpener({ open: (url) => opened.push(url), find: (key) => (key === 'vscode' ? fake : null) });
  const r = ed.openFolder('vscode', dir);
  assert.equal(r.how, 'command');
  assert.ok(await new Promise((res) => { const t = setInterval(() => { if (fs.existsSync(`${fake}.log`)) { clearInterval(t); res(true); } }, 20); setTimeout(() => { clearInterval(t); res(false); }, 3000); }), 'the command ran');
  assert.equal(fs.readFileSync(`${fake}.log`, 'utf8').trim(), dir);
  assert.deepEqual(opened, [], 'no link needed for the folder');
  // Without the command, the folder opens through its link; the chat always through its link.
  assert.equal(ed.openFolder('cursor', dir).how, 'link');
  assert.equal(opened.at(-1), `cursor://file${dir}/`);
  const chat = await ed.openChat('cursor', { sessionId: 'abc', folder: '' });
  assert.equal(chat.url, 'cursor://anthropic.claude-code/open?session=abc');
  assert.equal(opened.at(-1), chat.url);
});

test('the demo opens nothing', async () => {
  const opened = [];
  const ed = new EditorOpener({ open: (url) => opened.push(url), demo: true });
  assert.equal(ed.openFolder('vscode', '/x').how, 'demo');
  const r = await ed.openChat('vscode', { sessionId: 'abc', folder: '/x' });
  assert.equal(r.folder, 'demo');
  assert.deepEqual(opened, []);
});

test('the clipboard says when it could not copy', async () => {
  // Whatever this machine has, the call settles with a boolean and never throws.
  const ok = await copyText('hello', { platform: 'linux' });
  assert.equal(typeof ok, 'boolean');
});
