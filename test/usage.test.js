import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Usage, normalize } from '../src/usage.js';
import { CostBook, countFile, familyOf, priceOf, DEFAULT_PRICES } from '../src/cost.js';
import { burnReport } from '../src/burn.js';
import { Store } from '../src/store.js';

const HOUR = 3600000;

test('a reading from the mod and one from a status line come to the same shape', () => {
  const t = Date.now();
  const a = normalize({ sessionId: 's1', cwd: '/x', rateLimits: [{ kind: 'five_hour', percentUsed: 23.5, resetsAt: new Date(t + HOUR).toISOString() }, { kind: 'seven_day', percentUsed: 41.2 }], cost: { usd: 1.23456 }, context: { percent: 8, tokens: 15500, window: 200000 } }, t);
  assert.equal(a.sid, 's1');
  assert.equal(a.windows.five_hour.pct, 23.5);
  assert.equal(a.windows.five_hour.resetsAt, t + HOUR);
  assert.equal(a.windows.seven_day.resetsAt, null);
  assert.equal(a.cost.usd, 1.2346);
  assert.equal(a.context.percent, 8);
  const b = normalize({ session_id: 's2', rate_limits: { five_hour: { used_percentage: 23.5, resets_at: Math.round((t + HOUR) / 1000) }, seven_day: { used_percentage: 41.2, resets_at: Math.round((t + 3 * 24 * HOUR) / 1000) } }, cost: { total_cost_usd: 0.5 } }, t);
  assert.equal(b.sid, 's2');
  assert.equal(b.windows.five_hour.pct, 23.5);
  assert.equal(b.windows.five_hour.resetsAt, Math.round((t + HOUR) / 1000) * 1000);
  assert.equal(b.cost.usd, 0.5);
  // Nonsense is ignored, not stored.
  const c = normalize({ rateLimits: [{ kind: 'nope', percentUsed: 5 }, { kind: 'five_hour', percentUsed: 'x' }] }, t);
  assert.deepEqual(c.windows, {});
});

test('the usage store keeps the newest windows, each chat\'s cost, and a thinned history on disk', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kroog-usage-'));
  const file = path.join(dir, 'usage.jsonl');
  const usage = new Usage({ file });
  const t = Date.now();
  const resets = new Date(t + 2 * HOUR).toISOString();
  const weekResets = new Date(t + 3 * 24 * HOUR).toISOString();
  usage.add({ sessionId: 'a', cwd: '/x', rateLimits: [{ kind: 'five_hour', percentUsed: 20, resetsAt: resets }, { kind: 'seven_day', percentUsed: 40, resetsAt: weekResets }], cost: { usd: 0.5 } });
  usage.add({ sessionId: 'a', cwd: '/x', rateLimits: [{ kind: 'five_hour', percentUsed: 20, resetsAt: resets }, { kind: 'seven_day', percentUsed: 40, resetsAt: weekResets }], cost: { usd: 0.5 } });
  usage.add({ sessionId: 'b', cwd: '/y', rateLimits: [{ kind: 'five_hour', percentUsed: 21, resetsAt: resets }, { kind: 'seven_day', percentUsed: 40, resetsAt: weekResets }], cost: { usd: 1.25 } });
  const s = usage.summary();
  assert.equal(s.windows.five_hour.pct, 21);
  assert.equal(s.windows.seven_day.pct, 40);
  assert.equal(s.fromChat, 'b');
  assert.equal(typeof s.windows.five_hour.elapsedPct, 'number');
  assert.equal(s.windows.seven_day.ahead, false, '40% used with about 57% of the week gone is not ahead');
  assert.deepEqual(usage.costOf('a').usd, 0.5);
  assert.deepEqual(usage.costOf('b').usd, 1.25);
  // The repeat of the same state within ten minutes was not written.
  const lines = fs.readFileSync(file, 'utf8').trim().split('\n');
  assert.equal(lines.length, 2);
  // A new store reads it back.
  const again = new Usage({ file });
  assert.equal(again.summary().windows.five_hour.pct, 21);
  assert.equal(again.costOf('b').usd, 1.25);
  assert.equal(again.history('five_hour').length, 2);
  assert.deepEqual(usage.costs().map((c) => c.sid).sort(), ['a', 'b']);
});

test('ahead of pace: 80% of the week used with 30% of it gone', () => {
  const usage = new Usage({});
  const t = Date.now();
  const weekResets = new Date(t + 0.7 * 7 * 24 * HOUR).toISOString();
  usage.add({ sessionId: 'a', rateLimits: [{ kind: 'seven_day', percentUsed: 80, resetsAt: weekResets }] });
  const s = usage.summary();
  assert.equal(s.windows.seven_day.elapsedPct, 30);
  assert.equal(s.windows.seven_day.ahead, true);
});

test('cost from a transcript: each message once, by family, agents apart, with a dollar estimate', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kroog-cost-'));
  const main = path.join(dir, 'chat.jsonl');
  const line = (id, model, usage, ts = '2026-10-30T10:00:00.000Z') => JSON.stringify({ type: 'assistant', timestamp: ts, message: { id, model, usage, content: [] } });
  fs.writeFileSync(main, [
    line('m1', 'claude-opus-5-5', { input_tokens: 10, output_tokens: 100, cache_creation_input_tokens: 1000, cache_read_input_tokens: 5000 }),
    line('m1', 'claude-opus-5-5', { input_tokens: 10, output_tokens: 100, cache_creation_input_tokens: 1000, cache_read_input_tokens: 5000 }),
    line('m2', 'claude-haiku-5-5', { input_tokens: 5, output_tokens: 50, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 }, '2026-10-29T10:00:00.000Z'),
    JSON.stringify({ type: 'user', message: { role: 'user', content: 'hi' } }),
  ].join('\n'));
  const msgs = countFile(main);
  assert.equal(msgs.length, 2, 'a streamed message counts once');
  assert.equal(familyOf('claude-opus-5-5'), 'opus');
  assert.equal(familyOf('claude-fable-5-1'), 'fable');
  assert.equal(familyOf('claude-haiku-5-5'), 'haiku');
  const opus = priceOf({ input: 1e6, output: 0, cacheWrite: 0, cacheRead: 0 }, 'claude-opus-5-5');
  assert.equal(opus, DEFAULT_PRICES.opus.input);
  const book = new CostBook();
  const r = book.compute(main, []);
  assert.equal(r.messages, 2);
  assert.equal(r.tokens.cacheRead, 5000);
  assert.equal(r.all, 6165);
  assert.ok(r.byFamily.opus && r.byFamily.haiku);
  assert.ok(r.usd > 0 && r.estimate);
  assert.equal(Object.keys(r.byDay).length, 2);
  assert.equal(r.agents.files, 0);
});

test('the burn report: the week by chat, project, day and model, exact where the mod reported', async () => {
  const store = new Store();
  const now = Date.now();
  const a = store.ensureSession('a', '/x/app');
  Object.assign(a, { title: 'Add the gate', lastAt: now - HOUR, startedAt: now - 2 * HOUR, status: 'done' });
  const b = store.ensureSession('b', '/x/site');
  Object.assign(b, { title: 'Write the FAQ', lastAt: now - 3 * HOUR, startedAt: now - 4 * HOUR, status: 'done' });
  const old = store.ensureSession('old', '/x/site');
  Object.assign(old, { title: 'Long ago', lastAt: now - 10 * 24 * HOUR, status: 'done' });
  const usage = new Usage({});
  usage.add({ sessionId: 'a', cwd: '/x/app', rateLimits: [{ kind: 'seven_day', percentUsed: 41, resetsAt: new Date(now + 3 * 24 * HOUR).toISOString() }], cost: { usd: 2.5 } });
  const r = await burnReport({ store, usage, costs: null, demo: true, now });
  assert.equal(r.windows.windows.seven_day.pct, 41);
  assert.equal(r.chats.length, 2, 'only the last seven days');
  const first = r.chats.find((c) => c.id === 'a');
  assert.equal(first.usd, 2.5, 'the mod\'s figure wins');
  assert.equal(first.exact, true);
  assert.equal(r.chats.find((c) => c.id === 'b').exact, false);
  assert.equal(r.totals.chats, 2);
  assert.equal(r.totals.exact, 1);
  assert.equal(r.days.length, 7);
  assert.ok(r.projects.length === 2);
  assert.equal(r.estimate, true);
});

// Claude Code's own totals for one long session (its cost-state line), which the price
// table must reproduce to the cent: the table is checked against Claude Code, not memory.
test('the price table reproduces Claude Code\'s own totals for Opus 5.5 and Fable 5.1', () => {
  const opus = priceOf({ input: 9086, output: 1257121, cacheRead: 266439590, cacheWrite: 177318 + 2981291, cacheWrite1h: 2981291 }, 'claude-opus-5-5');
  assert.equal(opus.toFixed(4), '103.2036');
  const fable = priceOf({ input: 9989, output: 736317, cacheRead: 341794212, cacheWrite: 1052846 + 2277499, cacheWrite1h: 2277499 }, 'claude-fable-5-1');
  assert.equal(fable.toFixed(4), '181.0748');
  // A 1-hour cache write costs more than a 5-minute one; Haiku has two tiers by request size.
  assert.ok(priceOf({ cacheWrite: 1e6, cacheWrite1h: 1e6 }, 'claude-opus-5-5') > priceOf({ cacheWrite: 1e6 }, 'claude-opus-5-5'));
  const small = priceOf({ input: 50000, output: 1000 }, 'claude-haiku-5-5');
  const big = priceOf({ input: 150000, output: 1000 }, 'claude-haiku-5-5');
  assert.ok(big / 3 > small * 1.5, 'over 100k tokens Haiku costs more per token');
});

function transcript(lines) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kroog-cost-'));
  const file = path.join(dir, 'chat.jsonl');
  fs.writeFileSync(file, lines.map((l) => JSON.stringify(l)).join('\n'));
  return file;
}
const req = (id, ts, u, model = 'claude-opus-5-5') => ({ type: 'assistant', timestamp: ts, message: { id, model, content: [], usage: { input_tokens: u.i || 0, output_tokens: u.o || 0, cache_creation_input_tokens: u.w || 0, cache_read_input_tokens: u.r || 0, cache_creation: { ephemeral_5m_input_tokens: 0, ephemeral_1h_input_tokens: u.w || 0 } } } });
const costState = (usd, tokens) => ({ type: 'cost-state', sessionId: 'x', totalCostUSD: usd, modelUsage: { 'claude-opus-5-5': { inputTokens: 0, outputTokens: 0, cacheReadInputTokens: tokens, cacheCreationInputTokens: 0, costUSD: usd } } });

test('Claude Code\'s own total wins when it covers the transcript, and the parts add up to it', () => {
  const lines = [req('a', '2026-10-30T10:00:00Z', { r: 1e6, w: 1e5, o: 1e4 }), req('b', '2026-10-30T11:00:00Z', { r: 2e6, w: 1e5, o: 1e4 })];
  const all = 3e6 + 2e5 + 2e4;
  const book = new CostBook();
  const priced = book.compute(transcript(lines), []);
  assert.equal(priced.estimate, true);
  assert.equal(priced.source, 'prices');
  const own = book.compute(transcript([...lines, costState(5, all)]), []);
  assert.equal(own.estimate, false);
  assert.equal(own.source, 'claude-code');
  assert.equal(own.usd, 5);
  const kindsSum = Object.values(own.kinds).reduce((a, k) => a + k.usd, 0);
  assert.ok(Math.abs(kindsSum - 5) < 0.001, 'the kinds add up to Claude Code\'s total');
  const daySum = Object.values(own.byDay).reduce((a, d) => a + d.usd, 0);
  assert.ok(Math.abs(daySum - 5) < 0.001, 'the days add up to it too');
  // A total that covers far fewer tokens than the transcript (another process's) is not used.
  const partial = book.compute(transcript([...lines, costState(0.5, all / 10)]), []);
  assert.equal(partial.estimate, true);
});

test('the week counts only the requests made in it, not the chat\'s whole life', async () => {
  const now = Date.parse('2026-10-30T12:00:00');
  const old = new Date(now - 20 * 24 * HOUR).toISOString();
  const recent = new Date(now - 2 * HOUR).toISOString();
  const file = transcript([req('a', old, { r: 9e6, o: 1e5 }), req('b', recent, { r: 1e6, o: 1e4 })]);
  const book = new CostBook();
  const store = new Store();
  const s = store.ensureSession('long', '/x/app');
  Object.assign(s, { title: 'A long chat', lastAt: now - HOUR, startedAt: now - 20 * 24 * HOUR, status: 'done' });
  const costs = { of: () => book.compute(file, []), prices: book.prices };
  const r = await burnReport({ store, usage: null, costs, now });
  const whole = book.compute(file, []).usd;
  const recentOnly = priceOf({ cacheRead: 1e6, output: 1e4 }, 'claude-opus-5-5');
  assert.ok(Math.abs(r.totals.usd - recentOnly) < 0.01, `the week is ${r.totals.usd}, the recent request alone`);
  assert.ok(r.totals.usd < whole / 5);
  assert.equal(r.chats[0].allTimeUsd, Math.round(whole * 100) / 100);
  const daySum = r.days.reduce((a, d) => a + d.usd, 0);
  assert.ok(Math.abs(daySum - r.totals.usd) < 0.02, 'the days add up to the header');
  const kindSum = r.kinds.reduce((a, k) => a + k.usd, 0);
  assert.ok(Math.abs(kindSum - r.totals.usd) < 0.02, 'so do the kinds');
  assert.equal(r.requests, 1);
  assert.equal(r.contextPerRequest, 1e6);
});
