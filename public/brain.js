// The Brain page: a map of your ~/.claude world and your chats on top, then search by
// meaning and by keyword. The app calls renderBrain() on every live update, so this keeps
// its own state and only redraws the parts that changed (your typing is never interrupted).
import { mountBrainMap } from './brainmap.js';

const KIND_LABEL = {
  instructions: 'instructions',
  skill: 'skills',
  agent: 'agents',
  command: 'commands',
  plan: 'plans',
  memory: 'auto memory',
  'project-doc': 'project docs',
  note: 'kroog notes',
};

const B = {
  query: '',
  kind: 'all',
  results: null,
  recent: null,
  searching: false,
  lastShown: '',
  timer: null,
  seq: 0,
  connectBusy: false,
  lastBuilt: 0,
  // The map.
  map: null,
  mapData: null,
  mapKey: '',
  mapAt: 0,
  mapError: '',
  selected: null,
  texts: new Map(),
  detailSeq: 0,
};

let API = null;
let LAST_S = null;

function wordsOf(q) {
  return [...new Set(String(q || '').toLowerCase().split(/[^a-z0-9_]+/).filter((w) => w.length > 1))];
}

function marked(text, q, esc) {
  let html = esc(text);
  const ws = wordsOf(q).map((w) => (w.length > 3 && w.endsWith('s') ? w.slice(0, -1) : w));
  if (!ws.length) return html;
  const re = new RegExp(`\\b(${ws.map((w) => w.replace(/[^a-z0-9_]/g, '')).filter(Boolean).join('|')})[a-z0-9_]*`, 'gi');
  return html.replace(re, (m) => `<mark>${m}</mark>`);
}

function shortPath(p) {
  if (!p) return '';
  if (p.startsWith('kroog-note:')) return 'kroog note';
  return p.replace(/^\/(Users|home)\/[^/]+/, '~');
}

// A skill's title is "name: long description"; the name is enough in a list.
function shortTitle(t) {
  const x = String(t || '');
  const i = x.indexOf(': ');
  const head = i > 0 && i < 60 ? x.slice(0, i) : x;
  return head.length > 90 ? `${head.slice(0, 89)}…` : head;
}

function statusLine(st) {
  if (!st) return 'Starting up.';
  const parts = [];
  parts.push(`${st.files || 0} files, ${st.chunks || 0} pieces`);
  if (st.embedder && st.embedder !== 'none') parts.push(`searched by meaning with ${st.model || st.embedder} on this Mac, and by keyword`);
  else parts.push('searched by keyword (for search by meaning, run Ollama with an embedding model)');
  return `${parts.join(', ')}.`;
}

function progressLine(st) {
  if (!st || !st.building) return '';
  const p = st.progress || {};
  if (p.phase === 'embedding' && p.total) return `Indexing: ${p.done} of ${p.total} pieces`;
  return 'Reading your files';
}

function mapLine() {
  if (B.mapError) return B.mapError;
  const m = B.mapData;
  if (!m) return 'Drawing the map…';
  const files = m.nodes.filter((n) => n.type === 'file').length;
  const chats = m.nodes.length - files;
  const how = m.mode === 'vectors' ? `linked by meaning${m.embedder && m.embedder !== 'vectors' ? ` (${m.embedder})` : ''}` : 'linked by keyword';
  return `${files} files, ${chats} chats, ${m.edges.length} links · ${how}${m.truncated ? ' · only the newest files are shown' : ''}. Click a node to read it; drag to move; scroll to zoom.`;
}

// ---- the list -------------------------------------------------------------------------

function resultHtml(r, esc) {
  const canOpen = r.path && r.path.startsWith('/');
  return `<li class="brain-hit" data-brain-id="${esc(r.id)}" data-brain-path="${esc(r.path || '')}">
    <div class="bh-head"><b title="${esc(r.title || '')}">${esc(shortTitle(r.title) || shortPath(r.path))}</b><span class="bh-proj">${esc(r.project || '')}</span></div>
    ${r.heading && r.heading !== r.title ? `<div class="bh-path">${esc(r.heading)}</div>` : ''}
    <p class="bh-snip">${marked(r.snippet || '', B.query, esc)}</p>
    <div class="bh-foot"><span class="quiet">${esc(shortPath(r.path))}</span>
      <span class="bh-acts"><button type="button" class="linkish" data-brain-show="${esc(r.path || '')}">show on map</button>${canOpen ? `<button type="button" class="linkish" data-brain-open="${esc(r.path)}">open</button>` : ''}<button type="button" class="linkish" data-brain-copy="${esc(r.id)}">copy</button><button type="button" class="linkish" data-brain-brief="${esc(r.id)}">use in a brief</button></span></div>
  </li>`;
}

function listHtml(esc) {
  const searching = B.query.trim().length > 0;
  const items = searching ? B.results : B.recent;
  if (items == null) return `<p class="quiet">${searching ? 'Searching' : 'Loading'}<span class="dots"></span></p>`;
  const shown = B.kind === 'all' ? items : items.filter((r) => r.kind === B.kind);
  if (!shown.length) {
    return `<div class="empty"><p>${searching ? `Nothing matches "${esc(B.query.trim())}"${B.kind === 'all' ? '' : ` in ${esc(KIND_LABEL[B.kind] || B.kind)}`}.` : 'Nothing indexed yet. Kroog reads your ~/.claude folder and the projects of your chats.'}</p></div>`;
  }
  if (!searching) return `<div class="section-head"><h2>Recently changed</h2><span class="n">${shown.length}</span></div><ul class="brain-hits">${shown.map((r) => resultHtml(r, esc)).join('')}</ul>`;
  const kinds = [...new Set(shown.map((r) => r.kind))];
  return kinds.map((k) => {
    const rs = shown.filter((r) => r.kind === k);
    return `<div class="section-head"><h2>${esc(KIND_LABEL[k] || k)}</h2><span class="n">${rs.length}</span></div><ul class="brain-hits">${rs.map((r) => resultHtml(r, esc)).join('')}</ul>`;
  }).join('');
}

function pillsHtml(st, esc) {
  const counts = new Map(((st && st.sources) || []).map((x) => [x.kind, x.count]));
  const total = [...counts.values()].reduce((a, b) => a + b, 0);
  const pills = [['all', 'all', total], ...Object.keys(KIND_LABEL).filter((k) => counts.get(k)).map((k) => [k, KIND_LABEL[k], counts.get(k)])];
  return pills.map(([k, label, n]) => `<button type="button" class="pill" data-brain-kind="${esc(k)}" aria-pressed="${B.kind === k}">${esc(label)} <span class="n">${n}</span></button>`).join('');
}

function allItems() {
  return [...(B.results || []), ...(B.recent || [])];
}

// Which nodes on the map match the search: the files found, and chats whose title or
// summary has one of the words.
function matchIds() {
  const q = B.query.trim();
  if (!q || !B.mapData) return [];
  const ids = new Set();
  for (const r of B.results || []) ids.add(`f:${r.path}`);
  const ws = wordsOf(q);
  for (const n of B.mapData.nodes) {
    if (n.type !== 'chat') continue;
    const hay = `${n.title} ${n.gist} ${(n.keywords || []).join(' ')}`.toLowerCase();
    if (ws.some((w) => hay.includes(w))) ids.add(n.id);
  }
  return [...ids];
}

function syncMapQuery() {
  if (!B.map) return;
  const q = B.query.trim();
  B.map.setQuery(q, q && B.results ? matchIds() : []);
}

async function runSearch() {
  const q = B.query.trim();
  const seq = ++B.seq;
  if (!q) {
    B.results = null;
    paint();
    syncMapQuery();
    return;
  }
  B.searching = true;
  try {
    const r = await API.post('brain-search', { query: q, kinds: B.kind === 'all' ? null : [B.kind] });
    if (seq !== B.seq) return;
    B.results = r.results || [];
  } catch (error) {
    if (seq !== B.seq) return;
    B.results = [];
    API.toast(error.message);
  } finally {
    if (seq === B.seq) B.searching = false;
  }
  paint();
  syncMapQuery();
}

async function loadRecent() {
  try {
    const r = await API.post('brain-recent', {});
    B.recent = r.results || [];
  } catch {
    B.recent = [];
  }
  paint();
}

// Redraw only the list, when it changed.
function paint() {
  const box = document.getElementById('brain-list');
  if (!box || !API) return;
  const html = listHtml(API.esc);
  if (html === B.lastShown) return;
  B.lastShown = html;
  box.innerHTML = html;
}

// ---- the map ----------------------------------------------------------------------------

function mapKeyFor(S) {
  const st = (S && S.info && S.info.brain) || {};
  const sessions = S && S.sessions ? S.sessions.size : 0;
  return `${st.lastBuilt || 0}|${sessions}`;
}

async function loadMap(force = false) {
  if (!API || !B.map) return;
  const key = mapKeyFor(LAST_S);
  // Chats change often while they work; the map follows at a calm pace.
  if (!force && key === B.mapKey) return;
  if (!force && B.mapAt && Date.now() - B.mapAt < 15000 && B.mapData) { setTimeout(() => loadMap(), 15000 - (Date.now() - B.mapAt) + 50); return; }
  B.mapKey = key;
  B.mapAt = Date.now();
  try {
    const r = await API.post('brain-map', {});
    if (!B.map) return;
    B.mapData = r.map || { nodes: [], edges: [] };
    B.mapError = '';
    B.map.setData(B.mapData);
    syncMapQuery();
  } catch (error) {
    B.mapError = /404|Not found/i.test(error.message) ? 'The map is not available in this version of Kroog.' : `The map could not be drawn: ${error.message}`;
  }
  const line = document.getElementById('brain-mapline');
  if (line) line.textContent = mapLine();
}

function mountMap(view) {
  const box = view.querySelector('#brain-map');
  if (!box) return;
  if (B.map) B.map.destroy();
  B.map = mountBrainMap(box, {
    onSelect: (node) => showDetail(node),
    onOpen: (node) => {
      if (!node) return;
      if (node.type === 'chat') openChat(node.chatId);
      else if (node.path && node.path.startsWith('/')) API.openUrl(`vscode://file${node.path}`);
    },
  });
  if (B.mapData) {
    B.map.setData(B.mapData);
    syncMapQuery();
    if (B.selected) B.map.select(B.selected.id);
  }
  B.mapKey = '';
  loadMap(true);
}

function openChat(id) {
  location.hash = '#/lineage';
  window.dispatchEvent(new CustomEvent('kroog:open-chat', { detail: { id } }));
}

// ---- the detail panel ---------------------------------------------------------------------

function textHtml(text, esc) {
  return String(text || '').split('\n').map((line) => (/^#{1,6}\s/.test(line) ? `<b>${esc(line.replace(/^#+\s*/, ''))}</b>` : esc(line))).join('\n');
}

function dayish(t) {
  if (!t) return '';
  const d = new Date(t);
  const now = new Date();
  const same = d.toDateString() === now.toDateString();
  return same ? d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }).toLowerCase() : d.toLocaleDateString([], { weekday: 'short', day: 'numeric', month: 'short' }).toLowerCase();
}

async function showDetail(node) {
  B.selected = node;
  const top = document.getElementById('brain-top');
  const panel = document.getElementById('brain-detail');
  if (!top || !panel) return;
  const esc = API.esc;
  if (!node) {
    panel.hidden = true;
    panel.innerHTML = '';
    top.classList.remove('has-detail');
    return;
  }
  top.classList.add('has-detail');
  panel.hidden = false;
  const seq = ++B.detailSeq;
  const close = '<button type="button" class="icon-btn bd-close" data-brain-close aria-label="Close">×</button>';
  if (node.type === 'chat') {
    const s = LAST_S && LAST_S.sessions ? LAST_S.sessions.get(node.chatId) : null;
    const prompt = s && s.lastPrompt ? String(s.lastPrompt) : '';
    const reply = s && s.lastReply ? String(s.lastReply) : '';
    panel.innerHTML = `<div class="bd-head"><div><span class="bd-kind">chat · ${esc(node.status)} · ${esc(dayish(node.lastAt))}</span><h2>${esc(node.title)}</h2><span class="quiet">${esc(node.project)}</span></div>${close}</div>
      ${node.gist ? `<p class="bd-gist">${esc(node.gist)}${(node.keywords || []).length ? `<span class="kw">${node.keywords.map((k) => `<i>${esc(k)}</i>`).join('')}</span>` : ''}</p>` : ''}
      ${prompt ? `<div class="bd-sec"><span class="bd-label">you asked</span><p>${esc(prompt.length > 600 ? `${prompt.slice(0, 600)}…` : prompt)}</p></div>` : ''}
      ${reply ? `<div class="bd-sec"><span class="bd-label">last reply</span><p>${esc(reply.length > 1200 ? `${reply.slice(0, 1200)}…` : reply)}</p></div>` : ''}
      <div class="bd-acts"><button type="button" class="btn sm solid" data-brain-chat="${esc(node.chatId)}">open chat</button><button type="button" class="btn sm soft" data-brain-brief-node="1">use in a brief</button></div>`;
    return;
  }
  const canOpen = node.path && node.path.startsWith('/');
  panel.innerHTML = `<div class="bd-head"><div><span class="bd-kind">${esc(KIND_LABEL[node.kind] || node.kind)} · ${esc(node.project)}</span><h2 title="${esc(node.title)}">${esc(shortTitle(node.title))}</h2><span class="quiet bd-path">${esc(shortPath(node.path))}</span></div>${close}</div>
    <div class="bd-acts">${canOpen ? `<button type="button" class="btn sm soft" data-brain-open="${esc(node.path)}">open</button>` : ''}<button type="button" class="btn sm soft" data-brain-copy-node="1">copy</button><button type="button" class="btn sm soft" data-brain-brief-node="1">use in a brief</button></div>
    <pre class="bd-text" id="bd-text">${B.texts.has(node.path) ? textHtml(B.texts.get(node.path), esc) : 'loading…'}</pre>`;
  if (B.texts.has(node.path)) return;
  try {
    const r = await API.post('brain-read', { path: node.path });
    const text = String(r.text || '');
    B.texts.set(node.path, text);
    if (B.texts.size > 30) B.texts.delete(B.texts.keys().next().value);
    if (seq !== B.detailSeq) return;
    const pre = document.getElementById('bd-text');
    if (pre) pre.innerHTML = textHtml(text, esc);
  } catch (error) {
    if (seq !== B.detailSeq) return;
    const pre = document.getElementById('bd-text');
    if (pre) pre.textContent = /404|Not found/i.test(error.message) ? 'Reading files is not available in this version of Kroog.' : error.message;
  }
}

function briefFromNode(node) {
  if (!node) return;
  let text;
  if (node.type === 'chat') {
    const s = LAST_S && LAST_S.sessions ? LAST_S.sessions.get(node.chatId) : null;
    text = `From the chat "${node.title}" (${node.project}):\n${node.gist ? `${node.gist}\n` : ''}${s && s.lastReply ? `Last reply:\n${String(s.lastReply).slice(0, 1500)}` : ''}`.trim();
  } else {
    const body = B.texts.get(node.path) || '';
    text = `From ${node.title} (${shortPath(node.path)}):\n${body ? body.slice(0, 2500) : (node.headings || []).join(', ')}`.trim();
  }
  window.dispatchEvent(new CustomEvent('kroog:brief-text', { detail: { title: node.title, text } }));
}

// ---- events ------------------------------------------------------------------------------

function bind(view) {
  if (view.dataset.brainBound) return;
  view.dataset.brainBound = '1';
  view.addEventListener('input', (e) => {
    if (e.target.id !== 'brain-q') return;
    B.query = e.target.value;
    clearTimeout(B.timer);
    B.timer = setTimeout(runSearch, 250);
  });
  view.addEventListener('click', async (e) => {
    if (!e.target.closest('.brain-page')) return;
    const t = e.target.closest('button, .brain-hit');
    if (!t) return;
    const d = t.dataset;
    if (t.classList.contains('brain-hit')) {
      // A click on the result itself (not one of its buttons) shows it on the map.
      if (e.target.closest('button')) return;
      showOnMap(d.brainPath);
      return;
    }
    if (d.brainKind) {
      B.kind = d.brainKind;
      for (const p of view.querySelectorAll('[data-brain-kind]')) p.setAttribute('aria-pressed', String(p.dataset.brainKind === B.kind));
      if (B.query.trim()) runSearch(); else paint();
      return;
    }
    const item = (id) => allItems().find((r) => r.id === id);
    if (d.brainShow !== undefined) { showOnMap(d.brainShow); return; }
    if (d.brainOpen) { API.openUrl(`vscode://file${d.brainOpen}`); return; }
    if (d.brainClose !== undefined) { if (B.map) B.map.select(null); else showDetail(null); return; }
    if (d.brainChat) { openChat(d.brainChat); return; }
    if (d.brainCopyNode) {
      const n = B.selected;
      if (!n) return;
      const body = n.type === 'chat' ? `${n.title}\n${n.gist || ''}` : `${n.title}\n${shortPath(n.path)}\n\n${B.texts.get(n.path) || ''}`;
      try { await navigator.clipboard.writeText(body); API.toast('Copied.'); } catch { API.toast('Copy failed.'); }
      return;
    }
    if (d.brainBriefNode) { briefFromNode(B.selected); return; }
    if (d.brainCopy) {
      const r = item(d.brainCopy);
      if (!r) return;
      try { await navigator.clipboard.writeText(`${r.title}\n${r.heading || ''}\n\n${r.snippet}\n\n(${r.path})`); API.toast('Copied.'); } catch { API.toast('Copy failed.'); }
      return;
    }
    if (d.brainBrief) {
      const r = item(d.brainBrief);
      if (!r) return;
      window.dispatchEvent(new CustomEvent('kroog:brief-text', { detail: { title: r.title, text: `From ${r.title}${r.heading && r.heading !== r.title ? ` (${r.heading})` : ''}, ${shortPath(r.path)}:\n${r.snippet}` } }));
      return;
    }
    if (t.id === 'brain-build') {
      t.disabled = true;
      try { await API.post('brain-build', {}); API.toast('Indexing again. New and changed files only.'); } catch (error) { API.toast(error.message); }
      t.disabled = false;
      setTimeout(loadRecent, 1500);
      return;
    }
    if (t.id === 'brain-connect') {
      if (B.connectBusy) return;
      B.connectBusy = true;
      t.disabled = true;
      try {
        const r = await API.post('brain-connect', {});
        API.toast(r.message || 'Connected. New Claude Code chats can search your brain.');
      } catch (error) {
        API.toast(error.message);
      }
      B.connectBusy = false;
      t.disabled = false;
    }
  });
}

function showOnMap(p) {
  if (!B.map || !p) return;
  const id = `f:${p}`;
  if (!B.mapData || !B.mapData.nodes.some((n) => n.id === id)) { API.toast('That file is not on the map yet.'); return; }
  B.map.select(id);
  const top = document.getElementById('brain-top');
  if (top) top.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
}

// ---- render ------------------------------------------------------------------------------

export function renderBrain(view, S, api) {
  API = api;
  LAST_S = S;
  const esc = api.esc;
  const st = (S.info && S.info.brain) || null;
  bind(view);
  const page = view.querySelector('.brain-page');
  if (page) {
    // Already showing: update the status, pills and progress; leave the search box alone.
    const lead = page.querySelector('#brain-lead');
    if (lead) lead.textContent = statusLine(st);
    const prog = page.querySelector('#brain-progress');
    if (prog) prog.textContent = progressLine(st);
    const pills = page.querySelector('#brain-pills');
    const ph = pillsHtml(st, esc);
    if (pills && pills.dataset.html !== ph) { pills.innerHTML = ph; pills.dataset.html = ph; }
    const err = page.querySelector('#brain-error');
    if (err) err.textContent = st && st.error ? st.error : '';
    const connect = page.querySelector('#brain-connect');
    if (connect) {
      const connected = Boolean(S.info && S.info.brainConnected);
      const label = connected ? 'connected · add again' : 'add to claude code';
      if (connect.textContent !== label) { connect.textContent = label; connect.className = `btn ${connected ? 'soft' : 'solid'}`; }
    }
    // The index was rebuilt: refresh the list (and the search, if there is one).
    if (st && st.lastBuilt && st.lastBuilt !== B.lastBuilt) {
      B.lastBuilt = st.lastBuilt;
      loadRecent();
      if (B.query.trim()) runSearch();
    }
    loadMap();
    return;
  }
  B.lastShown = '';
  const connected = S.info && S.info.brainConnected;
  view.innerHTML = `<div class="page brain-page">
    <header class="page-head"><div><h1>Brain</h1><p class="lead" id="brain-lead">${esc(statusLine(st))}</p></div>
      <button type="button" class="btn soft" id="brain-build">index again</button></header>
    <p class="quiet" id="brain-progress">${esc(progressLine(st))}</p>
    <p class="brain-error" id="brain-error">${st && st.error ? esc(st.error) : ''}</p>
    <div class="tools">
      <div class="search brain-search"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" aria-hidden="true"><circle cx="11" cy="11" r="6.5"/><path d="M16 16l4.5 4.5"/></svg><label for="brain-q" class="sr">Search your brain</label><input id="brain-q" type="search" placeholder="ask your brain, like: how do we deploy the dbt models" value="${esc(B.query)}" autocomplete="off"></div>
    </div>
    <div class="brain-top" id="brain-top">
      <div class="brain-map" id="brain-map" tabindex="0" aria-label="Map of your brain"></div>
      <aside class="brain-detail" id="brain-detail" hidden></aside>
    </div>
    <p class="quiet brain-mapline" id="brain-mapline">${esc(mapLine())}</p>
    <div class="tools" id="brain-pills" role="group" aria-label="Kind">${pillsHtml(st, esc)}</div>
    <div class="brain-grid">
      <div id="brain-list"></div>
      <aside class="aside-box brain-connect" aria-label="Use it inside Claude Code">
        <h2>Use it inside Claude Code</h2>
        <p>Add Kroog's brain to Claude Code as a connector (an MCP server called kroog-brain). Then every chat, in VS Code too, can search it on its own when it needs a convention, a decision or a how-to from another project.</p>
        <button type="button" class="btn ${connected ? 'soft' : 'solid'}" id="brain-connect">${connected ? 'connected · add again' : 'add to claude code'}</button>
        <p class="quiet">It runs on this Mac, reads only Kroog's index, and works even when the Kroog tab is closed. New chats pick it up.</p>
        <h2 style="margin-top:18px">What is in it</h2>
        <p class="quiet">Your CLAUDE.md files and rules, skills, agents, commands, plans, Claude Code's own memory for each project, each project's .claude docs, your Kroog notes, and your recent chats. Only text files; never settings, keys or chat transcripts. It stays on this Mac.</p>
      </aside>
    </div>
  </div>`;
  B.lastBuilt = st ? st.lastBuilt : 0;
  mountMap(view);
  if (B.selected) showDetail(B.selected);
  if (B.query.trim()) runSearch(); else paint();
  if (B.recent == null) loadRecent();
}

// For the app: forget what the page showed, for example after the index was rebuilt.
export function brainChanged() {
  B.recent = null;
  B.lastShown = '';
  B.texts.clear();
  if (document.getElementById('brain-list')) loadRecent();
  loadMap(true);
}
