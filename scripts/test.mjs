// Runs every test/*.test.js with Node's test runner. A script, not a shell glob, so it works
// the same in cmd.exe and PowerShell (which do not expand `*`) as in sh.
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const files = fs.readdirSync(path.join(root, 'test')).filter((f) => f.endsWith('.test.js')).sort().map((f) => path.join('test', f));
const r = spawnSync(process.execPath, ['--test', ...process.argv.slice(2), ...files], { cwd: root, stdio: 'inherit' });
process.exit(r.status === null ? 1 : r.status);
