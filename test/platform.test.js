// What differs on Windows, checked on any system: inbox addresses (named pipes), starting
// .cmd files through cmd.exe, vscode://file links, folder matching, the Node hook relay and
// the hook commands Claude Code runs in Git Bash or PowerShell.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { isPipe, inboxAddressValid, inboxPresent, forgetPipes, commandLine, commandNames, fileLinkPath, sameFolder, baseName } from '../src/platform.js';
import { hookCommand, hookNodeScript, relayKind, withKroogHooks, withoutKroogHooks } from '../src/link.js';
import { folderUrl } from '../src/editor.js';
import { tildePath, fileLink, isFilePath } from '../public/util.js';

test('a chat inbox is a named pipe on Windows and a socket file elsewhere', () => {
  const pipe = '\\\\.\\pipe\\claude-code-1234';
  assert.equal(isPipe(pipe), true);
  assert.equal(isPipe('/tmp/x.sock'), false);
  assert.equal(inboxAddressValid(pipe, { platform: 'win32' }), true);
  assert.equal(inboxAddressValid('C:\\Windows\\system32\\cmd.exe', { platform: 'win32' }), false);
  assert.equal(inboxAddressValid('/etc/passwd', { platform: 'win32' }), false);
  assert.equal(inboxAddressValid(pipe, { platform: 'linux' }), false);
  assert.equal(inboxAddressValid('\\\\.\\pipe\\a\0b', { platform: 'win32' }), false);
});

test('on Windows a chat\'s inbox is there while its pipe is in the list of open pipes', () => {
  const pipe = '\\\\.\\pipe\\claude-code-1234';
  let open = ['claude-code-1234', 'other'];
  const readdir = () => open;
  forgetPipes();
  assert.equal(inboxPresent(pipe, { platform: 'win32', readdir }), true);
  assert.equal(inboxPresent('\\\\.\\pipe\\CLAUDE-code-1234', { platform: 'win32', readdir }), true, 'pipe names ignore case');
  open = ['other'];
  forgetPipes();
  assert.equal(inboxPresent(pipe, { platform: 'win32', readdir }), false, 'a closed chat\'s pipe is gone from the list');
  assert.equal(inboxPresent('/tmp/x.sock', { platform: 'win32', readdir }), false);
  // When the list cannot be read, Kroog says maybe, and sending finds out.
  forgetPipes();
  assert.equal(inboxPresent(pipe, { platform: 'win32', readdir: () => { throw new Error('no'); } }), true);
  forgetPipes();
});

test('a .cmd file starts through cmd.exe with every argument quoted; an .exe starts directly', () => {
  const c = commandLine('C:\\Users\\Jo Smith\\AppData\\Roaming\\npm\\claude.cmd', ['plugin', 'install', 'kroog', '--marketplace', 'C:\\Users\\Jo Smith\\kroog', '--tools', ''], { platform: 'win32', comspec: 'C:\\Windows\\system32\\cmd.exe' });
  assert.equal(c.file, 'C:\\Windows\\system32\\cmd.exe');
  assert.deepEqual(c.args.slice(0, 3), ['/d', '/s', '/c']);
  assert.equal(c.args[3], '""C:\\Users\\Jo Smith\\AppData\\Roaming\\npm\\claude.cmd" "plugin" "install" "kroog" "--marketplace" "C:\\Users\\Jo Smith\\kroog" "--tools" """');
  assert.equal(c.options.windowsVerbatimArguments, true);
  const exe = commandLine('C:\\Users\\jo\\.local\\bin\\claude.exe', ['--version'], { platform: 'win32' });
  assert.equal(exe.file, 'C:\\Users\\jo\\.local\\bin\\claude.exe');
  assert.deepEqual(exe.args, ['--version']);
  const unix = commandLine('/usr/local/bin/claude', ['-p'], { platform: 'darwin' });
  assert.equal(unix.file, '/usr/local/bin/claude');
  assert.deepEqual(commandNames('claude', { platform: 'win32' }), ['claude.exe', 'claude.cmd', 'claude.bat']);
  assert.deepEqual(commandNames('code', { platform: 'linux' }), ['code']);
});

test('file links and folder names work for Windows paths', () => {
  assert.equal(fileLinkPath('C:\\Users\\jo\\code\\shop'), '/C:/Users/jo/code/shop');
  assert.equal(fileLinkPath('/Users/jo/code/shop'), '/Users/jo/code/shop');
  assert.equal(folderUrl('vscode', 'C:\\Users\\jo\\code\\shop'), 'vscode://file/C:/Users/jo/code/shop/');
  assert.equal(fileLink('C:\\Users\\jo\\notes.md'), 'vscode://file/C:/Users/jo/notes.md');
  assert.equal(isFilePath('C:\\Users\\jo\\notes.md'), true);
  assert.equal(isFilePath('kroog-note:12'), false);
  assert.equal(tildePath('C:\\Users\\Jo Smith\\code'), '~\\code');
  assert.equal(baseName('C:\\Users\\jo\\code\\shop\\'), 'shop');
  assert.equal(sameFolder('C:\\Users\\Jo\\Code\\Shop', 'c:/users/jo/code/shop/src', { platform: 'win32' }), true);
  assert.equal(sameFolder('C:\\Users\\jo\\shop', 'C:\\Users\\jo\\shopping', { platform: 'win32' }), false);
  assert.equal(sameFolder('/Users/jo/Shop', '/Users/jo/shop', { platform: 'darwin' }), false);
});

test('Windows gets the Node relay, run as `node "<path>" <Event>` in Git Bash and PowerShell alike', () => {
  assert.equal(relayKind({ platform: 'win32' }), 'node');
  assert.equal(relayKind({ platform: 'linux', hasCurl: true, force: '' }), 'sh');
  assert.equal(relayKind({ platform: 'linux', hasCurl: false, force: '' }), 'node');
  const script = 'C:\\Users\\Jo Smith\\.kroog\\hook.mjs';
  assert.deepEqual(hookCommand({ kind: 'node', scriptPath: script, event: 'Stop', platform: 'win32', nodeOnPath: true }), { command: 'node "C:/Users/Jo Smith/.kroog/hook.mjs" Stop' });
  const ps = hookCommand({ kind: 'node', scriptPath: script, event: 'Stop', platform: 'win32', nodeOnPath: false, nodePath: 'C:\\Program Files\\nodejs\\node.exe' });
  assert.equal(ps.shell, 'powershell');
  assert.equal(ps.command, '& "C:/Program Files/nodejs/node.exe" "C:/Users/Jo Smith/.kroog/hook.mjs" Stop');

  const linked = withKroogHooks({ hooks: { Stop: [{ hooks: [{ type: 'command', command: 'echo mine' }] }] } }, script, { kind: 'node', platform: 'win32', nodeOnPath: true });
  assert.equal(linked.hooks.Stop.length, 2, 'your own hooks stay');
  assert.match(linked.hooks.Stop[1].hooks[0].command, /^node "C:\/Users\/Jo Smith\/\.kroog\/hook\.mjs" Stop$/);
  const removed = withoutKroogHooks(linked);
  assert.equal(JSON.stringify(removed).includes('hook.mjs'), false, 'unlink finds the Node relay too');
  assert.equal(removed.hooks.Stop[0].hooks[0].command, 'echo mine');
});

test('the Node relay is valid JavaScript, forwards the event, and exits 0 when Kroog is off', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kroog-relay-'));
  const file = path.join(dir, 'hook.mjs');
  fs.writeFileSync(file, hookNodeScript({ port: 1, tokenPath: 'C:\\Users\\Jo Smith\\.kroog\\token' }));
  const checked = spawnSync(process.execPath, ['--check', file], { encoding: 'utf8' });
  assert.equal(checked.status, 0, checked.stderr);
  const text = fs.readFileSync(file, 'utf8');
  assert.match(text, /const TOKEN_PATH = "C:\\\\Users\\\\Jo Smith\\\\\.kroog\\\\token";/);
  assert.match(text, /http:\/\/127\.0\.0\.1:1\/hook\//);
  for (const h of ['X-Kroog-Token', 'X-Kroog-Entry', 'X-Kroog-Inbox', 'X-Kroog-Inbox-Token']) assert.ok(text.includes(h), h);
  const ran = spawnSync(process.execPath, [file, 'Stop'], { input: '{}', encoding: 'utf8', timeout: 10000 });
  assert.equal(ran.status, 0);
  assert.equal(ran.stdout, '');
});
