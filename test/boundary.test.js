// The boundary (SECURITY.md), kept by reading the source as text: which hosts Kroog may
// talk to, which files it may never name, and that it listens on 127.0.0.1 alone. A new
// host or a credential path anywhere in src/, bin/, public/ or mod/ fails here first.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

function files(dir, exts) {
  const out = [];
  for (const entry of fs.readdirSync(path.join(root, dir), { withFileTypes: true })) {
    const p = path.join(dir, entry.name);
    if (entry.isDirectory()) { if (entry.name !== 'fonts' && entry.name !== 'node_modules') out.push(...files(p, exts)); } else if (exts.some((e) => entry.name.endsWith(e))) out.push(p);
  }
  return out;
}

const CODE = [...files('src', ['.js']), ...files('bin', ['.js']), ...files('public', ['.js']), ...files('mod', ['.ts', '.json'])];
const read = (f) => fs.readFileSync(path.join(root, f), 'utf8');

// Hosts the code may name. Anything else is a new network path and needs a decision.
// (www.w3.org is the SVG namespace, not a request.)
const HOSTS_ALLOWED = ['api.anthropic.com', '127.0.0.1', 'localhost', 'nodejs.org', 'code.claude.com', 'github.com', 'ollama.com', 'www.w3.org'];

test('the only hosts in the code are the allowed ones', () => {
  const found = new Map();
  for (const f of CODE) {
    if (f.startsWith('src/demo.js') || f.endsWith('water.js')) continue; // made-up chats and a credited animation
    for (const m of read(f).matchAll(/https?:\/\/([a-z0-9.-]+)/gi)) {
      const host = m[1].toLowerCase();
      if (!HOSTS_ALLOWED.includes(host)) found.set(`${f}: ${host}`, true);
    }
  }
  assert.deepEqual([...found.keys()], []);
});

test('the server listens on 127.0.0.1 only', () => {
  const all = [...files('src', ['.js']), ...files('bin', ['.js'])].map(read).join('\n');
  const listens = [...all.matchAll(/\.listen\(([^)]*)\)/g)].map((m) => m[1]);
  assert.ok(listens.length >= 1);
  for (const args of listens) assert.match(args, /'127\.0\.0\.1'|socket|path\.join/, `listen(${args})`);
});

test('credentials and secrets are never read', () => {
  const offenders = [];
  for (const f of CODE) {
    const text = read(f);
    // Kroog's own key lives in ~/.kroog/.env and is handled by config.js alone, never read
    // from the environment (where it could leak into Claude Code).
    for (const re of [/\.credentials/g, /find-generic-password/g, /keychain/gi, /process\.env\.ANTHROPIC/g, /oauth\/usage/g]) {
      for (const m of text.matchAll(re)) {
        // The brain's skip list names .credentials to leave it out; that is the one allowed mention.
        const line = text.slice(0, m.index).split('\n').length;
        const lineText = text.split('\n')[line - 1];
        if (/SKIP_FILE|never|skip|leave/i.test(lineText)) continue;
        offenders.push(`${f}:${line} ${m[0]}`);
      }
    }
  }
  assert.deepEqual(offenders, []);
});

test('the mod reaches one host, carries no credential, and reads one file', () => {
  const mod = read('mod/hooks/register.ts');
  const hosts = [...mod.matchAll(/https?:\/\/([a-z0-9.-]+)/gi)].map((m) => m[1]);
  assert.deepEqual([...new Set(hosts)], ['127.0.0.1']);
  assert.doesNotMatch(mod, /auth:/, 'no session credential rides on the request');
  const reads = [...mod.matchAll(/\$\.fs\.read\(([^)]*)\)/g)].map((m) => m[1]);
  assert.deepEqual(reads, ['`${dir}/token`']);
  assert.match(mod, /const dir = \(await \$\.env\.get\('KROOG_HOME'\)\) \|\| `\$\{await \$\.env\.get\('HOME'\)\}\/\.kroog`/);
  assert.doesNotMatch(mod, /\$\.process|\$\.fs\.write|\$\.session\.send|\$\.model/);
});

test('nothing is written outside ~/.kroog and the two Claude Code places', () => {
  const offenders = [];
  for (const f of [...files('src', ['.js']), ...files('bin', ['.js'])]) {
    const text = read(f);
    for (const m of text.matchAll(/fs\.(writeFileSync|appendFileSync|promises\.writeFile|mkdirSync|renameSync|copyFileSync)\(([^,)]+)/g)) {
      const target = m[2].trim();
      const ok = /p\.|paths\(|this\.file|tmp|home|Home|dir\b|backup|claudeSettings|hookScript|file\b|out\b|target|dest|path\.join\(this/.test(target);
      if (!ok) offenders.push(`${f}: ${m[0]}`);
    }
  }
  assert.deepEqual(offenders, []);
});
