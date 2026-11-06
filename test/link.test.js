import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kroog-link-'));
process.env.KROOG_HOME = path.join(tmp, 'kroog');
process.env.CLAUDE_CONFIG_DIR = path.join(tmp, 'claude');

const { link, unlink, linkStatus, HOOK_EVENTS } = await import('../src/link.js');

test('link keeps your own hooks and settings, and unlink puts things back', () => {
  fs.mkdirSync(process.env.CLAUDE_CONFIG_DIR, { recursive: true });
  const settingsPath = path.join(process.env.CLAUDE_CONFIG_DIR, 'settings.json');
  const mine = {
    model: 'opus',
    permissions: { allow: ['Bash(npm test)'] },
    hooks: { PostToolUse: [{ matcher: 'Edit', hooks: [{ type: 'command', command: 'prettier --write' }] }] },
  };
  fs.writeFileSync(settingsPath, JSON.stringify(mine, null, 2));

  const result = link({ port: 4999 });
  assert.ok(fs.existsSync(result.backupPath));
  const after = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
  assert.equal(after.model, 'opus');
  assert.deepEqual(after.permissions, mine.permissions);
  assert.equal(after.hooks.PostToolUse.length, 2);
  assert.equal(after.hooks.PostToolUse[0].hooks[0].command, 'prettier --write');
  for (const def of HOOK_EVENTS) assert.ok(after.hooks[def.event], `missing ${def.event}`);
  assert.equal(after.hooks.Stop[0].matcher, undefined);
  assert.equal(after.hooks.PermissionRequest[0].hooks[0].timeout, 600);
  // sh and curl on macOS and Linux; the Node relay on Windows (or where curl is missing).
  const node = result.relay === 'node';
  assert.match(after.hooks.PreToolUse[0].hooks[0].command, node ? /hook\.mjs["']? PreToolUse$/ : /hook\.sh' PreToolUse$/);

  const script = fs.readFileSync(result.scriptPath, 'utf8');
  assert.match(script, node ? /'http:\/\/127\.0\.0\.1:4999\/hook\/'/ : /127\.0\.0\.1:4999\/hook\/\$EVENT/);
  if (!node) assert.match(script, /exit 0\s*$/);

  link({ port: 4999 });
  const twice = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
  assert.equal(twice.hooks.PostToolUse.length, 2, 'linking twice must not duplicate hooks');

  const status = linkStatus();
  assert.equal(status.linked, true);
  assert.equal(status.scriptPort, 4999);

  const un = unlink();
  assert.equal(un.changed, true);
  assert.deepEqual(JSON.parse(fs.readFileSync(settingsPath, 'utf8')), mine);
  assert.equal(linkStatus().linked, false);
});

test('link refuses a broken settings file and changes nothing', () => {
  const settingsPath = path.join(process.env.CLAUDE_CONFIG_DIR, 'settings.json');
  fs.writeFileSync(settingsPath, '{ not json');
  assert.throws(() => link({ port: 4999 }), /isn't valid JSON/);
  assert.equal(fs.readFileSync(settingsPath, 'utf8'), '{ not json');
});
