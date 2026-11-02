// Links Kroog to Claude Code by adding a few hooks to ~/.claude/settings.json.
// Every Claude Code chat on this computer (VS Code, Cursor, terminal) reads that file, so no
// editor plugin is needed. Each hook runs ~/.kroog/hook.sh, which forwards the event to
// Kroog on 127.0.0.1 and prints Kroog's answer. If Kroog isn't running, it prints nothing.

import fs from 'node:fs';
import path from 'node:path';
import { ensureHome, paths, DEFAULT_PORT } from './config.js';

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
// Hooks written when Kroog was called Crew.
const OLD_MARKER = '/.crew/hook.sh';

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
  return handler.command.includes(MARKER) || handler.command.includes(OLD_MARKER) || handler.command.includes(scriptPath);
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

export function withKroogHooks(settings, scriptPath) {
  const next = withoutKroogHooks(settings);
  next.hooks = next.hooks || {};
  for (const def of HOOK_EVENTS) {
    const group = {};
    if (def.matcher !== undefined) group.matcher = def.matcher;
    group.hooks = [{ type: 'command', command: `/bin/sh ${shQuote(scriptPath)} ${def.event}`, timeout: def.timeout }];
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
  fs.writeFileSync(p.hookScript, hookScript({ port, tokenPath: p.token }), { mode: 0o755 });
  fs.chmodSync(p.hookScript, 0o755);
  const backupPath = backup(p.claudeSettings, exists);
  writeJson(p.claudeSettings, withKroogHooks(data, p.hookScript));
  return { settingsPath: p.claudeSettings, backupPath, scriptPath: p.hookScript, events: HOOK_EVENTS.map((e) => e.event) };
}

// Keep the relay script up to date (for example when a new Kroog version adds a header),
// without touching Claude Code's settings. Only when Kroog is linked on this port.
export function refreshScript({ port = DEFAULT_PORT } = {}) {
  const p = paths();
  if (!fs.existsSync(p.hookScript)) return false;
  const current = fs.readFileSync(p.hookScript, 'utf8');
  const m = current.match(/127\.0\.0\.1:(\d+)/);
  if (!m || Number(m[1]) !== Number(port)) return false;
  const next = hookScript({ port, tokenPath: p.token });
  if (next === current) return false;
  fs.writeFileSync(p.hookScript, next, { mode: 0o755 });
  return true;
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
    for (const [event, groups] of Object.entries(data.hooks || {})) {
      if ((groups || []).some((g) => (g.hooks || []).some((h) => isKroogHandler(h, p.hookScript)))) linkedEvents.push(event);
    }
    const scriptOk = fs.existsSync(p.hookScript);
    let scriptPort = null;
    if (scriptOk) {
      const m = fs.readFileSync(p.hookScript, 'utf8').match(/127\.0\.0\.1:(\d+)/);
      scriptPort = m ? Number(m[1]) : null;
    }
    return {
      linked: linkedEvents.length === HOOK_EVENTS.length && scriptOk,
      partial: linkedEvents.length > 0 && linkedEvents.length < HOOK_EVENTS.length,
      linkedEvents,
      settingsPath: p.claudeSettings,
      scriptPath: p.hookScript,
      scriptPort,
      error: null,
    };
  } catch (error) {
    return { linked: false, partial: false, linkedEvents: [], settingsPath: p.claudeSettings, scriptPath: p.hookScript, scriptPort: null, error: error.message };
  }
}
