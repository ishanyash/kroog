// Which files feed the second brain. Markdown and plain text only, never settings,
// credentials, transcripts or caches.
import fs from 'node:fs';
import path from 'node:path';

export const MAX_FILE = 512 * 1024;
const TEXT_EXT = /\.(md|markdown|mdx|txt)$/i;
const SKIP_DIR = new Set(['node_modules', '.git', 'shell-snapshots', 'cache', 'statsig', 'todos', 'ide', 'session-env', 'sessions', 'backups', 'file-history', 'tool-results', 'subagents', 'debug', 'telemetry', 'downloads']);
const SKIP_FILE = /^(settings.*\.json|\.credentials.*|\.env.*)$/i;

// A file is never indexed when it looks private or machine-made.
export function excluded(file) {
  const base = path.basename(file);
  if (SKIP_FILE.test(base)) return true;
  if (/\.jsonl$/i.test(base)) return true;
  // Folders are skipped while walking (see walk), so a project that happens to live in a
  // folder called "cache" is still fine.
  return false;
}

// Walk a folder for text files, following symlinks that stay readable, without loops.
export function walk(root, { maxDepth = 8, filter = () => true } = {}) {
  const out = [];
  const seen = new Set();
  const visit = (dir, depth) => {
    if (depth > maxDepth) return;
    let real;
    try { real = fs.realpathSync(dir); } catch { return; }
    if (seen.has(real)) return;
    seen.add(real);
    let names = [];
    try { names = fs.readdirSync(dir); } catch { return; }
    for (const name of names) {
      const full = path.join(dir, name);
      let st;
      try { st = fs.statSync(full); } catch { continue; }
      if (st.isDirectory()) {
        if (SKIP_DIR.has(name)) continue;
        if (name === 'plugins') continue;
        visit(full, depth + 1);
      } else if (st.isFile() && TEXT_EXT.test(name) && st.size <= MAX_FILE && !excluded(full) && filter(full)) {
        out.push({ path: full, mtime: st.mtimeMs, size: st.size });
      }
    }
  };
  visit(root, 0);
  return out;
}

function fileInfo(p) {
  try {
    const st = fs.statSync(p);
    if (!st.isFile() || st.size > MAX_FILE) return null;
    return { path: p, mtime: st.mtimeMs, size: st.size };
  } catch {
    return null;
  }
}

function folderName(p) {
  return String(p || '').split(/[\\/]/).filter(Boolean).pop() || p;
}

// Claude Code names a project's folder under ~/.claude/projects after its path, with
// every / and . turned into -. Make a readable label from it.
function projectFromMemoryDir(name, projects) {
  for (const cwd of projects) {
    if (cwd.replace(/[^A-Za-z0-9]/g, '-') === name) return folderName(cwd);
  }
  // Same project folder name as one of your chats, for example after a move.
  for (const cwd of projects) {
    const label = folderName(cwd);
    if (name.endsWith(`-${label.replace(/[^A-Za-z0-9]/g, '-')}`)) return label;
  }
  const bits = name.split('-').filter(Boolean);
  return bits.slice(-2).join('-') || name;
}

// Every source file, with its kind and project label.
export function listSources({ claudeDir, projects = [] }) {
  const files = new Map();
  const add = (info, kind, project) => {
    if (!info || files.has(info.path) || excluded(info.path)) return;
    files.set(info.path, { ...info, kind, project });
  };
  const user = 'all projects';
  if (claudeDir && fs.existsSync(claudeDir)) {
    add(fileInfo(path.join(claudeDir, 'CLAUDE.md')), 'instructions', user);
    add(fileInfo(path.join(claudeDir, 'AGENTS.md')), 'instructions', user);
    const dirs = [['rules', 'instructions'], ['skills', 'skill'], ['agents', 'agent'], ['commands', 'command'], ['plans', 'plan'], ['output-styles', 'instructions']];
    for (const [d, kind] of dirs) {
      const root = path.join(claudeDir, d);
      if (fs.existsSync(root)) for (const f of walk(root)) add(f, kind, user);
    }
    const projRoot = path.join(claudeDir, 'projects');
    let names = [];
    try { names = fs.readdirSync(projRoot); } catch { /* none */ }
    for (const name of names) {
      const mem = path.join(projRoot, name, 'memory');
      if (!fs.existsSync(mem)) continue;
      const label = projectFromMemoryDir(name, projects);
      for (const f of walk(mem, { maxDepth: 4 })) add(f, 'memory', label);
    }
  }
  for (const cwd of [...new Set(projects.filter(Boolean))]) {
    if (!fs.existsSync(cwd)) continue;
    const label = folderName(cwd);
    for (const n of ['CLAUDE.md', 'CLAUDE.local.md', 'AGENTS.md']) add(fileInfo(path.join(cwd, n)), 'instructions', label);
    const dot = path.join(cwd, '.claude');
    if (fs.existsSync(dot)) {
      for (const f of walk(dot)) {
        const rel = path.relative(dot, f.path).split(path.sep);
        const kind = rel[0] === 'skills' ? 'skill' : rel[0] === 'agents' ? 'agent' : rel[0] === 'commands' ? 'command' : rel[0] === 'rules' || rel.at(-1) === 'CLAUDE.md' ? 'instructions' : 'project-doc';
        add(f, kind, label);
      }
    }
  }
  return [...files.values()];
}
