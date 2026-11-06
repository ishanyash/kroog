// Runs every test/*.test.js, one file at a time, each in its own Node process. A script, not
// a shell glob, so it works the same in cmd.exe and PowerShell (which do not expand `*`) as in
// sh. A file still running after two minutes is stopped, and the watchdog prints what kept it
// running, so a hang names its cause instead of running for hours.
//
//   npm test               every file
//   npm test -- inbox      only files whose name contains "inbox"
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const only = process.argv.slice(2);
const files = fs.readdirSync(path.join(root, 'test'))
  .filter((f) => f.endsWith('.test.js') && (!only.length || only.some((o) => f.includes(o))))
  .sort()
  .map((f) => path.join('test', f));
const watchdog = pathToFileURL(path.join(root, 'scripts', 'watchdog.mjs')).href;

const failed = [];
const started = Date.now();
for (const file of files) {
  console.log(`\n# ${file}`);
  const r = spawnSync(process.execPath, ['--import', watchdog, '--test-reporter=spec', file], {
    cwd: root,
    stdio: 'inherit',
    timeout: 240000,
    env: { ...process.env, KROOG_TEST_WATCHDOG: process.env.KROOG_TEST_WATCHDOG || '120000' },
  });
  if (r.error) console.log(`# ${file} was stopped: ${r.error.message}`);
  if (r.status !== 0) failed.push(file);
}
const secs = Math.round((Date.now() - started) / 1000);
console.log(failed.length ? `\n${failed.length} of ${files.length} test files failed (${secs}s): ${failed.join(', ')}` : `\nAll ${files.length} test files passed (${secs}s).`);
process.exit(failed.length ? 1 : 0);
