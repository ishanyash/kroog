// The burn page: the plan's windows as they stand, the week's pace, and where the spend
// went. Claude Code's own figures (from the transcript or the mod) are exact; the rest is
// Kroog's pricing of the transcript, marked ~. Every figure covers the same seven days.
import { $, esc, plural, dayish } from './util.js';

const B = { view: null, report: null, loading: false, timer: null, at: 0, error: '' };

function money(usd, { exact = true } = {}) {
  if (usd == null) return '';
  const n = Number(usd);
  const s = n >= 100 ? `$${Math.round(n)}` : n >= 10 ? `$${n.toFixed(1)}` : n > 0 && n < 0.01 ? '<$0.01' : `$${n.toFixed(2)}`;
  return exact ? s : `~${s}`;
}

export function tokensText(n) {
  if (n == null) return '';
  if (n >= 1e9) return `${(n / 1e9).toFixed(1)}B tokens`;
  if (n >= 1e6) return `${(n / 1e6).toFixed(1)}M tokens`;
  if (n >= 1e3) return `${Math.round(n / 1e3)}k tokens`;
  return `${n} tokens`;
}

function resetText(t) {
  if (!t) return '';
  const d = new Date(t);
  const now = new Date();
  const time = d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }).replace(/\s?([AP])M$/i, (m, x) => ` ${x.toLowerCase()}m`);
  if (d.toDateString() === now.toDateString()) return `resets ${time}`;
  const tomorrow = new Date(Date.now() + 86400000);
  if (d.toDateString() === tomorrow.toDateString()) return `resets tomorrow ${time}`;
  return `resets ${d.toLocaleDateString('en-GB', { weekday: 'short' }).toLowerCase()} ${time}`;
}

function left(t) {
  if (!t) return '';
  const ms = t - Date.now();
  if (ms <= 0) return 'resetting';
  const h = Math.floor(ms / 3600000);
  const m = Math.round((ms % 3600000) / 60000);
  if (h >= 48) return `${Math.round(h / 24)} days left`;
  if (h >= 1) return `${h}h ${m}m left`;
  return `${m}m left`;
}

// One window as a bar: used so far, with a mark where an even pace would be.
export function windowHtml(kind, w, { compact = false } = {}) {
  const name = kind === 'five_hour' ? '5 hours' : kind === 'seven_day' ? 'week' : 'spend';
  if (!w) return compact ? '' : `<div class="win"><div class="win-head"><b>${name}</b><span class="quiet">no reading yet</span></div><div class="bar"><i style="width:0%"></i></div></div>`;
  const pct = Math.max(0, Math.min(100, w.pct));
  const state = w.ahead ? 'ahead' : pct >= 90 ? 'near' : '';
  const paceMark = w.elapsedPct != null ? `<s class="pace" style="left:${w.elapsedPct}%" title="an even pace would be here (${w.elapsedPct}% of the window gone)"></s>` : '';
  if (compact) return `<span class="uw ${state}" title="${esc(name)}: ${pct}% used${w.elapsedPct != null ? `, ${w.elapsedPct}% of the window gone` : ''}${w.resetsAt ? `, ${resetText(w.resetsAt)}` : ''}"><b>${Math.round(pct)}%</b><span class="bar"><i style="width:${pct}%"></i>${paceMark}</span></span>`;
  return `<div class="win ${state}">
    <div class="win-head"><b>${name}</b><span>${pct}% used</span><span class="quiet">${w.resetsAt ? `${esc(resetText(w.resetsAt))}, ${esc(left(w.resetsAt))}` : ''}</span></div>
    <div class="bar big"><i style="width:${pct}%"></i>${paceMark}</div>
    <p class="quiet">${w.elapsedPct == null ? '' : w.ahead ? `Ahead of pace: ${pct}% used with ${w.elapsedPct}% of the window gone.` : `${w.elapsedPct}% of the window gone, ${pct}% used.`}${pacePlan(kind, w)}</p>
  </div>`;
}

function pacePlan(kind, w) {
  if (kind !== 'seven_day' || !w.resetsAt || w.elapsedPct == null) return '';
  const leftPct = 100 - w.pct;
  const leftMs = w.resetsAt - Date.now();
  const days = leftMs / 86400000;
  if (leftPct <= 0) return ' The week is used up.';
  if (days < 0.5) return '';
  const perDay = leftPct / days;
  if (w.elapsedPct > 0 && w.pct > 0) {
    const rate = w.pct / w.elapsedPct;
    if (rate > 1.05) {
      const runsOutAt = w.resetsAt - (7 * 86400000) + (100 / rate) * (7 * 86400000) / 100;
      return ` At this pace the week runs out ${esc(dayish(runsOutAt))}. ${perDay.toFixed(0)}% a day keeps it.`;
    }
  }
  return ` ${perDay.toFixed(0)}% a day until it resets.`;
}

// The week as a burn-up line: used percent over elapsed percent, with the even-pace line.
function paceChartHtml(kind, w, points) {
  const W = 560;
  const H = 180;
  const padL = 34;
  const padR = 12;
  const padT = 10;
  const padB = 24;
  const length = kind === 'five_hour' ? 5 * 3600000 : 7 * 86400000;
  if (!w || !w.resetsAt) return '';
  const start = w.resetsAt - length;
  const x = (t) => padL + ((t - start) / length) * (W - padL - padR);
  const y = (p) => padT + (1 - Math.max(0, Math.min(100, p)) / 100) * (H - padT - padB);
  const path = points.length ? points.map(([t, p], i) => `${i ? 'L' : 'M'}${x(t).toFixed(1)},${y(p).toFixed(1)}`).join(' ') : '';
  const nowX = x(Date.now());
  const ticks = kind === 'seven_day'
    ? Array.from({ length: 8 }, (_, i) => start + i * 86400000)
    : Array.from({ length: 6 }, (_, i) => start + i * 3600000);
  const tickLabel = (t) => (kind === 'seven_day' ? new Date(t).toLocaleDateString('en-GB', { weekday: 'short' }).toLowerCase() : new Date(t).toLocaleTimeString([], { hour: 'numeric' }).toLowerCase().replace(' ', ''));
  const last = points[points.length - 1];
  return `<figure class="pace-chart"><svg viewBox="0 0 ${W} ${H}" role="img" aria-label="${esc(kind === 'seven_day' ? 'The week' : 'The last five hours')}: percent used over time, against an even pace">
    ${[0, 25, 50, 75, 100].map((p) => `<line class="grid" x1="${padL}" x2="${W - padR}" y1="${y(p)}" y2="${y(p)}"/><text class="ax" x="${padL - 6}" y="${y(p) + 3}" text-anchor="end">${p}</text>`).join('')}
    ${ticks.map((t) => `<text class="ax" x="${x(t).toFixed(1)}" y="${H - 8}" text-anchor="middle">${esc(tickLabel(t))}</text>`).join('')}
    <line class="even" x1="${padL}" y1="${y(0)}" x2="${W - padR}" y2="${y(100)}"/>
    <line class="now" x1="${nowX.toFixed(1)}" x2="${nowX.toFixed(1)}" y1="${padT}" y2="${H - padB}"/>
    ${path ? `<path class="used" d="${path}"/>` : ''}
    ${last ? `<circle class="dot" cx="${x(last[0]).toFixed(1)}" cy="${y(last[1]).toFixed(1)}" r="4"/><text class="lbl" x="${Math.min(W - padR - 40, x(last[0]) + 8).toFixed(1)}" y="${(y(last[1]) - 8).toFixed(1)}">${last[1]}%</text>` : ''}
  </svg><figcaption class="quiet">used, against an even pace (the thin diagonal); the vertical line is now</figcaption></figure>`;
}

function barsHtml(rows, { label, value, max, exactOf = () => true, title = () => '' }) {
  if (!rows.length) return '<p class="quiet">Nothing yet.</p>';
  const top = Math.max(max, 0.0001);
  return `<ul class="bars">${rows.map((r) => `<li title="${esc(title(r))}"><span class="l">${label(r)}</span><span class="b">${value(r) > 0 ? `<i style="width:${Math.max(1, (value(r) / top) * 100).toFixed(1)}%"></i>` : ''}</span><span class="v${value(r) > 0 ? '' : ' quiet'}">${value(r) > 0 ? esc(money(value(r), { exact: exactOf(r) })) : '0'}</span></li>`).join('')}</ul>`;
}

// How the dollars add up: the tokens of each kind, and what they cost. Cache reads lead
// because they are most of the tokens: every request re-reads the conversation so far.
const KIND_LABEL = {
  cacheRead: ['cache reads', 'the conversation so far, re-read on every request'],
  cacheWrite: ['cache writes', 'new context saved for the next request'],
  output: ['output', 'what Claude wrote, thinking included'],
  input: ['input', 'the part not served from the cache'],
};

function kindsHtml(r) {
  const kinds = (r.kinds || []).filter((k) => k.tokens > 0 || k.usd > 0);
  if (!kinds.length) return '';
  const totalUsd = kinds.reduce((a, k) => a + k.usd, 0);
  const totalTok = kinds.reduce((a, k) => a + k.tokens, 0);
  const top = Math.max(...kinds.map((k) => k.usd), 0.0001);
  const ctx = r.contextPerRequest ? tokensText(r.contextPerRequest).replace(' tokens', '') : '';
  const read = kinds.find((k) => k.kind === 'cacheRead');
  return `<div class="adds"><h3>how it adds up</h3>
    <ul class="bars kinds">${kinds.map((k) => `<li><span class="l"><b>${esc(KIND_LABEL[k.kind][0])}</b> <span class="quiet">${esc(KIND_LABEL[k.kind][1])}</span></span><span class="b">${k.usd > 0 ? `<i style="width:${Math.max(1, (k.usd / top) * 100).toFixed(1)}%"></i>` : ''}</span><span class="t">${esc(tokensText(k.tokens))}${totalTok ? ` <span class="quiet">(${Math.round((k.tokens / totalTok) * 100)}%)</span>` : ''}</span><span class="v">${esc(money(k.usd, { exact: !r.estimate }))}</span></li>`).join('')}</ul>
    <p class="quiet">${r.requests ? `${esc(r.requests.toLocaleString('en-GB'))} requests to the model${ctx ? `, each re-reading about ${esc(ctx)} tokens of conversation` : ''}. ` : ''}${read && totalTok ? `Cache reads are the cheapest kind per token, but they are ${Math.round((read.tokens / totalTok) * 100)}% of the tokens, so they are ${Math.round((read.usd / Math.max(totalUsd, 0.0001)) * 100)}% of the dollars. Long chats cost more per message because every message re-reads everything before it.` : ''}</p>
  </div>`;
}

function reportHtml(S, r) {
  const w = r.windows || { windows: {} };
  const fh = w.windows.five_hour;
  const sd = w.windows.seven_day;
  const sl = w.windows.spend_limit;
  const haveWindows = Boolean(fh || sd || sl);
  const mod = S.info.mod || {};
  const chats = r.chats || [];
  const maxChat = chats.length ? chats[0].usd : 0;
  const projects = r.projects || [];
  const days = r.days || [];
  const maxDay = Math.max(...days.map((d) => d.usd), 0);
  const families = r.families || [];
  const t = r.totals || {};
  const estimateNote = r.estimate ? ' Figures with ~ are Kroog\'s own pricing of the transcript, for chats where Claude Code did not record a total; the rest are Claude Code\'s figures.' : '';
  return `<header class="page-head"><div><h1>Burn</h1><p class="lead">Your plan's two windows, how fast they are going, and where this week's spend went.${w.at ? ` Last reading ${esc(dayish(w.at))}${w.fromChat && S.sessions.get(w.fromChat) ? ` from "${esc(S.sessions.get(w.fromChat).title || 'a chat')}"` : ''}.` : ''}</p></div>
    <div class="acts"><button type="button" class="btn soft" id="burn-again">read again</button></div></header>
  ${!haveWindows ? `<section class="burn-empty">
      <p>${mod.installed ? 'No reading yet. A chat sends one after its first reply; open chats start sending after a restart or /reload-plugins. Windows appear only on a claude.ai plan (Pro or Max).' : 'Kroog needs its mod in Claude Code to read the plan\'s windows. It is one line, and it only ever talks to this Kroog.'}</p>
      ${mod.installed || mod.demo ? '' : `<div class="row"><button type="button" class="btn solid" id="mod-install">install the mod</button><span class="quiet">or, in the Terminal: <code>${esc(S.info.modLine || '')}</code></span></div>`}
    </section>` : ''}
  <section class="wins">${windowHtml('five_hour', fh)}${windowHtml('seven_day', sd)}${sl ? windowHtml('spend_limit', sl) : ''}</section>
  ${sd ? paceChartHtml('seven_day', sd, (r.history || {}).seven_day || []) : fh ? paceChartHtml('five_hour', fh, (r.history || {}).five_hour || []) : ''}
  <section class="went">
    <div class="section-head"><h2>where it went, last 7 days</h2><span class="n">${esc(money(t.usd, { exact: !r.estimate }))}</span><span class="quiet">${esc(plural(t.chats || 0, 'chat'))}${t.tokens ? `, ${esc(tokensText(t.tokens))}` : ''}${r.agentsUsd ? `, agents ${esc(money(r.agentsUsd, { exact: false }))}` : ''}</span></div>
    <p class="quiet">What these tokens would cost on the API at list price, the same figure Claude Code reports. On a Pro or Max plan you pay the plan's price, not this; what limits you is the two windows above.${estimateNote}</p>
    ${kindsHtml(r)}
    <div class="went-grid">
      <div><h3>by day</h3>${barsHtml(days, { label: (d) => esc(new Date(`${d.day}T12:00:00`).toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric' }).toLowerCase()), value: (d) => d.usd, max: maxDay, exactOf: () => !r.estimate, title: (d) => tokensText(d.tokens) })}</div>
      <div><h3>by project</h3>${barsHtml(projects.slice(0, 8), { label: (p) => esc(p.project), value: (p) => p.usd, max: projects.length ? projects[0].usd : 0, exactOf: () => !r.estimate, title: (p) => `${plural(p.chats, 'chat')}, ${tokensText(p.tokens)}` })}</div>
      <div><h3>by model</h3>${barsHtml(families, { label: (f) => esc(f.family), value: (f) => f.usd, max: families.length ? families[0].usd : 0, exactOf: () => !r.estimate })}</div>
    </div>
    <h3>by chat</h3>
    ${chats.length ? `<ul class="bars chats">${chats.slice(0, 20).map((c) => `<li><button type="button" class="l linkish" data-open="${esc(c.id)}">${esc(c.title)}</button><span class="b"><i style="width:${Math.max(1, (c.usd / Math.max(maxChat, 0.0001)) * 100).toFixed(1)}%"></i></span><span class="v" title="${esc([c.tokens ? tokensText(c.tokens) : '', c.requests ? `${c.requests} requests` : '', c.agentsUsd ? `agents ${money(c.agentsUsd, { exact: c.exact })}` : '', c.allTimeUsd > c.usd + 0.01 ? `${money(c.allTimeUsd, { exact: c.exact })} since it started` : ''].filter(Boolean).join(', '))}">${esc(money(c.usd, { exact: c.exact }))}</span><span class="quiet p">${esc(c.project)}</span></li>`).join('')}</ul>` : '<p class="quiet">No chats in the last seven days.</p>'}
  </section>`;
}

async function load(S, post, force = false) {
  if (B.loading) return;
  if (!force && Date.now() - B.at < 30000 && B.report) return;
  B.loading = true;
  try {
    const res = await fetch('/api/burn', { headers: { 'X-Kroog-UI': '1' } });
    const data = await res.json();
    if (data.ok === false) throw new Error(data.error || 'Could not read the usage.');
    B.report = data;
    B.error = '';
    B.at = Date.now();
  } catch (error) {
    B.error = error.message;
  } finally {
    B.loading = false;
  }
  draw(S);
}

function draw(S) {
  if (!B.view) return;
  if (!B.report) {
    B.view.innerHTML = `<div class="page burn"><header class="page-head"><div><h1>Burn</h1><p class="lead">${B.error ? esc(B.error) : 'Reading the usage'}${B.error ? '' : '<span class="dots"></span>'}</p></div></header></div>`;
    return;
  }
  B.view.innerHTML = `<div class="page burn">${reportHtml(S, B.report)}</div>`;
}

export function renderBurn(view, S, { post }) {
  B.view = view;
  if (!view.querySelector('.burn')) draw(S);
  load(S, post).catch(() => {});
  clearInterval(B.timer);
  B.timer = setInterval(() => { if (document.body.contains(B.view) && B.view.querySelector('.burn')) load(S, post, true).catch(() => {}); }, 60000);
}

// A fresh reading arrived through the stream: redraw the windows part without a fetch.
export function burnUsageChanged(S) {
  if (!B.view || !B.view.querySelector('.burn') || !B.report) return;
  B.report.windows = S.usage || B.report.windows;
  draw(S);
}

export function burnRefresh(S, post) {
  return load(S, post, true);
}

export function unmountBurn() {
  clearInterval(B.timer);
  B.timer = null;
  B.view = null;
}
