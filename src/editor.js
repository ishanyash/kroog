// Opening things in VS Code or Cursor from Kroog.
//
// Two ways in. A folder opens best through the editor's own command (`code`, `cursor`): it
// focuses the window that already has the folder, or opens one, with no "an external
// application wants to open this folder" dialog. Without the command, the `vscode://file/`
// link does the same with that one dialog (macOS lets you tick "allow without asking").
// A chat opens through the Claude Code extension's link, which the extension confirms
// once ("Allow 'Claude Code for VS Code' to open this URI?", with a "do not ask again").
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';

export const EDITORS = {
  vscode: { name: 'VS Code', scheme: 'vscode', command: 'code', apps: ['Visual Studio Code.app/Contents/Resources/app/bin/code'] },
  cursor: { name: 'Cursor', scheme: 'cursor', command: 'cursor', apps: ['Cursor.app/Contents/Resources/app/bin/cursor'] },
  'vscode-insiders': { name: 'VS Code Insiders', scheme: 'vscode-insiders', command: 'code-insiders', apps: ['Visual Studio Code - Insiders.app/Contents/Resources/app/bin/code-insiders'] },
  windsurf: { name: 'Windsurf', scheme: 'windsurf', command: 'windsurf', apps: ['Windsurf.app/Contents/Resources/app/bin/windsurf'] },
};

export function editorKey(editor) {
  return EDITORS[editor] ? editor : 'vscode';
}

export function editorName(editor) {
  return EDITORS[editorKey(editor)].name;
}

function isExec(file) {
  try { fs.accessSync(file, fs.constants.X_OK); return fs.statSync(file).isFile(); } catch { return false; }
}

// The editor's command on this computer, if it is installed: on the PATH, in the usual places,
// or inside the app itself (VS Code: "Shell Command: Install 'code' command in PATH" is
// not needed for that).
export function findEditorCommand(editor, { env = process.env, home = os.homedir() } = {}) {
  const e = EDITORS[editorKey(editor)];
  const tries = [];
  for (const dir of String(env.PATH || '').split(path.delimiter).filter(Boolean)) tries.push(path.join(dir, e.command));
  tries.push(`/opt/homebrew/bin/${e.command}`, `/usr/local/bin/${e.command}`);
  for (const app of e.apps) tries.push(path.join('/Applications', app), path.join(home, 'Applications', app));
  return tries.find(isExec) || null;
}

export function folderUrl(editor, folder) {
  const f = String(folder || '');
  return `${EDITORS[editorKey(editor)].scheme}://file${f.endsWith('/') ? f : `${f}/`}`;
}

export function chatUrl(editor, sessionId, prompt = '') {
  const q = [];
  if (sessionId) q.push(`session=${encodeURIComponent(sessionId)}`);
  if (prompt) q.push(`prompt=${encodeURIComponent(prompt)}`);
  return `${EDITORS[editorKey(editor)].scheme}://anthropic.claude-code/open${q.length ? `?${q.join('&')}` : ''}`;
}

function spawnQuiet(cmd, args) {
  try {
    const child = spawn(cmd, args, { stdio: 'ignore', detached: true });
    child.on('error', () => { /* reported through the return value of the caller */ });
    child.unref();
    return true;
  } catch {
    return false;
  }
}

export class EditorOpener {
  // `open` opens a URL on this computer; `find` finds an editor's command (both swappable for tests).
  constructor({ open, find = findEditorCommand, demo = false } = {}) {
    this.demo = demo;
    this.find = find;
    this.open = open || ((url) => {
      if (demo) return;
      const cmd = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'explorer' : 'xdg-open';
      spawnQuiet(cmd, [url]);
    });
    this.commands = new Map();
  }

  command(editor) {
    const key = editorKey(editor);
    if (!this.commands.has(key)) this.commands.set(key, this.find(key));
    return this.commands.get(key);
  }

  // Opens (or focuses) the project folder. Says how it did it, so the caller knows how long
  // to wait before the chat link: a window that is already open is ready at once.
  openFolder(editor, folder) {
    const f = String(folder || '');
    if (!f) return { ok: false, how: 'none' };
    if (this.demo) return { ok: true, how: 'demo' };
    const cmd = this.command(editor);
    if (cmd && spawnQuiet(cmd, [f])) return { ok: true, how: 'command', command: cmd };
    this.open(folderUrl(editor, f));
    return { ok: true, how: 'link' };
  }

  // Opens a chat in the editor: its folder first, when given, then the chat.
  async openChat(editor, { folder = '', sessionId = '', prompt = '' } = {}) {
    const url = chatUrl(editor, sessionId, prompt);
    if (this.demo) return { ok: true, url, folder: folder ? 'demo' : 'none' };
    let how = 'none';
    if (folder && fs.existsSync(folder)) {
      how = this.openFolder(editor, folder).how;
      // The folder's window needs a moment; a new window needs a few.
      await new Promise((r) => setTimeout(r, how === 'command' ? 1800 : 2500));
    }
    this.open(url);
    return { ok: true, url, folder: how };
  }
}
