// Kroog's mod (a Claude Code plugin, in `mod/`): it sends the plan's usage windows and each
// chat's cost to Kroog. Installing it is one Claude Code command, run here on `link`, which
// reads the mod from this folder (so `git pull` updates it) at the user scope.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { findClaude, cleanEnv } from './claude-cli.js';

export const MOD_NAME = 'kroog';

export function repoRoot() {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
}

function run(bin, args, { timeoutMs = 60000 } = {}) {
  return new Promise((resolve) => {
    execFile(bin, args, { timeout: timeoutMs, env: cleanEnv(), maxBuffer: 4 * 1024 * 1024 }, (error, stdout, stderr) => {
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
  return { installed: true, version: mine.folderVersion || mine.version || '', from: mine.readFromFolder || mine.installPath || '', enabled: mine.enabled !== false, current: path.resolve(mine.readFromFolder || '') === path.join(repoRoot(), 'mod') };
}

// Installs (or re-installs) the mod from this folder, with the port Kroog runs on.
export async function installMod({ claudePath = '', port = 4877 } = {}) {
  const cli = findClaude(claudePath);
  if (!cli) return { ok: false, error: 'Claude Code was not found, so the mod could not be installed. Install it for the Terminal, or run the line from Setup in a chat.' };
  const root = repoRoot();
  if (!fs.existsSync(path.join(root, '.claude-plugin', 'marketplace.json'))) return { ok: false, error: `No marketplace file in ${root}.` };
  const r = await run(cli.path, ['plugin', 'install', MOD_NAME, '--marketplace', root, '--scope', 'user', '--config', `port=${port}`, '--json'], { timeoutMs: 120000 });
  let out = null;
  try { out = JSON.parse(r.stdout.trim().split('\n').pop() || 'null'); } catch { out = null; }
  if (out && out.outcome === 'ok') return { ok: true, message: `The Kroog mod is installed from ${root}/mod. Chats started from now on send their usage; open chats do after a restart or /reload-plugins.` };
  return { ok: false, error: (out && out.message) || (r.stderr || r.error || r.stdout).trim().slice(0, 300) || 'The install did not finish.' };
}

export async function uninstallMod({ claudePath = '' } = {}) {
  const cli = findClaude(claudePath);
  if (!cli) return { ok: false, error: 'Claude Code was not found.' };
  const r = await run(cli.path, ['plugin', 'uninstall', `${MOD_NAME}@${MOD_NAME}`, '--json']);
  await run(cli.path, ['plugin', 'marketplace', 'remove', MOD_NAME]);
  return r.ok ? { ok: true } : { ok: false, error: (r.stderr || r.error).trim().slice(0, 200) };
}

// The line to paste into a chat when the install above cannot run.
export function installLine({ remote = 'ishanyash/kroog' } = {}) {
  return `/plugin install ${MOD_NAME} --marketplace ${remote}`;
}
