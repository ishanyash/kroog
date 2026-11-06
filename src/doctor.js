// `kroog doctor`: checks, in plain words, everything that has to be right for Kroog to see
// your chats and send messages into them. Each check says ok or what to do.
import fs from 'node:fs';
import { inboxPresent } from './platform.js';
import os from 'node:os';
import path from 'node:path';
import { paths, loadSettings, claudeDir } from './config.js';
import { linkStatus, hasOldCrewHooks } from './link.js';
import { findClaude, claudeVersion } from './claude-cli.js';
import { Presence } from './presence.js';
import { modStatus, installLine } from './mod.js';

// Claude Code gives each chat an inbox from this version on.
export const INBOX_VERSION = '2.1.224';

export function cmpVersion(a, b) {
  const pa = String(a || '0').split('.').map(Number);
  const pb = String(b || '0').split('.').map(Number);
  for (let i = 0; i < 3; i += 1) {
    if ((pa[i] || 0) !== (pb[i] || 0)) return (pa[i] || 0) - (pb[i] || 0);
  }
  return 0;
}

// Claude Code extensions installed in VS Code, Cursor and friends, newest first per editor.
export function editorExtensions(home = os.homedir()) {
  const out = [];
  for (const [editor, dir] of [['VS Code', '.vscode/extensions'], ['Cursor', '.cursor/extensions'], ['VS Code Insiders', '.vscode-insiders/extensions'], ['Windsurf', '.windsurf/extensions']]) {
    let names = [];
    try { names = fs.readdirSync(path.join(home, dir)); } catch { continue; }
    const versions = names.map((n) => /^anthropic\.claude-code-(\d+\.\d+\.\d+)/.exec(n)).filter(Boolean).map((m) => m[1]);
    versions.sort((a, b) => cmpVersion(b, a));
    if (versions.length) out.push({ editor, version: versions[0] });
  }
  return out;
}

async function running(port) {
  try {
    const r = await fetch(`http://127.0.0.1:${port}/api/state`, { signal: AbortSignal.timeout(1500) });
    return r.ok;
  } catch {
    return false;
  }
}

export async function doctor({ version = '' } = {}) {
  const p = paths();
  const settings = loadSettings();
  const checks = [];
  const ok = (what, detail = '') => checks.push({ ok: true, what, detail });
  const bad = (what, fix) => checks.push({ ok: false, what, fix });

  // 1. Linked, and the hook script is current.
  const link = linkStatus();
  if (link.error) bad('Claude Code settings could not be read', link.error);
  else if (link.linked) ok('Linked to Claude Code', link.settingsPath);
  else bad('Not linked to Claude Code', 'Run: node bin/kroog.js link');
  if (hasOldCrewHooks()) bad('Some hooks still point at the old ~/.crew folder', 'Run: node bin/kroog.js link');
  // The relay the hooks use: hook.sh (sh and curl), or hook.mjs (Node: Windows, or no curl).
  let script = '';
  try { script = fs.readFileSync(link.scriptPath || p.hookScript, 'utf8'); } catch { /* missing */ }
  if (!script) bad('The hook script is missing', 'Run: node bin/kroog.js link');
  else if (!script.includes('X-Kroog-Inbox')) bad('The hook script is from an older version, so chats can\'t tell Kroog their inbox', 'Start Kroog once (it updates the script), or run: node bin/kroog.js link');
  else ok(`The hook script passes each chat's inbox to Kroog (${link.relay === 'node' ? 'the Node relay' : 'sh and curl'})`);
  if (link.scriptPort && Number(link.scriptPort) !== Number(settings.port)) bad(`The hooks talk to port ${link.scriptPort}, but Kroog uses ${settings.port}`, `Run: node bin/kroog.js link --port ${settings.port}`);

  // 2. Kroog itself.
  if (await running(settings.port)) ok(`Kroog is running on port ${settings.port}`);
  else bad('Kroog is not running', 'Run: node bin/kroog.js start (and keep that window open)');

  // 3. Claude Code versions: the CLI Kroog uses, and the extension in each editor.
  const cli = findClaude(settings.claudePath || '');
  const cliVersion = cli ? await claudeVersion(cli.path) : null;
  if (cliVersion) ok(`Claude Code ${cliVersion} found (the AI helper uses it)`, cli.path);
  else bad('Claude Code was not found, so the AI helper cannot use Haiku on your plan', 'Install it (code.claude.com) or set its path in Setup');
  const exts = editorExtensions();
  // Terminal chats work without an editor; the extension is only needed to open chats from Kroog.
  if (!exts.length) ok('No Claude Code extension in VS Code or Cursor', 'Fine for terminal chats. To open chats from Kroog, install the Claude Code extension in your editor.');
  for (const e of exts) {
    if (cmpVersion(e.version, INBOX_VERSION) >= 0) ok(`${e.editor} has Claude Code ${e.version}, which has chat inboxes`);
    else bad(`${e.editor} has Claude Code ${e.version}, which is too old for messages from Kroog`, `Update the Claude Code extension to ${INBOX_VERSION} or newer`);
  }

  // 4. Claude Code's registry of open chats.
  const presence = new Presence({ dir: path.join(claudeDir(), 'sessions') });
  presence.refresh();
  if (presence.available) {
    const open = presence.all();
    const inEditors = open.filter((e) => e.entry === 'claude-vscode').length;
    if (open.length) ok(`Claude Code reports ${open.length} open chat${open.length === 1 ? '' : 's'} right now${inEditors ? ` (${inEditors} in an editor)` : ''}`, open.slice(0, 5).map((e) => `${e.busy ? 'busy' : 'idle'} · ${e.cwd}`).join('\n           '));
    else ok('Claude Code reports no open chats right now', 'Open one in VS Code and it shows up within seconds');
  } else {
    bad('Claude Code\'s registry of open chats was not found', 'Kroog then learns about a chat only when it does something. Update Claude Code if this stays.');
  }

  // 5. Inboxes Kroog knows, and recent hook events.
  let inboxes = {};
  try { inboxes = JSON.parse(fs.readFileSync(p.inboxes, 'utf8')); } catch { /* none */ }
  const known = Object.values(inboxes);
  const alive = known.filter((v) => inboxPresent(v.socket));
  const fromRegistry = presence.available ? presence.all().filter((e) => e.socket && e.token).length : 0;
  if (alive.length || fromRegistry) ok(`Kroog can message ${Math.max(alive.length, fromRegistry)} open chat${Math.max(alive.length, fromRegistry) === 1 ? '' : 's'} right now`);
  else if (presence.available) ok('No open chat to message right now', 'Open one in VS Code and Kroog can reach it within seconds');
  else bad('Kroog knows no open chat inbox yet', 'In VS Code, send any message in the chat once while Kroog runs. If it still does not show up, type /status in that chat: it needs a "Peer address" line.');
  let state = {};
  try { state = JSON.parse(fs.readFileSync(p.state, 'utf8')); } catch { /* none */ }
  const last = Object.values(state.lastEvents || {}).sort((a, b) => b - a)[0];
  if (last) ok(`Last event from a chat: ${Math.round((Date.now() - last) / 60000)} min ago`);
  else bad('No events from any chat yet', 'Use a chat in VS Code while Kroog runs');

  // 6. The mod that sends plan usage, and the last reading it sent.
  const mod = await modStatus({ claudePath: settings.claudePath || '' });
  if (mod.installed) ok(`The Kroog mod is installed (${mod.version}), so chats send their plan usage`, mod.from);
  else bad('The Kroog mod is not installed, so Kroog cannot show plan usage', `Run: node bin/kroog.js link. Or in the Terminal: ${installLine()}`);
  let lastReading = null;
  try {
    const lines = fs.readFileSync(p.usage, 'utf8').trim().split('\n');
    lastReading = JSON.parse(lines[lines.length - 1]);
  } catch { /* none */ }
  if (lastReading && lastReading.t) ok(`Last plan usage reading: ${Math.round((Date.now() - lastReading.t) / 60000)} min ago`, Object.entries(lastReading.windows || {}).map(([k, w]) => `${k.replace('_', ' ')} ${w.pct}%`).join(', ') || 'no windows in it (not a claude.ai plan?)');
  else if (mod.installed) ok('No plan usage reading yet', 'A chat sends one after its first reply (open chats after a restart or /reload-plugins)');

  return { version, checks, claudeDir: claudeDir(), home: p.home };
}

export function printDoctor(r) {
  console.log(`Kroog ${r.version} check-up\n`);
  for (const c of r.checks) {
    console.log(`${c.ok ? '  ok      ' : '  PROBLEM '} ${c.what}`);
    if (c.ok && c.detail) console.log(`           ${c.detail}`);
    if (!c.ok && c.fix) console.log(`           Fix: ${c.fix}`);
  }
  const problems = r.checks.filter((c) => !c.ok).length;
  console.log(problems ? `\n${problems} thing${problems === 1 ? '' : 's'} to fix.` : '\nAll good.');
  console.log(boundaryText(r));
}

// The boundary Kroog keeps (SECURITY.md), with this computer's paths filled in.
export function boundaryText(r) {
  const c = r.claudeDir;
  const h = r.home;
  return [
    '',
    'What Kroog touches on this computer:',
    `  reads    ${c}/projects (transcripts, memory), ${c}/sessions, ${c}/settings.json,`,
    `           ${c}/CLAUDE.md, AGENTS.md, rules, skills, agents, commands, plans, output-styles (text files only);`,
    `           each project's CLAUDE.md, AGENTS.md and .claude docs; the editors' Claude Code extension folders; ${h}`,
    `  writes   ${h}; hooks in Claude Code's settings (backed up first); the mod, and the kroog-brain tool if you add it;`,
    '           the clipboard when you ask. unlink removes the hooks, the mod and the tool.',
    '  network  listens on 127.0.0.1 only, and every request needs its token; out to api.anthropic.com only with your own key,',
    '           claude -p for the helper, Ollama at 127.0.0.1, and GitHub only when the mod installs outside a git clone',
    `  never    ${c}/.credentials.json, the Keychain, any .env but its own, your source files, other apps, telemetry`,
  ].join('\n');
}
