// Links Kroog to Claude Code by adding a few hooks to ~/.claude/settings.json.
// Every Claude Code chat on this computer (VS Code, Cursor, terminal) reads that file, so no
// editor plugin is needed. Each hook runs a small relay that forwards the event to Kroog on
// 127.0.0.1 and prints Kroog's answer; if Kroog isn't running, it prints nothing. The relay
// is ~/.kroog/hook.sh (sh and curl) on macOS and Linux, and ~/.kroog/hook.mjs (Node, which
// Kroog needs anyway) on Windows, or anywhere curl is missing. Claude Code runs hook
// commands with Git Bash or PowerShell on Windows; `node "<path>" <Event>` reads the same
// in both.

import fs from 'node:fs';
import path from 'node:path';
import { ensureHome, paths, DEFAULT_PORT } from './config.js';
import { commandNames, isRunnable } from './platform.js';

export const HOOK_EVENTS = [
  { event: 'SessionStart', timeout: 10 },
  { event: 'UserPromptSubmit', timeout: 30 },
  { event: 'PreToolUse', matcher: '*', timeout: 30 },
  { event: 'PermissionRequest', matcher: '*', timeout: 600 },
  { event: 'PostToolUse', matcher: '*', timeout: 30 },
  { event: 'PostToolUseFailure', matcher: '*', timeout: 30 },
  { event: 'Notification', matcher: '*', timeout: 10 },
  { event: 'Stop', timeout: 600 },
  { event: 'StopFailure', timeout: 10 },
  { event: 'SubagentStart', matcher: '*', timeout: 10 },
  { event: 'SubagentStop', matcher: '*', timeout: 10 },
  { event: 'SessionEnd', timeout: 5 },
];

const MARKER = '/.kroog/hook.sh';
const NODE_MARKER = '/.kroog/hook.mjs';
// Hooks written when Kroog was called Crew.
const OLD_MARKER = '/.crew/hook.sh';
const fwd = (p) => String(p || '').replace(/\\/g, '/');

function shQuote(value) {
  return `'${String(value).replace(/'/g, `'\\''`)}'`;
}

export function hookScript({ port = DEFAULT_PORT, tokenPath }) {
  return `#!/bin/sh
# Kroog hook relay, written by \`kroog link\`. Safe to delete with \`kroog unlink\`.
# Claude Code runs this for each event in your chats. It forwards the event to the
# Kroog app on this computer (127.0.0.1 only) and prints Kroog's answer. If Kroog isn't
# running, it prints nothing and exits 0, so your chat carries on as before.
EVENT="$1"
TOKEN=$(cat ${shQuote(tokenPath)} 2>/dev/null)
curl -sf --connect-timeout 1 --max-time 590 -X POST \\
  -H "Content-Type: application/json" \\
  -H "X-Kroog-Token: $TOKEN" \\
  -H "X-Kroog-Entry: \${CLAUDE_CODE_ENTRYPOINT:-}" \\
  -H "X-Kroog-Bundle: \${__CFBundleIdentifier:-}" \\
  -H "X-Kroog-Term: \${TERM_PROGRAM:-}" \\
  -H "X-Kroog-Inbox: \${CLAUDE_CODE_MESSAGING_SOCKET:-}" \\
  -H "X-Kroog-Inbox-Token: \${CLAUDE_CODE_MESSAGING_TOKEN:-}" \\
  --data-binary @- "http://127.0.0.1:${port}/hook/$EVENT" 2>/dev/null
exit 0
`;
}

// The same relay in Node, for Windows (and anywhere curl is missing). It reads the event
// from Claude Code on stdin, forwards it with the same headers, prints Kroog's answer, and
// always exits 0 so a chat never waits on Kroog.
export function hookNodeScript({ port = DEFAULT_PORT, tokenPath }) {
  return `// Kroog hook relay, written by \`kroog link\`. Safe to delete with \`kroog unlink\`.
// Claude Code runs this for each event in your chats. It forwards the event to the Kroog
// app on this computer (127.0.0.1 only) and prints Kroog's answer. If Kroog isn't running,
// it prints nothing and exits 0, so your chat carries on as before.
import fs from 'node:fs';
const TOKEN_PATH = ${JSON.stringify(tokenPath)};
const URL_BASE = 'http://127.0.0.1:${Number(port)}/hook/';
const event = String(process.argv[2] || '').replace(/[^A-Za-z]/g, '');
const clean = (v) => String(v || '').replace(/[^\\x20-\\x7e]/g, '');
let token = '';
try { token = fs.readFileSync(TOKEN_PATH, 'utf8').trim(); } catch { /* not linked */ }
const chunks = [];
for await (const chunk of process.stdin) chunks.push(chunk);
try {
  const res = await fetch(URL_BASE + event, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Kroog-Token': token,
      'X-Kroog-Entry': clean(process.env.CLAUDE_CODE_ENTRYPOINT),
      'X-Kroog-Bundle': clean(process.env.__CFBundleIdentifier),
      'X-Kroog-Term': clean(process.env.TERM_PROGRAM),
      'X-Kroog-Inbox': clean(process.env.CLAUDE_CODE_MESSAGING_SOCKET),
      'X-Kroog-Inbox-Token': clean(process.env.CLAUDE_CODE_MESSAGING_TOKEN),
    },
    body: Buffer.concat(chunks),
    signal: AbortSignal.timeout(590000),
  });
  if (res.ok) process.stdout.write(await res.text());
} catch { /* Kroog is not running */ }
process.exit(0);
`;
}

function onPath(name, env = process.env) {
  for (const dir of String(env.PATH || '').split(path.delimiter).filter(Boolean)) {
    for (const n of commandNames(name)) if (isRunnable(path.join(dir, n))) return path.join(dir, n);
  }
  return null;
}

// Which relay this computer gets: the sh one where sh and curl are there, the Node one
// otherwise (always on Windows).
export function relayKind({ platform = process.platform, hasCurl = null, force = process.env.KROOG_RELAY } = {}) {
  if (platform === 'win32') return 'node';
  if (force === 'node' || force === 'sh') return force;
  const curl = hasCurl === null ? Boolean(onPath('curl')) : hasCurl;
  return curl ? 'sh' : 'node';
}

// The hook's command line. Node by name when it is on the PATH (Claude Code finds it the
// same way), else by its full path; on Windows a full path with spaces needs PowerShell's
// call operator, so that hook says it runs in PowerShell.
export function hookCommand({ kind, scriptPath, event, platform = process.platform, nodeOnPath = null, nodePath = process.execPath }) {
  if (kind === 'sh') return { command: `/bin/sh ${shQuote(scriptPath)} ${event}` };
  const script = fwd(scriptPath);
  const byName = nodeOnPath === null ? Boolean(onPath('node')) : nodeOnPath;
  if (platform === 'win32') {
    if (byName) return { command: `node "${script}" ${event}` };
    return { shell: 'powershell', command: `& "${fwd(nodePath)}" "${script}" ${event}` };
  }
  return { command: `${byName ? 'node' : shQuote(nodePath)} ${shQuote(scriptPath)} ${event}` };
}

function readSettings(file) {
  if (!fs.existsSync(file)) return { exists: false, data: {} };
  const raw = fs.readFileSync(file, 'utf8');
  if (!raw.trim()) return { exists: true, data: {} };
  try {
    return { exists: true, data: JSON.parse(raw) };
  } catch (error) {
    const err = new Error(`Couldn't read ${file}: it isn't valid JSON (${error.message}). Fix it, then run link again. Nothing was changed.`);
    err.code = 'BAD_SETTINGS';
    throw err;
  }
}

function isKroogHandler(handler, scriptPath = paths().hookScript) {
  if (!handler || handler.type !== 'command' || typeof handler.command !== 'string') return false;
  const c = fwd(handler.command);
  const p = paths();
  return [MARKER, NODE_MARKER, OLD_MARKER, fwd(scriptPath), fwd(p.hookScript), fwd(p.hookNode)].some((m) => m && c.includes(m));
}

// True when Claude Code's settings still point at the old ~/.crew/hook.sh.
export function hasOldCrewHooks() {
  try {
    const { data } = readSettings(paths().claudeSettings);
    return Object.values(data.hooks || {}).some((groups) => (groups || []).some((g) => (g.hooks || []).some((h) => typeof h.command === 'string' && h.command.includes(OLD_MARKER))));
  } catch {
    return false;
  }
}

export function withoutKroogHooks(settings) {
  const next = JSON.parse(JSON.stringify(settings || {}));
  if (!next.hooks || typeof next.hooks !== 'object') return next;
  const scriptPath = paths().hookScript;
  for (const event of Object.keys(next.hooks)) {
    const groups = Array.isArray(next.hooks[event]) ? next.hooks[event] : [];
    const kept = groups
      .map((group) => ({ ...group, hooks: (group.hooks || []).filter((h) => !isKroogHandler(h, scriptPath)) }))
      .filter((group) => group.hooks.length > 0);
    if (kept.length) next.hooks[event] = kept;
    else delete next.hooks[event];
  }
  if (Object.keys(next.hooks).length === 0) delete next.hooks;
  return next;
}

export function withKroogHooks(settings, scriptPath, { kind = 'sh', platform = process.platform, nodeOnPath = null } = {}) {
  const next = withoutKroogHooks(settings);
  next.hooks = next.hooks || {};
  for (const def of HOOK_EVENTS) {
    const group = {};
    if (def.matcher !== undefined) group.matcher = def.matcher;
    group.hooks = [{ type: 'command', ...hookCommand({ kind, scriptPath, event: def.event, platform, nodeOnPath }), timeout: def.timeout }];
    next.hooks[def.event] = [...(next.hooks[def.event] || []), group];
  }
  return next;
}

function backup(file, exists) {
  const p = paths();
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const target = path.join(p.backups, `settings-${stamp}.json`);
  if (exists) fs.copyFileSync(file, target);
  else fs.writeFileSync(target, '// settings.json did not exist before Kroog linked\n');
  return target;
}

function writeJson(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.kroog-tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2) + '\n');
  fs.renameSync(tmp, file);
}

export function link({ port = DEFAULT_PORT } = {}) {
  const p = ensureHome();
  const { exists, data } = readSettings(p.claudeSettings);
  const kind = relayKind();
  // Both relays are written, so switching later (curl installed, a move to another system's
  // shell) needs only another `link`.
  fs.writeFileSync(p.hookScript, hookScript({ port, tokenPath: p.token }), { mode: 0o755 });
  try { fs.chmodSync(p.hookScript, 0o755); } catch { /* Windows has no execute bit */ }
  fs.writeFileSync(p.hookNode, hookNodeScript({ port, tokenPath: p.token }), { mode: 0o644 });
  const scriptPath = kind === 'node' ? p.hookNode : p.hookScript;
  const backupPath = backup(p.claudeSettings, exists);
  writeJson(p.claudeSettings, withKroogHooks(data, scriptPath, { kind }));
  return { settingsPath: p.claudeSettings, backupPath, scriptPath, relay: kind, events: HOOK_EVENTS.map((e) => e.event) };
}

// Keep the relay script up to date (for example when a new Kroog version adds a header),
// without touching Claude Code's settings. Only when Kroog is linked on this port.
export function refreshScript({ port = DEFAULT_PORT } = {}) {
  const p = paths();
  let changed = false;
  for (const [file, make, mode] of [[p.hookScript, hookScript, 0o755], [p.hookNode, hookNodeScript, 0o644]]) {
    if (!fs.existsSync(file)) continue;
    const current = fs.readFileSync(file, 'utf8');
    const m = current.match(/127\.0\.0\.1:(\d+)/);
    if (!m || Number(m[1]) !== Number(port)) continue;
    const next = make({ port, tokenPath: p.token });
    if (next === current) continue;
    fs.writeFileSync(file, next, { mode });
    changed = true;
  }
  return changed;
}

export function unlink() {
  const p = paths();
  const { exists, data } = readSettings(p.claudeSettings);
  if (!exists) return { settingsPath: p.claudeSettings, changed: false };
  const cleaned = withoutKroogHooks(data);
  const changed = JSON.stringify(cleaned) !== JSON.stringify(data);
  let backupPath = null;
  if (changed) {
    backupPath = backup(p.claudeSettings, true);
    writeJson(p.claudeSettings, cleaned);
  }
  return { settingsPath: p.claudeSettings, changed, backupPath };
}

export function linkStatus() {
  const p = paths();
  try {
    const { data } = readSettings(p.claudeSettings);
    const linkedEvents = [];
    let usesNode = false;
    for (const [event, groups] of Object.entries(data.hooks || {})) {
      const mine = (groups || []).flatMap((g) => (g.hooks || []).filter((h) => isKroogHandler(h, p.hookScript)));
      if (mine.length) linkedEvents.push(event);
      if (mine.some((h) => fwd(h.command).includes('hook.mjs'))) usesNode = true;
    }
    const scriptPath = usesNode ? p.hookNode : p.hookScript;
    const scriptOk = fs.existsSync(scriptPath);
    let scriptPort = null;
    if (scriptOk) {
      const m = fs.readFileSync(scriptPath, 'utf8').match(/127\.0\.0\.1:(\d+)/);
      scriptPort = m ? Number(m[1]) : null;
    }
    return {
      linked: linkedEvents.length === HOOK_EVENTS.length && scriptOk,
      partial: linkedEvents.length > 0 && linkedEvents.length < HOOK_EVENTS.length,
      linkedEvents,
      settingsPath: p.claudeSettings,
      scriptPath,
      relay: usesNode ? 'node' : 'sh',
      scriptPort,
      error: null,
    };
  } catch (error) {
    return { linked: false, partial: false, linkedEvents: [], settingsPath: p.claudeSettings, scriptPath: p.hookScript, scriptPort: null, error: error.message };
  }
}
