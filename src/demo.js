// Demo mode: fake chats that run through the same engine as real ones, so you can try
// every control (Allow, Deny, Send, Drive, Stop, Handoff) before linking Claude Code.
import crypto from 'node:crypto';

const META = {
  vscode: { entry: 'claude-vscode', bundle: 'com.microsoft.VSCode', term: '' },
  cursor: { entry: 'claude-vscode', bundle: 'com.todesktop.230313mzl4w4u92', term: '' },
  vscodeTerminal: { entry: 'cli', bundle: 'com.microsoft.VSCode', term: 'vscode' },
  desktop: { entry: 'claude-desktop', bundle: 'com.anthropic.claudefordesktop', term: '' },
  terminal: { entry: 'cli', bundle: 'com.apple.Terminal', term: 'Apple_Terminal' },
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const jitter = (ms) => ms + Math.round(Math.random() * ms * 0.4);
const newId = () => crypto.randomUUID();
const home = '/Users/you/code';

export function startDemo({ engine, store }) {
  let stopped = false;
  const h = (event, sid, cwd, meta, extra = {}) => engine.handle(event, { session_id: sid, cwd, hook_event_name: event, ...extra }, META[meta]);

  // Move a seeded chat back in time: it started `startAgo` minutes ago and was active
  // around each of `activeAgo` (minutes ago, oldest first). Its steps spread over those.
  function place(sid, startAgo, activeAgo) {
    const s = store.session(sid);
    if (!s) return;
    const now = Date.now();
    const n = s.steps.length;
    s.steps.forEach((step, i) => {
      const slot = Math.min(activeAgo.length - 1, Math.floor((i * activeAgo.length) / Math.max(1, n)));
      step.t = now - activeAgo[slot] * 60000 + i * 20000;
    });
    s.startedAt = now - startAgo * 60000;
    s.lastAt = now - activeAgo[activeAgo.length - 1] * 60000 + n * 20000;
    s.since = s.lastAt;
  }

  async function tool(sid, cwd, meta, name, input, { fail = null, response = {} } = {}) {
    const id = `toolu_${crypto.randomBytes(6).toString('hex')}`;
    const pre = await h('PreToolUse', sid, cwd, meta, { tool_name: name, tool_input: input, tool_use_id: id });
    if (pre && pre.continue === false) return { stopped: true };
    await sleep(jitter(1400));
    const post = fail
      ? await h('PostToolUseFailure', sid, cwd, meta, { tool_name: name, tool_input: input, tool_use_id: id, error: fail })
      : await h('PostToolUse', sid, cwd, meta, { tool_name: name, tool_input: input, tool_use_id: id, tool_response: response });
    if (post && post.continue === false) return { stopped: true };
    const context = post && post.hookSpecificOutput && post.hookSpecificOutput.additionalContext;
    return { context };
  }

  // A brief from earlier chats, the way Handoff makes one, so the demo shows lineage.
  function briefFrom(sources, notes, goal, editor) {
    const parts = sources.map((sid) => {
      const s = store.session(sid);
      return s ? `From the chat "${s.title}":\n${s.lastReply}` : '';
    }).filter(Boolean);
    const text = ['Brief from Kroog: notes from earlier chats on related work.', `Goal: ${goal}`, ...parts].join('\n\n');
    return { ...engine.createBrief({ text, goal, editor, sources, notes }), delivered: 'editor' };
  }

  let costTestPrompt = 'The cost check test fails on the orders model. Find out why and fix it.';

  async function seed() {
    const costDir = `${home}/dbt-cost`;

    // Four days ago: where the cost work started.
    const weekly = newId();
    await h('SessionStart', weekly, costDir, 'vscode', { source: 'startup' });
    await h('UserPromptSubmit', weekly, costDir, 'vscode', { prompt: 'Find out what our dbt runs cost each week.' });
    for (const f of ['models/staging/stg_orders.sql', 'dbt_project.yml']) {
      await h('PreToolUse', weekly, costDir, 'vscode', { tool_name: 'Read', tool_input: { file_path: `${costDir}/${f}` }, tool_use_id: `seed-w-${f}` });
      await h('PostToolUse', weekly, costDir, 'vscode', { tool_name: 'Read', tool_input: { file_path: `${costDir}/${f}` }, tool_use_id: `seed-w-${f}`, tool_response: {} });
    }
    await h('Stop', weekly, costDir, 'vscode', { last_assistant_message: 'About £38 a week. The orders models are 60% of it, mostly full refreshes that could be incremental.' });
    // Started four days ago, picked up again yesterday and this morning.
    place(weekly, 6060, [6040, 1640, 190]);

    // Finished earlier today, started from a brief about yesterday's chat.
    const cost = newId();
    const fromWeekly = briefFrom([weekly], [], 'Add a cost check to dbt dry runs: estimate each run and stop anything over £5.', 'vscode');
    await h('SessionStart', cost, costDir, 'vscode', { source: 'startup' });
    await h('UserPromptSubmit', cost, costDir, 'vscode', { prompt: fromWeekly.prompt });
    await h('PreToolUse', cost, costDir, 'vscode', { tool_name: 'TodoWrite', tool_input: { todos: [
      { content: 'Estimate the cost with a dry run', status: 'completed' },
      { content: 'Stop runs over the limit', status: 'completed' },
      { content: 'Add tests', status: 'completed' },
      { content: 'Update the README', status: 'completed' },
    ] }, tool_use_id: 'seed1' });
    for (const f of ['macros/cost_gate.sql', 'dbt_project.yml', 'tests/test_cost_gate.py', 'README.md']) {
      await h('PreToolUse', cost, costDir, 'vscode', { tool_name: 'Edit', tool_input: { file_path: `${costDir}/${f}` }, tool_use_id: `seed-${f}` });
      await h('PostToolUse', cost, costDir, 'vscode', { tool_name: 'Edit', tool_input: { file_path: `${costDir}/${f}` }, tool_use_id: `seed-${f}`, tool_response: {} });
    }
    await h('Stop', cost, costDir, 'vscode', { last_assistant_message: 'Done. Each dbt run now gets a dry-run estimate first.\n\n- Runs over £5 stop before they start; runs over £2 show a warning.\n- The limits live in dbt_project.yml under vars.cost_gate.\n- 6 new tests in tests/test_cost_gate.py, all passing.\n\nCheck a model on its own with: dbt run-operation estimate_cost --args \'{model: stg_orders}\'' });
    place(cost, 110, [100, 48]);

    const faq = newId();
    const siteDir = `${home}/ishanyash-site`;
    await h('SessionStart', faq, siteDir, 'cursor', { source: 'startup' });
    await h('UserPromptSubmit', faq, siteDir, 'cursor', { prompt: 'Draft the coaching FAQ using only facts already on the site.' });
    await h('PreToolUse', faq, siteDir, 'cursor', { tool_name: 'Write', tool_input: { file_path: `${siteDir}/content/coaching.md` }, tool_use_id: 'seed-faq' });
    await h('PostToolUse', faq, siteDir, 'cursor', { tool_name: 'Write', tool_input: { file_path: `${siteDir}/content/coaching.md` }, tool_use_id: 'seed-faq', tool_response: {} });
    await h('Stop', faq, siteDir, 'cursor', { last_assistant_message: 'Drafted 8 answers in content/coaching.md. Every answer uses only facts already on the site, and each links to the page it comes from.' });
    place(faq, 3020, [3010, 2990]);

    const rename = newId();
    await h('SessionStart', rename, siteDir, 'vscode', { source: 'startup' });
    await h('UserPromptSubmit', rename, siteDir, 'vscode', { prompt: 'Give the sections on the work page clearer names.' });
    await h('Stop', rename, siteDir, 'vscode', { last_assistant_message: 'Renamed 4 headings on the work page.' });
    place(rename, 1530, [1510]);

    // Not in an editor, so hidden while "Only editor chats" is on.
    const desk = newId();
    await h('SessionStart', desk, `${home}/notes`, 'desktop', { source: 'startup' });
    await h('UserPromptSubmit', desk, `${home}/notes`, 'desktop', { prompt: 'Tidy up my meeting notes folder.' });
    const term = newId();
    await h('SessionStart', term, `${home}/scripts`, 'terminal', { source: 'startup' });
    await h('UserPromptSubmit', term, `${home}/scripts`, 'terminal', { prompt: 'Write a backup script for my photos.' });

    const notes = [
      { type: 'Decision', text: 'Runs over £5 stop before they start; runs over £2 warn.', sid: cost, cwd: costDir },
      { type: 'How-to', text: "Check one model's cost first: dbt run-operation estimate_cost --args '{model: stg_orders}'.", sid: cost, cwd: costDir },
      { type: 'Finding', text: 'The cost limits live in dbt_project.yml under vars.cost_gate.', sid: cost, cwd: costDir },
      { type: 'Decision', text: 'Every FAQ answer uses only facts already on the site.', sid: faq, cwd: siteDir, remembered: true },
      { type: 'How-to', text: 'New posts go in content/posts/<slug>.md with draft: false.', sid: faq, cwd: siteDir, remembered: true },
    ];
    const made = [];
    for (const n of notes) {
      const s = store.session(n.sid);
      const note = store.addNote({ sessionId: n.sid, chatTitle: s.title, project: s.project, cwd: n.cwd, type: n.type, text: n.text });
      if (note && n.remembered) store.updateNote(note.id, { remembered: true });
      if (note) made.push(note);
    }

    // The live cost-test chat starts from a brief about the cost-check chat and one of its notes.
    const decision = made.find((x) => x.sessionId === cost && x.type === 'Decision');
    costTestPrompt = briefFrom([cost], decision ? [decision.id] : [], 'The cost check test fails on the orders model. Find out why and fix it.', 'cursor').prompt;
  }

  // A chat that asks before running a command, then asks you a question.
  async function costTest() {
    const sid = newId();
    const cwd = `${home}/dbt-cost`;
    await h('SessionStart', sid, cwd, 'cursor', { source: 'startup' });
    await sleep(800);
    await h('UserPromptSubmit', sid, cwd, 'cursor', { prompt: costTestPrompt });
    await sleep(jitter(1500));
    await tool(sid, cwd, 'cursor', 'TodoWrite', { todos: [
      { content: 'Find why the test fails', status: 'in_progress' },
      { content: 'Fix how the limit is read', status: 'pending' },
      { content: 'Run the orders model again', status: 'pending' },
    ] });
    await tool(sid, cwd, 'cursor', 'Read', { file_path: `${cwd}/macros/cost_gate.sql` });
    await tool(sid, cwd, 'cursor', 'Grep', { pattern: 'cost_limit' });
    await tool(sid, cwd, 'cursor', 'Edit', { file_path: `${cwd}/macros/cost_gate.sql` });
    await tool(sid, cwd, 'cursor', 'TodoWrite', { todos: [
      { content: 'Find why the test fails', status: 'completed' },
      { content: 'Fix how the limit is read', status: 'completed' },
      { content: 'Run the orders model again', status: 'in_progress' },
    ] });
    const input = { command: 'dbt run --select stg_orders --target dev', description: 'Run the orders model in dev' };
    const id = 'toolu_demo_perm';
    await h('PreToolUse', sid, cwd, 'cursor', { tool_name: 'Bash', tool_input: input, tool_use_id: id });
    const answer = await h('PermissionRequest', sid, cwd, 'cursor', { tool_name: 'Bash', tool_input: input });
    const behavior = answer && answer.hookSpecificOutput ? answer.hookSpecificOutput.decision.behavior : 'allow';
    if (stopped) return;
    if (behavior === 'deny') {
      await sleep(1200);
      await h('Stop', sid, cwd, 'cursor', { last_assistant_message: 'OK, I won\'t run it. The fix is in macros/cost_gate.sql: the limit was read as text, not a number. Should a run over the cost limit fail, or only warn?' });
      return;
    }
    await sleep(jitter(1800));
    await h('PostToolUse', sid, cwd, 'cursor', { tool_name: 'Bash', tool_input: input, tool_use_id: id, tool_response: { stdout: 'Completed successfully' } });
    await tool(sid, cwd, 'cursor', 'TodoWrite', { todos: [
      { content: 'Find why the test fails', status: 'completed' },
      { content: 'Fix how the limit is read', status: 'completed' },
      { content: 'Run the orders model again', status: 'completed' },
    ] });
    let result = await h('Stop', sid, cwd, 'cursor', { last_assistant_message: 'Fixed. The limit was read as text, not a number, so every run looked too expensive. The orders model runs again in dev.\n\nOne thing to decide: should a run over the cost limit fail, or only warn?' });
    while (result && result.decision === 'block' && !stopped) {
      await sleep(jitter(1500));
      await tool(sid, cwd, 'cursor', 'Edit', { file_path: `${cwd}/dbt_project.yml` });
      await tool(sid, cwd, 'cursor', 'Bash', { command: 'dbt test --select cost_gate', description: 'Run the cost check tests' });
      result = await h('Stop', sid, cwd, 'cursor', { last_assistant_message: 'Done. I set it the way you asked in dbt_project.yml and the cost check tests pass.' });
    }
  }

  // A long-running chat with a helper, a failing test, and room for your messages.
  async function branchSearch() {
    const sid = newId();
    const cwd = `${home}/neurobuttr-mcp`;
    await h('SessionStart', sid, cwd, 'vscode', { source: 'startup' });
    await sleep(500);
    await h('UserPromptSubmit', sid, cwd, 'vscode', { prompt: 'Add a search tool that finds branches by keyword. Add tests.' });
    const plan = (n) => ({ todos: ['Find where branches are stored', 'Add the search tool', 'Write tests', 'Run the tests and fix failures'].map((c, i) => ({ content: c, status: i < n ? 'completed' : i === n ? 'in_progress' : 'pending' })) });
    const steps = [
      ['TodoWrite', plan(0)],
      ['Read', { file_path: `${cwd}/src/server.ts` }],
      ['Read', { file_path: `${cwd}/src/tools/branches.ts` }],
      ['SUBAGENT', 'Explore'],
      ['TodoWrite', plan(1)],
      ['Write', { file_path: `${cwd}/src/tools/search.ts` }],
      ['Edit', { file_path: `${cwd}/src/server.ts` }],
      ['TodoWrite', plan(2)],
      ['Write', { file_path: `${cwd}/tests/search.test.ts` }],
      ['TodoWrite', plan(3)],
      ['FAIL', { command: 'npm test', description: 'Run the tests' }],
      ['Edit', { file_path: `${cwd}/src/tools/search.ts` }],
      ['Bash', { command: 'npm test', description: 'Run the tests again' }],
    ];
    for (const [name, input] of steps) {
      if (stopped) return;
      if (name === 'SUBAGENT') {
        const agentId = `agent_${crypto.randomBytes(4).toString('hex')}`;
        await h('SubagentStart', sid, cwd, 'vscode', { agent_id: agentId, agent_type: input });
        await sleep(jitter(1500));
        await h('PreToolUse', sid, cwd, 'vscode', { tool_name: 'Grep', tool_input: { pattern: 'branch' }, tool_use_id: 'sub1', agent_id: agentId, agent_type: input });
        await sleep(jitter(1500));
        await h('PostToolUse', sid, cwd, 'vscode', { tool_name: 'Grep', tool_input: { pattern: 'branch' }, tool_use_id: 'sub1', tool_response: {}, agent_id: agentId, agent_type: input });
        await h('SubagentStop', sid, cwd, 'vscode', { agent_id: agentId, agent_type: input, stop_hook_active: false, last_assistant_message: 'Branches are stored in 3 places: the cache, the index and the tree file.' });
        continue;
      }
      const r = name === 'FAIL'
        ? await tool(sid, cwd, 'vscode', 'Bash', input, { fail: '3 tests failed: search ignores descriptions' })
        : await tool(sid, cwd, 'vscode', name, input);
      if (r.stopped) return;
      await sleep(jitter(2600));
    }
    await tool(sid, cwd, 'vscode', 'TodoWrite', plan(4));
    let result = await h('Stop', sid, cwd, 'vscode', { last_assistant_message: 'Branch search works. It matches branch names and descriptions, not full content, and all 60 tests pass.\n\nShould search ignore upper and lower case?' });
    while (result && result.decision === 'block' && !stopped) {
      await sleep(jitter(1500));
      await tool(sid, cwd, 'vscode', 'Edit', { file_path: `${cwd}/src/tools/search.ts` });
      await tool(sid, cwd, 'vscode', 'Bash', { command: 'npm test', description: 'Run the tests' });
      result = await h('Stop', sid, cwd, 'vscode', { last_assistant_message: 'Done. Search now follows your answer, and the tests still pass.' });
    }
  }

  // Keeps working so you can send it a message and watch it arrive after a step.
  async function post() {
    const sid = newId();
    const cwd = `${home}/ishanyash-site`;
    await h('SessionStart', sid, cwd, 'vscode', { source: 'startup' });
    await h('UserPromptSubmit', sid, cwd, 'vscode', { prompt: "Draft this week's post: Power BI in UK analyst ads. Use the house style." });
    const sections = ['the opening', 'section 2 of 4', 'section 3 of 4', 'section 4 of 4', 'the summary'];
    await tool(sid, cwd, 'vscode', 'TodoWrite', { todos: [
      { content: 'Collect the numbers and their sources', status: 'in_progress' },
      { content: 'Write the four sections', status: 'pending' },
      { content: 'Check every number against its page', status: 'pending' },
    ] });
    await tool(sid, cwd, 'vscode', 'WebSearch', { query: 'IT Jobs Watch Power BI data analyst UK' });
    await tool(sid, cwd, 'vscode', 'WebFetch', { url: 'https://www.itjobswatch.co.uk/jobs/uk/power%20bi.do' });
    await tool(sid, cwd, 'vscode', 'TodoWrite', { todos: [
      { content: 'Collect the numbers and their sources', status: 'completed' },
      { content: 'Write the four sections', status: 'in_progress' },
      { content: 'Check every number against its page', status: 'pending' },
    ] });
    let round = 0;
    while (!stopped) {
      const label = sections[round % sections.length];
      const r = await tool(sid, cwd, 'vscode', 'Edit', { file_path: `${cwd}/content/posts/power-bi-analyst-ads.md` });
      if (r.stopped) return;
      const s = store.session(sid);
      if (s) {
        s.now = `Writing ${label}`;
        store.touch(s);
      }
      round += 1;
      await sleep(jitter(6000));
      if (round > 40) return;
    }
  }

  (async () => {
    await seed();
    while (!stopped && !engine.hasViewers()) await sleep(500);
    await sleep(1500);
    if (stopped) return;
    branchSearch();
    await sleep(2500);
    post();
    await sleep(4000);
    costTest();
  })().catch((error) => console.error('[kroog demo]', error));

  return () => {
    stopped = true;
  };
}
