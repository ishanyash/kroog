// The burn page's report: the plan's windows as they stand, their history for the pace
// chart, and where the last seven days' spend went: by chat, project, day and model.
// Claude Code's own cost (from the mod) is exact; the transcript estimate fills the rest.
import { DEFAULT_PRICES, dayKey } from './cost.js';

const WEEK = 7 * 86400000;

function round(x) {
  return Math.round(x * 100) / 100;
}

// The demo has no transcripts: a made-up spend per chat, steady across runs.
function demoCost(s) {
  let h = 7;
  for (const c of s.id) h = (h * 31 + c.charCodeAt(0)) % 1000003;
  const usd = 0.4 + (h % 900) / 100;
  const tokens = Math.round(usd * 180000);
  const day = dayKey(s.lastAt || Date.now());
  return { usd: round(usd), all: tokens, byFamily: { opus: { usd: round(usd * 0.8) }, haiku: { usd: round(usd * 0.2) } }, byDay: { [day]: { usd: round(usd), tokens, messages: 12 } }, agents: { usd: round(usd * 0.3) }, messages: 12, estimate: true };
}

export async function burnReport({ store, usage, costs, demo = false, now = Date.now() }) {
  const since = now - WEEK;
  const sessions = Object.values(store.data.sessions).filter((s) => !s.archived && (s.lastAt || 0) >= since);
  const chats = [];
  const byProject = {};
  const byDay = {};
  const byFamily = {};
  let total = 0;
  let totalTokens = 0;
  let exactCount = 0;
  let agentsUsd = 0;
  for (const s of sessions) {
    const exact = usage ? usage.costOf(s.id) : null;
    const est = demo ? demoCost(s) : costs.of(s.id);
    const usd = exact ? exact.usd : est ? est.usd : null;
    if (usd == null) continue;
    if (exact) exactCount += 1;
    total += usd;
    const tokens = est ? est.all : null;
    if (tokens) totalTokens += tokens;
    chats.push({ id: s.id, title: s.title || 'New chat', project: s.project, cwd: s.cwd, lastAt: s.lastAt, startedAt: s.startedAt, status: s.status, usd: round(usd), exact: Boolean(exact), tokens, messages: est ? est.messages : null, agentsUsd: est ? round(est.agents.usd) : null });
    const p = byProject[s.project] || (byProject[s.project] = { project: s.project, cwd: s.cwd, usd: 0, chats: 0, tokens: 0 });
    p.usd += usd;
    p.chats += 1;
    p.tokens += tokens || 0;
    if (est) {
      // Days and models come from the transcript; scale them to the exact figure when there is one.
      const scale = exact && est.usd > 0 ? exact.usd / est.usd : 1;
      for (const [day, d] of Object.entries(est.byDay || {})) {
        if (day < dayKey(since)) continue;
        const x = byDay[day] || (byDay[day] = { day, usd: 0, tokens: 0 });
        x.usd += d.usd * scale;
        x.tokens += d.tokens;
      }
      for (const [fam, f] of Object.entries(est.byFamily || {})) {
        const x = byFamily[fam] || (byFamily[fam] = { family: fam, usd: 0 });
        x.usd += f.usd * scale;
      }
      agentsUsd += (est.agents ? est.agents.usd : 0) * scale;
    }
  }
  chats.sort((a, b) => b.usd - a.usd);
  const projects = Object.values(byProject).map((p) => ({ ...p, usd: round(p.usd) })).sort((a, b) => b.usd - a.usd);
  const days = [];
  for (let i = 6; i >= 0; i -= 1) {
    const day = dayKey(now - i * 86400000);
    const d = byDay[day] || { day, usd: 0, tokens: 0 };
    days.push({ day, usd: round(d.usd), tokens: d.tokens });
  }
  const families = Object.values(byFamily).map((f) => ({ ...f, usd: round(f.usd) })).sort((a, b) => b.usd - a.usd);
  return {
    windows: usage ? usage.summary(now) : { at: null, windows: {}, stale: true },
    history: { five_hour: usage ? usage.history('five_hour', now) : [], seven_day: usage ? usage.history('seven_day', now) : [] },
    chats: chats.slice(0, 60),
    projects,
    days,
    families,
    agentsUsd: round(agentsUsd),
    totals: { usd: round(total), tokens: totalTokens, chats: chats.length, exact: exactCount },
    prices: costs ? costs.prices : DEFAULT_PRICES,
    estimate: exactCount < chats.length,
  };
}
