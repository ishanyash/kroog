// What differs between macOS, Linux and Windows, in one place.
//
// - A chat's inbox is a Unix socket on macOS and Linux, and a named pipe (\\.\pipe\...) on
//   Windows (Claude Code 2.1.234 or later).
// - On Windows, npm's `claude.cmd` and the editors' `code.cmd` can only be started through
//   cmd.exe; everything else starts directly.
// - Opening a link: `open` on macOS, `xdg-open` on Linux, Explorer on Windows.
// - A file link for VS Code is vscode://file/<path>, with forward slashes on Windows too.
import fs from 'node:fs';
import path from 'node:path';
import { spawn, execFile } from 'node:child_process';

export const IS_WIN = process.platform === 'win32';

// ---------------------------------------------------------------- chat inboxes

export function isPipe(p) {
  return /^\\\\[.?]\\pipe\\[^\\\0]+$/i.test(String(p || ''));
}

// Only an address Claude Code would use: a socket file you own, or (on Windows) a local pipe.
export function inboxAddressValid(p, { platform = process.platform } = {}) {
  const s = String(p || '');
  if (!s || s.includes('\0')) return false;
  if (platform === 'win32') return isPipe(s);
  if (!path.isAbsolute(s) || !/\.sock$/.test(s)) return false;
  try {
    const st = fs.statSync(s);
    if (!st.isSocket()) return false;
    if (typeof process.getuid === 'function' && st.uid !== process.getuid()) return false;
    return true;
  } catch {
    return false;
  }
}

// Is the inbox still there? A socket file can be looked at. A pipe cannot (opening it would
// connect to the chat), but Windows lists every open pipe under \\.\pipe\, so Kroog looks for
// its name there. The list is kept for a moment, since a sync looks at every chat at once.
// Node 22 lists "\\.\pipe\" given as text; Node 20 drops the last backslash from text and
// fails, but keeps it in a Buffer. The first way that works is remembered.
export const PIPE_DIRS = ['\\\\.\\pipe\\', Buffer.from('\\\\.\\pipe\\'), '\\\\?\\pipe\\'];
let pipeDir = null;
export function listPipes(readdir = fs.readdirSync) {
  for (const dir of pipeDir ? [pipeDir] : PIPE_DIRS) {
    try {
      const names = readdir(dir).map((n) => String(n));
      pipeDir = dir;
      return names;
    } catch { /* try the next way */ }
  }
  return null;
}

let pipeList = { at: 0, names: null };
function openPipes(readdir, fresh = false) {
  if (fresh || Date.now() - pipeList.at > 250) {
    const listed = listPipes(readdir);
    pipeList = { at: Date.now(), names: listed ? new Set(listed.map((n) => n.toLowerCase())) : null };
  }
  return pipeList.names;
}

export function inboxPresent(p, { platform = process.platform, readdir = fs.readdirSync } = {}) {
  const s = String(p || '');
  if (platform === 'win32') {
    if (!isPipe(s)) return false;
    const name = s.slice(9).toLowerCase();
    const before = pipeList.at;
    let names = openPipes(readdir);
    // Not in a list made a moment ago: the chat may have just opened, so look once more.
    if (names && !names.has(name) && pipeList.at === before) names = openPipes(readdir, true);
    return names ? names.has(name) : true;
  }
  try { return fs.statSync(s).isSocket(); } catch { return false; }
}

// Forget the cached pipe list (tests, or right after a chat closes).
export function forgetPipes() {
  pipeList = { at: 0, names: null };
  pipeDir = null;
}

// ---------------------------------------------------------------- starting programs

const quoteForCmd = (a) => `"${String(a).replace(/"/g, '""')}"`;

// How to start `bin` with `args`. A .cmd or .bat file on Windows goes through cmd.exe, with
// the whole line quoted the way cmd.exe expects (the same thing npm's cross-spawn does).
// Callers keep long or multi-line text out of the arguments (files or stdin instead).
export function commandLine(bin, args = [], { platform = process.platform, comspec = process.env.ComSpec } = {}) {
  if (platform === 'win32' && /\.(cmd|bat)$/i.test(String(bin))) {
    const line = [bin, ...args].map(quoteForCmd).join(' ');
    return { file: comspec || 'cmd.exe', args: ['/d', '/s', '/c', `"${line}"`], options: { windowsVerbatimArguments: true } };
  }
  return { file: bin, args: [...args], options: {} };
}

export function execCli(bin, args, opts, cb) {
  const c = commandLine(bin, args);
  return execFile(c.file, c.args, { ...opts, ...c.options, windowsHide: true }, cb);
}

export function spawnCli(bin, args, opts = {}) {
  const c = commandLine(bin, args);
  return spawn(c.file, c.args, { ...opts, ...c.options, windowsHide: true });
}

// The names a command can have on this system: `claude` on macOS and Linux; `claude.exe`
// (Anthropic's installer, the editors' copy) and `claude.cmd` (npm) on Windows.
export function commandNames(name, { platform = process.platform } = {}) {
  return platform === 'win32' ? [`${name}.exe`, `${name}.cmd`, `${name}.bat`] : [name];
}

// Present and runnable. Windows has no execute bit, so there it is enough that the file exists.
export function isRunnable(file, { platform = process.platform } = {}) {
  try {
    if (!fs.statSync(file).isFile()) return false;
    if (platform !== 'win32') fs.accessSync(file, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------- links and paths

// Opens a link (a web page, or a vscode:// link) with whatever this system uses for links.
export function openExternal(url, { platform = process.platform } = {}) {
  const [cmd, args] = platform === 'darwin' ? ['open', [url]] : platform === 'win32' ? ['explorer.exe', [url]] : ['xdg-open', [url]];
  try {
    const child = spawn(cmd, args, { stdio: 'ignore', detached: true, windowsHide: true });
    child.on('error', () => { /* best effort */ });
    child.unref();
    return true;
  } catch {
    return false;
  }
}

// The path part of a vscode://file link: "/Users/me/app" stays; "C:\Users\me\app" becomes
// "/C:/Users/me/app".
export function fileLinkPath(p) {
  const s = String(p || '');
  if (/^[A-Za-z]:[\\/]/.test(s)) return `/${s.replace(/\\/g, '/')}`;
  return s.replace(/\\/g, '/');
}

// Two folders are the same project when one holds the other. Windows paths ignore case and
// accept either slash.
export function sameFolder(a, b, { platform = process.platform } = {}) {
  const norm = (p) => {
    let s = String(p || '');
    if (platform === 'win32' || /^[A-Za-z]:[\\/]/.test(s)) s = s.replace(/\\/g, '/').toLowerCase();
    return s.replace(/\/+$/, '');
  };
  const x = norm(a);
  const y = norm(b);
  if (!x || !y) return false;
  return x === y || x.startsWith(`${y}/`) || y.startsWith(`${x}/`);
}

// The last part of a path, whichever slash it uses.
export function baseName(p) {
  return String(p || '').split(/[\\/]/).filter(Boolean).pop() || '';
}
