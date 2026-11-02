// Finds and runs Claude Code's own command line on this computer, signed in with your usual
// Claude Code login (your subscription). Kroog uses it two ways:
//   - (in older versions, to run chats itself; Kroog no longer does), and
//   - for small model calls (summaries, briefs, notes) with Haiku, hooks off and no tools.
// The VS Code and Cursor extensions carry a private copy of the same program, so Kroog can
// use that copy when `claude` is not installed in the Terminal.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, execFile } from 'node:child_process';

// Claude Code sets these for the chats it runs. A program started from inside a chat must
// not inherit them, or it would think it is part of that chat.
const DROP_ENV = /^(CLAUDE_CODE_(CHILD_SESSION|SESSION_|REMOTE_SESSION|ENTRYPOINT|SSE_PORT|MESSAGING_)|CLAUDECODE$)/;

export function cleanEnv(extra = {}) {
  const env = {};
  for (const [k, v] of Object.entries(process.env)) if (!DROP_ENV.test(k)) env[k] = v;
  return { ...env, ...extra };
}

function isExec(file) {
  try {
    const st = fs.statSync(file);
    if (!st.isFile()) return false;
    fs.accessSync(file, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function versionKey(name) {
  const m = /(\d+)\.(\d+)\.(\d+)/.exec(name);
  return m ? Number(m[1]) * 1e8 + Number(m[2]) * 1e4 + Number(m[3]) : 0;
}

// The copy bundled inside an editor extension, newest version first.
function extensionCopies(home) {
  const found = [];
  for (const dir of ['.vscode/extensions', '.cursor/extensions', '.vscode-insiders/extensions', '.windsurf/extensions']) {
    const root = path.join(home, dir);
    let names = [];
    try { names = fs.readdirSync(root).filter((n) => n.startsWith('anthropic.claude-code')); } catch { continue; }
    names.sort((a, b) => versionKey(b) - versionKey(a));
    for (const n of names) {
      const base = path.join(root, n, 'resources');
      const tries = [path.join(base, 'native-binary', 'claude'), path.join(base, 'claude'), path.join(base, 'bin', 'claude')];
      // Fall back to a short search, in case the folder layout changes.
      try {
        for (const sub of fs.readdirSync(base)) {
          tries.push(path.join(base, sub, 'claude'));
        }
      } catch { /* no resources folder */ }
      for (const f of tries) if (isExec(f)) { found.push({ path: f, from: dir.split('/')[0].replace('.', '') }); break; }
    }
  }
  return found;
}

export function findClaude(preferred = '') {
  const home = os.homedir();
  const tries = [];
  if (preferred) tries.push({ path: preferred, from: 'setup' });
  for (const dir of String(process.env.PATH || '').split(path.delimiter).filter(Boolean)) tries.push({ path: path.join(dir, 'claude'), from: 'terminal' });
  for (const f of [path.join(home, '.local/bin/claude'), path.join(home, '.claude/local/claude'), '/opt/homebrew/bin/claude', '/usr/local/bin/claude', path.join(home, '.npm-global/bin/claude')]) tries.push({ path: f, from: 'terminal' });
  for (const t of tries) if (isExec(t.path)) return t;
  const ext = extensionCopies(home);
  return ext[0] || null;
}

export function claudeVersion(bin) {
  return new Promise((resolve) => {
    execFile(bin, ['--version'], { timeout: 15000, env: cleanEnv() }, (error, stdout) => {
      if (error) return resolve(null);
      const m = /(\d+\.\d+\.\d+)/.exec(String(stdout));
      resolve(m ? m[1] : String(stdout).trim().slice(0, 40));
    });
  });
}

// One small model call. Hooks are off, so it never shows up in Kroog as a chat. No tools,
// no saved session, Claude Code's long system prompt replaced by a short one.
export function ask(bin, { system, prompt, model = 'haiku', timeoutMs = 90000 }) {
  return new Promise((resolve, reject) => {
    const args = ['-p', '--model', model, '--no-session-persistence', '--output-format', 'json', '--tools', '', '--strict-mcp-config', '--settings', '{"disableAllHooks":true}'];
    if (system) args.push('--system-prompt', system);
    const child = spawn(bin, args, { cwd: os.tmpdir(), env: cleanEnv({ KROOG_INTERNAL: '1' }), stdio: ['pipe', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    const timer = setTimeout(() => { child.kill('SIGTERM'); reject(new Error('Claude Code took too long to answer.')); }, timeoutMs);
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { err += d; });
    child.on('error', (e) => { clearTimeout(timer); reject(new Error(`Could not start Claude Code: ${e.message}`)); });
    child.on('close', (code) => {
      clearTimeout(timer);
      let data = null;
      try { data = JSON.parse(out); } catch { /* not json */ }
      if (!data) return reject(new Error(`Claude Code did not answer (exit ${code}). ${(err || out).trim().slice(0, 200)}`));
      if (data.is_error) return reject(new Error(`Claude Code: ${String(data.result || data.subtype || 'error').slice(0, 200)}`));
      resolve(String(data.result || ''));
    });
    child.stdin.end(String(prompt || ''));
  });
}

// A full chat turn, the same as typing into Claude Code, with its normal settings and
// hooks (so Kroog sees every step). mode: 'new' | 'resume' | 'fork'.
export function startTurn(bin, { mode, id, from, cwd, prompt, permissionMode = 'default', model = '' }) {
  const args = ['-p', '--output-format', 'stream-json', '--verbose'];
  if (mode === 'new') args.push('--session-id', id);
  else if (mode === 'resume') args.push('--resume', id);
  else if (mode === 'fork') args.push('--resume', from, '--fork-session', '--session-id', id);
  if (permissionMode && permissionMode !== 'default') args.push('--permission-mode', permissionMode);
  if (model) args.push('--model', model);
  const child = spawn(bin, args, { cwd, env: cleanEnv({ KROOG_RUN: '1' }), stdio: ['pipe', 'pipe', 'pipe'] });
  child.stdin.end(String(prompt || ''));
  return child;
}
