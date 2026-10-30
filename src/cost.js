// What a chat spent, counted from its transcript: tokens by kind and model, and a dollar
// estimate at list price. Claude Code's own figure (sent in by the mod) is exact and wins
// where it exists; this is for every other chat, including old ones, and for the token
// counts themselves, which Claude Code does not report per chat.
//
// Prices are per million tokens, in US dollars, as Kroog knows them. They can be out of
// date: Setup shows the table and lets you change it, and the page says "estimate".
import fs from 'node:fs';
import path from 'node:path';
import { findTranscript } from './transcript.js';

export const DEFAULT_PRICES = {
  // family: [input, output, cache write, cache read]
  opus: { input: 5, output: 25, cacheWrite: 6.25, cacheRead: 0.5 },
  sonnet: { input: 3, output: 15, cacheWrite: 3.75, cacheRead: 0.3 },
  haiku: { input: 1, output: 5, cacheWrite: 1.25, cacheRead: 0.1 },
  other: { input: 5, output: 25, cacheWrite: 6.25, cacheRead: 0.5 },
};

export function familyOf(model) {
  const m = String(model || '').toLowerCase();
  if (m.includes('haiku')) return 'haiku';
  if (m.includes('sonnet')) return 'sonnet';
  if (m.includes('opus') || m.includes('fable') || m.includes('mythos')) return 'opus';
  return 'other';
}

export function priceOf(tokens, model, prices = DEFAULT_PRICES) {
  const p = prices[familyOf(model)] || prices.other || DEFAULT_PRICES.other;
  return (tokens.input * p.input + tokens.output * p.output + tokens.cacheWrite * p.cacheWrite + tokens.cacheRead * p.cacheRead) / 1e6;
}

const empty = () => ({ input: 0, output: 0, cacheWrite: 0, cacheRead: 0 });

// A local calendar day, as "2026-10-30".
export function dayKey(t) {
  const d = new Date(t);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

// Sums the assistant messages of one transcript file. A message streams as several
// entries that repeat its usage, so each message id counts once, at its largest figures.
export function countFile(file) {
  let text = '';
  try { text = fs.readFileSync(file, 'utf8'); } catch { return null; }
  const byId = new Map();
  let anon = 0;
  for (const line of text.split('\n')) {
    if (!line || !line.includes('"usage"')) continue;
    let e;
    try { e = JSON.parse(line); } catch { continue; }
    if (!e || e.type !== 'assistant' || !e.message || !e.message.usage) continue;
    const u = e.message.usage;
    const id = e.message.id || `anon-${anon += 1}`;
    const cur = byId.get(id) || { model: String(e.message.model || ''), t: Date.parse(e.timestamp || '') || 0, ...empty() };
    cur.input = Math.max(cur.input, Number(u.input_tokens) || 0);
    cur.output = Math.max(cur.output, Number(u.output_tokens) || 0);
    cur.cacheWrite = Math.max(cur.cacheWrite, Number(u.cache_creation_input_tokens) || 0);
    cur.cacheRead = Math.max(cur.cacheRead, Number(u.cache_read_input_tokens) || 0);
    byId.set(id, cur);
  }
  return [...byId.values()];
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

// Cost of one chat: tokens by kind, by model family, the agents' share, messages counted,
// and the dollar estimate. Cached by the files' modification times.
export class CostBook {
  constructor({ prices = DEFAULT_PRICES } = {}) {
    this.prices = prices;
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

  compute(main, agents) {
    const total = empty();
    const byFamily = {};
    const byDay = {};
    const agentTokens = empty();
    let messages = 0;
    let usd = 0;
    let agentUsd = 0;
    const add = (msgs, isAgent) => {
      for (const m of msgs || []) {
        messages += 1;
        const fam = familyOf(m.model);
        const f = byFamily[fam] || (byFamily[fam] = { ...empty(), usd: 0, messages: 0 });
        for (const k of ['input', 'output', 'cacheWrite', 'cacheRead']) { total[k] += m[k]; f[k] += m[k]; if (isAgent) agentTokens[k] += m[k]; }
        const price = priceOf(m, m.model, this.prices);
        usd += price;
        f.usd += price;
        f.messages += 1;
        if (isAgent) agentUsd += price;
        if (m.t) {
          const day = dayKey(m.t);
          const d = byDay[day] || (byDay[day] = { usd: 0, tokens: 0, messages: 0 });
          d.usd += price;
          d.tokens += m.input + m.output + m.cacheWrite + m.cacheRead;
          d.messages += 1;
        }
      }
    };
    add(countFile(main), false);
    for (const f of agents) add(countFile(f), true);
    const round = (x) => Math.round(x * 10000) / 10000;
    for (const f of Object.values(byFamily)) f.usd = round(f.usd);
    for (const d of Object.values(byDay)) d.usd = round(d.usd);
    return { tokens: total, all: total.input + total.output + total.cacheWrite + total.cacheRead, byFamily, byDay, agents: { tokens: agentTokens, usd: round(agentUsd), files: agents.length }, messages, usd: round(usd), estimate: true };
  }
}
