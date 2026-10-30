// The brain as a map, drawn on a canvas: files from your ~/.claude world and your chats,
// joined by similarity and lineage, grouped by project. Plain canvas, no libraries.
//
//   mountBrainMap(container, { onSelect, onOpen }) -> { setData, setQuery, select, destroy }

const KIND_LABEL = {
  instructions: 'instructions', skill: 'skill', agent: 'agent', command: 'command', plan: 'plan',
  memory: 'memory', 'project-doc': 'project doc', note: 'note', chat: 'chat',
};
const LEGEND = [['instructions', 'instructions'], ['memory', 'memory'], ['skill', 'skills, agents, commands'], ['plan', 'plans'], ['project-doc', 'project docs'], ['note', 'notes'], ['chat', 'chats']];
const MIN_SCALE = 0.25;
const MAX_SCALE = 4;

function hashSeed(str) {
  let h = 2166136261;
  for (let i = 0; i < str.length; i += 1) h = Math.imul(h ^ str.charCodeAt(i), 16777619);
  return (h >>> 0) / 4294967295;
}

function readTokens() {
  const cs = getComputedStyle(document.documentElement);
  const get = (name, fallback) => (cs.getPropertyValue(name) || fallback).trim();
  return {
    paper: get('--paper', '#edebe5'), paper2: get('--paper-2', '#e3e0d8'), ink: get('--ink', '#15191b'), ink2: get('--ink-2', '#3d4447'),
    ink3: get('--ink-3', '#5f676a'), line: get('--line', '#cfcbc1'), line2: get('--line-2', '#b5b0a4'), accent: get('--accent', '#1e6b60'),
    accentInk: get('--accent-ink', '#15524a'), accentSoft: get('--accent-soft', '#d6e5df'), amber: get('--amber', '#a8722a'),
    amberInk: get('--amber-ink', '#7a5118'), error: get('--error', '#b4462e'),
    mono: get('--mono', '"IBM Plex Mono", Menlo, monospace'),
  };
}

function nodeSize(n) {
  if (n.type === 'chat') return 12;
  if (n.kind === 'note') return 8;
  if (n.kind === 'project-doc') return 7;
  const c = n.size || 1;
  return c <= 2 ? 7 : c <= 8 ? 10 : 13;
}

function shortTitle(n, max = 26) {
  let t = String(n.title || '');
  if (n.type === 'file') {
    const i = t.indexOf(': ');
    if (i > 0 && i < 60) t = t.slice(0, i);
    if (t.includes('/') && !t.includes(' ')) t = t.split('/').slice(-2).join('/');
  }
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
}

// Andrew's monotone chain, for the faint hull around each project.
function hull(points) {
  const pts = points.slice().sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  if (pts.length < 3) return pts;
  const cross = (o, a, b) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
  const lower = [];
  for (const p of pts) { while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], p) <= 0) lower.pop(); lower.push(p); }
  const upper = [];
  for (let i = pts.length - 1; i >= 0; i -= 1) { const p = pts[i]; while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], p) <= 0) upper.pop(); upper.push(p); }
  upper.pop();
  lower.pop();
  return lower.concat(upper);
}

export function mountBrainMap(container, api = {}) {
  const reduced = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  container.classList.add('brainmap');
  if (!container.hasAttribute('tabindex')) container.tabIndex = 0;
  container.innerHTML = `<canvas class="bm-canvas" aria-hidden="true"></canvas>
    <div class="bm-tip" hidden></div>
    <div class="bm-legend" aria-label="Legend">${LEGEND.map(([k, l]) => `<span><i class="bm-g bm-g-${k}"></i>${l}</span>`).join('')}</div>
    <div class="bm-ctl"><button type="button" class="bm-btn" data-bm="out" aria-label="Zoom out">−</button><button type="button" class="bm-btn" data-bm="in" aria-label="Zoom in">+</button><button type="button" class="bm-btn bm-fit" data-bm="fit">fit</button></div>
    <p class="bm-empty" hidden></p>`;
  const canvas = container.querySelector('canvas');
  const tip = container.querySelector('.bm-tip');
  const emptyEl = container.querySelector('.bm-empty');
  const ctx = canvas.getContext('2d');

  const M = {
    nodes: [], edges: [], byId: new Map(), clusters: new Map(),
    view: { s: 1, tx: 0, ty: 0 }, moved: false,
    hover: null, selected: null, neighbours: new Set(), query: '', matches: null,
    alpha: 0, raf: 0, blinkTimer: 0, dragging: null, panning: null, pointers: new Map(), pinch: null,
    tokens: readTokens(), width: 0, height: 0, dpr: 1, labelTop: new Set(), labelBig: new Set(), destroyed: false, sig: '',
    wMin: 0, wMax: 1,
  };

  // ---- size and theme ---------------------------------------------------------------
  function resize() {
    const r = container.getBoundingClientRect();
    M.width = Math.max(10, Math.round(r.width));
    M.height = Math.max(10, Math.round(r.height));
    M.dpr = Math.min(window.devicePixelRatio || 1, 3);
    canvas.width = Math.round(M.width * M.dpr);
    canvas.height = Math.round(M.height * M.dpr);
    canvas.style.width = `${M.width}px`;
    canvas.style.height = `${M.height}px`;
    if (!M.moved) fit(false);
    draw();
  }
  const ro = new ResizeObserver(() => resize());
  ro.observe(container);
  const mo = new MutationObserver(() => { M.tokens = readTokens(); draw(); });
  mo.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme', 'class'] });
  const mq = window.matchMedia ? window.matchMedia('(prefers-color-scheme: dark)') : null;
  const onScheme = () => { M.tokens = readTokens(); draw(); };
  if (mq) mq.addEventListener('change', onScheme);

  // ---- data and layout --------------------------------------------------------------
  function setData(map) {
    const old = M.byId;
    const sig = `${((map && map.nodes) || []).map((n) => n.id).sort().join('\n')}\n--\n${((map && map.edges) || []).map((e) => `${e.a}>${e.b}:${e.kind}`).sort().join('\n')}`;
    if (sig === M.sig && M.nodes.length) {
      // Same shape: only the details changed (a chat's status, a summary). No re-layout.
      for (const n of (map && map.nodes) || []) {
        const cur = old.get(n.id);
        if (cur) Object.assign(cur, n, { x: cur.x, y: cur.y, vx: cur.vx, vy: cur.vy, r: cur.r, fixed: cur.fixed });
      }
      draw();
      blinkWatch();
      return;
    }
    M.sig = sig;
    const nodes = ((map && map.nodes) || []).map((n) => {
      const prev = old.get(n.id);
      const node = { ...n, r: nodeSize(n) / 2, vx: 0, vy: 0, fixed: false, x: prev ? prev.x : NaN, y: prev ? prev.y : NaN };
      return node;
    });
    M.nodes = nodes;
    M.byId = new Map(nodes.map((n) => [n.id, n]));
    M.edges = ((map && map.edges) || []).map((e) => ({ ...e, an: M.byId.get(e.a), bn: M.byId.get(e.b) })).filter((e) => e.an && e.bn && e.an !== e.bn);
    const ws = M.edges.filter((e) => e.kind === 'similar').map((e) => e.w);
    M.wMin = ws.length ? Math.min(...ws) : 0;
    M.wMax = ws.length ? Math.max(...ws) : 1;
    placeClusters();
    const top = nodes.filter((n) => n.type === 'file').sort((a, b) => (b.size || 0) - (a.size || 0)).slice(0, 25);
    M.labelTop = new Set(top.map((n) => n.id));
    M.labelBig = new Set(top.slice(0, 10).map((n) => n.id));
    if (M.selected && !M.byId.has(M.selected)) { M.selected = null; M.neighbours = new Set(); }
    if (M.selected) M.neighbours = neighboursOf(M.selected);
    emptyEl.hidden = nodes.length > 0;
    emptyEl.textContent = nodes.length ? '' : 'Nothing on the map yet. Kroog is reading your ~/.claude folder.';
    // Settle quickly first, then let the rest unfold.
    M.alpha = 1;
    for (let i = 0; i < (reduced ? 160 : 36); i += 1) tick();
    if (reduced) M.alpha = 0;
    if (!M.moved) fit(false);
    draw();
    heat(reduced ? 0 : 0.6);
    blinkWatch();
  }

  function placeClusters() {
    const groups = new Map();
    for (const n of M.nodes) {
      const g = groups.get(n.project) || { name: n.project, nodes: [] };
      g.nodes.push(n);
      groups.set(n.project, g);
    }
    const all = groups.get('all projects');
    const others = [...groups.values()].filter((g) => g !== all).sort((a, b) => b.nodes.length - a.nodes.length);
    const radiusOf = (g) => 26 + 16 * Math.sqrt(g.nodes.length);
    let ring = 0;
    for (const g of others) ring += 2 * radiusOf(g) + 40;
    ring = ring / (2 * Math.PI);
    const centreR = all ? radiusOf(all) : 0;
    const maxOther = others.length ? Math.max(...others.map(radiusOf)) : 0;
    const R = others.length ? Math.max(ring * 1.3, centreR + maxOther + 90, 180) : 0;
    // Spread the ring to the shape of the box, so a wide map uses its width.
    const aspect = Math.max(1, Math.min(2.2, (M.width || 1) / (M.height || 1)));
    const place = (g, ax, ay) => {
      g.ax = ax;
      g.ay = ay;
      g.r = radiusOf(g);
      // A sunflower spread inside the cluster, stable from one build to the next.
      const list = g.nodes.slice().sort((a, b) => (a.id < b.id ? -1 : 1));
      list.forEach((n, i) => {
        if (Number.isFinite(n.x) && Number.isFinite(n.y)) return;
        const t = i + 0.5;
        const rr = g.r * Math.sqrt(t / Math.max(1, list.length));
        const ang = t * 2.399963 + hashSeed(n.id) * 0.4;
        n.x = ax + rr * Math.cos(ang);
        n.y = ay + rr * Math.sin(ang);
      });
    };
    if (all) place(all, 0, 0);
    let angle = -Math.PI / 2;
    const total = others.reduce((s, g) => s + 2 * radiusOf(g) + 40, 0) || 1;
    for (const g of others) {
      const span = (2 * radiusOf(g) + 40) / total * 2 * Math.PI;
      const a = angle + span / 2;
      place(g, R * aspect * Math.cos(a), R * Math.sin(a));
      angle += span;
    }
    M.clusters = groups;
  }

  function tick() {
    const nodes = M.nodes;
    const n = nodes.length;
    if (!n) return;
    const a = M.alpha;
    // Repulsion, with a hard push apart when two nodes overlap.
    for (let i = 0; i < n; i += 1) {
      const p = nodes[i];
      for (let j = i + 1; j < n; j += 1) {
        const q = nodes[j];
        let dx = q.x - p.x;
        let dy = q.y - p.y;
        let d2 = dx * dx + dy * dy;
        if (d2 < 1) { dx = (hashSeed(p.id) - 0.5) * 2; dy = (hashSeed(q.id) - 0.5) * 2; d2 = dx * dx + dy * dy || 1; }
        const d = Math.sqrt(d2);
        const same = p.project === q.project;
        let f = (same ? 420 : 160) / d2;
        const min = p.r + q.r + 10;
        if (d < min) f += (min - d) * 0.5;
        if (f > 6) f = 6;
        const fx = (dx / d) * f;
        const fy = (dy / d) * f;
        p.vx -= fx; p.vy -= fy;
        q.vx += fx; q.vy += fy;
      }
    }
    // Links pull; stronger and shorter when the link is strong.
    for (const e of M.edges) {
      const p = e.an;
      const q = e.bn;
      const dx = q.x - p.x;
      const dy = q.y - p.y;
      const d = Math.sqrt(dx * dx + dy * dy) || 1;
      const rel = (e.w - M.wMin) / ((M.wMax - M.wMin) || 1);
      const rest = e.kind === 'similar' ? 50 + (1 - rel) * 70 : 80;
      const k = e.kind === 'similar' ? 0.012 + 0.03 * rel : 0.03;
      const f = (d - rest) * k;
      const fx = (dx / d) * f;
      const fy = (dy / d) * f;
      p.vx += fx; p.vy += fy;
      q.vx -= fx; q.vy -= fy;
    }
    // A weak pull to the project's place on the map.
    for (const p of nodes) {
      const g = M.clusters.get(p.project);
      if (g) { p.vx += (g.ax - p.x) * 0.02; p.vy += (g.ay - p.y) * 0.02; }
      p.vx += -p.x * 0.001;
      p.vy += -p.y * 0.001;
    }
    for (const p of nodes) {
      if (p.fixed) { p.vx = 0; p.vy = 0; continue; }
      p.vx *= 0.55;
      p.vy *= 0.55;
      const sp = Math.sqrt(p.vx * p.vx + p.vy * p.vy);
      if (sp > 14) { p.vx *= 14 / sp; p.vy *= 14 / sp; }
      p.x += p.vx * a;
      p.y += p.vy * a;
    }
  }

  function heat(to) {
    if (reduced) { for (let i = 0; i < 40; i += 1) tick(); M.alpha = 0; draw(); return; }
    M.alpha = Math.max(M.alpha, to);
    if (!M.raf) M.raf = requestAnimationFrame(frame);
  }

  function frame() {
    M.raf = 0;
    if (M.destroyed) return;
    if (M.alpha > 0.015 || M.dragging) {
      tick();
      if (!M.dragging) M.alpha *= 0.96;
      draw();
      M.raf = requestAnimationFrame(frame);
    } else {
      M.alpha = 0;
      draw();
    }
  }

  function neighboursOf(id) {
    const set = new Set();
    for (const e of M.edges) {
      if (e.a === id) set.add(e.b);
      if (e.b === id) set.add(e.a);
    }
    return set;
  }

  // ---- view ---------------------------------------------------------------------------
  const toScreen = (x, y) => [x * M.view.s + M.view.tx, y * M.view.s + M.view.ty];
  const toWorld = (sx, sy) => [(sx - M.view.tx) / M.view.s, (sy - M.view.ty) / M.view.s];

  function fit(byUser = true) {
    if (!M.nodes.length) { M.view = { s: 1, tx: M.width / 2, ty: M.height / 2 }; return; }
    let x0 = Infinity; let y0 = Infinity; let x1 = -Infinity; let y1 = -Infinity;
    for (const n of M.nodes) { x0 = Math.min(x0, n.x); y0 = Math.min(y0, n.y); x1 = Math.max(x1, n.x); y1 = Math.max(y1, n.y); }
    const pad = 70;
    const bw = Math.max(80, x1 - x0 + pad * 2);
    const bh = Math.max(80, y1 - y0 + pad * 2);
    const s = Math.max(MIN_SCALE, Math.min(M.width / bw, M.height / bh, 1.6));
    M.view = { s, tx: M.width / 2 - ((x0 + x1) / 2) * s, ty: M.height / 2 - ((y0 + y1) / 2) * s };
    if (byUser) M.moved = false;
    draw();
  }

  function zoomBy(f, cx = M.width / 2, cy = M.height / 2) {
    const s2 = Math.max(MIN_SCALE, Math.min(MAX_SCALE, M.view.s * f));
    const k = s2 / M.view.s;
    M.view = { s: s2, tx: cx - (cx - M.view.tx) * k, ty: cy - (cy - M.view.ty) * k };
    M.moved = true;
    draw();
  }

  function centreOn(n) {
    const [sx, sy] = toScreen(n.x, n.y);
    const margin = 40;
    if (sx > margin && sx < M.width - margin && sy > margin && sy < M.height - margin) return;
    M.view.tx += M.width / 2 - sx;
    M.view.ty += M.height / 2 - sy;
    M.moved = true;
  }

  // ---- drawing ------------------------------------------------------------------------
  function lit(n) {
    if (M.selected) return n.id === M.selected || M.neighbours.has(n.id);
    if (M.matches && M.matches.size) return M.matches.has(n.id);
    return true;
  }

  function draw() {
    if (M.destroyed) return;
    const t = M.tokens;
    const { s } = M.view;
    ctx.setTransform(M.dpr, 0, 0, M.dpr, 0, 0);
    ctx.clearRect(0, 0, M.width, M.height);
    if (!M.nodes.length) return;
    const dimAlpha = M.selected ? 0.3 : 0.25;
    const sz = Math.max(0.6, Math.min(1.6, s));
    ctx.lineJoin = 'round';
    ctx.lineCap = 'round';

    // Project hulls and labels.
    ctx.font = `11px ${t.mono}`;
    for (const g of M.clusters.values()) {
      if (!g.nodes.length) continue;
      const pts = g.nodes.map((n) => toScreen(n.x, n.y));
      if (g.nodes.length >= 3) {
        const h = hull(pts);
        if (h.length >= 3) {
          const cx = h.reduce((a, p) => a + p[0], 0) / h.length;
          const cy = h.reduce((a, p) => a + p[1], 0) / h.length;
          const grown = h.map(([x, y]) => { const dx = x - cx; const dy = y - cy; const d = Math.hypot(dx, dy) || 1; const pad = 22 * sz; return [x + (dx / d) * pad, y + (dy / d) * pad]; });
          ctx.beginPath();
          for (let i = 0; i < grown.length; i += 1) {
            const p = grown[i];
            const q = grown[(i + 1) % grown.length];
            const mx = (p[0] + q[0]) / 2;
            const my = (p[1] + q[1]) / 2;
            if (i === 0) ctx.moveTo(mx, my);
            else ctx.quadraticCurveTo(p[0], p[1], mx, my);
          }
          const first = grown[0];
          const second = grown[1 % grown.length];
          ctx.quadraticCurveTo(first[0], first[1], (first[0] + second[0]) / 2, (first[1] + second[1]) / 2);
          ctx.closePath();
          ctx.fillStyle = t.paper2;
          ctx.globalAlpha = 0.42;
          ctx.fill();
          ctx.globalAlpha = 0.35;
          ctx.strokeStyle = t.line;
          ctx.lineWidth = 1;
          ctx.stroke();
          ctx.globalAlpha = 1;
        }
      }
      // The name sits above the cluster, at its left, clear of the node labels.
      const top = Math.min(...pts.map((p) => p[1]));
      const left = Math.min(...pts.map((p) => p[0]));
      ctx.fillStyle = t.ink3;
      ctx.globalAlpha = 0.9;
      ctx.textAlign = 'left';
      ctx.fillText(String(g.name).toLowerCase(), left - 4, top - 18 * sz);
      ctx.globalAlpha = 1;
    }

    // Links.
    for (const e of M.edges) {
      const [ax, ay] = toScreen(e.an.x, e.an.y);
      const [bx, by] = toScreen(e.bn.x, e.bn.y);
      const on = lit(e.an) && lit(e.bn);
      const both = M.selected && (e.a === M.selected || e.b === M.selected);
      let alpha;
      ctx.setLineDash([]);
      if (e.kind === 'similar') {
        const rel = (e.w - M.wMin) / ((M.wMax - M.wMin) || 1);
        alpha = 0.22 + 0.55 * rel;
        ctx.strokeStyle = both ? t.accent : t.line2;
        ctx.lineWidth = both ? 1.2 : 1;
      } else {
        alpha = 0.85;
        ctx.strokeStyle = both ? t.accent : t.ink2;
        ctx.lineWidth = 1.2;
        if (e.kind === 'memory') ctx.setLineDash([2, 4]);
      }
      ctx.globalAlpha = on ? alpha : alpha * dimAlpha;
      ctx.beginPath();
      ctx.moveTo(ax, ay);
      ctx.lineTo(bx, by);
      ctx.stroke();
      if (e.kind === 'continue') {
        // An open ring where the branch begins (at the newer chat).
        const d = Math.hypot(bx - ax, by - ay) || 1;
        const off = (e.bn.r * sz) + 7;
        const rx = bx - ((bx - ax) / d) * off;
        const ry = by - ((by - ay) / d) * off;
        ctx.setLineDash([]);
        ctx.fillStyle = t.paper;
        ctx.beginPath();
        ctx.arc(rx, ry, 3.5, 0, Math.PI * 2);
        ctx.fill();
        ctx.stroke();
      }
    }
    ctx.setLineDash([]);
    ctx.globalAlpha = 1;

    // Nodes.
    const blinkOn = Math.floor(Date.now() / 500) % 2 === 0;
    for (const n of M.nodes) {
      const [x, y] = toScreen(n.x, n.y);
      if (x < -40 || y < -40 || x > M.width + 40 || y > M.height + 40) continue;
      const on = lit(n);
      ctx.globalAlpha = on ? 1 : dimAlpha;
      const size = nodeSize(n) * sz;
      const h = size / 2;
      if (n.type === 'chat') {
        const w = 18 * sz;
        const hh = 12 * sz;
        const colour = n.status === 'working' ? t.accent : n.status === 'needs' ? t.amber : n.status === 'error' ? t.error : t.ink3;
        ctx.fillStyle = t.paper;
        ctx.strokeStyle = colour;
        ctx.lineWidth = 1;
        roundRect(x - w / 2, y - hh / 2, w, hh, 2.5);
        ctx.fill();
        ctx.stroke();
        if (n.status === 'working') {
          if (reduced || blinkOn) {
            ctx.fillStyle = t.accent;
            ctx.fillRect(x - w / 2 + 3 * sz, y - hh / 2 + 3 * sz, 4 * sz, hh - 6 * sz);
          }
        } else if (n.status === 'needs') {
          ctx.fillStyle = t.amber;
          ctx.fillRect(x - w / 2 + 3 * sz, y - hh / 2 + 3 * sz, 4 * sz, hh - 6 * sz);
        }
      } else if (n.kind === 'note') {
        ctx.fillStyle = t.amber;
        ctx.beginPath();
        ctx.arc(x, y, h, 0, Math.PI * 2);
        ctx.fill();
      } else if (n.kind === 'instructions') {
        ctx.fillStyle = t.ink;
        ctx.fillRect(x - h, y - h, size, size);
      } else if (n.kind === 'memory') {
        ctx.fillStyle = t.accent;
        ctx.fillRect(x - h, y - h, size, size);
      } else if (n.kind === 'project-doc') {
        ctx.fillStyle = t.ink2;
        ctx.fillRect(x - h, y - h, size, size);
      } else {
        // skills, agents, commands: hollow; plans: hollow and dotted.
        ctx.strokeStyle = t.ink;
        ctx.lineWidth = 1.2;
        if (n.kind === 'plan') ctx.setLineDash([2, 2]);
        ctx.strokeRect(x - h + 0.5, y - h + 0.5, size - 1, size - 1);
        ctx.setLineDash([]);
      }
      // An outline for what you searched for or picked.
      const isSel = n.id === M.selected;
      const isMatch = M.matches && M.matches.size && M.matches.has(n.id);
      if (isSel || isMatch || n === M.hover) {
        ctx.strokeStyle = t.accent;
        ctx.lineWidth = isSel ? 1.6 : 1.1;
        const pad = 4;
        const w = (n.type === 'chat' ? 18 * sz : size) + pad * 2;
        const hh = (n.type === 'chat' ? 12 * sz : size) + pad * 2;
        roundRect(x - w / 2, y - hh / 2, w, hh, 3);
        ctx.stroke();
      }
    }
    ctx.globalAlpha = 1;

    // Labels: chats, the biggest files, and whatever is picked or under the pointer.
    ctx.font = `11px ${t.mono}`;
    ctx.textAlign = 'left';
    const placed = [];
    const want = [];
    for (const n of M.nodes) {
      const always = n === M.hover || n.id === M.selected;
      const chat = n.type === 'chat' && s >= 0.6;
      const big = M.labelTop.has(n.id) && (s >= 0.85 || (s >= 0.5 && M.labelBig.has(n.id)));
      const match = M.matches && M.matches.size && M.matches.has(n.id) && s >= 0.6;
      if (always || chat || big || match) want.push([n, always ? 0 : chat ? 1 : match ? 2 : 3]);
    }
    want.sort((a, b) => a[1] - b[1]);
    for (const [n] of want) {
      const [x, y] = toScreen(n.x, n.y);
      if (x < -40 || y < -40 || x > M.width + 40 || y > M.height + 40) continue;
      const text = shortTitle(n);
      const w = ctx.measureText(text).width;
      const lx = x + (n.type === 'chat' ? 9 * sz : nodeSize(n) * sz / 2) + 6;
      const ly = y + 4;
      const rect = [lx - 4, ly - 11, w + 12, 14];
      if (placed.some((r) => r[0] < rect[0] + rect[2] && r[0] + r[2] > rect[0] && r[1] < rect[1] + rect[3] && r[1] + r[3] > rect[1])) continue;
      placed.push(rect);
      const on = lit(n);
      ctx.globalAlpha = on ? 1 : dimAlpha;
      ctx.fillStyle = t.paper;
      ctx.globalAlpha = (on ? 1 : dimAlpha) * 0.8;
      ctx.fillRect(rect[0], rect[1], rect[2], rect[3]);
      ctx.globalAlpha = on ? 1 : dimAlpha;
      ctx.fillStyle = n.type === 'chat' ? t.ink : t.ink2;
      ctx.fillText(text, lx, ly);
    }
    ctx.globalAlpha = 1;
  }

  function roundRect(x, y, w, h, r) {
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.lineTo(x + w - r, y);
    ctx.quadraticCurveTo(x + w, y, x + w, y + r);
    ctx.lineTo(x + w, y + h - r);
    ctx.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
    ctx.lineTo(x + r, y + h);
    ctx.quadraticCurveTo(x, y + h, x, y + h - r);
    ctx.lineTo(x, y + r);
    ctx.quadraticCurveTo(x, y, x + r, y);
    ctx.closePath();
  }

  // Blink the working chats, once every half second, only while there are any.
  function blinkWatch() {
    clearInterval(M.blinkTimer);
    M.blinkTimer = 0;
    if (reduced) return;
    if (M.nodes.some((n) => n.type === 'chat' && n.status === 'working')) {
      M.blinkTimer = setInterval(() => { if (!document.hidden && !M.raf) draw(); }, 500);
    }
  }

  // ---- pointer, wheel, keys -----------------------------------------------------------
  function nodeAt(sx, sy) {
    let best = null;
    let bestD = Infinity;
    const sz = Math.max(0.6, Math.min(1.6, M.view.s));
    for (const n of M.nodes) {
      const [x, y] = toScreen(n.x, n.y);
      const reach = (n.type === 'chat' ? 11 : nodeSize(n) / 2 + 4) * sz + 3;
      const d = Math.hypot(x - sx, y - sy);
      if (d <= reach && d < bestD) { best = n; bestD = d; }
    }
    return best;
  }

  function showTip(n, sx, sy) {
    if (!n) { tip.hidden = true; return; }
    const esc = (v) => String(v || '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
    const kind = n.type === 'chat' ? `chat · ${n.status}` : KIND_LABEL[n.kind] || n.kind;
    const extra = n.type === 'chat' ? (n.gist || '') : (n.headings || []).slice(0, 3).join(' · ');
    tip.innerHTML = `<b>${esc(n.title)}</b><span>${esc(kind)} · ${esc(n.project)}</span>${extra ? `<em>${esc(extra)}</em>` : ''}`;
    tip.hidden = false;
    const tw = tip.offsetWidth;
    const th = tip.offsetHeight;
    let left = sx + 16;
    if (left + tw > M.width - 8) left = sx - tw - 16;
    let top = sy - 10;
    if (top + th > M.height - 8) top = M.height - th - 8;
    if (top < 8) top = 8;
    tip.style.left = `${Math.max(8, left)}px`;
    tip.style.top = `${top}px`;
  }

  function pos(e) {
    const r = canvas.getBoundingClientRect();
    return [e.clientX - r.left, e.clientY - r.top];
  }

  let lastClick = { id: null, t: 0 };
  function onDown(e) {
    if (e.button !== undefined && e.button !== 0) return;
    const [sx, sy] = pos(e);
    M.pointers.set(e.pointerId, [sx, sy]);
    canvas.setPointerCapture(e.pointerId);
    if (M.pointers.size === 2) {
      const [a, b] = [...M.pointers.values()];
      M.pinch = { d: Math.hypot(a[0] - b[0], a[1] - b[1]), s: M.view.s, cx: (a[0] + b[0]) / 2, cy: (a[1] + b[1]) / 2 };
      M.dragging = null;
      M.panning = null;
      return;
    }
    const n = nodeAt(sx, sy);
    if (n) {
      M.dragging = { n, sx, sy, moved: false };
      n.fixed = true;
    } else {
      M.panning = { sx, sy, tx: M.view.tx, ty: M.view.ty, moved: false };
    }
    container.focus({ preventScroll: true });
  }

  function onMove(e) {
    const [sx, sy] = pos(e);
    if (M.pointers.has(e.pointerId)) M.pointers.set(e.pointerId, [sx, sy]);
    if (M.pinch && M.pointers.size >= 2) {
      const [a, b] = [...M.pointers.values()];
      const d = Math.hypot(a[0] - b[0], a[1] - b[1]) || 1;
      const s2 = Math.max(MIN_SCALE, Math.min(MAX_SCALE, M.pinch.s * (d / M.pinch.d)));
      const k = s2 / M.view.s;
      M.view = { s: s2, tx: M.pinch.cx - (M.pinch.cx - M.view.tx) * k, ty: M.pinch.cy - (M.pinch.cy - M.view.ty) * k };
      M.moved = true;
      draw();
      return;
    }
    if (M.dragging) {
      const d = M.dragging;
      if (Math.hypot(sx - d.sx, sy - d.sy) > 4) d.moved = true;
      if (d.moved) {
        const [wx, wy] = toWorld(sx, sy);
        d.n.x = wx;
        d.n.y = wy;
        tip.hidden = true;
        heat(0.3);
      }
      return;
    }
    if (M.panning) {
      const p = M.panning;
      if (Math.hypot(sx - p.sx, sy - p.sy) > 4) p.moved = true;
      if (p.moved) {
        M.view.tx = p.tx + (sx - p.sx);
        M.view.ty = p.ty + (sy - p.sy);
        M.moved = true;
        tip.hidden = true;
        draw();
      }
      return;
    }
    const n = nodeAt(sx, sy);
    if (n !== M.hover) {
      M.hover = n;
      canvas.style.cursor = n ? 'pointer' : 'grab';
      draw();
    }
    showTip(n, sx, sy);
  }

  function onUp(e) {
    M.pointers.delete(e.pointerId);
    if (M.pinch) { if (M.pointers.size < 2) M.pinch = null; return; }
    if (M.dragging) {
      const d = M.dragging;
      d.n.fixed = false;
      M.dragging = null;
      if (!d.moved) {
        const now = Date.now();
        if (lastClick.id === d.n.id && now - lastClick.t < 400) {
          lastClick = { id: null, t: 0 };
          if (api.onOpen) api.onOpen(publicNode(d.n));
        } else {
          lastClick = { id: d.n.id, t: now };
          select(d.n.id);
        }
      } else heat(0.3);
      return;
    }
    if (M.panning) {
      const p = M.panning;
      M.panning = null;
      if (!p.moved) select(null);
    }
  }

  function onWheel(e) {
    e.preventDefault();
    const [sx, sy] = pos(e);
    const f = Math.exp(-e.deltaY * (e.ctrlKey ? 0.01 : 0.0015));
    zoomBy(f, sx, sy);
  }

  function onKey(e) {
    if (e.key === '+' || e.key === '=') { zoomBy(1.2); e.preventDefault(); }
    else if (e.key === '-') { zoomBy(1 / 1.2); e.preventDefault(); }
    else if (e.key === 'f') { fit(); e.preventDefault(); }
    else if (e.key === 'Escape') { select(null); }
  }

  function onCtl(e) {
    const b = e.target.closest('[data-bm]');
    if (!b) return;
    if (b.dataset.bm === 'fit') fit();
    else zoomBy(b.dataset.bm === 'in' ? 1.2 : 1 / 1.2);
  }

  canvas.addEventListener('pointerdown', onDown);
  canvas.addEventListener('pointermove', onMove);
  canvas.addEventListener('pointerup', onUp);
  canvas.addEventListener('pointercancel', onUp);
  canvas.addEventListener('pointerleave', () => { if (!M.dragging && !M.panning) { M.hover = null; tip.hidden = true; draw(); } });
  canvas.addEventListener('wheel', onWheel, { passive: false });
  canvas.addEventListener('dblclick', (e) => e.preventDefault());
  container.addEventListener('keydown', onKey);
  container.querySelector('.bm-ctl').addEventListener('click', onCtl);
  canvas.style.cursor = 'grab';
  canvas.style.touchAction = 'none';

  // ---- public ---------------------------------------------------------------------------
  function publicNode(n) {
    if (!n) return null;
    const { vx, vy, fixed, r, ...rest } = n;
    return rest;
  }

  function select(id) {
    const n = id ? M.byId.get(id) : null;
    M.selected = n ? n.id : null;
    M.neighbours = n ? neighboursOf(n.id) : new Set();
    if (n) centreOn(n);
    draw();
    if (api.onSelect) api.onSelect(publicNode(n));
  }

  function setQuery(q, ids) {
    M.query = String(q || '');
    M.matches = ids && ids.length ? new Set(ids) : null;
    draw();
  }

  function destroy() {
    M.destroyed = true;
    ro.disconnect();
    mo.disconnect();
    if (mq) mq.removeEventListener('change', onScheme);
    if (M.raf) cancelAnimationFrame(M.raf);
    clearInterval(M.blinkTimer);
    container.removeEventListener('keydown', onKey);
    container.classList.remove('brainmap');
    container.innerHTML = '';
  }

  resize();
  return { setData, setQuery, select, destroy, fit, state: () => ({ nodes: M.nodes.length, edges: M.edges.length, selected: M.selected, scale: M.view.s }) };
}
