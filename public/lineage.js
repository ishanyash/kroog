// The lineage canvas as a week calendar. Seven day columns, Monday to Sunday; move back
// and forth a week at a time with the week bar (or the arrow keys). Each project is a
// lane. A chat sits on the day it started and a thin trail runs to the last day it was
// active that week. Chats that came from other chats are joined by a line (a brief), a
// dotted line (project memory) or a line ending in a ring (continued); links to chats in
// other weeks show as short stubs you can click to jump there. The key on each chat
// starts a connection: click it, then click the chat to send it to. Pan by dragging,
// zoom with the buttons, pinch or ctrl and scroll.
import { $, $$, esc, trim, look, whenText, lineText, cellsHtml, dur, plural, folderName, tildePath, lineageEdges, lineageOf, bucket, EDITORS } from './util.js';

const NODE_W = 208;
const COL_PAD = 12;
const MIN_COL = NODE_W + COL_PAD * 2;
const DAY_HEAD = 34;
const ROW_GAP = 10;
const LANE_GAP = 26;
const LANE_HEAD = 32;
const PAD_X = 24;
const PAD_Y = 8;
const SUB_GAP = 10;
const SUB_H = 20;
const TOP_SPACE = 70;
const RANK = { needs: 0, working: 1, done: 2, quiet: 3 };
const DAY_MS = 86400000;

const KEY_SVG = '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M10 14a4.2 4.2 0 0 0 6 0l3-3a4.2 4.2 0 0 0-6-6l-1 1"/><path d="M14 10a4.2 4.2 0 0 0-6 0l-3 3a4.2 4.2 0 0 0 6 6l1-1"/></svg>';

const L = {
  root: null,
  stage: null,
  world: null,
  svg: null,
  band: null,
  layer: null,
  overlay: null,
  water: null,
  waterOn: false,
  view: { x: 0, y: 0, k: 1 },
  fitted: false,
  userMoved: false,
  fitKey: '',
  laneOrder: [],
  pos: new Map(),
  els: new Map(),
  bounds: null,
  hooks: {},
  hovered: null,
  hoverTimer: null,
  days: null,
  pointers: new Map(),
  drag: null,
  pinch: null,
  last: null,
  args: null,
  weekStart: null,
  linking: null,
  linkHover: null,
  ptr: null,
};

// ---------------------------------------------------------------- time helpers

function dayStart(t) {
  const d = new Date(t);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

// Local Monday 00:00 of the week holding t.
function mondayOf(t) {
  const d = new Date(dayStart(t));
  const back = (d.getDay() + 6) % 7;
  d.setDate(d.getDate() - back);
  return d.getTime();
}

// Day i of the week (handles daylight saving changes).
function dayOfWeek(ws, i) {
  const d = new Date(ws);
  d.setDate(d.getDate() + i);
  return d.getTime();
}

function weekEnd(ws) {
  return dayOfWeek(ws, 7);
}

const fmtDay = (t) => new Date(t).toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short' }).replace(/,/g, '').toLowerCase();
const fmtDate = (t) => new Date(t).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' }).toLowerCase();

function weekLabel(ws) {
  return `${fmtDate(ws)} – ${fmtDate(dayOfWeek(ws, 6))}`;
}

// Every moment a chat did something: when it started, each step, its last activity.
function moments(s) {
  const out = [];
  if (s.startedAt) out.push(s.startedAt);
  if (s.lastAt) out.push(s.lastAt);
  for (const st of s.steps || []) if (st && st.t) out.push(st.t);
  return out;
}

function activeIn(s, ws, we) {
  return moments(s).some((t) => t >= ws && t < we);
}

// ---------------------------------------------------------------- mount

export function mountLineage(container, hooks) {
  L.hooks = hooks;
  container.innerHTML = `<div class="stage" id="stage" role="region" aria-label="Lineage of your chats, one week at a time">
    <canvas class="water" aria-hidden="true"></canvas>
    <div class="world" id="world"><div class="days" id="days" aria-hidden="true"></div><svg class="edges" id="edges" aria-hidden="true"></svg><div id="layer"></div><svg class="band" id="band" aria-hidden="true"></svg></div>
    <div id="overlay"></div>
  </div>`;
  L.root = container;
  L.stage = $('#stage', container);
  L.world = $('#world', container);
  L.svg = $('#edges', container);
  L.band = $('#band', container);
  L.layer = $('#layer', container);
  L.days = $('#days', container);
  L.overlay = $('#overlay', container);
  L.els = new Map();
  L.pos = new Map();
  if (L.weekStart == null) L.weekStart = mondayOf(Date.now());
  bindStage();
  setWater(hooks.waterOn());
  applyView();
}

export function unmountLineage() {
  unhover();
  if (L.water) { L.water.destroy(); L.water = null; }
  L.stage = null;
  L.root = null;
}

export function isMounted() {
  return Boolean(L.stage && document.body.contains(L.stage));
}

// The water behind the lineage: the fish.
export function setWater(on) {
  L.waterOn = Boolean(on);
  if (!L.stage) return;
  if (L.waterOn) {
    if (!L.water && window.KroogWater) L.water = window.KroogWater.start($('.water', L.stage));
    scheduleAvoid();
  } else if (L.water) {
    L.water.destroy();
    L.water = null;
  }
}

export function themeChanged() {
  if (L.water) L.water.setTheme();
}

// ---------------------------------------------------------------- weeks

function rerender() {
  if (L.args) renderLineage(...L.args);
}

function goWeek(ws) {
  const current = mondayOf(Date.now());
  const next = Math.min(mondayOf(ws), current);
  if (next === L.weekStart) return false;
  L.weekStart = next;
  L.userMoved = false;
  L.fitKey = '';
  unhover();
  rerender();
  return true;
}

// Move n weeks back (negative) or forward (positive). Never past this week.
export function shiftWeek(n) {
  const d = new Date(L.weekStart ?? mondayOf(Date.now()));
  d.setDate(d.getDate() + 7 * n);
  return goWeek(d.getTime());
}

// Show the week that holds the moment t.
export function showWeekOf(t) {
  return goWeek(t || Date.now());
}

// ---------------------------------------------------------------- model

function laneKey(s) {
  return s.cwd || s.project || 'unknown';
}

function buildModel(S, UI, visible) {
  const all = visible;
  const allById = new Map(all.map((s) => [s.id, s]));
  const notesById = new Map(S.notes.map((n) => [n.id, n]));
  const allEdges = lineageEdges(allById, notesById);
  // A chat continued from another (a branch Kroog ran) draws as its own kind of line.
  for (const e of allEdges) {
    const to = allById.get(e.to);
    if ((to.inputs || []).some((x) => x.kind === 'continue' && (x.from || []).includes(e.from))) e.kind = 'continue';
  }

  const ws = L.weekStart;
  const we = weekEnd(ws);
  const current = ws === mondayOf(Date.now());
  const sessions = all.filter((s) => activeIn(s, ws, we));
  const byId = new Map(sessions.map((s) => [s.id, s]));
  const edges = allEdges.filter((e) => byId.has(e.from) && byId.has(e.to));
  // Links that reach into another week: drawn as stubs at the edge of this one.
  const stubs = [];
  for (const e of allEdges) {
    const inFrom = byId.has(e.from);
    const inTo = byId.has(e.to);
    if (inFrom === inTo) continue;
    const other = allById.get(inFrom ? e.to : e.from);
    const t = inFrom ? (other.startedAt || other.lastAt) : (other.lastAt || other.startedAt);
    if (!t) continue;
    const side = t < ws ? 'left' : t >= we ? 'right' : inFrom ? 'right' : 'left';
    stubs.push({ id: inFrom ? e.from : e.to, side, kind: e.kind, other, t, dir: inFrom ? 'to' : 'from' });
  }
  const picked = new Set(UI.handoff.active ? UI.handoff.sources.map((x) => x.id) : []);

  // Briefs on their way, only in this week: sent and not picked up yet, and the one you are making.
  const pseudo = [];
  if (current) {
    for (const b of S.briefs || []) {
      const from = (b.sources || []).filter((id) => byId.has(id));
      const fromNotes = (b.notes || []).map((id) => notesById.get(id)).filter((n) => n && n.sessionId && byId.has(n.sessionId)).map((n) => n.sessionId);
      const both = [...new Set([...from, ...fromNotes])];
      if (!both.length) continue;
      pseudo.push({ id: `brief:${b.id}`, kind: 'waiting', brief: b, from: both });
    }
    if (UI.handoff.active) {
      const from = [...picked].filter((id) => byId.has(id));
      const fromNotes = UI.handoff.notes.map((id) => notesById.get(id)).filter((n) => n && n.sessionId && byId.has(n.sessionId)).map((n) => n.sessionId);
      const both = [...new Set([...from, ...fromNotes])];
      if (both.length) pseudo.push({ id: 'brief:draft', kind: 'draft', from: both });
    }
  }

  // How many chats were active in each of the last 8 weeks, for the week strip.
  const thisWeek = mondayOf(Date.now());
  const strip = [];
  for (let i = 7; i >= 0; i -= 1) {
    const d = new Date(thisWeek);
    d.setDate(d.getDate() - 7 * i);
    const s0 = d.getTime();
    const s1 = weekEnd(s0);
    strip.push({ ws: s0, n: all.filter((s) => activeIn(s, s0, s1)).length });
  }
  return { all, sessions, byId, edges, stubs, pseudo, picked, ws, we, current, strip };
}

function nodeMode(s, model, ctx) {
  if (s.id === ctx.selected || model.picked.has(s.id) || ctx.linkSrc.has(s.id)) return 'full';
  const k = bucket(s);
  if (k === 'working' || k === 'needs') return 'full';
  const ref = Math.min(Date.now(), model.we - 1);
  return (s.lastAt || 0) >= dayStart(ref) - DAY_MS ? 'full' : 'mini';
}

// ---------------------------------------------------------------- layout
// Seven columns, Monday to Sunday, as wide as the screen allows (never narrower than a
// chat). A chat sits in the column of the day it started (Monday if it started before
// this week); inside a project lane, chats take rows like a calendar and keep their row
// until the last day they were active this week.

function layout(model, sizes) {
  const { sessions, byId, pseudo, ws, we } = model;
  const now = Date.now();
  const today = dayStart(now);
  const r = L.stage ? L.stage.getBoundingClientRect() : { width: 1200 };
  const colW = Math.max(MIN_COL, Math.floor((r.width - 48 - PAD_X * 2) / 7));

  const cols = [];
  for (let i = 0; i < 7; i += 1) {
    const day = dayOfWeek(ws, i);
    const diff = Math.round((today - day) / DAY_MS);
    cols.push({ day, x: PAD_X + i * colW, w: colW, today: day === today, future: day > today, label: { main: diff === 0 ? 'today' : diff === 1 ? 'yesterday' : fmtDay(day), sub: diff === 0 || diff === 1 ? fmtDay(day) : '' } });
  }
  const colOfTime = (t) => {
    if (t < ws) return 0;
    if (t >= we) return 6;
    for (let i = 6; i >= 0; i -= 1) if (t >= cols[i].day) return i;
    return 0;
  };

  const span = new Map();
  for (const s of sessions) {
    const inWeek = moments(s).filter((t) => t >= ws && t < we).map(colOfTime);
    const start = s.startedAt || s.lastAt || now;
    const c0 = start < ws ? 0 : colOfTime(start);
    const set = new Set([c0, ...inWeek]);
    const dayCols = [...set].sort((a, b) => a - b);
    span.set(s.id, { c0, c1: dayCols[dayCols.length - 1], dayCols, early: start < ws ? start : null });
  }
  const todayCol = cols.findIndex((c) => c.today);

  // Lanes, one per project. They keep their order once shown; new ones go first,
  // the ones that need you or are working before the rest, then the most recent.
  const lanes = new Map();
  for (const s of sessions) {
    const key = laneKey(s);
    if (!lanes.has(key)) lanes.set(key, { key, name: s.project || folderName(key), path: s.cwd, ids: [] });
    lanes.get(key).ids.push(s.id);
  }
  const keys = [...lanes.keys()];
  const rankOf = (key) => Math.min(...lanes.get(key).ids.map((id) => RANK[bucket(byId.get(id))]));
  const lastOf = (key) => Math.max(...lanes.get(key).ids.map((id) => byId.get(id).lastAt || 0));
  const fresh = keys.filter((k) => !L.laneOrder.includes(k)).sort((a, b) => rankOf(a) - rankOf(b) || lastOf(b) - lastOf(a));
  L.laneOrder = [...fresh, ...L.laneOrder.filter((k) => !fresh.includes(k))];
  const order = L.laneOrder.filter((k) => lanes.has(k));

  // Briefs on their way sit in today's column, in the lane of the chat they are for.
  const pseudoLane = new Map();
  for (const p of pseudo) {
    const target = p.brief && p.brief.target === 'running' && byId.get(p.brief.targetId);
    const src = byId.get(p.from[0]);
    const key = target ? laneKey(target) : src ? laneKey(src) : null;
    if (key && lanes.has(key) && todayCol >= 0) pseudoLane.set(p.id, key);
    span.set(p.id, { c0: todayCol, c1: todayCol, dayCols: [todayCol] });
  }

  const pos = new Map();
  const laneBoxes = [];
  let top = PAD_Y + DAY_HEAD + 8;
  for (const key of order) {
    const lane = lanes.get(key);
    const items = [...lane.ids, ...pseudo.filter((p) => pseudoLane.get(p.id) === key).map((p) => p.id)];
    const startOf = (id) => (byId.get(id) || {}).startedAt || Infinity;
    items.sort((a, b) => span.get(a).c0 - span.get(b).c0 || (a.startsWith('brief:') ? 1 : 0) - (b.startsWith('brief:') ? 1 : 0) || startOf(a) - startOf(b) || (a < b ? -1 : 1));
    const rows = [];
    const rowOf = new Map();
    for (const id of items) {
      const { c0, c1 } = span.get(id);
      let ri = rows.findIndex((row) => row.end < c0);
      if (ri === -1) { rows.push({ end: -1, h: 0 }); ri = rows.length - 1; }
      rows[ri].end = c1;
      const size = sizes.get(id) || { h: 60, sub: 0 };
      rows[ri].h = Math.max(rows[ri].h, size.h + size.sub);
      rowOf.set(id, ri);
    }
    const laneTop = top;
    let y = laneTop + LANE_HEAD;
    const rowY = rows.map((row) => { const at = y; y += row.h + ROW_GAP; return at; });
    for (const id of items) {
      const size = sizes.get(id) || { h: 60, sub: 0 };
      const { c0, c1, dayCols, early } = span.get(id);
      pos.set(id, { x: cols[c0].x + COL_PAD, y: rowY[rowOf.get(id)], h: size.h, sub: size.sub, lane: key, col: c0, endCol: c1, dayCols, early });
    }
    const laneBottom = y - ROW_GAP;
    laneBoxes.push({ key, name: lane.name, path: lane.path, top: laneTop, bottom: laneBottom, count: lane.ids.length });
    top = laneBottom + LANE_GAP;
  }

  const width = PAD_X * 2 + colW * 7;
  const height = Math.max(top - LANE_GAP + PAD_Y + 12, PAD_Y + DAY_HEAD + 160);
  return { pos, laneBoxes, width, height, cols, colW, span };
}

// ---------------------------------------------------------------- nodes

const linkKey = (id) => `<button type="button" class="link-key" data-link="${esc(id)}" aria-label="Connect this chat to another chat" title="Connect to another chat">${KEY_SVG}</button>`;

function chatNodeHtml(s, mode, ctx, early) {
  const lk = look(s);
  const sel = ctx.selected === s.id;
  const picked = ctx.picked.has(s.id);
  const dim = ctx.lit && !ctx.lit.has(s.id);
  const src = ctx.linkSrc.has(s.id);
  const hov = L.linkHover === s.id && !src;
  const cls = `node k-${lk.k}${mode === 'mini' ? ' mini' : ''}${sel ? ' sel' : ''}${picked ? ' picked' : ''}${dim ? ' dim' : ''}${src ? ' link-src' : ''}${hov ? ' link-hover' : ''}`;
  const label = `${s.title || 'Untitled chat'}. ${lk.word}. ${lineText(s)}`;
  const kroog = s.owner === 'kroog' ? '<span class="tag tag-kroog">kroog</span>' : '';
  const earlyMark = early ? `<span class="early" title="Started ${esc(fmtDay(early))}">← from ${esc(fmtDay(early))}</span>` : '';
  if (mode === 'mini') {
    return { cls, label, tip: `${s.title || ''}${early ? ` (started ${fmtDay(early)})` : ''}`, html: `<span class="dot" aria-hidden="true"></span>${early ? '<span class="early-m" aria-hidden="true">←</span>' : ''}<span class="t">${esc(s.title || 'Untitled chat')}</span>${kroog}<span class="when" data-tick="when" data-id="${esc(s.id)}">${esc(whenText(s))}</span>${linkKey(s.id)}${picked ? '<span class="pickmark">in brief</span>' : ''}` };
  }
  const n = s.needs || {};
  const asking = s.status === 'needs' && n.kind === 'permission' && s.waitingPermission;
  const acts = asking
    ? `<span class="acts"><button type="button" class="btn sm solid" data-allow="${esc(s.id)}">allow</button><button type="button" class="btn sm" data-deny="${esc(s.id)}">deny</button><span class="count" data-tick="deadline" data-deadline="${n.deadline || ''}" data-what="editor in" data-short="1">${esc(shortCount(n.deadline))}</span></span>`
    : '';
  const drive = s.drive ? '<span class="tag">drive</span>' : '';
  return {
    cls,
    label,
    html: `${earlyMark}<span class="st"><span class="w">${esc(lk.word)}${kroog}</span><span class="when">${drive ? `${drive} ` : ''}<span data-tick="when" data-id="${esc(s.id)}">${esc(whenText(s))}</span>${linkKey(s.id)}</span></span>
      <span class="t">${esc(s.title || 'Untitled chat')}</span>
      <span class="l">${esc(lineText(s))}</span>
      ${cellsHtml(s)}${acts}${picked ? '<span class="pickmark">in brief</span>' : ''}`,
  };
}

function shortCount(deadline) {
  if (!deadline) return '';
  const sec = Math.max(0, Math.round((deadline - Date.now()) / 1000));
  return sec >= 60 ? `${Math.floor(sec / 60)}m ${sec % 60}s` : `${sec}s`;
}

function briefNodeHtml(p, ctx) {
  if (p.kind === 'draft') {
    const h = ctx.handoff;
    const inKroog = h.run === 'kroog' && ctx.canRun;
    const dest = h.target === 'new' ? (inKroog ? 'to a new chat in kroog' : `to a new chat in ${EDITORS[h.editor] || 'VS Code'}`) : h.target === 'running' ? 'to a running chat' : 'to project memory';
    return {
      cls: 'node brief draft',
      label: 'The brief you are making',
      html: `<span class="st"><span class="w">new brief</span><span class="when">${esc(plural(p.from.length, 'source'))}</span></span>
        <span class="t">${esc((h.goal || '').trim() || 'Add a goal in the panel')}</span>
        <span class="l">${esc(dest)}</span>`,
    };
  }
  const b = p.brief;
  const target = b.target === 'running' && ctx.byId.get(b.targetId) ? `for "${trim(ctx.byId.get(b.targetId).title, 40)}"` : `for a new chat in ${EDITORS[b.editor] || 'VS Code'}`;
  return {
    cls: 'node brief',
    label: `A brief waiting ${target}`,
    html: `<span class="st"><span class="w">brief waiting</span><span class="when">${esc(dur(b.t))}</span></span>
      <span class="t">${esc(b.goal || 'Pick up from the brief')}</span>
      <span class="l">${esc(target)}</span>`,
  };
}

function subsHtml(s) {
  const items = [];
  const memory = (s.inputs || []).filter((x) => x.kind === 'memory').at(-1);
  if (memory) items.push(`<span class="sub mem"><i></i>memory <span class="n">${(memory.notes || []).length}</span></span>`);
  for (const hp of Object.values(s.helpers || {}).slice(-3)) {
    items.push(`<span class="sub${hp.state === 'working' ? ' on' : ''}"><i></i>${esc(String(hp.type || 'helper').toLowerCase())}</span>`);
  }
  const more = Object.keys(s.helpers || {}).length - 3;
  if (more > 0) items.push(`<span class="sub n">+${more}</span>`);
  return items.join('');
}

// ---------------------------------------------------------------- render

export function renderLineage(S, UI, visible) {
  if (!L.stage) return;
  L.args = [S, UI, visible];
  if (L.weekStart == null) L.weekStart = mondayOf(Date.now());
  L.linking = UI.linking && Array.isArray(UI.linking.sources) && UI.linking.sources.length ? UI.linking : null;
  if (!L.linking) L.linkHover = null;
  const model = buildModel(S, UI, visible);
  const ctx = {
    selected: UI.selected,
    picked: model.picked,
    handoff: UI.handoff,
    byId: model.byId,
    lit: null,
    canRun: Boolean(S.info && S.info.claude && S.info.claude.found),
    linkSrc: new Set(L.linking ? L.linking.sources : []),
  };
  if (UI.selected && model.byId.has(UI.selected) && !UI.handoff.active && !L.linking) {
    const set = lineageOf(UI.selected, model.edges);
    if (set.size > 1) ctx.lit = set;
  }
  L.last = { model, ctx };

  // 1. Nodes: work out where each sits first (for the "from earlier" mark), create or update, then measure.
  const ws = model.ws;
  const wanted = new Map();
  for (const s of model.sessions) {
    const mode = nodeMode(s, model, ctx);
    const start = s.startedAt || s.lastAt || 0;
    const r = chatNodeHtml(s, mode, ctx, start && start < ws ? start : null);
    wanted.set(s.id, { ...r, sub: mode === 'full' ? subsHtml(s) : '' });
  }
  for (const p of model.pseudo) wanted.set(p.id, { ...briefNodeHtml(p, ctx), sub: '' });

  for (const [id, el] of L.els) {
    if (!wanted.has(id)) {
      if (L.hovered === id) unhover();
      el.node.remove();
      if (el.subs) el.subs.remove();
      L.els.delete(id);
    }
  }
  const fresh = [];
  for (const [id, r] of wanted) {
    let el = L.els.get(id);
    if (!el) {
      const node = document.createElement('div');
      node.dataset.id = id;
      if (!id.startsWith('brief:')) {
        node.dataset.open = id;
        node.tabIndex = 0;
        node.setAttribute('role', 'button');
      } else if (id === 'brief:draft') {
        node.dataset.draft = '1';
        node.tabIndex = 0;
        node.setAttribute('role', 'button');
      }
      const subs = document.createElement('div');
      subs.className = 'subs';
      L.layer.append(node, subs);
      el = { node, subs, html: '', sub: '' };
      L.els.set(id, el);
      fresh.push(id);
    }
    if (el.node.className !== r.cls) el.node.className = r.cls;
    if (el.html !== r.html) {
      const focused = el.node.contains(document.activeElement) ? document.activeElement.dataset : null;
      el.node.innerHTML = r.html;
      el.html = r.html;
      if (focused && focused.allow) $('[data-allow]', el.node)?.focus();
    }
    el.node.setAttribute('aria-label', r.label);
    if (r.tip) el.node.title = r.tip;
    else el.node.removeAttribute('title');
    if (ctx.selected === id) el.node.setAttribute('aria-current', 'true');
    else el.node.removeAttribute('aria-current');
    if (el.sub !== r.sub) {
      el.subs.innerHTML = r.sub;
      el.sub = r.sub;
    }
    el.subs.hidden = !r.sub;
    el.subs.classList.toggle('dim', Boolean(ctx.lit && !ctx.lit.has(id)));
  }

  const sizes = new Map();
  for (const [id, el] of L.els) sizes.set(id, { h: el.node.offsetHeight || 60, sub: el.sub ? SUB_GAP + SUB_H : 0 });

  // 2. Layout and place.
  const lay = layout(model, sizes);
  L.pos = lay.pos;
  L.bounds = { width: lay.width, height: lay.height, lanes: lay.laneBoxes };
  for (const [id, el] of L.els) {
    const p = lay.pos.get(id);
    if (!p) { el.node.style.visibility = 'hidden'; continue; }
    el.node.style.visibility = '';
    const isFresh = fresh.includes(id);
    if (isFresh) el.node.style.transition = 'none';
    el.node.style.transform = `translate(${p.x}px, ${p.y}px)`;
    if (el.sub) {
      if (isFresh) el.subs.style.transition = 'none';
      el.subs.style.transform = `translate(${p.x + 10}px, ${p.y + p.h + SUB_GAP}px)`;
    }
    if (isFresh) requestAnimationFrame(() => { el.node.style.transition = ''; el.subs.style.transition = ''; });
  }

  // 3. Days, lanes, lines and links to other weeks.
  drawDays(lay);
  drawLanes(lay);
  drawEdges(model, lay, ctx);
  drawStubs(model, lay);
  renderOverlay(S, UI, model);
  L.stage.classList.toggle('linking', Boolean(L.linking));
  drawBand();

  // Until you pan or zoom, the view keeps the whole week in sight.
  const key = `${L.weekStart}:${Math.round(lay.width)}x${Math.round(lay.height)}`;
  if (!L.userMoved && key !== L.fitKey) {
    fit(L.fitted);
    L.fitted = true;
    L.fitKey = key;
  }
  scheduleAvoid();
}

function drawLanes(lay) {
  for (const el of $$('.lane-rule, .lane-label', L.layer)) el.remove();
  const frag = document.createDocumentFragment();
  for (const lane of lay.laneBoxes) {
    const rule = document.createElement('div');
    rule.className = 'lane-rule';
    rule.style.transform = `translate(${PAD_X}px, ${lane.top - 8}px)`;
    rule.style.width = `${lay.width - PAD_X * 2}px`;
    const label = document.createElement('div');
    label.className = 'lane-label';
    label.style.transform = `translate(${PAD_X + COL_PAD}px, ${lane.top}px)`;
    label.innerHTML = `<b>${esc(lane.name)}</b><span>${esc(tildePath(lane.path))}</span>${lane.path ? `<button type="button" class="lane-new" data-new-chat="${esc(lane.path)}">+ new chat</button>` : ''}`;
    frag.append(rule, label);
  }
  L.layer.prepend(frag);
}

// The calendar behind the chats: a header per day, faint lines between days, today tinted.
function drawDays(lay) {
  const h = lay.height - PAD_Y;
  const parts = [];
  for (const c of lay.cols) {
    parts.push(`<div class="day-col${c.today ? ' today' : ''}${c.future ? ' future' : ''}" style="transform:translate(${c.x}px, ${PAD_Y}px);width:${c.w}px;height:${h}px"><span class="day-head"><b>${esc(c.label.main)}</b>${c.label.sub ? `<i>${esc(c.label.sub)}</i>` : ''}${c.today ? '<em class="now">now</em>' : ''}</span></div>`);
  }
  L.days.innerHTML = parts.join('');
}

function bezier(x1, y1, x2, y2) {
  const dx = Math.max(36, Math.abs(x2 - x1) / 2);
  const c1 = x1 + dx;
  const c2 = x2 - dx;
  const at = (t) => {
    const u = 1 - t;
    return [u * u * u * x1 + 3 * u * u * t * c1 + 3 * u * t * t * c2 + t * t * t * x2, u * u * u * y1 + 3 * u * u * t * y1 + 3 * u * t * t * y2 + t * t * t * y2];
  };
  return { d: `M ${x1} ${y1} C ${c1} ${y1}, ${c2} ${y2}, ${x2} ${y2}`, mx: at(0.5)[0], my: at(0.5)[1], at };
}

// A line with rounded corners through a list of points.
function rounded(points, r = 10) {
  const pts = points.filter((p, i) => i === 0 || p[0] !== points[i - 1][0] || p[1] !== points[i - 1][1]);
  let d = `M ${pts[0][0]} ${pts[0][1]}`;
  for (let i = 1; i < pts.length - 1; i += 1) {
    const [px, py] = pts[i - 1];
    const [cx, cy] = pts[i];
    const [nx, ny] = pts[i + 1];
    const d1 = Math.hypot(cx - px, cy - py);
    const d2 = Math.hypot(nx - cx, ny - cy);
    if (!d1 || !d2) continue;
    const rr = Math.min(r, d1 / 2, d2 / 2);
    d += ` L ${cx - ((cx - px) / d1) * rr} ${cy - ((cy - py) / d1) * rr} Q ${cx} ${cy} ${cx + ((nx - cx) / d2) * rr} ${cy + ((ny - cy) / d2) * rr}`;
  }
  const last = pts[pts.length - 1];
  return `${d} L ${last[0]} ${last[1]}`;
}

// The line from one chat to another. A plain curve when nothing is in the way;
// otherwise it steps into the free gap between columns and runs along the gap
// between lanes, so it never hides behind another chat.
function route(a, b, aId, bId, lay) {
  const x1 = a.x + NODE_W;
  const y1 = a.y + a.h / 2;
  const y2 = b.y + b.h / 2;
  // Same day: down the side of the column, into the chat from its right.
  if (Math.abs(b.x - a.x) < 1) {
    const gx = x1 + COL_PAD - 2;
    const ex = b.x + NODE_W;
    return { d: rounded([[x1, y1], [gx, y1], [gx, y2], [ex, y2]], 6), mx: gx + 4, my: (y1 + y2) / 2, inX: ex, side: true };
  }
  const x2 = b.x;
  const curve = bezier(x1, y1, x2, y2);
  const pad = 4;
  const blocks = [];
  for (const [id, p] of lay.pos) {
    if (id === aId || id === bId) continue;
    blocks.push([p.x - pad, p.y - pad, p.x + NODE_W + pad, p.y + p.h + pad]);
  }
  let hit = x2 < x1 + 16 || a.lane !== b.lane;
  for (let i = 1; i < 20 && !hit; i += 1) {
    const [px, py] = curve.at(i / 20);
    hit = blocks.some(([l, t, r, bt]) => px > l && px < r && py > t && py < bt);
  }
  if (!hit) return curve;
  const laneA = lay.laneBoxes.find((l) => l.key === a.lane);
  const laneB = lay.laneBoxes.find((l) => l.key === b.lane);
  let cy;
  if (!laneA || !laneB || laneA === laneB) cy = (laneA || laneB).top + 24;
  else cy = Math.max(laneA.top, laneB.top) - 18;
  const gx1 = x1 + COL_PAD - 2;
  const gx2 = x2 - COL_PAD + 2;
  const d = rounded([[x1, y1], [gx1, y1], [gx1, cy], [gx2, cy], [gx2, y2], [x2, y2]], 6);
  return { d, mx: (gx1 + gx2) / 2, my: cy };
}

function drawEdges(model, lay, ctx) {
  const parts = [];
  const port = (x, y, cls) => `<circle class="${cls}" cx="${x}" cy="${y}" r="3"/>`;
  const mid = (p) => p.y + p.h / 2;
  const labels = [];

  // Trails: from each chat to the last day it was active this week, a dot on every active day.
  for (const s of model.sessions) {
    const p = lay.pos.get(s.id);
    if (!p || p.endCol <= p.col) continue;
    const k = bucket(s);
    const cls = `trail${k === 'working' ? ' on' : k === 'needs' ? ' needs' : ''}${ctx.lit && !ctx.lit.has(s.id) ? ' dim' : ''}`;
    const y = p.y + Math.min(p.h / 2, 16);
    const endX = lay.cols[p.endCol].x + lay.cols[p.endCol].w / 2;
    parts.push(`<path class="${cls}" d="M ${p.x + NODE_W} ${y} H ${endX}"/>`);
    for (const c of p.dayCols) {
      if (c === p.col) continue;
      parts.push(`<circle class="${cls}" cx="${lay.cols[c].x + lay.cols[c].w / 2}" cy="${y}" r="${c === p.endCol ? 3 : 2.25}"/>`);
    }
  }

  for (const e of model.edges) {
    const a = lay.pos.get(e.from);
    const b = lay.pos.get(e.to);
    if (!a || !b) continue;
    const lit = ctx.lit && ctx.lit.has(e.from) && ctx.lit.has(e.to) ? ' lit' : '';
    const dim = ctx.lit && !lit ? ' dim' : '';
    const c = route(a, b, e.from, e.to, lay);
    const kind = e.kind === 'memory' ? 'memory' : e.kind === 'continue' ? 'continue' : 'brief';
    parts.push(`<path class="${kind}${lit}${dim}" d="${c.d}"/>`);
    const inX = c.inX ?? b.x;
    parts.push(port(a.x + NODE_W, mid(a), `out${lit}`));
    parts.push(kind === 'continue' ? `<circle class="in ring${lit}" cx="${inX + (c.side ? 5 : -5)}" cy="${mid(b)}" r="4"/>` : port(inX, mid(b), `in${lit}`));
    if (lit || !ctx.lit) labels.push(`<text class="${lit.trim()}" x="${c.mx}" y="${c.my - 5}" text-anchor="${c.side ? 'start' : 'middle'}">${kind === 'continue' ? 'continued' : kind}</text>`);
  }
  for (const p of model.pseudo) {
    const b = lay.pos.get(p.id);
    if (!b) continue;
    for (const src of p.from) {
      const a = lay.pos.get(src);
      if (!a) continue;
      const c = route(a, b, src, p.id, lay);
      parts.push(`<path class="${p.kind === 'draft' ? 'draft' : 'waiting'}" d="${c.d}"/>`);
      parts.push(port(a.x + NODE_W, mid(a), 'out'), port(c.inX ?? b.x, mid(b), 'in'));
    }
  }
  // Links to chats in other weeks: a short dashed stub to the edge of the week.
  for (const st of model.stubs) {
    const p = lay.pos.get(st.id);
    if (!p) continue;
    const y = mid(p);
    const cls = `stub ${st.kind === 'memory' ? 'memory' : st.kind === 'continue' ? 'continue' : 'brief'}`;
    if (st.side === 'left') parts.push(`<path class="${cls}" d="M ${PAD_X - 6} ${y} H ${p.x}"/>`, port(p.x, y, 'in'));
    else parts.push(`<path class="${cls}" d="M ${p.x + NODE_W} ${y} H ${lay.width - PAD_X + 6}"/>`, port(p.x + NODE_W, y, 'out'));
  }
  // Helpers and memory hang off the bottom of their chat.
  for (const s of model.sessions) {
    const p = lay.pos.get(s.id);
    const el = L.els.get(s.id);
    if (!p || !el || !el.sub) continue;
    const x = p.x + 13.5;
    parts.push(`<path class="sub-line" d="M ${x} ${p.y + p.h} V ${p.y + p.h + SUB_GAP + 4}"/>`);
  }
  L.svg.setAttribute('width', lay.width);
  L.svg.setAttribute('height', lay.height);
  L.svg.innerHTML = parts.join('') + labels.join('');
}

// The labels on links to other weeks, as buttons that jump to that week.
function drawStubs(model, lay) {
  for (const el of $$('.week-stub', L.layer)) el.remove();
  const frag = document.createDocumentFragment();
  const used = new Map();
  for (const st of model.stubs) {
    const p = lay.pos.get(st.id);
    if (!p) continue;
    const key = `${st.id}:${st.side}`;
    const n = used.get(key) || 0;
    used.set(key, n + 1);
    const b = document.createElement('button');
    b.type = 'button';
    b.className = `week-stub ${st.side}`;
    b.dataset.weekJump = String(st.t);
    const title = trim(st.other.title || 'a chat', 26);
    b.textContent = `${st.dir === 'from' ? 'from' : 'to'} ${title} · ${fmtDay(st.t)}`;
    b.title = `${st.dir === 'from' ? 'Came from' : 'Led to'} "${st.other.title || 'a chat'}". Go to that week.`;
    const y = p.y + p.h / 2 + 4 + n * 18;
    if (st.side === 'left') b.style.transform = `translate(${PAD_X - 4}px, ${y}px)`;
    else b.style.transform = `translate(${p.x + NODE_W + 8}px, ${y}px)`;
    frag.append(b);
  }
  L.layer.append(frag);
}

// ---------------------------------------------------------------- linking: the rubber band

function drawBand() {
  if (!L.band) return;
  if (!L.linking || !L.ptr) {
    L.band.innerHTML = '';
    return;
  }
  const { x: px, y: py } = L.ptr;
  const parts = [];
  for (const id of L.linking.sources) {
    const p = L.pos.get(id);
    if (!p) continue;
    const c = bezier(p.x + NODE_W, p.y + p.h / 2, px, py);
    parts.push(`<path d="${c.d}"/><circle class="src" cx="${p.x + NODE_W}" cy="${p.y + p.h / 2}" r="3.5"/>`);
  }
  if (parts.length) parts.push(`<circle class="tip" cx="${px}" cy="${py}" r="4"/>`);
  const w = Math.max(L.bounds ? L.bounds.width : 0, px + 20);
  const h = Math.max(L.bounds ? L.bounds.height : 0, py + 20);
  L.band.setAttribute('width', w);
  L.band.setAttribute('height', h);
  L.band.innerHTML = parts.join('');
}

function setLinkHover(id) {
  if (L.linkHover === id) return;
  const prev = L.linkHover && L.els.get(L.linkHover);
  if (prev) prev.node.classList.remove('link-hover');
  L.linkHover = id;
  const el = id && L.els.get(id);
  if (el && !(L.linking && L.linking.sources.includes(id))) el.node.classList.add('link-hover');
}

// ---------------------------------------------------------------- overlay

function weekBarHtml(model) {
  const current = mondayOf(Date.now());
  const max = Math.max(1, ...model.strip.map((w) => w.n));
  const cells = model.strip.map((w) => {
    const level = w.n ? Math.max(0.18, w.n / max) : 0;
    const on = w.ws === model.ws;
    return `<button type="button" class="wk${on ? ' on' : ''}${w.n ? '' : ' none'}" data-week-start="${w.ws}" style="--lv:${level.toFixed(2)}" aria-label="Week of ${esc(weekLabel(w.ws))}: ${plural(w.n, 'chat')}" title="${esc(weekLabel(w.ws))}: ${plural(w.n, 'chat')}"></button>`;
  }).join('');
  return `<div class="weekbar" role="group" aria-label="Week">
    <button type="button" class="wb-nav" data-week-nav="-1" aria-label="Previous week">‹</button>
    <span class="wb-label">${esc(weekLabel(model.ws))}${model.current ? ' <i>this week</i>' : ''}</span>
    <button type="button" class="wb-nav" data-week-nav="1" aria-label="Next week" ${model.ws >= current ? 'disabled' : ''}>›</button>
    ${model.current ? '' : '<button type="button" class="wb-today" data-week-nav="today">today</button>'}
    <span class="wb-strip" aria-label="The last 8 weeks">${cells}</span>
  </div>`;
}

function renderOverlay(S, UI, model) {
  const sessions = model.sessions;
  const projects = new Set(sessions.map(laneKey)).size;
  const demo = S.info.mode === 'demo';
  const tl = sessions.length ? `${plural(sessions.length, 'chat')} in ${plural(projects, 'project')} this week` : '';
  const picking = UI.handoff.active;
  let html = '';
  if (model.all.length) html += weekBarHtml(model);
  html += `<div class="cap tl">${esc(tl)}${demo ? `${tl ? ' · ' : ''}these chats are fake, so try everything` : ''}</div><div class="cap tr" data-tick="clock"></div>`;
  if (model.all.length) html += `<div class="ctl bl" role="group" aria-label="Zoom"><button type="button" class="btn sq soft" data-zoom="out" aria-label="Zoom out">−</button><button type="button" class="btn sq soft" data-zoom="in" aria-label="Zoom in">+</button><button type="button" class="btn soft" data-zoom="fit">fit</button></div>`;
  if (L.linking) {
    const n = L.linking.sources.length;
    html += `<div class="banner link-banner"><span>Connecting from ${plural(n, 'chat')}. Click the chat to send it to, or "+ new chat" in a project. Esc cancels.</span><button type="button" class="btn sm soft" data-link-cancel>cancel</button></div>`;
  } else if (picking) {
    html += '<div class="banner"><span>Click chats to add them to the brief.</span><button type="button" class="btn sm soft" data-handoff-cancel>cancel</button></div>';
  }
  if (sessions.length) html += `<div class="legend" aria-hidden="true">
    <span><svg width="22" height="8"><path d="M1 4 H21" stroke="var(--line-2)" stroke-width="1.25"/><circle cx="21" cy="4" r="2.5" fill="var(--paper)" stroke="var(--line-2)"/></svg>brief</span>
    <span><svg width="22" height="8"><path d="M1 4 H21" stroke="var(--ink-3)" stroke-width="1.5" stroke-dasharray="0.5 5" stroke-linecap="round"/></svg>memory</span>
    <span><svg width="24" height="10"><path d="M1 5 H17" stroke="var(--line-2)" stroke-width="1.25"/><circle cx="20" cy="5" r="3.5" fill="none" stroke="var(--line-2)" stroke-width="1.25"/></svg>continued</span>
    <span><svg width="8" height="8"><circle cx="4" cy="4" r="3" fill="var(--paper)" stroke="var(--ink-2)"/></svg>helper</span>
    <span><svg width="8" height="10"><rect x="1" y="0" width="6" height="10" fill="var(--accent)"/></svg>working</span>
  </div>`;
  if (!model.all.length) html += emptyHtml(S);
  else if (!sessions.length) html += `<div class="week-empty">No chats this week.${model.current ? '' : ' <button type="button" class="linkish" data-week-nav="today">back to this week</button>'}</div>`;
  L.overlay.innerHTML = html;
  L.stage.classList.toggle('picking', picking);
  const clockEl = $('[data-tick="clock"]', L.overlay);
  if (clockEl && L.hooks.clockText) clockEl.textContent = L.hooks.clockText();
}

function emptyHtml(S) {
  const link = S.info.link || {};
  if (!S.connected) return '<div class="empty-canvas"><h1>Kroog is offline.</h1><p>Is the Terminal window that runs Kroog still open? Start it again with <code>node bin/kroog.js start</code>.</p></div>';
  if (S.info.mode !== 'demo' && !link.linked) return '<div class="empty-canvas"><h1>Link Kroog to Claude Code to see your chats.</h1><p>It adds a few hooks to ~/.claude/settings.json, with a backup first. No editor plugin needed.</p><a class="btn" href="#/setup">open setup</a></div>';
  return '<div class="empty-canvas"><h1>No chats yet.</h1><p>Start a chat in the Claude Code panel in VS Code or Cursor. It appears here as soon as you send your first message. Chats you used before linking can be brought in from Claude Code\'s history.</p>' + (S.info.mode === 'demo' ? '' : '<button type="button" class="btn" id="do-import">import recent chats</button>') + '</div>';
}

// ---------------------------------------------------------------- view: pan and zoom

function applyView(glide = false) {
  if (!L.world) return;
  L.world.style.transition = glide ? 'transform 0.35s cubic-bezier(0.2, 0.7, 0.2, 1)' : 'none';
  L.world.style.transform = `translate(${L.view.x}px, ${L.view.y}px) scale(${L.view.k})`;
  scheduleAvoid();
}

function stageRect() {
  return L.stage.getBoundingClientRect();
}

// Fit the week: as wide as the screen, top aligned like a calendar. On a narrow screen
// it shrinks to half size at most, starting at today's side, and you pan for the rest.
export function fit(glide = true, byYou = false) {
  if (!L.stage || !L.bounds) return;
  if (byYou) L.userMoved = false;
  unhover();
  const r = stageRect();
  const side = 16;
  const w = L.bounds.width;
  const k = Math.max(0.5, Math.min(1, (r.width - side * 2) / w));
  let x;
  if (w * k <= r.width - side * 2) x = (r.width - w * k) / 2;
  else {
    // Keep today (or the week's end) in sight.
    const todayCol = Math.max(0, Math.min(6, Math.round((dayStart(Date.now()) - L.weekStart) / DAY_MS)));
    const col = L.weekStart === mondayOf(Date.now()) ? todayCol : 6;
    const colW = (w - PAD_X * 2) / 7;
    const right = (PAD_X + (col + 1) * colW + PAD_X) * k;
    x = Math.min(side, r.width - side - right);
  }
  const y = TOP_SPACE;
  L.view = { x, y, k };
  applyView(glide);
}

export function zoomBy(factor, cx, cy) {
  if (!L.stage) return;
  unhover();
  L.userMoved = true;
  const r = stageRect();
  const px = cx ?? r.width / 2;
  const py = cy ?? r.height / 2;
  const k = Math.max(0.3, Math.min(1.6, L.view.k * factor));
  const wx = (px - L.view.x) / L.view.k;
  const wy = (py - L.view.y) / L.view.k;
  L.view = { k, x: px - wx * k, y: py - wy * k };
  applyView(cx == null);
}

// Bring a chat into view, leaving room around it. Switches to its week if needed.
export function reveal(id, center = false) {
  if (!L.stage) return;
  if (!L.pos.has(id) && L.args) {
    const s = L.args[2].find((x) => x.id === id);
    if (s) showWeekOf(s.lastAt || s.startedAt);
  }
  const p = L.pos.get(id);
  if (!p) return;
  const r = stageRect();
  const k = L.view.k;
  const x1 = p.x * k + L.view.x;
  const y1 = p.y * k + L.view.y;
  const x2 = x1 + NODE_W * k;
  const y2 = y1 + (p.h + p.sub) * k;
  const m = 40;
  let { x, y } = L.view;
  if (center) {
    x = r.width / 2 - (p.x + NODE_W / 2) * k;
    y = r.height / 2 - (p.y + p.h / 2) * k;
  } else {
    if (x1 < m) x += m - x1;
    else if (x2 > r.width - m) x -= x2 - (r.width - m);
    if (y1 < TOP_SPACE + 30) y += TOP_SPACE + 30 - y1;
    else if (y2 > r.height - m - 40) y -= y2 - (r.height - m - 40);
  }
  if (x === L.view.x && y === L.view.y) return;
  L.view = { ...L.view, x, y };
  applyView(true);
}

export function nextNeeding(after) {
  if (!L.last) return null;
  const ids = [];
  for (const key of L.laneOrder) {
    const inLane = L.last.model.sessions.filter((s) => laneKey(s) === key && (s.status === 'needs' || s.status === 'error'));
    inLane.sort((a, b) => (L.pos.get(a.id)?.y || 0) - (L.pos.get(b.id)?.y || 0));
    ids.push(...inLane.map((s) => s.id));
  }
  // Chats that need you in other weeks too.
  if (L.args) {
    for (const s of L.args[2]) if ((s.status === 'needs' || s.status === 'error') && !ids.includes(s.id)) ids.push(s.id);
  }
  if (!ids.length) return null;
  const i = ids.indexOf(after);
  return ids[(i + 1) % ids.length];
}

function toWorld(e) {
  const r = stageRect();
  return { x: (e.clientX - r.left - L.view.x) / L.view.k, y: (e.clientY - r.top - L.view.y) / L.view.k };
}

function bindStage() {
  const stage = L.stage;
  const onBackground = (e) => !e.target.closest('.node, .ctl, .banner, .weekbar, .week-stub, button, a, input, textarea, select');

  // The week bar and links to other weeks.
  stage.addEventListener('click', (e) => {
    const t = e.target.closest('[data-week-nav], [data-week-start], [data-week-jump]');
    if (!t || !stage.contains(t)) return;
    e.preventDefault();
    if (t.dataset.weekNav === 'today') showWeekOf(Date.now());
    else if (t.dataset.weekNav) shiftWeek(Number(t.dataset.weekNav));
    else if (t.dataset.weekStart) showWeekOf(Number(t.dataset.weekStart));
    else if (t.dataset.weekJump) showWeekOf(Number(t.dataset.weekJump));
  });

  stage.addEventListener('pointerdown', (e) => {
    if (!onBackground(e) || (e.pointerType === 'mouse' && e.button !== 0)) return;
    L.pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    stage.setPointerCapture(e.pointerId);
    if (L.pointers.size === 1) {
      L.drag = { x: e.clientX, y: e.clientY, vx: L.view.x, vy: L.view.y, moved: false };
    } else if (L.pointers.size === 2) {
      const [a, b] = [...L.pointers.values()];
      L.pinch = { d: Math.hypot(a.x - b.x, a.y - b.y), k: L.view.k };
      L.drag = null;
    }
  });
  stage.addEventListener('pointermove', (e) => {
    // While connecting chats, a line follows the pointer from the chats you started from.
    if (L.linking) {
      L.ptr = toWorld(e);
      const node = e.target.closest ? e.target.closest('.node[data-open]') : null;
      setLinkHover(node ? node.dataset.open : null);
      drawBand();
    }
    if (!L.pointers.has(e.pointerId)) return;
    L.pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (L.pinch && L.pointers.size === 2) {
      const [a, b] = [...L.pointers.values()];
      const r = stageRect();
      const d = Math.hypot(a.x - b.x, a.y - b.y);
      const target = Math.max(0.3, Math.min(1.6, L.pinch.k * (d / L.pinch.d)));
      zoomBy(target / L.view.k, (a.x + b.x) / 2 - r.left, (a.y + b.y) / 2 - r.top);
      return;
    }
    if (!L.drag) return;
    const dx = e.clientX - L.drag.x;
    const dy = e.clientY - L.drag.y;
    if (!L.drag.moved && Math.hypot(dx, dy) < 4) return;
    if (!L.drag.moved) unhover();
    L.drag.moved = true;
    L.userMoved = true;
    stage.classList.add('panning');
    L.view = { ...L.view, x: L.drag.vx + dx, y: L.drag.vy + dy };
    applyView();
  });
  stage.addEventListener('pointerleave', () => {
    if (!L.linking) return;
    L.ptr = null;
    setLinkHover(null);
    drawBand();
  });
  const end = (e) => {
    if (!L.pointers.has(e.pointerId)) return;
    L.pointers.delete(e.pointerId);
    if (L.pointers.size < 2) L.pinch = null;
    if (L.drag && !L.drag.moved && e.type === 'pointerup' && L.hooks.onBackground) L.hooks.onBackground();
    if (!L.pointers.size) L.drag = null;
    stage.classList.remove('panning');
  };
  stage.addEventListener('pointerup', end);

  // Resting the pointer on a chat (or focusing it) asks for its summary card.
  const chatOf = (t) => (t && t.closest ? t.closest('.node[data-open]') : null);
  stage.addEventListener('pointerover', (e) => {
    if (e.pointerType === 'touch' || (L.drag && L.drag.moved) || L.pinch || L.linking) return;
    const node = chatOf(e.target);
    if (!node || node.dataset.open === L.hovered) return;
    clearTimeout(L.hoverTimer);
    L.hoverTimer = setTimeout(() => hover(node), 350);
  });
  stage.addEventListener('pointerout', (e) => {
    const node = chatOf(e.target);
    if (!node || node.contains(e.relatedTarget)) return;
    clearTimeout(L.hoverTimer);
    if (L.hovered === node.dataset.open) unhover();
  });
  stage.addEventListener('focusin', (e) => {
    const node = e.target.matches && e.target.matches('.node[data-open]') ? e.target : null;
    if (node && !L.linking) hover(node);
  });
  stage.addEventListener('focusout', (e) => {
    const node = e.target.matches && e.target.matches('.node[data-open]') ? e.target : null;
    if (node && L.hovered === node.dataset.open) unhover();
  });
  stage.addEventListener('pointercancel', end);
  stage.addEventListener('wheel', (e) => {
    if (e.target.closest('.ctl, .banner, .weekbar')) return;
    e.preventDefault();
    const r = stageRect();
    if (e.ctrlKey || e.metaKey) {
      zoomBy(Math.exp(-e.deltaY * 0.01), e.clientX - r.left, e.clientY - r.top);
    } else {
      unhover();
      L.userMoved = true;
      L.view = { ...L.view, x: L.view.x - e.deltaX, y: L.view.y - e.deltaY };
      applyView();
    }
  }, { passive: false });
  let resizeTimer = null;
  new ResizeObserver(() => {
    scheduleAvoid();
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => {
      // Columns follow the width of the screen, so lay out again.
      L.fitKey = '';
      rerender();
      if (L.hooks.selected && L.hooks.selected()) reveal(L.hooks.selected());
    }, 120);
  }).observe(stage);
}

function hover(node) {
  clearTimeout(L.hoverTimer);
  if (!node.isConnected) return;
  L.hovered = node.dataset.open;
  if (L.hooks.hover) L.hooks.hover(L.hovered, node.getBoundingClientRect());
}

function unhover() {
  clearTimeout(L.hoverTimer);
  if (!L.hovered) return;
  L.hovered = null;
  if (L.hooks.unhover) L.hooks.unhover();
}

// ---------------------------------------------------------------- water: steer around the work

let avoidQueued = false;
function scheduleAvoid() {
  if (!L.water || avoidQueued) return;
  avoidQueued = true;
  requestAnimationFrame(() => {
    avoidQueued = false;
    if (!L.water || !L.stage) return;
    const { x, y, k } = L.view;
    const pad = 14;
    const boxes = [];
    for (const [id, p] of L.pos) {
      const el = L.els.get(id);
      if (!el) continue;
      boxes.push({ l: p.x * k + x - pad, t: p.y * k + y - pad, r: (p.x + NODE_W) * k + x + pad, b: (p.y + p.h + p.sub) * k + y + pad });
    }
    for (const lane of (L.bounds && L.bounds.lanes) || []) {
      boxes.push({ l: PAD_X * k + x - pad, t: lane.top * k + y - pad, r: (PAD_X + 420) * k + x + pad, b: (lane.top + 22) * k + y + pad });
    }
    if (L.bounds) boxes.push({ l: PAD_X * k + x - pad, t: PAD_Y * k + y - pad, r: (L.bounds.width - PAD_X) * k + x + pad, b: (PAD_Y + DAY_HEAD) * k + y + pad });
    const s = stageRect();
    for (const el of $$('.cap, .ctl, .legend, .banner, .weekbar, .week-empty, .empty-canvas', L.overlay)) {
      const r = el.getBoundingClientRect();
      if (r.width) boxes.push({ l: r.left - s.left - pad, t: r.top - s.top - pad, r: r.right - s.left + pad, b: r.bottom - s.top + pad });
    }
    L.water.setAvoid(boxes);
  });
}
