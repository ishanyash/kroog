// Where `link` installs Kroog's mod from: a folder that stays put (a git clone or an unzipped
// copy) is used as is; a copy in npx's cache or npm's node_modules installs from GitHub.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { isStableFolder, repoRoot } from '../src/mod.js';

test('a clone or an unzipped copy is a stable folder; npx and node_modules copies are not', () => {
  assert.equal(isStableFolder(repoRoot()), true, 'this clone');
  const unzipped = fs.mkdtempSync(path.join(os.tmpdir(), 'kroog-unzipped-'));
  assert.equal(isStableFolder(unzipped), true, 'an unzipped copy with no .git');
  assert.equal(isStableFolder(path.join(os.homedir(), '.npm', '_npx', 'abc123', 'node_modules', 'kroog')), false);
  assert.equal(isStableFolder(path.join('/usr', 'local', 'lib', 'node_modules', 'kroog')), false);
});
