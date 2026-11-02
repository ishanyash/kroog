// The page's key, end to end against a real Kroog (the demo): 127.0.0.1 is open to every
// program and account on the computer, so nothing but the hook endpoints and the app's own
// static files answers without Kroog's token. Also: the demo keeps out of ~/.kroog.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

async function startDemo(env, port) {
  const child = spawn(process.execPath, [path.join(root, 'bin/kroog.js'), 'demo', '--port', String(port), '--no-open'], { env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '';
  child.stdout.on('data', (d) => { out += d; });
  child.stderr.on('data', (d) => { out += d; });
  for (let i = 0; i < 100 && !out.includes('Open it with its key'); i += 1) await new Promise((r) => setTimeout(r, 100));
  return { child, out: () => out };
}

const get = (port, p, headers = {}) => fetch(`http://127.0.0.1:${port}${p}`, { headers, redirect: 'manual' });

test('the page and the API need Kroog\'s key; the hook endpoints keep their own token', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'kroog-key-'));
  const port = 49000 + Math.floor(Math.random() * 900);
  const { child, out } = await startDemo({ KROOG_HOME: home }, port);
  try {
    assert.match(out(), /Open it with its key: http:\/\/127\.0\.0\.1:\d+\/\?k=/);
    const token = fs.readFileSync(path.join(home, 'token'), 'utf8').trim();
    assert.ok(token.length >= 32);

    // Without the key: the locked page, and every API route refuses, reads included.
    const page = await get(port, '/');
    assert.equal(page.status, 401);
    assert.match(await page.text(), /node bin\/kroog\.js open/);
    for (const p of ['/api/state', '/api/burn', '/api/stream', '/api/transcript/x']) assert.equal((await get(port, p, { 'X-Kroog-UI': '1' })).status, 401, p);
    const post = await fetch(`http://127.0.0.1:${port}/api/settings`, { method: 'POST', headers: { 'X-Kroog-UI': '1', 'Content-Type': 'application/json' }, body: '{}' });
    assert.equal(post.status, 401);

    // A wrong key sets nothing.
    const wrong = await get(port, '/?k=nope');
    assert.equal(wrong.status, 302);
    assert.equal(wrong.headers.get('set-cookie'), null);

    // The link from the Terminal: a cookie only this browser can send, then the plain address.
    const link = await get(port, `/?k=${encodeURIComponent(token)}`);
    assert.equal(link.status, 302);
    assert.equal(link.headers.get('location'), '/');
    const cookie = link.headers.get('set-cookie');
    assert.match(cookie, new RegExp(`^kroog_${port}=`));
    assert.match(cookie, /HttpOnly/);
    assert.match(cookie, /SameSite=Strict/);
    const jar = cookie.split(';')[0];
    assert.equal((await get(port, '/', { Cookie: jar })).status, 200);
    assert.equal((await get(port, '/api/state', { Cookie: jar, 'X-Kroog-UI': '1' })).status, 200);
    // Scripts can send the token as a header instead.
    assert.equal((await get(port, '/api/state', { 'X-Kroog-Token': token })).status, 200);
    // Which program holds the port answers without the key, with a name and version only.
    const who = await (await get(port, '/api/who')).json();
    assert.equal(who.name, 'Kroog');
    assert.ok(who.version);
    assert.deepEqual(Object.keys(who).sort(), ['mode', 'name', 'ok', 'version']);
    // The app's own code is public and loads without the key.
    assert.equal((await get(port, '/app.js')).status, 200);
    // Hooks still need the hook token.
    const hook = await fetch(`http://127.0.0.1:${port}/hook/Stop`, { method: 'POST', body: '{}' });
    assert.equal(hook.status, 401);
  } finally {
    child.kill();
  }
});

test('the demo keeps its data in a temporary folder, never in ~/.kroog', async () => {
  const fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), 'kroog-fakehome-'));
  const port = 49000 + Math.floor(Math.random() * 900);
  const clean = { ...process.env, HOME: fakeHome, USERPROFILE: fakeHome };
  delete clean.KROOG_HOME;
  const child = spawn(process.execPath, [path.join(root, 'bin/kroog.js'), 'demo', '--port', String(port), '--no-open'], { env: clean, stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '';
  child.stdout.on('data', (d) => { out += d; });
  try {
    for (let i = 0; i < 100 && !out.includes('Open it with its key'); i += 1) await new Promise((r) => setTimeout(r, 100));
    assert.match(out, /temporary folder/);
    assert.equal(fs.existsSync(path.join(fakeHome, '.kroog')), false, 'no ~/.kroog was made');
  } finally {
    child.kill();
  }
});
