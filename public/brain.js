// The Brain page: search everything in your ~/.claude world and Kroog's notes, by meaning
// and by keyword. The app calls renderBrain() on every live update, so this keeps its own
// state and only redraws the parts that changed (your typing is never interrupted).

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
};

let API = null;

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

function resultHtml(r, esc) {
  const canOpen = r.path && r.path.startsWith('/');
  return `<li class="brain-hit" data-brain-id="${esc(r.id)}">
    <div class="bh-head"><b title="${esc(r.title || '')}">${esc(shortTitle(r.title) || shortPath(r.path))}</b><span class="bh-proj">${esc(r.project || '')}</span></div>
    ${r.heading && r.heading !== r.title ? `<div class="bh-path">${esc(r.heading)}</div>` : ''}
    <p class="bh-snip">${marked(r.snippet || '', B.query, esc)}</p>
    <div class="bh-foot"><span class="quiet">${esc(shortPath(r.path))}</span>
      <span class="bh-acts">${canOpen ? `<button type="button" class="linkish" data-brain-open="${esc(r.path)}">open</button>` : ''}<button type="button" class="linkish" data-brain-copy="${esc(r.id)}">copy</button><button type="button" class="linkish" data-brain-brief="${esc(r.id)}">use in a brief</button></span></div>
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

async function runSearch() {
  const q = B.query.trim();
  const seq = ++B.seq;
  if (!q) {
    B.results = null;
    paint();
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
    const t = e.target.closest('button');
    if (!t) return;
    const d = t.dataset;
    if (d.brainKind) {
      B.kind = d.brainKind;
      for (const p of view.querySelectorAll('[data-brain-kind]')) p.setAttribute('aria-pressed', String(p.dataset.brainKind === B.kind));
      if (B.query.trim()) runSearch(); else paint();
      return;
    }
    const item = (id) => allItems().find((r) => r.id === id);
    if (d.brainOpen) { API.openUrl(`vscode://file${d.brainOpen}`); return; }
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

// A skill's title is "name: long description"; the name is enough in the list.
function shortTitle(t) {
  const x = String(t || '');
  const i = x.indexOf(': ');
  const head = i > 0 && i < 60 ? x.slice(0, i) : x;
  return head.length > 90 ? `${head.slice(0, 89)}…` : head;
}

export function renderBrain(view, S, api) {
  API = api;
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
    // The index was rebuilt: refresh the list (and the search, if there is one).
    if (st && st.lastBuilt && st.lastBuilt !== B.lastBuilt) {
      B.lastBuilt = st.lastBuilt;
      loadRecent();
      if (B.query.trim()) runSearch();
    }
    return;
  }
  B.lastShown = '';
  const connected = S.info && S.info.brainConnected;
  view.innerHTML = `<div class="page brain-page">
    <header class="page-head"><div><h1>Brain</h1><p class="lead" id="brain-lead">${esc(statusLine(st))}</p></div>
      <button type="button" class="btn soft" id="brain-build">index again</button></header>
    <p class="quiet brain-sub">Your CLAUDE.md files and rules, skills, agents, commands, plans, Claude Code's own memory for each project, each project's .claude docs, and your Kroog notes. Only text files; never settings, keys or chat transcripts. It stays on this Mac.</p>
    <p class="quiet" id="brain-progress">${esc(progressLine(st))}</p>
    <p class="brain-error" id="brain-error">${st && st.error ? esc(st.error) : ''}</p>
    <div class="tools">
      <div class="search brain-search"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" aria-hidden="true"><circle cx="11" cy="11" r="6.5"/><path d="M16 16l4.5 4.5"/></svg><label for="brain-q" class="sr">Search your brain</label><input id="brain-q" type="search" placeholder="ask your brain, like: how do we deploy the dbt models" value="${esc(B.query)}" autocomplete="off"></div>
    </div>
    <div class="tools" id="brain-pills" role="group" aria-label="Kind">${pillsHtml(st, esc)}</div>
    <div class="brain-grid">
      <div id="brain-list"></div>
      <aside class="aside-box brain-connect" aria-label="Use it inside Claude Code">
        <h2>Use it inside Claude Code</h2>
        <p>Add Kroog's brain to Claude Code as a connector (an MCP server called kroog-brain). Then every chat, in VS Code too, can search it on its own when it needs a convention, a decision or a how-to from another project.</p>
        <button type="button" class="btn ${connected ? 'soft' : 'solid'}" id="brain-connect">${connected ? 'connected · add again' : 'add to claude code'}</button>
        <p class="quiet">It runs on this Mac, reads only Kroog's index, and works even when the Kroog tab is closed. New chats pick it up.</p>
      </aside>
    </div>
  </div>`;
  B.lastBuilt = st ? st.lastBuilt : 0;
  if (B.query.trim()) runSearch(); else paint();
  if (B.recent == null) loadRecent();
}

// For the app: forget what the page showed, for example after the index was rebuilt.
export function brainChanged() {
  B.recent = null;
  B.lastShown = '';
  if (document.getElementById('brain-list')) loadRecent();
}
