// Kroog browser app. Plain JavaScript modules, no build step. Talks only to the Kroog server on this Mac.
import {
  $, $$, esc, trim, clipText, words, lowerFirst, plural, EDITORS, NOTE_TYPES,
  dur, clock, dayish, countdownText, edName, editorUrl, bucket, look, whenText, lineText, firstLine,
  visibleSessions, hiddenByScope, shortFile, folderName, tildePath, cellsHtml,
} from './util.js';
import { renderBrain } from './brain.js';
import { mountLineage, unmountLineage, renderLineage, isMounted, fit, zoomBy, reveal, nextNeeding, setWater, themeChanged, shiftWeek } from './lineage.js';

const S = { sessions: new Map(), notes: [], briefs: [], settings: {}, info: {}, connected: false, lastEventAt: 0 };
const UI = {
  route: 'lineage',
  selected: null,
  logOpen: false,
  demoSeen: false,
  list: { filter: 'all', query: '' },
  handoff: { active: false, sources: [], notes: [], goal: '', target: 'new', editor: '', runTarget: '', memoryCwd: '', short: false, run: 'editor', newCwd: '', aiText: null, aiBusy: false },
  // A new chat started from a lane's "+ new chat".
  newChat: null,
  hover: null,
  // Connecting chats: the link key on a chat starts it; clicking another chat finishes it.
  linking: null,
  library: { kind: 'all', query: '', project: 'all', memCwd: '', adding: false },
  previous: new Map(),
};

const store = {
  get(key, fallback) { try { return localStorage.getItem(key) ?? fallback; } catch { return fallback; } },
  set(key, value) { try { localStorage.setItem(key, value); } catch { /* private window */ } },
};
const waterOn = () => store.get('kroog-water', 'on') !== 'off';
// Kroog can run chats itself when it found Claude Code on this Mac.
const canRun = () => Boolean(S.info.claude && S.info.claude.found);
const aiOn = () => Boolean(S.info.ai && S.info.ai.provider && S.info.ai.provider !== 'off');
const kroogRunning = (s) => Boolean(s.kroogRunning);
const aiBasis = (s) => `${s.status}|${(s.steps || []).length}|${(s.lastReply || '').length}`;
const aiFresh = (s) => Boolean(s.ai && s.ai.basis === aiBasis(s));
const asked = new Map();
// Ask for a summary when you look at a chat, at most once a minute per chat.
function wantSummary(s, force = false) {
  if (!s || !aiOn() || S.settings.aiSummaries === 'off') return;
  if (!s.lastReply && !s.lastPrompt) return;
  if (!force && (aiFresh(s) || s.aiPending)) return;
  const last = asked.get(s.id) || 0;
  if (!force && Date.now() - last < 60000) return;
  asked.set(s.id, Date.now());
  post('summarize', { id: s.id, force }).catch(() => {});
}

// ---------------------------------------------------------------- server calls

async function post(path, body = {}) {
  const res = await fetch(`/api/${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Kroog-UI': '1' },
    body: JSON.stringify(body),
  });
  let data = {};
  try { data = await res.json(); } catch { data = {}; }
  if (!res.ok || data.ok === false) throw new Error(data.error || `Kroog could not do that (${res.status}).`);
  return data;
}

let toastTimer = null;
function toast(message, ms = 4200) {
  const el = $('#toast');
  el.textContent = message;
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.hidden = true; }, ms);
}

async function act(promise, okMessage) {
  try {
    const r = await promise;
    if (okMessage) toast(typeof okMessage === 'function' ? okMessage(r) : okMessage);
    return r;
  } catch (error) {
    toast(error.message, 6000);
    return null;
  }
}

function openUrl(url) {
  // Links like vscode:// open the editor. The browser may ask once to allow it.
  window.location.href = url;
}

// ---------------------------------------------------------------- live updates

function applySnapshot(data) {
  S.sessions = new Map(data.sessions.map((s) => [s.id, s]));
  S.notes = data.notes || [];
  S.briefs = data.briefs || [];
  S.settings = data.settings || {};
  S.info = data.info || {};
  for (const s of S.sessions.values()) UI.previous.set(s.id, s.status);
  S.lastEventAt = Date.now();
  if (!UI.handoff.editor) UI.handoff.editor = S.settings.defaultEditor || 'vscode';
  renderAll(false);
}

function connect() {
  const es = new EventSource('/api/stream');
  es.addEventListener('snapshot', (e) => applySnapshot(JSON.parse(e.data)));
  es.addEventListener('session', (e) => {
    const s = JSON.parse(e.data);
    const before = UI.previous.get(s.id);
    S.sessions.set(s.id, s);
    UI.previous.set(s.id, s.status);
    S.lastEventAt = Date.now();
    alertIfNeeded(before, s);
    scheduleRender();
  });
  es.addEventListener('notes', (e) => { S.notes = JSON.parse(e.data); scheduleRender(); });
  es.addEventListener('briefs', (e) => { S.briefs = JSON.parse(e.data); scheduleRender(); });
  es.addEventListener('settings', (e) => { S.settings = JSON.parse(e.data); scheduleRender(); });
  es.addEventListener('info', (e) => { S.info = JSON.parse(e.data); scheduleRender(); });
  es.onopen = () => { S.connected = true; renderTop(); };
  es.onerror = () => { S.connected = false; renderTop(); };
}

function alertIfNeeded(before, s) {
  if (!before || before === s.status) return;
  const shown = S.settings.ideOnly === false || s.kind === 'ide' || s.kind === 'kroog' || s.kind === 'unknown';
  if (!shown || s.archived) return;
  let title = null;
  let body = '';
  if (s.status === 'needs' && s.needs) {
    title = `Needs you: ${trim(s.title || 'a chat', 60)}`;
    body = s.needs.kind === 'permission' ? `Wants to ${lowerFirst(s.needs.title || 'do something')}` : trim(s.needs.title, 140);
  } else if (s.status === 'done' && before === 'working') {
    title = `Done: ${trim(s.title || 'a chat', 60)}`;
    body = firstLine(s.lastReply, 140);
  }
  if (!title) return;
  if (store.get('kroog-alerts', 'off') === 'on' && 'Notification' in window && Notification.permission === 'granted' && document.hidden) {
    const n = new Notification(title, { body, tag: s.id });
    n.onclick = () => { window.focus(); select(s.id); n.close(); };
  }
}

let renderQueued = false;
function scheduleRender() {
  if (renderQueued) return;
  renderQueued = true;
  requestAnimationFrame(() => {
    renderQueued = false;
    renderAll(false);
  });
}

// Keeps what you are typing when part of the page redraws.
function preserveFocus(fn) {
  const el = document.activeElement;
  const id = el && el.id && ['INPUT', 'TEXTAREA', 'SELECT'].includes(el.tagName) ? el.id : null;
  const value = id ? el.value : null;
  const start = id && el.selectionStart != null ? el.selectionStart : null;
  const end = id && el.selectionEnd != null ? el.selectionEnd : null;
  fn();
  if (!id) return;
  const again = document.getElementById(id);
  if (!again || again === el) return;
  if (again.value !== value && again.tagName !== 'SELECT') again.value = value;
  again.focus();
  if (start != null && again.setSelectionRange) {
    try { again.setSelectionRange(start, end); } catch { /* not a text field */ }
  }
}

// ---------------------------------------------------------------- render

function renderAll(routeChanged) {
  renderTop();
  const view = $('#view');
  if (UI.route === 'lineage') {
    if (!isMounted()) {
      view.classList.add('is-canvas');
      mountLineage(view, {
        waterOn,
        selected: () => UI.selected,
        clockText: () => clock(Date.now()),
        onBackground: () => {
          if (UI.selected) { UI.selected = null; renderAll(false); }
        },
        hover: (id, rect) => showHover(id, rect),
        unhover: () => hideHover(),
      });
    }
    renderLineage(S, UI, visibleSessions(S));
  } else {
    if (isMounted()) unmountLineage();
    hideHover();
    view.classList.remove('is-canvas');
    preserveFocus(() => {
      if (UI.route === 'list') renderList(routeChanged);
      else if (UI.route === 'library') renderLibrary();
      else if (UI.route === 'brain') renderBrain($('#view'), S, { post, toast, esc, openUrl });
      else renderSetup();
    });
  }
  renderSide();
  renderLog();
  refreshHover();
}

// ---------------------------------------------------------------- hover card (a short summary)

function hoverCardHtml(s) {
  const lk = look(s);
  const ai = s.ai;
  let body = '';
  if (ai && ai.gist) {
    body = `<p class="gist">${esc(ai.gist)}${!aiFresh(s) && s.aiPending ? ' <span class="quiet">(updating)</span>' : ''}</p>${keywordsHtml(ai)}`;
  } else if (s.aiPending) {
    body = '<p class="quiet">summarising<span class="dots"></span></p>';
  } else {
    const fallback = s.lastReply ? firstLine(s.lastReply, 110) : s.lastPrompt ? firstLine(s.lastPrompt, 110) : '';
    body = fallback ? `<p>${esc(fallback)}</p>` : `<p class="quiet">${aiOn() ? 'No summary yet.' : 'Turn on the AI helper in setup for summaries.'}</p>`;
  }
  return `<div class="hc-head"><span class="w k-${lk.k}">${esc(lk.word)}</span><span class="when">${esc(whenText(s))}</span></div>
    <b class="hc-title">${esc(trim(s.title || 'New chat', 90))}</b>
    <div class="hc-body">${body}</div>
    <div class="hc-foot">${esc(s.project || '')}${s.place ? ` · ${esc(s.place)}` : ''}${(s.files || []).length ? ` · ${plural(s.files.length, 'file')}` : ''}</div>`;
}

function keywordsHtml(ai) {
  const ks = (ai && ai.keywords) || [];
  return ks.length ? `<p class="kw">${ks.map((k) => `<span>${esc(k)}</span>`).join('')}</p>` : '';
}

function showHover(id, rect) {
  const s = S.sessions.get(id);
  if (!s || UI.handoff.active) return;
  UI.hover = { id, rect };
  wantSummary(s);
  refreshHover();
}

function hideHover() {
  UI.hover = null;
  const el = document.getElementById('hovercard');
  if (el) el.hidden = true;
}

function refreshHover() {
  if (!UI.hover) return;
  const s = S.sessions.get(UI.hover.id);
  if (!s || UI.route !== 'lineage') { hideHover(); return; }
  let el = document.getElementById('hovercard');
  if (!el) {
    el = document.createElement('div');
    el.id = 'hovercard';
    el.className = 'hovercard';
    el.setAttribute('role', 'tooltip');
    document.body.appendChild(el);
  }
  el.innerHTML = hoverCardHtml(s);
  el.hidden = false;
  const r = UI.hover.rect;
  const w = Math.min(300, window.innerWidth - 24);
  el.style.width = `${w}px`;
  const h = el.offsetHeight;
  let left = r.right + 12;
  if (left + w > window.innerWidth - 12) left = r.left - w - 12;
  if (left < 12) left = Math.max(12, Math.min(window.innerWidth - w - 12, r.left));
  let top = r.top;
  if (left === Math.max(12, Math.min(window.innerWidth - w - 12, r.left))) top = r.bottom + 8;
  top = Math.max(60, Math.min(top, window.innerHeight - h - 12));
  el.style.left = `${Math.round(left)}px`;
  el.style.top = `${Math.round(top)}px`;
}

function renderTop() {
  const needs = visibleSessions(S).filter((s) => s.status === 'needs' || s.status === 'error').length;
  const pill = $('#needs-pill');
  pill.hidden = needs === 0;
  $('#needs-count').textContent = String(needs);
  pill.setAttribute('aria-label', `${plural(needs, 'chat')} need${needs === 1 ? 's' : ''} you. Go to the next one.`);
  document.title = needs ? `(${needs}) kroog` : 'kroog';
  for (const a of $$('.nav a')) {
    if (a.dataset.route === UI.route) a.setAttribute('aria-current', 'page');
    else a.removeAttribute('aria-current');
  }
  const conn = $('#conn');
  conn.classList.toggle('off', !S.connected);
  conn.querySelector('span').textContent = S.connected ? (S.info.mode === 'demo' ? 'demo' : 'live') : 'offline';
}

// ---------------------------------------------------------------- side panel

// Finish a link: the picked chats become the sources of a brief for this chat.
function connectTo(targetId, newCwd = '') {
  const sources = (UI.linking && UI.linking.sources) || [];
  UI.linking = null;
  const h = UI.handoff;
  UI.handoff = { active: true, sources: [], notes: [], goal: '', target: newCwd ? 'new' : 'running', editor: h.editor || S.settings.defaultEditor || 'vscode', runTarget: newCwd ? '' : targetId, memoryCwd: '', short: false, run: 'editor', newCwd, aiText: null, aiBusy: false, extra: h.extra || [] };
  for (const id of sources) addSource(id);
  UI.selected = null;
  UI.newChat = null;
  hideHover();
  renderAll(false);
}

function toggleLink(id) {
  if (UI.handoff.active) { toast('Finish or cancel the brief first.'); return; }
  const l = UI.linking;
  if (!l) UI.linking = { sources: [id] };
  else if (l.sources.includes(id)) {
    l.sources = l.sources.filter((x) => x !== id);
    if (!l.sources.length) UI.linking = null;
  } else l.sources.push(id);
  UI.selected = null;
  UI.newChat = null;
  hideHover();
  renderAll(false);
}

function select(id, focusComposer = false) {
  if (UI.linking) {
    if (UI.linking.sources.includes(id)) { toast('That chat is already picked. Click the chat to send it to.'); return; }
    connectTo(id);
    return;
  }
  // While you make a brief, clicking a chat adds it to the brief or takes it out.
  if (UI.handoff.active) {
    if (UI.route !== 'lineage') location.hash = '#/lineage';
    toggleSource(id);
    return;
  }
  UI.selected = id;
  UI.newChat = null;
  if (UI.route !== 'lineage' && UI.route !== 'list') location.hash = '#/lineage';
  renderAll(false);
  if (UI.route === 'lineage') requestAnimationFrame(() => reveal(id));
  if (focusComposer) setTimeout(() => { const m = $('#msg'); if (m) m.focus(); }, 30);
}

function renderSide() {
  const side = $('#side');
  const onCanvas = UI.route === 'lineage' || UI.route === 'list';
  if (UI.handoff.active && UI.route === 'lineage') {
    if (side.dataset.mode !== 'brief') {
      side.dataset.mode = 'brief';
      side.dataset.id = '';
      side.innerHTML = '';
    }
    side.hidden = false;
    preserveFocus(() => { side.innerHTML = briefPanelHtml(); });
    return;
  }
  if (UI.newChat && onCanvas) {
    side.hidden = false;
    if (side.dataset.mode !== 'new' || side.dataset.id !== UI.newChat.cwd) {
      side.dataset.mode = 'new';
      side.dataset.id = UI.newChat.cwd;
      side.innerHTML = newChatHtml();
    } else {
      const btn = $('#nc-start');
      if (btn) btn.disabled = !canRun();
    }
    return;
  }
  const s = UI.selected ? S.sessions.get(UI.selected) : null;
  if (s && UI.selected !== UI.lastSummaryAsk) { UI.lastSummaryAsk = UI.selected; wantSummary(s); }
  if (!s || !onCanvas) {
    side.hidden = true;
    side.dataset.mode = '';
    side.dataset.id = '';
    return;
  }
  side.hidden = false;
  if (side.dataset.mode !== 'chat' || side.dataset.id !== s.id) {
    side.dataset.mode = 'chat';
    side.dataset.id = s.id;
    side.innerHTML = `<div class="side-head" id="side-head"></div><div class="side-body convo" id="side-body"></div>${composerHtml()}`;
    bindComposer();
    UI.scrollToEnd = true;
    UI.menuOpen = false;
    UI.branchFor = null;
  }
  preserveFocus(() => {
    $('#side-head').innerHTML = sideHeadHtml(s);
    $('#side-head').className = `side-head k-${look(s).k}`;
  });
  fetchTranscript(s);
  renderConversation(s);
  updateComposer(s);
}

function newChatHtml() {
  const cwd = UI.newChat.cwd;
  const ed = S.settings.defaultEditor || 'vscode';
  return `<div class="side-head k-working"><div class="row"><span class="w">new chat<span class="when">${esc(folderName(cwd))}</span></span><button type="button" class="icon-btn" data-newchat-cancel aria-label="Cancel"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18"/></svg></button></div>
      <h2>Start a chat in ${esc(folderName(cwd))}</h2>
      <div class="where"><span>${esc(tildePath(cwd))}</span></div></div>
    <div class="side-body">
      <div class="field"><label for="nc-text">What should it do?</label><textarea id="nc-text" rows="6" placeholder="For example: add a test for the weekly cost model">${esc(UI.newChat.text || '')}</textarea></div>
      <label class="check"><input type="checkbox" id="nc-edits" ${S.settings.kroogPermissionMode === 'acceptEdits' ? 'checked' : ''}><span>let it edit files without asking (commands still ask)</span></label>
      <p class="quiet">${canRun() ? 'It runs here in Kroog with your usual Claude Code login and settings. Questions about edits and commands show up here. Later you can carry it on in VS Code, where it is in the session history.' : 'Kroog could not find Claude Code on this Mac, so it can only open the chat in your editor. See setup.'}</p>
    </div>
    <div class="composer"><div class="row"><button type="button" class="btn soft" id="nc-editor">open in ${esc(EDITORS[ed] || 'VS Code')}</button><button type="button" class="btn solid" id="nc-start" ${canRun() ? '' : 'disabled'}>start in kroog</button></div></div>`;
}

async function startNewChat() {
  const text = ($('#nc-text') || {}).value || '';
  if (!text.trim()) { toast('Write what it should do first.'); return; }
  const btn = $('#nc-start');
  if (btn) btn.disabled = true;
  const r = await act(post('run', { cwd: UI.newChat.cwd, prompt: text, permissionMode: ($('#nc-edits') || {}).checked ? 'acceptEdits' : 'default' }), 'Started. It runs here in Kroog.');
  if (btn) btn.disabled = false;
  if (!r) return;
  UI.newChat = null;
  UI.selected = r.id;
  renderAll(false);
  if (UI.route === 'lineage') setTimeout(() => reveal(r.id, true), 120);
}

// ---------------------------------------------------------------- the chat panel
// The panel shows the real conversation, read from Claude Code's own history file, the way
// Claude Code shows it. What you send from here goes into the same chat (its inbox), so the
// chat in VS Code and this panel are two windows on one conversation.

const TX = new Map();       // chat id -> { items, found, loading, key }
const OUTBOX = new Map();   // chat id -> [{ text, t, state }] messages sent from Kroog, until the chat shows them

function txKey(s) { return `${s.lastAt || 0}|${(s.steps || []).length}`; }

function fetchTranscript(s) {
  const cur = TX.get(s.id);
  const key = txKey(s);
  if (cur && (cur.key === key || cur.loading)) return;
  TX.set(s.id, { ...(cur || { items: [], found: false }), loading: true, key });
  fetch(`/api/transcript/${encodeURIComponent(s.id)}`)
    .then((r) => r.json())
    .then((d) => { TX.set(s.id, { items: d.items || [], found: Boolean(d.found), more: d.more, loading: false, key }); })
    .catch(() => { TX.set(s.id, { ...(TX.get(s.id) || {}), loading: false, key }); })
    .finally(() => { if (UI.selected === s.id) renderConversation(S.sessions.get(s.id)); });
}

// Without a history file (the demo, or a chat on another machine), build it from the steps.
function itemsFromSteps(s) {
  const out = [];
  for (const st of s.steps || []) {
    if (st.kind === 'prompt' || st.kind === 'you') out.push({ kind: 'you', text: st.text, t: st.t, via: st.kind === 'you' ? 'kroog' : '' });
    else if (st.kind === 'reply') out.push({ kind: 'claude', text: st.text, t: st.t });
    else if (st.kind === 'tool') out.push({ kind: 'tool', text: st.text, state: st.state || 'ok', t: st.t, helper: st.helper });
    else if (st.kind === 'error') out.push({ kind: 'note', text: st.text, t: st.t, bad: true });
  }
  if (s.lastReply && !out.some((x) => x.kind === 'claude')) out.push({ kind: 'claude', text: s.lastReply, t: s.lastAt });
  return out;
}

function placeName(s) {
  if (s.owner === 'kroog') return 'Kroog';
  return s.place && s.place !== 'Unknown app' ? s.place : edName(s);
}

// Where the chat is, and whether Kroog can reach it.
function whereLine(s) {
  if (kroogRunning(s)) return '<span class="live">running in kroog</span>';
  if (s.live) return `<span class="live">open in ${esc(placeName(s))}</span>`;
  return `<span>not open now · last in ${esc(placeName(s))}</span>`;
}

function sideHeadHtml(s) {
  const lk = look(s);
  const ai = s.ai;
  const menu = [
    `<button type="button" data-handoff="${esc(s.id)}">hand off from this chat</button>`,
    canRun() ? `<button type="button" data-branch="${esc(s.id)}">start a branch here</button>` : '',
    aiOn() ? `<button type="button" data-summarize="${esc(s.id)}">summarise again</button>` : '',
    `<button type="button" data-archive="${esc(s.id)}">hide from kroog</button>`,
  ].join('');
  const openBtn = s.owner === 'kroog'
    ? `<button type="button" class="btn sm" data-to-editor="${esc(s.id)}" ${kroogRunning(s) ? 'disabled title="Wait for it to finish, or stop it"' : ''}>open in ${esc(edName(s))}</button>`
    : s.editor ? `<a class="btn sm" href="${esc(editorUrl(s))}">open in ${esc(edName(s))}</a>` : '';
  return `<div class="row"><span class="w">${esc(lk.word)}<span class="when" data-tick="when" data-id="${esc(s.id)}">${esc(whenText(s))}</span></span>
      <span class="head-acts">${openBtn}<details class="menu" ${UI.menuOpen ? 'open' : ''}><summary class="icon-btn" aria-label="More">⋯</summary><div class="menu-items">${menu}</div></details>
      <button type="button" class="icon-btn" data-close aria-label="Close"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18"/></svg></button></span></div>
    <h2>${esc(s.title || 'New chat')}</h2>
    <div class="where">${whereLine(s)}<span>${esc(s.project)}</span>${(s.inputs || []).length ? `<span>${givenText(s)}</span>` : ''}</div>
    ${ai && ai.gist ? `<div class="gistline"><span>${esc(ai.gist)}</span>${(ai.keywords || []).map((k) => `<i>${esc(k)}</i>`).join('')}</div>` : s.aiPending ? '<div class="gistline quiet">summarising<span class="dots"></span></div>' : ''}`;
}

function chatLink(id) {
  const s = S.sessions.get(id);
  if (!s) return 'an earlier chat';
  return `<a class="linkish" href="#/lineage" data-open="${esc(id)}">${esc(trim(s.title || 'New chat', 40))}</a>`;
}

function givenText(s) {
  const parts = [];
  for (const input of (s.inputs || []).slice(-2)) {
    const from = (input.from || []).filter((id) => id !== s.id);
    const word = input.kind === 'memory' ? 'memory from' : input.kind === 'continue' ? 'branch of' : 'brief from';
    if (from.length) parts.push(`${word} ${from.slice(0, 2).map(chatLink).join(', ')}`);
    else if (input.kind === 'memory') parts.push('project memory');
  }
  return parts.join(' · ');
}

// Small, safe markdown: code blocks, inline code, bold, paragraphs.
function md(text) {
  const parts = String(text || '').split(/```/);
  return parts.map((part, i) => {
    if (i % 2 === 1) return `<pre>${esc(part.replace(/^[a-z0-9_-]*\n/i, ''))}</pre>`;
    return esc(part)
      .replace(/`([^`\n]+)`/g, '<code>$1</code>')
      .replace(/\*\*([^*\n]+)\*\*/g, '<b>$1</b>')
      .split(/\n{2,}/).map((p) => `<p>${p.replace(/\n/g, '<br>')}</p>`).join('');
  }).join('');
}

function toolsHtml(group, key) {
  const open = UI.openTools && UI.openTools.has(key);
  const shown = open || group.length <= 4 ? group : group.slice(-3);
  const hidden = group.length - shown.length;
  return `<div class="tools-run">${hidden ? `<button type="button" class="linkish quiet more-steps" data-tools="${esc(key)}">${hidden} earlier step${hidden === 1 ? '' : 's'}</button>` : ''}${shown.map((x) => `<div class="tl st-${esc(x.state || 'ok')}"><i aria-hidden="true"></i><span>${x.helper ? `<span class="quiet">${esc(String(x.helper).toLowerCase())}:</span> ` : ''}${esc(x.text)}</span>${x.state === 'failed' ? '<b class="fail">failed</b>' : ''}</div>`).join('')}</div>`;
}

function conversationHtml(s) {
  const tx = TX.get(s.id);
  const items = tx && tx.found ? tx.items : itemsFromSteps(s);
  // Messages sent from Kroog stay "sent" until the chat shows them.
  const box = OUTBOX.get(s.id) || [];
  const pending = box.filter((o) => !items.some((x) => x.kind === 'you' && x.t >= o.t - 5000 && x.text.trim() === o.text.trim()));
  OUTBOX.set(s.id, pending);
  let html = tx && tx.more ? '<p class="quiet older">Older messages are in the chat in VS Code.</p>' : '';
  if (!items.length && !pending.length) html += `<p class="quiet older">${tx && tx.loading ? 'loading the conversation' : 'Nothing in this chat yet.'}</p>`;
  let group = [];
  let n = 0;
  const flush = () => { if (group.length) { html += toolsHtml(group, `${s.id}:${n}`); group = []; } };
  for (const x of items) {
    n += 1;
    if (x.kind === 'tool') { group.push(x); continue; }
    flush();
    if (x.kind === 'you') html += `<div class="msg you"><div class="who">you${x.via === 'kroog' ? ' <span class="quiet">from kroog</span>' : x.via === 'session' ? ' <span class="quiet">from another chat</span>' : ''}</div><div class="txt">${md(x.text)}</div></div>`;
    else if (x.kind === 'claude') html += `<div class="msg claude"><div class="who">claude</div><div class="txt">${md(x.text)}</div></div>`;
    else html += `<p class="note${x.bad ? ' bad' : ''}">${esc(x.text)}</p>`;
  }
  flush();
  for (const o of pending) html += `<div class="msg you pending"><div class="who">you <span class="quiet">${o.state === 'waiting' ? 'waiting for its current step' : 'sent, waiting for the chat'}</span></div><div class="txt">${md(o.text)}</div></div>`;

  const n2 = s.needs || {};
  if (s.status === 'needs' && n2.kind === 'permission') {
    html += `<div class="ask k-needs"><span class="kind">${n2.helper ? `helper "${esc(n2.helper)}" wants to` : 'it wants to'}</span>
      <p class="what">${esc(lowerFirst(n2.title || 'do something'))}</p>${n2.detail ? `<pre>${esc(n2.detail)}</pre>` : ''}
      ${s.waitingPermission
        ? `<div class="row"><button type="button" class="btn solid" data-allow="${esc(s.id)}">allow</button><button type="button" class="btn" data-deny-reason="${esc(s.id)}">deny</button><span class="count" data-tick="deadline" data-deadline="${n2.deadline || ''}">${esc(countdownText(n2.deadline))}</span></div>
           <div class="field"><label for="deny-reason">Reason if you deny (optional)</label><input type="text" id="deny-reason" autocomplete="off"></div>`
        : `<p class="why">${s.editor ? `${esc(edName(s))} is asking you.` : 'Answer it where the chat runs.'}</p>`}</div>`;
  } else if (s.status === 'needs' && n2.kind === 'question') {
    html += `<div class="ask k-needs"><span class="kind">it asks</span><p class="what">${esc(n2.title || 'Needs your answer')}</p></div>`;
  } else if (s.status === 'error') {
    html += `<div class="ask k-error"><span class="kind">it stopped</span><p class="what">${esc(n2.title || 'An error')}</p></div>`;
  }
  if (s.status === 'working') html += `<p class="working-now"><i aria-hidden="true"></i>${esc(s.now || 'Working')}</p>`;
  return html;
}

function renderConversation(s) {
  const body = $('#side-body');
  if (!s || !body || UI.selected !== s.id) return;
  const atEnd = body.scrollHeight - body.scrollTop - body.clientHeight < 60;
  const scroll = body.scrollTop;
  preserveFocus(() => { body.innerHTML = conversationHtml(s); });
  body.scrollTop = atEnd || UI.scrollToEnd ? body.scrollHeight : scroll;
  UI.scrollToEnd = false;
}

function sideBodyHtml(s) {
  fetchTranscript(s);
  return conversationHtml(s);
}

function composerHtml() {
  return `<form class="composer" id="composer">
    <label for="msg" class="sr">Message to this chat</label>
    <textarea id="msg" rows="2" placeholder="Message this chat"></textarea>
    <p class="hint" id="composer-hint"></p>
    <div class="row end"><button type="button" class="btn sm warn" id="stop-btn" hidden>stop</button><button type="button" class="btn soft" id="alt-btn" hidden></button><button type="submit" class="btn solid" id="send-btn">send</button></div>
  </form>`;
}

// Where a message goes, in plain words. Kroog never quietly makes a copy of a chat:
// when it can't reach one, it says so and lets you pick.
function composerMode(s) {
  if (UI.branchFor === s.id) return 'branch';
  if (s.holdingStop) return 'now';
  if (s.inbox) return 'inbox';
  const busy = s.status === 'working' || (s.status === 'needs' && s.needs && s.needs.kind === 'permission' && (s.waitingPermission || s.needs.kroog));
  if (busy) return 'queue';
  // Not open anywhere: Kroog carries the same chat on here, when Claude Code's registry of
  // open chats is there to confirm it (or Kroog ran it / saw it close).
  const registry = Boolean(S.info.claude && S.info.claude.registry);
  if (canRun() && !s.live && (registry || s.owner === 'kroog' || s.status === 'ended')) return 'continue';
  return s.editor ? 'unreachable' : 'later';
}

function updateComposer(s) {
  const hint = $('#composer-hint');
  if (!hint) return;
  const send = $('#send-btn');
  const alt = $('#alt-btn');
  const stop = $('#stop-btn');
  const msg = $('#msg');
  const mode = composerMode(s);
  const ed = edName(s);
  const why = s.status === 'ended' ? 'It was closed' : `It isn't open in ${ed} right now, or it hasn't done anything since Kroog started`;
  const texts = {
    now: ['send', 'Goes in now. It was waiting for you.'],
    inbox: ['send', `Goes straight into the chat${s.owner === 'kroog' ? '' : ` in ${ed}`}.`],
    queue: ['send', 'It reads this after its current step.'],
    continue: ['send', `Not open anywhere, so Kroog carries this chat on here. You can open it in ${ed} again afterwards.`],
    branch: ['start branch', 'Starts a new chat here with everything this one knows, plus your message. This chat stays as it is.'],
    unreachable: [`open in ${ed}`, `${why}, so Kroog can't reach it. Open it in ${ed} (your message is copied) and send it once there. After that, Kroog can message it.`],
    later: ['send', 'It reads this with your next message where the chat runs.'],
  };
  send.textContent = texts[mode][0];
  hint.textContent = texts[mode][1];
  hint.classList.toggle('warn-hint', mode === 'unreachable');
  alt.hidden = !(mode === 'unreachable' && canRun()) && mode !== 'branch';
  alt.textContent = mode === 'branch' ? 'cancel' : 'start a branch here';
  msg.placeholder = mode === 'branch' ? 'Message for the new branch' : 'Message this chat';
  stop.hidden = !(s.status === 'working' || s.holdingStop || kroogRunning(s) || (s.status === 'needs' && s.waitingPermission));
  stop.textContent = s.holdingStop ? 'let go' : 'stop';
}

async function copyText(text) {
  try { await navigator.clipboard.writeText(text); return true; } catch { return false; }
}

async function sendToEditor(s, text) {
  const copied = text ? await copyText(text) : false;
  openUrl(editorUrl(s));
  toast(copied ? `Opening the chat in ${edName(s)}. Your message is copied: paste it there (Cmd+V) and press Enter.` : `Opening the chat in ${edName(s)}.`, 9000);
  return true;
}

async function sendBranch(s, text) {
  const r = await act(post(`sessions/${encodeURIComponent(s.id)}/send`, { text, mode: 'branch' }));
  if (!r) return false;
  UI.branchFor = null;
  toast(`Started a branch here. The ${edName(s)} chat is unchanged.`, 7000);
  UI.selected = r.id;
  renderAll(false);
  if (UI.route === 'lineage') setTimeout(() => reveal(r.id, true), 120);
  return true;
}

function bindComposer() {
  const form = $('#composer');
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const s = S.sessions.get(UI.selected);
    const box = $('#msg');
    const text = box.value.trim();
    if (!s) return;
    const mode = composerMode(s);
    if (mode === 'unreachable') { if (await sendToEditor(s, text)) box.value = ''; return; }
    if (!text) return;
    if (mode === 'branch') { if (await sendBranch(s, text)) box.value = ''; return; }
    const r = await act(post(`sessions/${encodeURIComponent(s.id)}/send`, { text }));
    if (!r) return;
    box.value = '';
    if (r.delivered === 'editor' && r.url) { sendToEditor(s, text); return; }
    const list = OUTBOX.get(s.id) || [];
    list.push({ text, t: Date.now(), state: r.delivered === 'queued' ? 'waiting' : 'sent' });
    OUTBOX.set(s.id, list);
    UI.scrollToEnd = true;
    renderConversation(s);
  });
  $('#msg').addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); form.requestSubmit(); }
  });
  $('#alt-btn').addEventListener('click', async () => {
    const s = S.sessions.get(UI.selected);
    if (!s) return;
    if (composerMode(s) === 'branch') { UI.branchFor = null; updateComposer(s); return; }
    const box = $('#msg');
    if (!box.value.trim()) { UI.branchFor = s.id; updateComposer(s); box.focus(); return; }
    if (await sendBranch(s, box.value.trim())) box.value = '';
  });
  $('#stop-btn').addEventListener('click', () => {
    act(post(`sessions/${encodeURIComponent(UI.selected)}/stop`), (r) => r.note || 'Done.');
  });
}

// ---------------------------------------------------------------- handoff (drawn on the canvas)

function sourceFor(id) {
  return UI.handoff.sources.find((x) => x.id === id);
}

function addSource(id) {
  if (!sourceFor(id) && S.sessions.has(id)) UI.handoff.sources.push({ id, include: { reply: true, prompt: false, plan: true, files: true, notes: true } });
}

function toggleSource(id) {
  UI.handoff.aiText = null;
  if (sourceFor(id)) UI.handoff.sources = UI.handoff.sources.filter((x) => x.id !== id);
  else addSource(id);
  renderAll(false);
}

function startHandoff(fromId) {
  const h = UI.handoff;
  h.active = true;
  if (fromId) addSource(fromId);
  if (!h.editor) h.editor = S.settings.defaultEditor || 'vscode';
  UI.selected = null;
  if (UI.route !== 'lineage') location.hash = '#/lineage';
  else renderAll(false);
}

function endHandoff() {
  UI.handoff = { active: false, sources: [], notes: [], goal: '', target: 'new', editor: UI.handoff.editor, runTarget: '', memoryCwd: '', short: false, run: UI.handoff.run || 'editor', newCwd: '', aiText: null, aiBusy: false, extra: [] };
  renderAll(false);
}

function composeBrief() {
  const h = UI.handoff;
  const lines = ['Brief from Kroog: notes from earlier chats on related work. Use them as background and ask if anything is unclear.'];
  if (h.target === 'new' && h.goal.trim()) lines.push('', `Goal: ${h.goal.trim()}`);
  for (const src of h.sources) {
    const s = S.sessions.get(src.id);
    if (!s) continue;
    const inc = src.include;
    const parts = [];
    if (inc.prompt && s.lastPrompt) parts.push(`What was asked:\n${clipText(s.lastPrompt.replace(/\[Kroog brief [a-z0-9]+\]/i, '').trim(), h.short ? 300 : 800)}`);
    if (inc.reply && s.lastReply) parts.push(`Its last reply:\n${clipText(s.lastReply, h.short ? 500 : 2500)}`);
    if (inc.plan && (s.plan || []).length) parts.push(`Its plan:\n${s.plan.map((p) => `- [${p.state === 'done' ? 'done' : p.state === 'now' ? 'in progress' : 'to do'}] ${p.text}`).join('\n')}`);
    if (inc.files && (s.files || []).length) parts.push(`Files it changed:\n${s.files.slice(-20).map((f) => `- ${shortFile(f, s.cwd)}`).join('\n')}`);
    if (inc.notes) {
      const ns = S.notes.filter((x) => x.sessionId === s.id);
      if (ns.length) parts.push(`Notes:\n${ns.map((x) => `- ${x.type}: ${x.text}`).join('\n')}`);
    }
    if (parts.length) lines.push('', `From the chat "${s.title || 'New chat'}" (${s.project}, ${look(s).word}):`, ...parts);
  }
  if ((h.extra || []).length) lines.push('', 'From the second brain:', ...h.extra.map((x) => `--- ${x.title} ---\n${clipText(x.text, h.short ? 600 : 2500)}`));
  const extra = S.notes.filter((x) => h.notes.includes(x.id));
  if (extra.length) lines.push('', 'Notes from the Library:', ...extra.map((x) => `- ${x.type}: ${x.text} (${x.project})`));
  return lines.join('\n');
}

// The brief that will be sent: the one the AI helper wrote (and you may have edited), or
// the plain one put together from the ticked parts.
function briefText() {
  return UI.handoff.aiText != null ? UI.handoff.aiText : composeBrief();
}

async function writeBriefWithAi() {
  const h = UI.handoff;
  if (!h.sources.length && !h.notes.length) { toast('Add a chat or a note first.'); return; }
  h.aiBusy = true;
  renderAll(false);
  const r = await act(post('write-brief', { sources: h.sources.map((x) => x.id), notes: h.notes, goal: h.goal }), 'Written. Read it over and edit it if you like.');
  h.aiBusy = false;
  if (r && r.text) h.aiText = r.text;
  renderAll(false);
}

function briefPanelHtml() {
  const h = UI.handoff;
  const brief = briefText();
  const n = words(brief);
  const live = visibleSessions(S).filter((s) => s.status !== 'ended' || canRun()).sort((a, b) => (b.lastAt || 0) - (a.lastAt || 0));
  const folders = [...new Set([...S.sessions.values()].map((s) => s.cwd).filter(Boolean))];
  if (!h.runTarget || !live.some((s) => s.id === h.runTarget)) h.runTarget = live[0] ? live[0].id : '';
  if (!h.memoryCwd || !folders.includes(h.memoryCwd)) {
    const first = S.sessions.get((h.sources[0] || {}).id);
    h.memoryCwd = first && first.cwd ? first.cwd : folders[0] || '';
  }
  const editor = h.editor || 'vscode';
  const count = h.sources.length + h.notes.length + (h.extra || []).length;
  const inKroog = canRun() && h.run === 'kroog' && h.target !== 'memory';
  if (!h.newCwd || !folders.includes(h.newCwd)) h.newCwd = h.memoryCwd || folders[0] || '';

  const srcHtml = h.sources.map((src) => {
    const s = S.sessions.get(src.id);
    if (!s) return '';
    const has = { reply: words(s.lastReply), prompt: words(s.lastPrompt), plan: (s.plan || []).length, files: (s.files || []).length, notes: S.notes.filter((x) => x.sessionId === s.id).length };
    // Only the parts this chat has; empty ones would only promise nothing.
    const tick = (key, label, unit) => {
      const v = has[key];
      if (!v) return '';
      return `<label class="check"><input type="checkbox" data-inc="${esc(s.id)}" data-key="${key}" ${src.include[key] ? 'checked' : ''}><span>${label} <span class="quiet">${unit ? plural(v, unit) : v}</span></span></label>`;
    };
    const ticks = `${tick('reply', 'its last reply', 'word')}${tick('prompt', 'what was asked', 'word')}${tick('plan', 'its plan', 'step')}${tick('files', 'files changed', '')}${tick('notes', 'its notes', '')}`;
    return `<div class="src"><div class="head"><b>${esc(s.title || 'New chat')}</b><button type="button" class="linkish quiet" data-unsource="${esc(s.id)}">remove</button></div>
      <div class="ticks">${ticks || '<span class="quiet">Nothing to hand off from this chat yet.</span>'}</div></div>`;
  }).join('');
  const extraHtml = (h.extra || []).map((x, i) => `<div class="src"><div class="head"><b>${esc(trim(x.title, 80))}</b><button type="button" class="linkish quiet" data-unextra="${i}">remove</button></div><span class="quiet" style="font-size:12px">from the brain</span></div>`).join('');
  const noteHtml = h.notes.map((id) => {
    const x = S.notes.find((y) => y.id === id);
    if (!x) return '';
    return `<div class="src"><div class="head"><b>${esc(trim(x.text, 80))}</b><button type="button" class="linkish quiet" data-unnote="${esc(id)}">remove</button></div><span class="quiet" style="font-size:12px">${esc(x.type.toLowerCase())} from the library</span></div>`;
  }).join('');

  const radio = (key, label, hint) => `<label class="${h.target === key ? 'on' : ''}"><input type="radio" name="dest" value="${key}" ${h.target === key ? 'checked' : ''}><span>${label}<span>${hint}</span></span></label>`;
  let destFields = '';
  const runSeg = canRun() && h.target !== 'memory'
    ? `<div class="field"><span class="label">Carry on</span><div class="seg" role="group" aria-label="Where you carry on"><button type="button" data-run="editor" aria-pressed="${h.run !== 'kroog'}">in ${esc(EDITORS[editor] || 'VS Code')}</button><button type="button" data-run="kroog" aria-pressed="${h.run === 'kroog'}">here in kroog only</button></div></div>`
    : '';
  if (h.target === 'new') {
    destFields = `<div class="field"><label for="ho-goal">Goal for the new chat</label><textarea id="ho-goal" rows="3" placeholder="For example: write the post on dbt tests and cost gates">${esc(h.goal)}</textarea></div>
      ${runSeg}
      ${canRun()
        ? `<div class="field"><label for="ho-newcwd">In project folder</label><select id="ho-newcwd">${folders.map((f) => `<option value="${esc(f)}" ${f === h.newCwd ? 'selected' : ''}>${esc(folderName(f))}</option>`).join('')}</select></div>
           <p class="quiet">${inKroog ? 'It runs here in Kroog only. You can open it in your editor later.' : `Kroog starts the chat in that folder with the brief (it answers with a short plan), then opens the folder and the chat in ${esc(EDITORS[editor] || 'VS Code')}, where you carry on. Kroog keeps showing it too.`}</p>`
        : `<div class="field"><label for="ho-editor">Open it in</label><select id="ho-editor">${Object.entries(EDITORS).map(([k, v]) => `<option value="${k}" ${k === editor ? 'selected' : ''}>${v}</option>`).join('')}</select></div>`}`;
  } else if (h.target === 'running') {
    const t = S.sessions.get(h.runTarget);
    let note = '';
    if (t && t.inbox) note = `It goes straight into the chat${t.owner === 'kroog' ? '' : `, which is open in ${esc(edName(t))}`}.`;
    else if (t && inKroog) {
      const live2 = t.status === 'working' || t.holdingStop || (t.status === 'needs' && t.needs && t.needs.kind === 'permission');
      if (live2) note = 'It is working, so it reads the brief after its current step.';
      else if (t.owner === 'kroog' || t.status === 'ended') note = 'Kroog runs its next turn here with the brief.';
      else note = `It is waiting in ${esc(edName(t))}, so Kroog starts a branch of it here with the brief. The ${esc(edName(t))} chat stays as it is.`;
    }
    destFields = live.length
      ? `<div class="field"><label for="ho-run">Which chat</label><select id="ho-run">${live.map((s) => `<option value="${esc(s.id)}" ${s.id === h.runTarget ? 'selected' : ''}>${esc(trim(s.title || 'New chat', 56))} (${esc(look(s).word)})</option>`).join('')}</select></div>${t && t.inbox ? '' : runSeg}${note ? `<p class="quiet">${note}</p>` : ''}`
      : '<p class="quiet">No open chats to send to.</p>';
  } else {
    destFields = folders.length
      ? `<div class="field"><label for="ho-mem">Project folder</label><select id="ho-mem">${folders.map((f) => `<option value="${esc(f)}" ${f === h.memoryCwd ? 'selected' : ''}>${esc(folderName(f))}</option>`).join('')}</select></div>`
      : '<p class="quiet">No project folders yet.</p>';
  }
  const sendLabel = h.target === 'new' ? (inKroog ? 'start it in kroog' : `start it, then open in ${EDITORS[editor]}`) : h.target === 'running' ? 'send the brief' : 'add to project memory';
  const disabled = !count || h.aiBusy || (h.target === 'running' && !live.length) || (h.target === 'memory' && !folders.length) || (h.target === 'new' && canRun() && !h.newCwd);
  const aiRow = aiOn()
    ? `<div class="row ai-row"><button type="button" class="btn sm soft" id="ho-ai" ${h.aiBusy || !count ? 'disabled' : ''}>${h.aiBusy ? 'writing' : h.aiText != null ? 'write it again' : 'write it with ai'}</button>${h.aiText != null ? '<button type="button" class="linkish quiet" id="ho-ai-reset">use the plain version</button>' : '<span class="quiet">merges the chats into one short brief</span>'}</div>`
    : '';
  const previewHtml = h.aiText != null
    ? `<div class="field"><label for="ho-aitext">The brief, written by the AI helper (you can edit it), about ${plural(n, 'word')}</label><textarea id="ho-aitext" rows="12">${esc(h.aiText)}</textarea></div>`
    : `<details class="fold"><summary>what the chat will read, about ${plural(n, 'word')}</summary><pre class="preview" id="ho-preview">${esc(brief)}</pre></details>`;

  return `<div class="side-head k-working"><div class="row"><span class="w">new brief<span class="when">${esc(plural(count, 'source'))}</span></span><button type="button" class="icon-btn" data-handoff-cancel aria-label="Cancel the brief"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18"/></svg></button></div>
      <h2>Hand off what a chat worked out</h2>
      <div class="where"><span>Click chats on the canvas to add or remove them.</span></div></div>
    <div class="side-body">
      <div>${srcHtml + noteHtml + extraHtml || '<p class="quiet">Nothing in the brief yet. Click a chat on the canvas, or use a note from the library.</p>'}</div>
      <div class="field"><span class="label">Send it to</span><div class="dest">${radio('new', 'a new chat', 'starts fresh with the brief')}${radio('running', 'a running chat', 'adds the brief to its work')}${radio('memory', 'project memory', 'every new chat in that folder starts with it')}</div></div>
      ${destFields}
      ${h.aiText != null ? '' : `<label class="check"><input type="checkbox" id="ho-short" ${h.short ? 'checked' : ''}><span>keep it short</span></label>`}
      ${aiRow}
      ${previewHtml}
    </div>
    <div class="composer"><div class="row"><button type="button" class="btn soft" id="ho-copy">copy</button><button type="button" class="btn solid" id="ho-send" ${disabled ? 'disabled' : ''}>${esc(sendLabel)}</button></div></div>`;
}

async function sendHandoff() {
  const h = UI.handoff;
  const text = briefText();
  const inKroog = canRun() && h.run === 'kroog' && h.target !== 'memory';
  const r = await act(post('handoff', {
    text,
    goal: h.goal,
    target: h.target,
    editor: h.editor || 'vscode',
    sessionId: h.runTarget,
    cwd: h.target === 'new' ? h.newCwd : h.memoryCwd,
    sources: h.sources.map((x) => x.id),
    notes: h.notes,
    run: inKroog ? 'kroog' : 'editor',
  }));
  if (!r) return;
  const target = S.sessions.get(h.runTarget);
  if (r.delivered === 'inbox') {
    toast(`Sent. The brief went straight into "${trim((target && target.title) || 'the chat', 40)}".`, 7000);
    endHandoff();
    return;
  }
  if (r.delivered === 'kroog') {
    const ed = EDITORS[h.editor] || 'VS Code';
    toast(!inKroog && (r.mode === 'new' || r.mode === 'resume') ? `Starting it with the brief. It opens in ${ed} in a few seconds.` : r.mode === 'fork' ? 'Started a branch of that chat here in Kroog, with the brief.' : r.mode === 'new' ? 'Started the new chat here in Kroog, with the brief.' : 'Sent. It runs here in Kroog.', 8000);
    endHandoff();
    UI.selected = r.id;
    renderAll(false);
    if (UI.route === 'lineage') setTimeout(() => reveal(r.id, true), 150);
    return;
  }
  if (r.delivered === 'editor' && r.url) {
    openUrl(r.url);
    toast(h.target === 'new' ? `Opening ${EDITORS[h.editor] || 'VS Code'}. Press Enter in the new chat and the brief goes with it.` : `Opening ${target ? edName(target) : 'the editor'}. Press Enter there and the brief goes in.`, 8000);
  } else if (r.delivered === 'now') toast('Sent. It carries on now.');
  else if (r.delivered === 'queued') toast('Sent. It reads the brief after its current step.');
  else if (r.delivered === 'memory') toast('Added to project memory. New chats in that folder start with it.');
  else if (r.delivered === 'paste' && r.url) {
    try { await navigator.clipboard.writeText(r.prompt); } catch { /* ignore */ }
    openUrl(r.url);
    toast(`Kroog can't reach that chat right now, so it opened it in ${target ? edName(target) : 'the editor'}. A short line with the brief is copied: paste it there (Cmd+V) and press Enter.`, 10000);
  } else if (r.delivered === 'copy') {
    try { await navigator.clipboard.writeText(r.prompt); } catch { /* ignore */ }
    toast('Copied. Paste it into that chat and the brief goes with it.', 8000);
  }
  endHandoff();
}

// ---------------------------------------------------------------- list

function renderList() {
  const q = UI.list.query.trim().toLowerCase();
  const all = visibleSessions(S).filter((s) => !q || `${s.title} ${s.project} ${s.now} ${s.lastPrompt} ${s.place}`.toLowerCase().includes(q));
  const counts = { all: all.length, needs: 0, working: 0, open: 0, done: 0 };
  for (const s of all) counts[bucket(s)] += 1;
  const defs = [['needs', 'needs you'], ['working', 'working'], ['open', 'open'], ['done', 'done']];
  const byLast = (a, b) => (b.lastAt || 0) - (a.lastAt || 0);
  const sorters = { needs: (a, b) => (a.since || 0) - (b.since || 0), working: byLast, open: byLast, done: byLast };
  const shown = all.filter((s) => UI.list.filter === 'all' || bucket(s) === UI.list.filter);
  const sections = defs.map(([key, title]) => {
    const items = shown.filter((s) => bucket(s) === key).sort(sorters[key]);
    if (!items.length) return '';
    return `<div class="section-head"><h2>${title}</h2><span class="n">${items.length}</span></div><ul class="rows">${items.map(rowHtml).join('')}</ul>`;
  }).join('');
  const hidden = hiddenByScope(S);
  const pills = [['all', 'all'], ...defs].map(([key, label]) => `<button type="button" class="pill" data-filter="${key}" aria-pressed="${UI.list.filter === key}">${label} <span class="n">${counts[key]}</span></button>`).join('');
  $('#view').innerHTML = `${demoLine()}<div class="page">
    <header class="page-head"><div><h1>Every chat</h1><p class="lead">${esc(statusSentence())}${hidden ? ` ${plural(hidden, 'chat')} outside your editors hidden.` : ''}</p></div>
      <div class="search"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" aria-hidden="true"><circle cx="11" cy="11" r="6.5"/><path d="M16 16l4.5 4.5"/></svg><label for="q" class="sr">Find a chat</label><input id="q" type="search" placeholder="find a chat" value="${esc(UI.list.query)}" autocomplete="off"></div></header>
    <div class="tools" role="group" aria-label="Show">${pills}${S.info.mode === 'demo' ? '' : '<button type="button" class="btn sm soft" id="do-import" style="margin-left:auto">import recent chats</button>'}</div>
    ${sections || `<div class="empty"><p>${q ? `No chats match "${esc(UI.list.query.trim())}".` : 'No chats here yet. Chats you used before linking can be imported with the button above.'}</p></div>`}
  </div>`;
}

function rowHtml(s) {
  const lk = look(s);
  return `<li><button type="button" class="row k-${lk.k}${UI.selected === s.id ? ' sel' : ''}" data-open="${esc(s.id)}">
    <span class="when" data-tick="when" data-id="${esc(s.id)}">${esc(whenText(s))}</span>
    <span><span class="title">${esc(s.title || 'New chat')}</span><span class="desc">${esc(lineText(s))}</span><span class="meta">${esc(s.project)}, ${esc(s.place || s.app)}</span></span>
    <span class="end">${s.live && lk.k !== 'working' ? '<i class="live-dot" title="open now"></i>' : ''}${esc(lk.word)}</span>
  </button></li>`;
}

function statusSentence() {
  const link = S.info.link || {};
  if (!S.connected) return 'Kroog is offline. Is the Terminal window still open?';
  if (S.info.mode === 'demo') return 'Demo chats, updating live.';
  if (!link.linked) return 'Not linked to Claude Code yet. Open setup to link it.';
  return S.lastEventAt ? `Live. Last update ${dur(S.lastEventAt) === 'just now' ? 'just now' : `${dur(S.lastEventAt)} ago`}.` : 'Live.';
}

function demoLine() {
  if (S.info.mode !== 'demo') return '';
  return '<div class="demo-line">Demo: these chats are fake, so try everything. When you are ready, quit the demo and run <code>node bin/kroog.js link</code>, then <code>node bin/kroog.js start</code>.</div>';
}

// ---------------------------------------------------------------- library

function typeClass(type) {
  return { Decision: 't-decision', Finding: 't-finding', 'How-to': 't-howto', 'Open question': 't-question', Brief: 't-brief' }[type] || 't-decision';
}

function renderLibrary() {
  const Lb = UI.library;
  const q = Lb.query.trim().toLowerCase();
  const folders = [...new Set([...S.notes.map((x) => x.cwd), ...[...S.sessions.values()].map((s) => s.cwd)].filter(Boolean))];
  if (!Lb.memCwd || !folders.includes(Lb.memCwd)) {
    const withMemory = S.notes.find((x) => x.remembered && x.cwd);
    Lb.memCwd = withMemory ? withMemory.cwd : folders[0] || '';
  }
  const base = S.notes.filter((x) => (Lb.project === 'all' || x.cwd === Lb.project) && (!q || `${x.text} ${x.chatTitle} ${x.project}`.toLowerCase().includes(q)));
  const shown = base.filter((x) => Lb.kind === 'all' || x.type === Lb.kind);
  const kinds = [['all', 'all'], ['Decision', 'decisions'], ['Finding', 'findings'], ['How-to', 'how-tos'], ['Open question', 'open questions'], ['Brief', 'briefs']];
  const projects = [...new Set(shown.map((x) => x.cwd || x.project))];
  const memory = S.notes.filter((x) => x.remembered && x.cwd === Lb.memCwd);
  const memWords = memory.reduce((sum, x) => sum + words(x.text), 0);
  const notesOff = S.info.mode !== 'demo' && (!S.info.apiKey || S.settings.notesEnabled === false);

  const groups = projects.map((key) => {
    const items = shown.filter((x) => (x.cwd || x.project) === key).sort((a, b) => (b.t || 0) - (a.t || 0));
    return `<div class="section-head"><h2>${esc(items[0].project)}</h2><span class="n">${items.length}</span></div><ul class="rows">${items.map(noteRowHtml).join('')}</ul>`;
  }).join('');

  $('#view').innerHTML = `${demoLine()}<div class="page">
    <header class="page-head"><div><h1>Library</h1><p class="lead">What your chats worked out, kept as short notes you can hand to the next chat. ${plural(S.notes.length, 'note')} so far.</p></div>
      <button type="button" class="btn soft" id="lib-add">${Lb.adding ? 'cancel' : 'add a note'}</button></header>
    ${notesOff ? `<p class="muted" style="margin-bottom:16px">${S.info.apiKey ? 'Writing notes is turned off.' : 'Kroog writes notes when you add an API key in setup.'} You can add notes yourself meanwhile.</p>` : ''}
    ${S.info.notesError ? `<p class="muted" style="margin-bottom:16px">The last note request failed: ${esc(S.info.notesError)}</p>` : ''}
    ${Lb.adding ? addNoteHtml(folders) : ''}
    <div class="tools">
      <div class="search"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" aria-hidden="true"><circle cx="11" cy="11" r="6.5"/><path d="M16 16l4.5 4.5"/></svg><label for="lib-q" class="sr">Find a note</label><input id="lib-q" type="search" placeholder="find a note" value="${esc(Lb.query)}" autocomplete="off"></div>
      ${kinds.map(([k, label]) => `<button type="button" class="pill" data-kind="${esc(k)}" aria-pressed="${Lb.kind === k}">${label} <span class="n">${k === 'all' ? base.length : base.filter((x) => x.type === k).length}</span></button>`).join('')}
      <select id="lib-project" aria-label="Project" style="width:auto"><option value="all">all projects</option>${folders.map((f) => `<option value="${esc(f)}" ${Lb.project === f ? 'selected' : ''}>${esc(folderName(f))}</option>`).join('')}</select>
    </div>
    <div class="lib">
      <div>${groups || `<div class="empty"><p>${q ? `No notes match "${esc(Lb.query.trim())}".` : 'No notes yet. They appear as your chats finish, or when you add one.'}</p></div>`}</div>
      <aside class="aside-box" aria-label="Project memory">
        <h2>Project memory</h2>
        <p>Every new chat in this folder starts knowing these notes. Press remember on a note to add it.</p>
        ${folders.length ? `<select id="mem-folder" aria-label="Project folder">${folders.map((f) => `<option value="${esc(f)}" ${Lb.memCwd === f ? 'selected' : ''}>${esc(folderName(f))}</option>`).join('')}</select>` : ''}
        ${memory.length ? `<ul class="rows" style="margin-top:12px">${memory.map((x) => `<li><span class="type ${typeClass(x.type)}">${esc(x.type.toLowerCase())}</span>${esc(x.text)} <button type="button" class="linkish quiet" data-forget="${esc(x.id)}">forget</button></li>`).join('')}</ul><p class="quiet" style="margin-top:10px;font-size:12.5px">About ${plural(memWords, 'word')} go into each new chat here.</p>` : '<p class="quiet" style="margin-top:12px">Nothing remembered for this folder yet.</p>'}
      </aside>
    </div>
  </div>`;
}

function noteRowHtml(x) {
  const inBrief = UI.handoff.notes.includes(x.id);
  const from = x.sessionId && S.sessions.has(x.sessionId)
    ? `from <a class="linkish" href="#/lineage" data-open="${esc(x.sessionId)}">${esc(trim(x.chatTitle, 56))}</a>`
    : `from ${esc(trim(x.chatTitle, 56))}`;
  return `<li class="note-row"><span class="type ${typeClass(x.type)}">${esc(x.type.toLowerCase())}</span>
    <div><p class="text">${esc(x.text)}</p>
      <div class="meta"><span>${from}, ${esc(dayish(x.t))}</span><span class="acts">
        <button type="button" class="linkish" data-note-handoff="${esc(x.id)}" aria-pressed="${inBrief}">${inBrief ? 'in the brief' : 'use in a brief'}</button>
        <button type="button" class="linkish" data-remember="${esc(x.id)}" aria-pressed="${Boolean(x.remembered)}">${x.remembered ? 'remembered' : 'remember'}</button>
        <button type="button" class="linkish" data-delnote="${esc(x.id)}">delete</button>
      </span></div></div></li>`;
}

function addNoteHtml(folders) {
  return `<form class="add-note" id="note-form">
    <div class="field"><label for="nf-type">Kind</label><select id="nf-type">${NOTE_TYPES.map((t) => `<option>${t}</option>`).join('')}</select></div>
    <div class="field"><label for="nf-text">Note, in one sentence</label><input type="text" id="nf-text" placeholder="Name the file, command or number" autocomplete="off"></div>
    ${folders.length ? `<div class="field"><label for="nf-folder">Project</label><select id="nf-folder">${folders.map((f) => `<option value="${esc(f)}">${esc(folderName(f))}</option>`).join('')}</select></div>` : ''}
    <button type="submit" class="btn solid">save note</button>
  </form>`;
}

// ---------------------------------------------------------------- setup

function themeChoice() {
  return store.get('kroog-theme', 'system');
}

function renderSetup() {
  const info = S.info;
  const link = info.link || {};
  const demo = info.mode === 'demo';
  const st = S.settings;
  const events = ['SessionStart', 'UserPromptSubmit', 'PreToolUse', 'PermissionRequest', 'PostToolUse', 'Notification', 'Stop', 'SubagentStart', 'SessionEnd'];
  const lastEvents = info.lastEvents || {};
  let state = '<span class="state">not linked</span>';
  if (demo) state = '<span class="state">demo</span>';
  else if (link.linked && link.scriptPort && link.scriptPort !== info.port) state = '<span class="state warn">linked to another port</span>';
  else if (link.linked) state = '<span class="state ok">linked</span>';
  else if (link.partial) state = '<span class="state warn">partly linked</span>';
  const theme = themeChoice();
  const alertsOn = store.get('kroog-alerts', 'off') === 'on';
  const permission = 'Notification' in window ? Notification.permission : 'unsupported';
  const hold = Number(st.permissionHoldSeconds ?? 30);
  const cl = info.claude || {};
  const ai = info.ai || {};
  const claudeState = demo ? '<span class="state">demo</span>' : cl.found ? '<span class="state ok">ready</span>' : '<span class="state warn">not found</span>';
  const aiState = ai.provider && ai.provider !== 'off' ? `<span class="state ok">${esc({ claude: 'claude code', api: 'api key', ollama: 'ollama', demo: 'demo' }[ai.provider] || ai.provider)}</span>` : '<span class="state">off</span>';
  const aiLine = demo
    ? 'In the demo, summaries are made from the chat text, with no model.'
    : ai.provider === 'claude' ? `Each call is one short Haiku request through Claude Code. It counts toward your plan's usage like any Claude Code chat, and takes about 3 seconds. ${ai.usedToday || 0} of ${ai.limit || 200} used today.`
    : ai.provider === 'api' ? `Each call costs well under a cent on your API key. ${ai.usedToday || 0} of ${ai.limit || 200} used today.`
    : ai.provider === 'ollama' ? `Runs on this Mac only, free. Needs Ollama running with the model pulled (ollama pull ${st.ollamaModel || 'llama3.2'}). ${ai.usedToday || 0} of ${ai.limit || 200} used today.`
    : 'Off. Kroog still works; chats just have no summaries, and briefs are put together without AI.';

  $('#view').innerHTML = `${demoLine()}<div class="page">
    <header class="page-head"><div><h1>Setup</h1><p class="lead">Kroog runs on this Mac only. It watches your Claude Code chats, lets you answer them here, and never changes your code.</p></div></header>
    <div class="setup">
      <section class="set"><h2>Claude Code ${state}</h2><div class="body">
        <p>Kroog adds a few hooks to <code>${esc(tildePath(link.settingsPath || '~/.claude/settings.json'))}</code>. Every Claude Code chat on this Mac reads that file, including the VS Code and Cursor panels, so no plugin is needed. Kroog saves a backup first.</p>
        ${link.error ? `<p style="color:var(--error)">${esc(link.error)}</p>` : ''}
        ${demo ? '<p>The demo never touches your settings. Quit it and run <code>node bin/kroog.js link</code>.</p>' : `<div class="tools" style="margin:0"><button type="button" class="btn solid" id="do-link">${link.linked ? 'link again' : 'link now'}</button>${link.linked || link.partial ? '<button type="button" class="btn warn" id="do-unlink">unlink</button>' : ''}</div>`}
        <p class="quiet">${info.claude && info.claude.registry ? `Claude Code reports ${plural(info.claude.open || 0, 'open chat')} right now. Chats that are open show up here at once; what they do arrives through the hooks.` : 'After linking, chats show up once they do something.'}</p>
        <ul class="events">${events.map((e) => `<li class="${lastEvents[e] ? 'yes' : ''}">${e}<span>${lastEvents[e] ? (dur(lastEvents[e]) === 'just now' ? 'just now' : `${dur(lastEvents[e])} ago`) : 'not yet'}</span></li>`).join('')}</ul>
      </div></section>

      <section class="set"><h2>Running chats here ${claudeState}</h2><div class="body">
        <p>Kroog can run Claude Code chats itself: new chats, a brief handed to a chat, or the next turn of a chat. It uses Claude Code on this Mac with your usual login, settings and plan, so these chats are in VS Code's session history too and you can carry them on there.</p>
        ${demo ? '<p class="quiet">In the demo, runs are pretend.</p>' : cl.found
          ? `<p class="quiet">Using <code>${esc(tildePath(cl.path))}</code>${cl.from === 'vscode' || cl.from === 'cursor' ? ` (the copy inside ${cl.from === 'cursor' ? 'Cursor' : 'VS Code'})` : ''}, version ${esc(cl.version || '')}.</p>`
          : '<p>Kroog could not find Claude Code. Install it for the Terminal (see code.claude.com), or paste the path to it below.</p>'}
        ${demo ? '' : `<form class="keyrow" id="claude-form" autocomplete="off"><label for="set-claude" class="sr">Path to Claude Code</label><input type="text" id="set-claude" placeholder="found on its own; or paste a path, like ~/.local/bin/claude" value="${esc(st.claudePath || '')}" autocomplete="off"><button type="submit" class="btn soft">check</button></form>`}
        <div class="field"><label for="set-kroogperm">Chats Kroog runs</label><select id="set-kroogperm"><option value="default" ${st.kroogPermissionMode !== 'acceptEdits' ? 'selected' : ''}>ask me here before edits and commands</option><option value="acceptEdits" ${st.kroogPermissionMode === 'acceptEdits' ? 'selected' : ''}>edit files without asking; ask before commands</option></select></div>
        <p class="quiet">Kroog answers its own chats' questions only while a Kroog tab is open. With no tab open, anything that needs your yes is not allowed.</p>
      </div></section>

      <section class="set"><h2>AI helper ${aiState}</h2><div class="body">
        <p>A small, fast model writes a short summary of each chat (hover a chat to see it) with one suggested next step, merges chats into one brief when you hand off, and writes notes for the library.</p>
        <div class="field"><label for="set-ai">Use</label><select id="set-ai">${[['auto', 'automatic: Claude Code with Haiku if found, else my API key'], ['claude', 'Claude Code with Haiku, on your plan'], ['api', 'my Anthropic API key (Haiku 5.5)'], ['ollama', 'a local model with Ollama'], ['off', 'nothing (AI off)']].map(([v, l]) => `<option value="${v}" ${(st.aiProvider || 'auto') === v ? 'selected' : ''}>${l}</option>`).join('')}</select></div>
        ${(st.aiProvider === 'ollama') ? `<div class="field"><label for="set-ollama">Ollama model</label><input type="text" id="set-ollama" value="${esc(st.ollamaModel || 'llama3.2')}" autocomplete="off"></div>` : ''}
        <div class="field"><label for="set-aisum">Summaries</label><select id="set-aisum">${[['finish', 'after each turn a chat finishes'], ['hover', 'only when I look at a chat'], ['off', 'off']].map(([v, l]) => `<option value="${v}" ${(st.aiSummaries || 'finish') === v ? 'selected' : ''}>${l}</option>`).join('')}</select></div>
        <div class="field"><label for="set-ailimit">At most, per day</label><select id="set-ailimit">${[50, 200, 500, 1000].map((v) => `<option value="${v}" ${Number(st.aiDailyLimit || 200) === v ? 'selected' : ''}>${v} calls</option>`).join('')}</select></div>
        <p class="quiet">${esc(aiLine)}</p>
        ${ai.error ? `<p style="color:var(--error)">${esc(ai.error)}</p>` : ''}
      </div></section>

      <section class="set"><h2>Older chats</h2><div class="body">
        <p>Kroog only hears from a chat once it does something. To see chats you used before linking, import them from Claude Code's own history on this Mac. Kroog reads it and changes nothing. Imported chats show their title, project, plan, files and last reply, and come alive again when you use them.</p>
        ${demo ? '<p class="quiet">The demo has fake chats only.</p>' : `<div class="tools" style="margin:0;flex-wrap:nowrap;align-items:center"><select id="import-days" aria-label="How far back" style="width:auto">${[[1, 'last day'], [3, 'last 3 days'], [7, 'last 7 days'], [14, 'last 14 days']].map(([v, l]) => `<option value="${v}" ${v === (UI.importDays || 7) ? 'selected' : ''}>${l}</option>`).join('')}</select><button type="button" class="btn solid" id="do-import">import recent chats</button></div>`}
        <p class="quiet">Kroog also does this each time it starts, for the last 7 days.</p>
      </div></section>

      <section class="set"><h2>Which chats</h2><div class="body">
        <label class="check"><input type="checkbox" id="set-ide" ${st.ideOnly !== false ? 'checked' : ''}><span>only chats in VS Code, Cursor and other editors</span></label>
        <p class="quiet">Hides chats from the Claude desktop app and from terminals outside an editor. ${plural(hiddenByScope(S), 'chat')} hidden now. Chats on claude.ai never reach Kroog.</p>
      </div></section>

      <section class="set"><h2>Permission questions</h2><div class="body">
        <p>When a chat asks to run a command or edit a file, Kroog can hold the question so you answer it here. If you don't, the editor asks as usual. Kroog only holds while a Kroog tab is open.</p>
        <div class="field"><label for="set-hold">Answer here first for</label><select id="set-hold">${[[0, "don't hold, only show them"], [15, '15 seconds'], [30, '30 seconds'], [60, '1 minute'], [120, '2 minutes']].map(([v, l]) => `<option value="${v}" ${hold === v ? 'selected' : ''}>${l}</option>`).join('')}</select></div>
      </div></section>


      <section class="set"><h2>Notes <span class="state ${info.apiKey ? 'ok' : ''}">${info.apiKey ? 'key saved' : 'no key'}</span></h2><div class="body">
        <p>When a chat finishes a turn, the AI helper can turn its reply into a few short notes for the library. An API key is only needed if you pick "my Anthropic API key" above, or if Claude Code is not found.</p>
        ${demo ? '<p class="quiet">Notes are off in the demo.</p>' : `
        <form class="keyrow" id="key-form" autocomplete="off"><label for="set-key" class="sr">Anthropic API key</label><input type="password" id="set-key" placeholder="${info.apiKey ? 'saved; paste a new key to replace it' : 'sk-ant-...'}" autocomplete="off"><button type="submit" class="btn solid">save key</button>${info.apiKey ? '<button type="button" class="btn warn" id="del-key">remove</button>' : ''}</form>
        <label class="check"><input type="checkbox" id="set-notes" ${st.notesEnabled !== false ? 'checked' : ''}><span>write notes when a chat finishes a turn</span></label>`}
        <p class="quiet">The key is saved only in <code>~/.kroog/.env</code> on this Mac, never in your shell, so your chats keep using your Claude plan. Make it in its own Console workspace with a monthly spend limit.</p>
      </div></section>

      <section class="set"><h2>Alerts</h2><div class="body">
        <p>The tab title shows how many chats need you, like "(2) kroog". Browser alerts pop up when a chat needs you or finishes while this tab is in the background.</p>
        ${permission === 'unsupported' ? '<p class="quiet">This browser has no alerts.</p>' : `<button type="button" class="btn soft" id="alerts-btn">${alertsOn && permission === 'granted' ? 'turn alerts off' : 'turn alerts on'}</button>`}
        ${permission === 'denied' ? '<p class="quiet">Your browser blocks alerts for this page. Allow them in its site settings.</p>' : ''}
      </div></section>

      <section class="set"><h2>Look</h2><div class="body">
        <div class="seg" role="group" aria-label="Theme">${[['system', 'match my Mac'], ['light', 'light'], ['dark', 'dark']].map(([k, l]) => `<button type="button" data-theme-choice="${k}" aria-pressed="${theme === k}">${l}</button>`).join('')}</div>
        <label class="check"><input type="checkbox" id="set-water" ${waterOn() ? 'checked' : ''}><span>the water behind the lineage</span></label>
        <p class="quiet">Fish from the ishanyash.com water. They stand still if your Mac is set to reduce motion.</p>
      </div></section>

      <section class="set"><h2>Where things live</h2><div class="body">
        <p>Kroog's files: <code>${esc(tildePath((info.paths || {}).home || '~/.kroog'))}</code></p>
        <p>Claude Code settings: <code>${esc(tildePath((info.paths || {}).settings || '~/.claude/settings.json'))}</code></p>
        <p>This page: <code>http://127.0.0.1:${esc(info.port || 4877)}</code>, on this Mac only. Version ${esc(info.version || '')}, draft.</p>
        <p class="quiet">Your chats stay on this Mac. The only thing Kroog sends anywhere is a note request to the Claude API, when you have added a key.</p>
      </div></section>
    </div>
  </div>`;
}

function applyTheme(choice) {
  store.set('kroog-theme', choice);
  const dark = choice === 'dark' || (choice === 'system' && window.matchMedia('(prefers-color-scheme: dark)').matches);
  document.documentElement.setAttribute('data-theme', dark ? 'dark' : 'light');
  themeChanged();
}

// ---------------------------------------------------------------- log bar

function feed(limit) {
  const items = [];
  for (const s of visibleSessions(S)) {
    for (const step of (s.steps || []).slice(-30)) {
      if (step.kind === 'info' && /^Chat (opened|closed)$/.test(step.text)) continue;
      items.push({ s, step });
    }
  }
  items.sort((a, b) => (b.step.t || 0) - (a.step.t || 0));
  return items.slice(0, limit);
}

function renderLog() {
  const bar = $('#logbar');
  const latest = feed(UI.logOpen ? 60 : 1);
  const top = latest[0];
  const line = top
    ? `<span class="when">${esc(clock(top.step.t))}</span><span class="who">${esc(trim(top.s.title || 'New chat', 40))}</span><span class="what">${esc(top.step.text)}</span>`
    : `<span class="what quiet">${esc(statusSentence())}</span>`;
  const panel = UI.logOpen
    ? `<div class="logpanel"><ol class="log">${latest.map(({ s, step }) => `<li><time>${esc(clock(step.t))}</time><span class="who"><a class="linkish" href="#/lineage" data-open="${esc(s.id)}">${esc(trim(s.title || 'New chat', 32))}</a></span><span>${esc(step.text)}</span></li>`).join('')}</ol></div>`
    : '';
  bar.innerHTML = `${panel}<div class="logline">${line}<button type="button" class="linkish quiet toggle" data-log-toggle aria-expanded="${UI.logOpen}">${UI.logOpen ? 'hide log' : 'show log'}</button></div>`;
}

// ---------------------------------------------------------------- routing and events

function route() {
  const r = (location.hash.replace(/^#\/?/, '') || (window.innerWidth < 760 ? 'list' : 'lineage')).split('?')[0];
  const map = { board: 'lineage', handoff: 'lineage' };
  const next = map[r] || (['lineage', 'list', 'brain', 'library', 'setup'].includes(r) ? r : 'lineage');
  // An unfinished brief waits on the lineage while you visit other pages.
  if (r === 'handoff') UI.handoff.active = true;
  UI.route = next;
  renderAll(true);
  $('#view').focus({ preventScroll: true });
}

function goToNeeding() {
  const ids = visibleSessions(S).filter((s) => s.status === 'needs' || s.status === 'error').map((s) => s.id);
  if (!ids.length) return;
  const next = UI.route === 'lineage' ? nextNeeding(UI.selected) || ids[0] : ids[(ids.indexOf(UI.selected) + 1) % ids.length];
  if (UI.route !== 'lineage' && UI.route !== 'list') location.hash = '#/lineage';
  UI.selected = next;
  renderAll(false);
  if (UI.route === 'lineage') requestAnimationFrame(() => reveal(next, true));
}

document.addEventListener('click', async (e) => {
  const t = e.target.closest('button, a, [data-open], [data-draft]');
  if (!t) return;
  const d = t.dataset;
  if (d.allow) { e.stopPropagation(); act(post(`sessions/${encodeURIComponent(d.allow)}/decide`, { behavior: 'allow' }), 'Allowed. It carries on.'); return; }
  if (d.deny) { e.stopPropagation(); act(post(`sessions/${encodeURIComponent(d.deny)}/decide`, { behavior: 'deny' }), 'Denied. It will try another way or ask you.'); return; }
  if (t.closest('.menu-items')) { UI.menuOpen = false; const m = t.closest('details.menu'); if (m) m.open = false; }
  if (d.branch) { UI.branchFor = d.branch; const s0 = S.sessions.get(d.branch); if (s0) updateComposer(s0); const m = $('#msg'); if (m) m.focus(); return; }
  if (d.tools) { UI.openTools = UI.openTools || new Set(); UI.openTools.add(d.tools); renderConversation(S.sessions.get(UI.selected)); return; }
  if (d.link) { e.preventDefault(); e.stopPropagation(); toggleLink(d.link); return; }
  if (d.linkCancel !== undefined) { UI.linking = null; renderAll(false); return; }
  if (d.open) { e.preventDefault(); select(d.open); return; }
  if (d.draft) { const g = $('#ho-goal'); if (g) g.focus(); return; }
  if (d.close !== undefined) { UI.selected = null; renderAll(false); return; }
  if (d.filter) { UI.list.filter = d.filter; renderAll(false); return; }
  if (d.zoom) { if (d.zoom === 'fit') fit(true, true); else zoomBy(d.zoom === 'in' ? 1.2 : 1 / 1.2); return; }
  if (d.jump !== undefined) { goToNeeding(); return; }
  if (d.logToggle !== undefined) { UI.logOpen = !UI.logOpen; renderLog(); return; }
  if (d.denyReason) {
    const reason = ($('#deny-reason') || {}).value || '';
    act(post(`sessions/${encodeURIComponent(d.denyReason)}/decide`, { behavior: 'deny', message: reason }), reason ? 'Denied, with your reason.' : 'Denied.');
    return;
  }
  if (d.release) { act(post(`sessions/${encodeURIComponent(d.release)}/release`), 'Handed over. The editor asks you now.'); return; }
  if (d.letgo) { act(post(`sessions/${encodeURIComponent(d.letgo)}/stop`), 'Released. The chat is back to normal in the editor.'); return; }
  if (d.handoff) { startHandoff(d.handoff); return; }
  if (d.handoffCancel !== undefined) { endHandoff(); return; }
  if (d.newChat !== undefined) {
    e.stopPropagation();
    if (UI.linking) { connectTo('', d.newChat); return; }
    if (UI.handoff.active) { toast('Finish or cancel the brief first.'); return; }
    UI.newChat = { cwd: d.newChat, text: '' };
    UI.selected = null;
    hideHover();
    renderAll(false);
    setTimeout(() => { const x = $('#nc-text'); if (x) x.focus(); }, 30);
    return;
  }
  if (d.newchatCancel !== undefined) { UI.newChat = null; renderAll(false); return; }
  if (d.run) { UI.handoff.run = d.run; renderAll(false); return; }
  if (d.summarize) { wantSummary(S.sessions.get(d.summarize), true); return; }
  if (d.toEditor) {
    const s = S.sessions.get(d.toEditor);
    const r = await act(post('to-editor', { id: d.toEditor }));
    if (r && r.url) { openUrl(r.url); toast(`Opening it in ${s ? edName(s) : 'the editor'}. It must be the same project folder that the editor has open. From now on, a message from Kroog starts a branch.`, 9000); }
    return;
  }
  if (d.unextra !== undefined) { UI.handoff.extra.splice(Number(d.unextra), 1); UI.handoff.aiText = null; renderAll(false); return; }
  if (d.unsource) { UI.handoff.aiText = null; UI.handoff.sources = UI.handoff.sources.filter((x) => x.id !== d.unsource); renderAll(false); return; }
  if (d.unnote) { UI.handoff.notes = UI.handoff.notes.filter((x) => x !== d.unnote); renderAll(false); return; }
  if (d.archive) { await act(post(`sessions/${encodeURIComponent(d.archive)}/archive`, { on: true }), 'Hidden. It comes back when it does something.'); UI.selected = null; renderAll(false); return; }
  if (d.remember) {
    const note = S.notes.find((x) => x.id === d.remember);
    act(post(`notes/${encodeURIComponent(d.remember)}/remember`, { on: !(note && note.remembered) }), note && note.remembered ? 'Forgotten. New chats no longer get it.' : 'Remembered. New chats in that folder start with it.');
    return;
  }
  if (d.forget) { act(post(`notes/${encodeURIComponent(d.forget)}/remember`, { on: false }), 'Forgotten. New chats no longer get it.'); return; }
  if (d.delnote) { act(post(`notes/${encodeURIComponent(d.delnote)}/delete`), 'Note deleted.'); return; }
  if (d.noteHandoff) {
    const h = UI.handoff;
    const had = h.notes.includes(d.noteHandoff);
    h.notes = had ? h.notes.filter((x) => x !== d.noteHandoff) : [...h.notes, d.noteHandoff];
    if (!had) h.active = true;
    renderAll(false);
    toast(had ? 'Removed from the brief.' : 'Added to the brief. Open the lineage to pick chats and send it.');
    return;
  }
  if (d.kind) { UI.library.kind = d.kind; renderAll(false); return; }
  if (d.themeChoice) { applyTheme(d.themeChoice); renderAll(false); return; }

  switch (t.id) {
    case 'theme-btn': applyTheme(document.documentElement.getAttribute('data-theme') === 'dark' ? 'light' : 'dark'); if (UI.route === 'setup') renderAll(false); break;
    case 'needs-pill': goToNeeding(); break;
    case 'ho-send': sendHandoff(); break;
    case 'ho-ai': writeBriefWithAi(); break;
    case 'ho-ai-reset': UI.handoff.aiText = null; renderAll(false); break;
    case 'nc-start': startNewChat(); break;
    case 'nc-editor': {
      const text = ($('#nc-text') || {}).value || '';
      const ed = S.settings.defaultEditor || 'vscode';
      openUrl(`${ed}://anthropic.claude-code/open${text.trim() ? `?prompt=${encodeURIComponent(text.trim())}` : ''}`);
      toast(`Opening a new chat in ${EDITORS[ed] || 'VS Code'}. It starts in the folder the editor has open, so open ${folderName(UI.newChat.cwd)} there first.`, 9000);
      UI.newChat = null;
      renderAll(false);
      break;
    }
    case 'claude-check': await act(post('claude-check'), (r) => r.message); break;
    case 'ho-copy':
      try { await navigator.clipboard.writeText(briefText()); toast('Brief copied. Paste it into any chat.'); } catch { toast('Copy failed. Open the preview and copy the text instead.'); }
      break;
    case 'lib-add': UI.library.adding = !UI.library.adding; renderAll(false); break;
    case 'do-link': await act(post('link'), (r) => r.message || 'Linked.'); break;
    case 'do-import': {
      const sel = document.getElementById('import-days');
      if (sel) UI.importDays = Number(sel.value);
      t.disabled = true;
      t.textContent = 'importing...';
      await act(post('import', { days: sel ? Number(sel.value) : 7 }), (r) => r.message || 'Imported.');
      t.disabled = false;
      t.textContent = 'import recent chats';
      break;
    }
    case 'do-unlink': await act(post('unlink'), (r) => r.message || 'Unlinked.'); break;
    case 'del-key': await act(post('apikey-remove'), 'API key removed. Notes are off.'); break;
    case 'alerts-btn': {
      const on = store.get('kroog-alerts', 'off') === 'on';
      if (on && Notification.permission === 'granted') {
        store.set('kroog-alerts', 'off');
        toast('Alerts are off.');
      } else {
        const result = await Notification.requestPermission();
        if (result === 'granted') { store.set('kroog-alerts', 'on'); toast('Alerts are on.'); } else toast('Your browser did not allow alerts.');
      }
      renderAll(false);
      break;
    }
    default: break;
  }
});

document.addEventListener('toggle', (e) => {
  if (e.target.matches && e.target.matches('details.menu')) UI.menuOpen = e.target.open;
}, true);

document.addEventListener('input', (e) => {
  const t = e.target;
  if (t.id === 'q') { UI.list.query = t.value; renderAll(false); }
  else if (t.id === 'lib-q') { UI.library.query = t.value; renderAll(false); }
  else if (t.id === 'nc-text' && UI.newChat) UI.newChat.text = t.value;
  else if (t.id === 'ho-aitext') UI.handoff.aiText = t.value;
  else if (t.id === 'ho-goal') {
    UI.handoff.goal = t.value;
    const pre = $('#ho-preview');
    if (pre) pre.textContent = composeBrief();
    if (UI.route === 'lineage') renderLineage(S, UI, visibleSessions(S));
  }
});

document.addEventListener('change', async (e) => {
  const t = e.target;
  const d = t.dataset;
  if (d.inc) { const src = sourceFor(d.inc); if (src) src.include[d.key] = t.checked; UI.handoff.aiText = null; renderAll(false); return; }
  if (t.name === 'dest') { UI.handoff.target = t.value; renderAll(false); return; }
  switch (t.id) {
    case 'ho-short': UI.handoff.short = t.checked; renderAll(false); break;
    case 'ho-editor': UI.handoff.editor = t.value; renderAll(false); break;
    case 'ho-mem': UI.handoff.memoryCwd = t.value; break;
    case 'ho-newcwd': UI.handoff.newCwd = t.value; break;
    case 'ho-run': UI.handoff.runTarget = t.value; renderAll(false); break;
    case 'set-kroogperm': await act(post('settings', { kroogPermissionMode: t.value }), 'Saved.'); break;
    case 'set-ai': await act(post('settings', { aiProvider: t.value }), 'Saved.'); break;
    case 'set-aisum': await act(post('settings', { aiSummaries: t.value }), 'Saved.'); break;
    case 'set-ailimit': await act(post('settings', { aiDailyLimit: Number(t.value) }), 'Saved.'); break;
    case 'set-ollama': await act(post('settings', { ollamaModel: t.value }), 'Saved.'); break;
    case 'lib-project': UI.library.project = t.value; renderAll(false); break;
    case 'mem-folder': UI.library.memCwd = t.value; renderAll(false); break;
    case 'set-ide': await act(post('settings', { ideOnly: t.checked })); break;
    case 'set-hold': await act(post('settings', { permissionHoldSeconds: Number(t.value) }), 'Saved.'); break;
    case 'set-drive': await act(post('settings', { driveMinutes: Number(t.value) }), 'Saved.'); break;
    case 'set-notes': await act(post('settings', { notesEnabled: t.checked }), t.checked ? 'Notes are on.' : 'Notes are off.'); break;
    case 'set-water': store.set('kroog-water', t.checked ? 'on' : 'off'); setWater(t.checked); toast(t.checked ? 'The fish are back.' : 'Still water.'); break;
    default: break;
  }
});

document.addEventListener('submit', async (e) => {
  if (e.target.id === 'claude-form') {
    e.preventDefault();
    await act(post('settings', { claudePath: $('#set-claude').value }));
    await act(post('claude-check'), (r) => r.message);
    return;
  }
  if (e.target.id === 'key-form') {
    e.preventDefault();
    const input = $('#set-key');
    const r = await act(post('apikey', { key: input.value }), (x) => x.message || 'Saved.');
    if (r) input.value = '';
  } else if (e.target.id === 'note-form') {
    e.preventDefault();
    const text = $('#nf-text').value.trim();
    const r = await act(post('notes', { type: $('#nf-type').value, text, cwd: $('#nf-folder') ? $('#nf-folder').value : '' }), 'Note saved.');
    if (r) { UI.library.adding = false; renderAll(false); }
  }
});

document.addEventListener('keydown', (e) => {
  const typing = e.target.closest('input, textarea, select');
  const node = e.target.closest('[data-open], [data-draft]');
  if (node && !typing && (e.key === 'Enter' || e.key === ' ') && !e.target.closest('button')) {
    e.preventDefault();
    if (node.dataset.open) select(node.dataset.open);
    return;
  }
  if (e.key === 'Escape' && !typing) {
    if (UI.linking) { UI.linking = null; renderAll(false); }
    else if (UI.handoff.active) endHandoff();
    else if (UI.newChat) { UI.newChat = null; renderAll(false); }
    else if (UI.selected) { UI.selected = null; renderAll(false); }
    return;
  }
  if (typing || e.metaKey || e.ctrlKey || e.altKey || UI.route !== 'lineage') return;
  if (e.key === 'f') fit(true, true);
  else if (e.key === 'ArrowLeft') shiftWeek(-1);
  else if (e.key === 'ArrowRight') shiftWeek(1);
  else if (e.key === '+' || e.key === '=') zoomBy(1.2);
  else if (e.key === '-') zoomBy(1 / 1.2);
});

window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => {
  if (themeChoice() === 'system') applyTheme('system');
});

// Ticking clocks and countdowns without redrawing everything.
function shortCount(deadline) {
  const sec = Math.max(0, Math.round((deadline - Date.now()) / 1000));
  return sec >= 60 ? `${Math.floor(sec / 60)}m ${sec % 60}s` : `${sec}s`;
}
setInterval(() => {
  for (const el of $$('[data-tick="deadline"]')) {
    const deadline = Number(el.dataset.deadline);
    if (!deadline) continue;
    el.textContent = el.dataset.short ? shortCount(deadline) : countdownText(deadline, el.dataset.what || 'the editor asks');
  }
  for (const el of $$('[data-tick="when"]')) {
    const s = S.sessions.get(el.dataset.id);
    if (s) el.textContent = whenText(s);
  }
  for (const el of $$('[data-tick="clock"]')) el.textContent = clock(Date.now());
}, 1000);

// "Use in a brief" on the Brain page.
window.addEventListener('kroog:brief-text', (e) => {
  const { title = 'From the brain', text = '' } = e.detail || {};
  if (!text) return;
  const h = UI.handoff;
  h.extra = [...(h.extra || []), { title, text }];
  h.active = true;
  h.aiText = null;
  toast('Added to a brief. Pick chats on the lineage to add more, then choose where it goes.');
  location.hash = '#/lineage';
});

// "Open chat" on the Brain map.
window.addEventListener('kroog:open-chat', (e) => {
  const id = e.detail && e.detail.id;
  if (!id || !S.sessions.has(id)) return;
  UI.route = 'lineage';
  if (location.hash !== '#/lineage') location.hash = '#/lineage';
  setTimeout(() => select(id), 60);
});

window.addEventListener('hashchange', route);
applyTheme(themeChoice());
route();
connect();
