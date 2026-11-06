// Kroog's mod (a Claude Code plugin, in `mod/`): it sends the plan's usage windows and each
// chat's cost to Kroog. Installing it is one Claude Code command, run here on `link`, at the
// user scope. From a folder that stays put (a git clone, or an unzipped copy) it reads the
// mod from this folder, so `git pull` or a new copy updates it; from a copy npm or npx keeps
// in its own cache, it installs from the GitHub repository instead.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execCli } from './platform.js';
import { findClaude, cleanEnv } from './claude-cli.js';

export const MOD_NAME = 'kroog';
export const REMOTE = 'ishanyash/kroog';

export function repoRoot() {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
}

// A git clone keeps its path and updates with git pull; a copy from npx does neither.
export function isClone(root = repoRoot()) {
  return fs.existsSync(path.join(root, '.git'));
}

// Whether this folder stays where it is: a git clone or an unzipped copy does; npx's cache
// and npm's node_modules are managed by npm and can move or vanish.
export function isStableFolder(root = repoRoot()) {
  if (isClone(root)) return true;
  const parts = path.resolve(root).split(path.sep);
  return !parts.includes('_npx') && !parts.includes('node_modules');
}

function run(bin, args, { timeoutMs = 60000 } = {}) {
  return new Promise((resolve) => {
    execCli(bin, args, { timeout: timeoutMs, env: cleanEnv(), maxBuffer: 4 * 1024 * 1024 }, (error, stdout, stderr) => {
      resolve({ ok: !error, stdout: String(stdout || ''), stderr: String(stderr || ''), error: error ? error.message : '' });
    });
  });
}

// Which plugins Claude Code has installed at the user scope, as `claude plugin list` says.
export async function modStatus({ claudePath = '' } = {}) {
  const cli = findClaude(claudePath);
  if (!cli) return { installed: false, reason: 'Claude Code was not found.' };
  const r = await run(cli.path, ['plugin', 'list', '--json']);
  if (!r.ok) return { installed: false, reason: 'Could not list Claude Code plugins.', detail: (r.stderr || r.error).trim().slice(0, 200) };
  let list = null;
  try { list = JSON.parse(r.stdout.trim()); } catch { list = null; }
  const items = Array.isArray(list) ? list : Array.isArray(list && list.plugins) ? list.plugins : [];
  const mine = items.find((p) => String(p.id || '').startsWith(`${MOD_NAME}@`));
  if (!mine) return { installed: false, reason: 'The mod is not installed.' };
  const folder = mine.readFromFolder || '';
  // "current": installed from this clone's folder. Unknown (null) for an install from GitHub.
  const current = folder ? path.resolve(folder) === path.join(repoRoot(), 'mod') : null;
  return { installed: true, version: mine.folderVersion || mine.version || '', from: folder || mine.installPath || '', enabled: mine.enabled !== false, current };
}

// Installs (or re-installs) the mod from this folder, with the port Kroog runs on.
export async function installMod({ claudePath = '', port = 4877, source = '' } = {}) {
  const cli = findClaude(claudePath);
  if (!cli) return { ok: false, error: 'Claude Code was not found, so the mod could not be installed. Install it for the Terminal, or run the line from Setup.' };
  const root = repoRoot();
  const from = source || (isStableFolder(root) ? root : REMOTE);
  if (from === root && !fs.existsSync(path.join(root, '.claude-plugin', 'marketplace.json'))) return { ok: false, error: `No marketplace file in ${root}.` };
  const r = await run(cli.path, ['plugin', 'install', MOD_NAME, '--marketplace', from, '--scope', 'user', '--config', `port=${port}`, '--json'], { timeoutMs: 120000 });
  let out = null;
  try { out = JSON.parse(r.stdout.trim().split('\n').pop() || 'null'); } catch { out = null; }
  const where = from === root ? `${root}/mod` : `github.com/${from}`;
  if (out && out.outcome === 'ok') return { ok: true, message: `The Kroog mod is installed from ${where}. Chats started from now on send their usage; open chats do after a restart or /reload-plugins.` };
  return { ok: false, error: (out && out.message) || (r.stderr || r.error || r.stdout).trim().slice(0, 300) || 'The install did not finish.' };
}

export async function uninstallMod({ claudePath = '' } = {}) {
  const cli = findClaude(claudePath);
  if (!cli) return { ok: false, error: 'Claude Code was not found.' };
  const r = await run(cli.path, ['plugin', 'uninstall', `${MOD_NAME}@${MOD_NAME}`, '--json']);
  await run(cli.path, ['plugin', 'marketplace', 'remove', MOD_NAME]);
  return r.ok ? { ok: true } : { ok: false, error: (r.stderr || r.error).trim().slice(0, 200) };
}

// The kroog-brain tool (added from the brain page) is a user-scope MCP server in Claude Code.
export async function removeBrainTool({ claudePath = '' } = {}) {
  const cli = findClaude(claudePath);
  if (!cli) return { ok: false };
  const r = await run(cli.path, ['mcp', 'remove', '--scope', 'user', 'kroog-brain']);
  return { ok: true, removed: r.ok };
}

// The line to run in the Terminal when the install above cannot run.
export function installLine({ remote = REMOTE } = {}) {
  return `claude plugin install ${MOD_NAME} --marketplace ${remote}`;
}

// The same from inside a chat: add the marketplace, then install from it.
export function chatInstallLines({ remote = REMOTE } = {}) {
  return [`/plugin marketplace add ${remote}`, `/plugin install ${MOD_NAME}@${MOD_NAME}`];
}
