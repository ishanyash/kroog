// What a chat spent, counted from its transcript: tokens by kind and model, and dollars.
//
// Claude Code writes its own running total into the transcript (a "cost-state" line: the
// session's cost at list price, per model, agents included). Where that line is there and
// covers the transcript, Kroog uses it: the figure is Claude Code's, not Kroog's. Otherwise
// (older Claude Code, or a total that does not match the transcript) Kroog prices each
// request itself with the table below. Either way the per-request tokens give the split by
// day, model and kind, scaled so the parts add up to the total.
//
// The dollars are what the tokens would cost on the API at list price. That is what Claude
// Code reports too; on a Pro or Max plan the bill is the plan's price, not this.
import fs from 'node:fs';
import path from 'node:path';
import { findTranscript } from './transcript.js';

// Dollars per million tokens, as of 30 October 2026. Opus 5.5 and Fable 5.1 reproduce
// Claude Code's own totals to the cent; Sonnet 5.5 and Haiku 5.5 are from published price
// lists. Haiku is priced in two tiers by the size of the request (up to 100k tokens, over).
// Cache writes come in two lifetimes: 5 minutes and 1 hour (Claude Code on a plan mostly
// writes the 1-hour kind for the main conversation).
export const PRICES_AS_OF = '30 October 2026';
export const DEFAULT_PRICES = {
  opus: { input: 4, output: 20, cacheWrite: 5, cacheWrite1h: 8, cacheRead: 0.2 },
  fable: { input: 10, output: 50, cacheWrite: 12.5, cacheWrite1h: 20, cacheRead: 0.25 },
  sonnet: { input: 2, output: 10, cacheWrite: 2.5, cacheWrite1h: 4, cacheRead: 0.2 },
  haiku: { input: 0.1, output: 0.5, cacheWrite: 0.125, cacheWrite1h: 0.2, cacheRead: 0.01, above: 100000, over: { input: 0.5, output: 2.5, cacheWrite: 0.625, cacheWrite1h: 1, cacheRead: 0.05 } },
  other: { input: 4, output: 20, cacheWrite: 5, cacheWrite1h: 8, cacheRead: 0.2 },
};

export const KINDS = ['cacheRead', 'cacheWrite', 'output', 'input'];

export function familyOf(model) {
  const m = String(model || '').toLowerCase();
  if (m.includes('haiku')) return 'haiku';
  if (m.includes('sonnet')) return 'sonnet';
  if (m.includes('fable') || m.includes('mythos')) return 'fable';
  if (m.includes('opus')) return 'opus';
  return 'other';
}

function rateOf(tokens, model, prices) {
  const p = prices[familyOf(model)] || prices.other || DEFAULT_PRICES.other;
  const size = (tokens.input || 0) + (tokens.cacheRead || 0) + (tokens.cacheWrite || 0);
  return p.above && p.over && size > p.above ? { ...p, ...p.over } : p;
}

// One request's dollars, by kind. A cache write with no lifetime split counts at the 5-minute rate.
export function piecesOf(tokens, model, prices = DEFAULT_PRICES) {
  const p = rateOf(tokens, model, prices);
  const w1h = Math.min(tokens.cacheWrite1h || 0, tokens.cacheWrite || 0);
  const w5m = (tokens.cacheWrite || 0) - w1h;
  const h1 = p.cacheWrite1h == null ? p.cacheWrite * 1.6 : p.cacheWrite1h;
  return {
    input: ((tokens.input || 0) * p.input) / 1e6,
    output: ((tokens.output || 0) * p.output) / 1e6,
    cacheWrite: (w5m * p.cacheWrite + w1h * h1) / 1e6,
    cacheRead: ((tokens.cacheRead || 0) * p.cacheRead) / 1e6,
  };
}

export function priceOf(tokens, model, prices = DEFAULT_PRICES) {
  const x = piecesOf(tokens, model, prices);
  return x.input + x.output + x.cacheWrite + x.cacheRead;
}

const empty = () => ({ input: 0, output: 0, cacheWrite: 0, cacheRead: 0 });

// A local calendar day, as "2026-10-30".
export function dayKey(t) {
  const d = new Date(t);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

// Reads one transcript file: its assistant requests (a request streams as several entries
// that repeat its usage, so each message id counts once, at its largest figures), and the
// last cost-state line Claude Code wrote, if any.
export function scanFile(file) {
  let text = '';
  try { text = fs.readFileSync(file, 'utf8'); } catch { return null; }
  const byId = new Map();
  let anon = 0;
  let own = null;
  for (const line of text.split('\n')) {
    if (!line) continue;
    if (line.includes('"cost-state"')) {
      try {
        const e = JSON.parse(line);
        if (e && e.type === 'cost-state' && Number.isFinite(Number(e.totalCostUSD))) own = e;
      } catch { /* a torn line */ }
      continue;
    }
    if (!line.includes('"usage"')) continue;
    let e;
    try { e = JSON.parse(line); } catch { continue; }
    if (!e || e.type !== 'assistant' || !e.message || !e.message.usage) continue;
    const u = e.message.usage;
    const id = e.message.id || `anon-${anon += 1}`;
    const cur = byId.get(id) || { model: String(e.message.model || ''), t: Date.parse(e.timestamp || '') || 0, ...empty(), cacheWrite1h: 0 };
    cur.input = Math.max(cur.input, Number(u.input_tokens) || 0);
    cur.output = Math.max(cur.output, Number(u.output_tokens) || 0);
    cur.cacheWrite = Math.max(cur.cacheWrite, Number(u.cache_creation_input_tokens) || 0);
    cur.cacheRead = Math.max(cur.cacheRead, Number(u.cache_read_input_tokens) || 0);
    const cc = u.cache_creation || {};
    cur.cacheWrite1h = Math.max(cur.cacheWrite1h, Number(cc.ephemeral_1h_input_tokens) || 0);
    byId.set(id, cur);
  }
  return { messages: [...byId.values()], own: own ? ownOf(own) : null };
}

export function countFile(file) {
  const r = scanFile(file);
  return r ? r.messages : null;
}

// Claude Code's cost-state line, reduced to its total, its tokens, and its dollars per model.
function ownOf(e) {
  let tokens = 0;
  const models = {};
  for (const [model, m] of Object.entries(e.modelUsage || {})) {
    const t = (Number(m.inputTokens) || 0) + (Number(m.outputTokens) || 0) + (Number(m.cacheReadInputTokens) || 0) + (Number(m.cacheCreationInputTokens) || 0);
    tokens += t;
    models[model] = { usd: Number(m.costUSD) || 0, tokens: t };
  }
  return { usd: Number(e.totalCostUSD) || 0, tokens, models, unknownModel: Boolean(e.hasUnknownModelCost) };
}

// The chat's own transcript plus its agents' (the subagents folder beside it).
export function filesOf(id) {
  const main = findTranscript(id);
  if (!main) return { main: null, agents: [] };
  const dir = path.join(path.dirname(main), id, 'subagents');
  let agents = [];
  try { agents = fs.readdirSync(dir).filter((f) => f.endsWith('.jsonl')).map((f) => path.join(dir, f)); } catch { /* none */ }
  return { main, agents };
}

function mtimeOf(file) {
  try { return fs.statSync(file).mtimeMs; } catch { return 0; }
}

// Cost of one chat, cached by the files' modification times.
export class CostBook {
  constructor({ prices = null } = {}) {
    this.prices = { ...DEFAULT_PRICES, ...(prices || {}) };
    this.cache = new Map(); // id -> { key, result }
  }

  setPrices(prices) {
    this.prices = { ...DEFAULT_PRICES, ...(prices || {}) };
    this.cache.clear();
  }

  of(id) {
    const { main, agents } = filesOf(id);
    if (!main) return null;
    const key = [main, ...agents].map((f) => `${f}:${mtimeOf(f)}`).join('|');
    const hit = this.cache.get(id);
    if (hit && hit.key === key) return hit.result;
    const result = this.compute(main, agents);
    this.cache.set(id, { key, result });
    return result;
  }

  // Tokens and dollars by kind, model family and day, the agents' share, requests counted,
  // and where the total came from: Claude Code's own figure, or Kroog's prices.
  compute(main, agents) {
    const total = empty();
    const byFamily = {};
    const byDay = {};
    const agentTokens = empty();
    const kinds = {};
    for (const k of KINDS) kinds[k] = { tokens: 0, usd: 0 };
    let messages = 0;
    let usd = 0;
    let agentUsd = 0;
    const add = (msgs, isAgent) => {
      for (const m of msgs || []) {
        messages += 1;
        const fam = familyOf(m.model);
        const f = byFamily[fam] || (byFamily[fam] = { ...empty(), usd: 0, messages: 0 });
        const pieces = piecesOf(m, m.model, this.prices);
        const price = pieces.input + pieces.output + pieces.cacheWrite + pieces.cacheRead;
        for (const k of KINDS) {
          total[k] += m[k];
          f[k] += m[k];
          if (isAgent) agentTokens[k] += m[k];
          kinds[k].tokens += m[k];
          kinds[k].usd += pieces[k];
        }
        usd += price;
        f.usd += price;
        f.messages += 1;
        if (isAgent) agentUsd += price;
        const day = dayKey(m.t || 0);
        const d = byDay[day] || (byDay[day] = { usd: 0, tokens: 0, messages: 0, agentsUsd: 0, families: {}, kinds: Object.fromEntries(KINDS.map((k) => [k, { tokens: 0, usd: 0 }])) });
        d.usd += price;
        d.tokens += m.input + m.output + m.cacheWrite + m.cacheRead;
        d.messages += 1;
        if (isAgent) d.agentsUsd += price;
        d.families[fam] = (d.families[fam] || 0) + price;
        for (const k of KINDS) { d.kinds[k].tokens += m[k]; d.kinds[k].usd += pieces[k]; }
      }
    };
    const head = scanFile(main) || { messages: [], own: null };
    add(head.messages, false);
    for (const f of agents) { const r = scanFile(f); add(r ? r.messages : [], true); }
    const all = total.input + total.output + total.cacheWrite + total.cacheRead;
    // Claude Code's own total wins when it covers this transcript: about the same tokens or
    // more (it also counts small background requests), but not a different session's worth.
    const own = head.own;
    const covers = own && own.usd > 0 && usd > 0 && own.tokens >= 0.9 * all && own.tokens <= 3 * all;
    const scale = covers ? own.usd / usd : 1;
    const round = (x) => Math.round(x * scale * 10000) / 10000;
    for (const f of Object.values(byFamily)) f.usd = round(f.usd);
    for (const k of KINDS) kinds[k].usd = round(kinds[k].usd);
    for (const d of Object.values(byDay)) {
      d.usd = round(d.usd);
      d.agentsUsd = round(d.agentsUsd);
      for (const fam of Object.keys(d.families)) d.families[fam] = round(d.families[fam]);
      for (const k of KINDS) d.kinds[k].usd = round(d.kinds[k].usd);
    }
    return {
      tokens: total,
      all,
      byFamily,
      byDay,
      kinds,
      agents: { tokens: agentTokens, usd: round(agentUsd), files: agents.length },
      messages,
      usd: covers ? Math.round(own.usd * 10000) / 10000 : round(usd),
      estimate: !covers,
      source: covers ? 'claude-code' : 'prices',
      priced: Math.round(usd * 10000) / 10000,
    };
  }
}
