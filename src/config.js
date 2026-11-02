import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';

export const DEFAULT_PORT = 4877;

export const DEFAULT_SETTINGS = {
  port: DEFAULT_PORT,
  // Show only chats from VS Code, Cursor and other editors (and chats Kroog can't place).
  ideOnly: false,
  // How long Kroog holds a permission request for your answer before VS Code asks you instead.
  // 0 means "only show it here, answer in the editor".
  permissionHoldSeconds: 30,
  // How long a chat in Drive mode waits for your next message after it finishes a turn.
  driveMinutes: 5,
  notesEnabled: true,
  // Which editor to open when Kroog can't tell: 'vscode', 'cursor', 'vscode-insiders', 'windsurf'.
  defaultEditor: 'vscode',
  // Where Claude Code is. Empty: Kroog looks for it (Terminal install, or the copy inside
  // the VS Code or Cursor extension).
  claudePath: '',
  // Chats Kroog runs: 'default' asks you in Kroog before edits and commands;
  // 'acceptEdits' lets them edit files without asking (commands still ask).
  kroogPermissionMode: 'default',
  // The AI helper for summaries, briefs and notes: 'auto', 'claude', 'api', 'ollama', 'off'.
  aiProvider: 'auto',
  // When to summarise a chat: 'finish' (after each turn), 'hover' (only when you look), 'off'.
  aiSummaries: 'finish',
  aiDailyLimit: 200,
  aiClaudeModel: 'haiku',
  ollamaModel: 'llama3.2',
  ollamaUrl: 'http://127.0.0.1:11434',
};

export function kroogHome() {
  return process.env.KROOG_HOME || path.join(os.homedir(), '.kroog');
}

// Kroog was called Crew before. Its folder was ~/.crew; move it over once, so your notes,
// chats, token and settings carry on. Returns true when it moved something.
export function migrateFromCrew() {
  if (process.env.KROOG_HOME) return false;
  const oldHome = path.join(os.homedir(), '.crew');
  const home = kroogHome();
  if (fs.existsSync(home) || !fs.existsSync(oldHome)) return false;
  try {
    fs.renameSync(oldHome, home);
    return true;
  } catch {
    return false;
  }
}

export function claudeDir() {
  return process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude');
}

export function paths() {
  const home = kroogHome();
  return {
    home,
    token: path.join(home, 'token'),
    config: path.join(home, 'config.json'),
    state: path.join(home, 'state.json'),
    env: path.join(home, '.env'),
    hookScript: path.join(home, 'hook.sh'),
    inboxes: path.join(home, 'inboxes.json'),
    usage: path.join(home, 'usage.jsonl'),
    backups: path.join(home, 'backups'),
    claudeSettings: path.join(claudeDir(), 'settings.json'),
  };
}

export function ensureHome() {
  const p = paths();
  fs.mkdirSync(p.home, { recursive: true, mode: 0o700 });
  fs.mkdirSync(p.backups, { recursive: true, mode: 0o700 });
  if (!fs.existsSync(p.token)) {
    fs.writeFileSync(p.token, crypto.randomBytes(24).toString('hex'), { mode: 0o600 });
  }
  return p;
}

export function readToken() {
  return fs.readFileSync(paths().token, 'utf8').trim();
}

export function loadSettings() {
  try {
    const saved = JSON.parse(fs.readFileSync(paths().config, 'utf8'));
    // Renamed setting from when Kroog was called Crew.
    if (saved.crewPermissionMode && !saved.kroogPermissionMode) saved.kroogPermissionMode = saved.crewPermissionMode;
    // Renamed setting from when Kroog was called Crew.
    if (saved.crewPermissionMode && !saved.kroogPermissionMode) saved.kroogPermissionMode = saved.crewPermissionMode;
    return { ...DEFAULT_SETTINGS, ...saved };
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

export function saveSettings(settings) {
  ensureHome();
  fs.writeFileSync(paths().config, JSON.stringify(settings, null, 2) + '\n', { mode: 0o600 });
}

// The API key lives only in ~/.kroog/.env. Kroog reads it into memory for its own note
// requests and never puts it in process.env, so it can't leak into Claude Code.
export function readApiKey() {
  try {
    const text = fs.readFileSync(paths().env, 'utf8');
    const match = text.match(/^\s*ANTHROPIC_API_KEY\s*=\s*["']?([^"'\s]+)["']?\s*$/m);
    return match ? match[1] : null;
  } catch {
    return null;
  }
}

export function writeApiKey(key) {
  ensureHome();
  fs.writeFileSync(paths().env, `ANTHROPIC_API_KEY=${key}\n`, { mode: 0o600 });
  fs.chmodSync(paths().env, 0o600);
}

export function removeApiKey() {
  try {
    fs.unlinkSync(paths().env);
  } catch {
    // already gone
  }
}
