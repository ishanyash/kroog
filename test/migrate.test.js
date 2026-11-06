import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

test('moving from Crew: the data folder moves and old hooks are replaced', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'kroog-home-'));
  const saved = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE, KROOG_HOME: process.env.KROOG_HOME, CLAUDE_CONFIG_DIR: process.env.CLAUDE_CONFIG_DIR };
  // The home folder: HOME on macOS and Linux, USERPROFILE on Windows.
  process.env.HOME = home;
  process.env.USERPROFILE = home;
  delete process.env.KROOG_HOME;
  process.env.CLAUDE_CONFIG_DIR = path.join(home, '.claude');
  try {
    fs.mkdirSync(path.join(home, '.crew'));
    fs.writeFileSync(path.join(home, '.crew', 'token'), 'abc');
    fs.mkdirSync(path.join(home, '.claude'));
    const old = `${home}/.crew/hook.sh`;
    fs.writeFileSync(path.join(home, '.claude', 'settings.json'), JSON.stringify({ model: 'opus', hooks: { Stop: [{ hooks: [{ type: 'command', command: `${old} Stop` }] }] } }));
    const { migrateFromCrew } = await import('../src/config.js');
    const { hasOldCrewHooks, link, linkStatus } = await import('../src/link.js');
    assert.equal(migrateFromCrew(), true);
    assert.equal(fs.readFileSync(path.join(home, '.kroog', 'token'), 'utf8'), 'abc');
    assert.equal(fs.existsSync(path.join(home, '.crew')), false);
    assert.equal(migrateFromCrew(), false, 'only once');
    assert.equal(hasOldCrewHooks(), true);
    link({ port: 4877 });
    assert.equal(hasOldCrewHooks(), false);
    const settings = JSON.parse(fs.readFileSync(path.join(home, '.claude', 'settings.json'), 'utf8'));
    assert.equal(settings.model, 'opus', 'your other settings stay');
    assert.match(JSON.stringify(settings.hooks).replace(/\\\\/g, '/'), /\/\.kroog\/hook\.(sh|mjs)/);
    assert.equal(linkStatus().linked, true);
  } finally {
    for (const [k, v] of Object.entries(saved)) if (v === undefined) delete process.env[k]; else process.env[k] = v;
  }
});
