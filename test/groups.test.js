import test from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../src/store.js';
import { Groups, similarityGroups } from '../src/groups.js';

function chat(store, id, cwd, title, reply, files = [], ago = 0) {
  const s = store.ensureSession(id, cwd);
  Object.assign(s, { title, lastPrompt: title, lastReply: reply, files, lastAt: Date.now() - ago, status: 'done' });
  return s;
}

function seed(store) {
  chat(store, 'a', '/x/dbt', 'Add a cost gate to dbt runs', 'Each dbt run now gets a dry-run cost estimate; runs over £5 stop. Macro cost_gate.sql.', ['/x/dbt/macros/cost_gate.sql', '/x/dbt/dbt_project.yml']);
  chat(store, 'b', '/x/dbt', 'The cost gate test fails on orders', 'Fixed the cost gate macro: the limit was read as text. Test in test_cost_gate.py passes.', ['/x/dbt/macros/cost_gate.sql', '/x/dbt/tests/test_cost_gate.py']);
  chat(store, 'c', '/x/dbt', 'Weekly dbt cost report', 'Cost per week is about £38; the orders models are 60% of it. Added the cost_gate limits to the report.', ['/x/dbt/dbt_project.yml']);
  chat(store, 'd', '/x/site', 'Rename headings on the work page', 'Renamed 4 headings in work.astro and fixed the nav.', ['/x/site/src/pages/work.astro']);
  chat(store, 'e', '/x/site', 'Draft the coaching FAQ', 'Drafted 8 FAQ answers in content/coaching.md using only facts from the site.', ['/x/site/content/coaching.md']);
}

test('chats about the same work are grouped by shared words', () => {
  const store = new Store();
  seed(store);
  const groups = similarityGroups(Object.values(store.data.sessions));
  const cost = groups.find((g) => g.chats.includes('a'));
  assert.ok(cost, 'the cost chats form a group');
  assert.ok(cost.chats.includes('b') && cost.chats.includes('c'));
  assert.ok(!cost.chats.includes('d') && !cost.chats.includes('e'));
  assert.match(cost.name, /cost/);
});

test('the AI helper names and proposes groups, and results are cached until chats change', async () => {
  const store = new Store();
  seed(store);
  let calls = 0;
  const ai = {
    provider: () => 'claude',
    complete: async ({ prompt }) => {
      calls += 1;
      const lines = prompt.split('\n');
      const num = (id) => lines.findIndex((l) => l.includes(store.session(id).title)) + 1;
      return JSON.stringify([{ name: 'dbt cost gate', why: 'All three are about the cost gate.', chats: [num('a'), num('b'), num('c')] }, { name: 'not valid', chats: [num('d')] }]);
    },
  };
  const groups = new Groups({ store, ai });
  const got = await groups.refresh();
  assert.equal(got.length, 1, 'a group needs two chats');
  assert.equal(got[0].name, 'dbt cost gate');
  assert.deepEqual([...got[0].chats].sort(), ['a', 'b', 'c']);
  assert.equal(got[0].cwd, '/x/dbt');
  assert.equal(got[0].by, 'ai');
  await groups.refresh();
  assert.equal(calls, 1, 'cached');
  store.session('d').lastAt = Date.now() + 5;
  await groups.refresh();
  assert.equal(calls, 2, 'a changed chat means a fresh look');
  assert.equal(groups.status().by, 'ai');
});

test('without the AI helper, word groups are used', async () => {
  const store = new Store();
  seed(store);
  const groups = new Groups({ store, ai: { provider: () => 'off' } });
  const got = await groups.refresh();
  assert.ok(got.length >= 1);
  assert.equal(got[0].by, 'words');
});
