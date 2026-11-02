// The burn page's report: the plan's windows as they stand, their history for the pace
// chart, and where the last seven days' spend went: by chat, project, day, model and kind
// of token. Every figure covers the same seven days: a chat that started earlier counts
// only for its requests in them. Claude Code's own figures are exact; Kroog's prices fill
// in where Claude Code did not record one.
import { DEFAULT_PRICES, PRICES_AS_OF, KINDS, dayKey } from './cost.js';

// Four places: a short chat on Haiku costs a fraction of a cent, and should not read as 0.
function round(x) {
  return Math.round(x * 10000) / 10000;
}

// The demo has no transcripts: a made-up spend per chat, steady across runs, shaped like
// a real one (cache reads are most of the tokens).
function demoCost(s) {
  let h = 7;
  for (const c of s.id) h = (h * 31 + c.charCodeAt(0)) % 1000003;
  const usd = 0.4 + (h % 900) / 100;
  const tokens = Math.round(usd * 1.6e6);
  const day = dayKey(s.lastAt || Date.now());
  const kinds = {
    cacheRead: { tokens: Math.round(tokens * 0.955), usd: round(usd * 0.48) },
    cacheWrite: { tokens: Math.round(tokens * 0.035), usd: round(usd * 0.3) },
    output: { tokens: Math.round(tokens * 0.0095), usd: round(usd * 0.21) },
    input: { tokens: Math.round(tokens * 0.0005), usd: round(usd * 0.01) },
  };
  const requests = 10 + (h % 60);
  return { usd: round(usd), all: tokens, estimate: true, source: 'prices', messages: requests, byDay: { [day]: { usd: round(usd), tokens, messages: requests, agentsUsd: round(usd * 0.3), families: { opus: round(usd * 0.8), haiku: round(usd * 0.2) }, kinds } }, kinds, agents: { usd: round(usd * 0.3) } };
}

// The seven days the page shows: today and the six before, as local calendar days.
function weekOf(now) {
  const days = [];
  for (let i = 6; i >= 0; i -= 1) days.push(dayKey(now - i * 86400000));
  const first = new Date(`${days[0]}T00:00:00`).getTime();
  return { days, first };
}

// One chat's part of the seven days: only the requests made in them, not the chat's whole life.
function inWeek(est, days) {
  const out = { usd: 0, tokens: 0, requests: 0, agentsUsd: 0, families: {}, kinds: Object.fromEntries(KINDS.map((k) => [k, { tokens: 0, usd: 0 }])), byDay: {} };
  for (const day of days) {
    const d = est.byDay && est.byDay[day];
    if (!d) continue;
    out.usd += d.usd;
    out.tokens += d.tokens;
    out.requests += d.messages || 0;
    out.agentsUsd += d.agentsUsd || 0;
    out.byDay[day] = { usd: d.usd, tokens: d.tokens };
    for (const [fam, v] of Object.entries(d.families || {})) out.families[fam] = (out.families[fam] || 0) + v;
    for (const k of KINDS) if (d.kinds && d.kinds[k]) { out.kinds[k].tokens += d.kinds[k].tokens; out.kinds[k].usd += d.kinds[k].usd; }
  }
  return out;
}

function scaled(part, f) {
  if (f === 1) return part;
  const kinds = Object.fromEntries(KINDS.map((k) => [k, { tokens: part.kinds[k].tokens, usd: part.kinds[k].usd * f }]));
  const families = Object.fromEntries(Object.entries(part.families).map(([fam, v]) => [fam, v * f]));
  const byDay = Object.fromEntries(Object.entries(part.byDay).map(([day, d]) => [day, { usd: d.usd * f, tokens: d.tokens }]));
  return { ...part, usd: part.usd * f, agentsUsd: part.agentsUsd * f, kinds, families, byDay };
}

export async function burnReport({ store, usage, costs, demo = false, now = Date.now() }) {
  const week = weekOf(now);
  const sessions = Object.values(store.data.sessions).filter((s) => !s.archived && (s.lastAt || 0) >= week.first);
  const chats = [];
  const byProject = {};
  const byDay = {};
  const byFamily = {};
  const kinds = Object.fromEntries(KINDS.map((k) => [k, { tokens: 0, usd: 0 }]));
  let total = 0;
  let totalTokens = 0;
  let requests = 0;
  let exactCount = 0;
  let agentsUsd = 0;
  for (const s of sessions) {
    const fromMod = usage ? usage.costOf(s.id) : null;
    const est = demo ? demoCost(s) : costs ? costs.of(s.id) : null;
    let part;
    let exact;
    let allTime;
    if (est) {
      // The mod's figure is the whole session's, so it only rescales the transcript's split.
      const f = est.estimate && fromMod && est.usd > 0 ? fromMod.usd / est.usd : 1;
      part = scaled(inWeek(est, week.days), f);
      exact = !est.estimate || Boolean(fromMod);
      allTime = est.usd * f;
    } else if (fromMod) {
      // No transcript: the whole figure on the chat's last day, and no split by kind.
      const day = dayKey(s.lastAt || now);
      part = { usd: fromMod.usd, tokens: 0, requests: 0, agentsUsd: 0, families: {}, kinds: Object.fromEntries(KINDS.map((k) => [k, { tokens: 0, usd: 0 }])), byDay: { [day]: { usd: fromMod.usd, tokens: 0 } } };
      exact = true;
      allTime = fromMod.usd;
    } else continue;
    if (!(part.usd > 0)) continue;
    if (exact) exactCount += 1;
    total += part.usd;
    totalTokens += part.tokens;
    requests += part.requests;
    agentsUsd += part.agentsUsd;
    chats.push({ id: s.id, title: s.title || 'New chat', project: s.project, cwd: s.cwd, lastAt: s.lastAt, startedAt: s.startedAt, status: s.status, usd: round(part.usd), allTimeUsd: round(allTime), exact, tokens: part.tokens || null, requests: part.requests, agentsUsd: part.agentsUsd ? round(part.agentsUsd) : null });
    const p = byProject[s.project] || (byProject[s.project] = { project: s.project, cwd: s.cwd, usd: 0, chats: 0, tokens: 0 });
    p.usd += part.usd;
    p.chats += 1;
    p.tokens += part.tokens;
    for (const [day, d] of Object.entries(part.byDay)) {
      const x = byDay[day] || (byDay[day] = { day, usd: 0, tokens: 0 });
      x.usd += d.usd;
      x.tokens += d.tokens;
    }
    for (const [fam, v] of Object.entries(part.families)) {
      const x = byFamily[fam] || (byFamily[fam] = { family: fam, usd: 0 });
      x.usd += v;
    }
    for (const k of KINDS) { kinds[k].tokens += part.kinds[k].tokens; kinds[k].usd += part.kinds[k].usd; }
  }
  chats.sort((a, b) => b.usd - a.usd);
  const projects = Object.values(byProject).map((p) => ({ ...p, usd: round(p.usd) })).sort((a, b) => b.usd - a.usd);
  const days = week.days.map((day) => {
    const d = byDay[day] || { day, usd: 0, tokens: 0 };
    return { day, usd: round(d.usd), tokens: d.tokens };
  });
  const families = Object.values(byFamily).map((f) => ({ ...f, usd: round(f.usd) })).filter((f) => f.usd > 0).sort((a, b) => b.usd - a.usd);
  const read = kinds.cacheRead.tokens + kinds.cacheWrite.tokens + kinds.input.tokens;
  return {
    windows: usage ? usage.summary(now) : { at: null, windows: {}, stale: true },
    history: { five_hour: usage ? usage.history('five_hour', now) : [], seven_day: usage ? usage.history('seven_day', now) : [] },
    chats: chats.slice(0, 60),
    projects,
    days,
    families,
    kinds: KINDS.map((k) => ({ kind: k, tokens: kinds[k].tokens, usd: round(kinds[k].usd) })),
    requests,
    contextPerRequest: requests ? Math.round(read / requests) : 0,
    agentsUsd: round(agentsUsd),
    totals: { usd: round(total), tokens: totalTokens, chats: chats.length, exact: exactCount },
    prices: costs ? costs.prices : DEFAULT_PRICES,
    pricesAsOf: PRICES_AS_OF,
    estimate: exactCount < chats.length,
  };
}
