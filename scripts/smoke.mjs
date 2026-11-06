// An end-to-end check that needs no Claude login, for CI on macOS, Linux and Windows:
// link Kroog to a throwaway Claude Code config, start it, run the hook commands `link`
// wrote the way Claude Code runs them (Git Bash and PowerShell on Windows, sh elsewhere),
// check Kroog saw each one, then stop and unlink. With Claude Code installed, `link` also
// installs the usage mod through it (on Windows that is npm's claude.cmd).
//
//   node scripts/smoke.mjs
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const bin = path.join(root, 'bin', 'kroog.js');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kroog-smoke-'));
// A port the system lets us use (Windows reserves whole ranges of high ports).
const port = await new Promise((resolve, reject) => {
  const s = net.createServer();
  s.on('error', reject);
  s.listen(0, '127.0.0.1', () => { const { port: p } = s.address(); s.close(() => resolve(p)); });
});
const env = { ...process.env, KROOG_HOME: path.join(tmp, 'kroog'), CLAUDE_CONFIG_DIR: path.join(tmp, 'claude') };
for (const k of Object.keys(env)) if (/^(CLAUDE_CODE_(SESSION_|MESSAGING_|ENTRYPOINT)|CLAUDECODE$)/.test(k)) delete env[k];
const project = path.join(tmp, 'shop');
fs.mkdirSync(project, { recursive: true });

const failures = [];
const check = (ok, what, detail = '') => {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${what}${detail ? `: ${detail}` : ''}`);
  if (!ok) failures.push(what);
};
const kroog = (args, opts = {}) => spawnSync(process.execPath, [bin, ...args], { env, encoding: 'utf8', timeout: 180000, ...opts });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function claudeOnPath() {
  const names = process.platform === 'win32' ? ['claude.cmd', 'claude.exe'] : ['claude'];
  for (const dir of String(process.env.PATH || '').split(path.delimiter)) for (const n of names) if (dir && fs.existsSync(path.join(dir, n))) return path.join(dir, n);
  return null;
}

// The shells Claude Code would use for a hook command on this system.
function shells(handler) {
  if (process.platform !== 'win32') return [['sh', '/bin/sh', ['-c']]];
  const list = [];
  const gitBash = ['C:\\Program Files\\Git\\bin\\bash.exe', 'C:\\Program Files (x86)\\Git\\bin\\bash.exe'].find((f) => fs.existsSync(f));
  if (gitBash && handler.shell !== 'powershell') list.push(['Git Bash', gitBash, ['-c']]);
  list.push(['PowerShell', 'powershell.exe', ['-NoProfile', '-NonInteractive', '-Command']]);
  return list;
}

async function main() {
  console.log(`Kroog smoke test on ${process.platform}, Node ${process.version}, port ${port}`);
  const withMod = Boolean(claudeOnPath());

  // 1. link
  const linked = kroog(['link', '--port', String(port), ...(withMod ? [] : ['--no-mod'])]);
  check(linked.status === 0, 'link', (linked.stdout + linked.stderr).trim().split('\n').slice(-2).join(' | '));
  const settingsFile = path.join(env.CLAUDE_CONFIG_DIR, 'settings.json');
  const settings = JSON.parse(fs.readFileSync(settingsFile, 'utf8'));
  const handler = (settings.hooks.UserPromptSubmit || [])[0].hooks[0];
  check(Boolean(handler && handler.command), 'hooks written', JSON.stringify(handler));
  if (process.platform === 'win32') check(/hook\.mjs/.test(handler.command), 'Windows uses the Node relay');

  // 2. start
  const child = spawn(process.execPath, [bin, 'start', '--port', String(port), '--no-open', '--no-import'], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '';
  child.stdout.on('data', (d) => { out += d; });
  child.stderr.on('data', (d) => { out += d; });
  for (let i = 0; i < 150 && !out.includes('Open it with its key'); i += 1) await sleep(100);
  check(out.includes('Open it with its key'), 'start', out.trim().split('\n')[0]);
  const token = fs.readFileSync(path.join(env.KROOG_HOME, 'token'), 'utf8').trim();

  // 3. each hook command, as Claude Code would run it
  for (const [name, shell, flags] of shells(handler)) {
    const sid = `smoke-${name.toLowerCase().replace(/\W+/g, '-')}`;
    const payload = JSON.stringify({ session_id: sid, cwd: project, prompt: `hello from ${name}`, hook_event_name: 'UserPromptSubmit' });
    const r = spawnSync(shell, [...flags, handler.command], { input: payload, env: { ...env, CLAUDE_CODE_ENTRYPOINT: 'cli' }, encoding: 'utf8', timeout: 60000, cwd: project });
    check(r.status === 0, `hook runs in ${name}`, (r.stderr || '').trim().slice(0, 200));
  }
  await sleep(800);
  const state = await (await fetch(`http://127.0.0.1:${port}/api/state`, { headers: { 'X-Kroog-Token': token } })).json();
  const sessions = Array.isArray(state.sessions) ? state.sessions : Object.values(state.sessions || {});
  for (const [name] of shells(handler)) {
    const sid = `smoke-${name.toLowerCase().replace(/\W+/g, '-')}`;
    const s = sessions.find((x) => x.id === sid);
    check(Boolean(s) && s.title === `hello from ${name}` && s.project === 'shop', `Kroog saw the chat from ${name}`, s ? `${s.title} in ${s.project}` : 'not found');
  }
  check((await fetch(`http://127.0.0.1:${port}/api/state`)).status === 401, 'the API needs the key');

  // 4. the mod, through Claude Code (claude.cmd on Windows)
  if (withMod) {
    const listed = spawnSync(claudeOnPath(), ['plugin', 'list', '--json'], { env, encoding: 'utf8', timeout: 60000, shell: process.platform === 'win32' });
    check(/kroog@kroog/.test(listed.stdout || ''), 'link installed the mod through Claude Code', (listed.stdout || listed.stderr || '').trim().slice(0, 160));
  } else console.log('skip mod: Claude Code is not installed here');

  // 5. stop, then unlink
  const stopped = kroog(['stop', '--port', String(port)]);
  check(/Stopped Kroog/.test(stopped.stdout), 'stop', stopped.stdout.trim().split('\n').pop());
  await sleep(500);
  let free = false;
  try { await fetch(`http://127.0.0.1:${port}/api/who`); } catch { free = true; }
  check(free, 'the port is free after stop');
  try { child.kill(); } catch { /* already stopped */ }
  const unlinked = kroog(['unlink']);
  const after = JSON.parse(fs.readFileSync(settingsFile, 'utf8'));
  check(unlinked.status === 0 && !JSON.stringify(after).includes('.kroog'), 'unlink removes the hooks');

  console.log(failures.length ? `\n${failures.length} failed: ${failures.join(', ')}` : '\nAll smoke checks passed.');
  process.exit(failures.length ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
