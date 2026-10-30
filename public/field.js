// The activity field: the pixels behind the lineage, driven by what the chats are doing.
//
// A quiet grid of 5px cells with 2px gaps, the same family as the step cells on the chats.
// At rest almost nothing is lit: a sparse, slow static of single cells. Each chat on screen
// is a source:
//   working   a stream of cells falls from under the chat. Each real step the chat takes
//             drops one cell in that step's style (a filled teal cell for a tool call, a
//             hollow one for an agent's, amber when it asked you, red when a step failed),
//             and between steps a slow trickle keeps the stream alive
//   needs you an amber ring of cells just outside the chat, breathing (red when it stopped)
//   open      one teal cell under its bottom-left corner, blinking slowly
//   done      nothing
// A cell also travels along a line into a working chat now and then. With reduced motion,
// one still frame. The canvas sits behind the chats and never draws over them.

const CELL = 5;
const PITCH = 7;
const STREAM_MAX = 48;
const STREAM_STEP = 120;
const IDLE_EVERY = 1500;
// Cell styles, by what the step was.
const FILL = 0;
const HOLLOW = 1;
const AMBER = 2;
const RED = 3;
const KIND = { o: FILL, p: FILL, y: FILL, e: FILL, r: FILL, h: HOLLOW, a: AMBER, f: RED };
const STATIC_SHARE = 0.0015;
const TRAVEL_MS = 1600;
const TRAVEL_EVERY = 4000;
const SAMPLES = 40;

function readTheme() {
  const cs = getComputedStyle(document.documentElement);
  const get = (name, fallback) => (cs.getPropertyValue(name) || fallback).trim() || fallback;
  const attr = document.documentElement.getAttribute('data-theme');
  const dark = attr === 'dark' || (attr !== 'light' && window.matchMedia('(prefers-color-scheme: dark)').matches);
  return {
    accent: get('--accent', '#1e6b60'),
    amber: get('--amber', '#a8722a'),
    error: get('--error', '#b4462e'),
    quiet: get('--line-2', '#b5b0a4'),
    dark,
    gain: dark ? 1.35 : 1,
  };
}

function makeStream() {
  return {
    dx: new Int16Array(STREAM_MAX),
    dy: new Int16Array(STREAM_MAX),
    age: new Uint8Array(STREAM_MAX),
    alive: new Uint8Array(STREAM_MAX),
    kind: new Uint8Array(STREAM_MAX),
    count: 0,
    spawnAt: 0,
    stepAt: 0,
    seen: null, // the newest step time already turned into a cell
  };
}

// One new cell at the top of the stream. `from`/`span` say which columns it may start in;
// `run` makes a short vertical run of cells (a step is a run of three, the trickle one).
function spawn(s, kind, from, span, run = 1) {
  const dx = from + Math.floor(Math.random() * Math.max(1, span));
  let placed = 0;
  for (let i = 0; i < STREAM_MAX && placed < run; i += 1) {
    if (s.alive[i]) continue;
    s.alive[i] = 1;
    s.count += 1;
    s.age[i] = 0;
    s.kind[i] = kind;
    s.dx[i] = dx;
    s.dy[i] = 1 + placed;
    placed += 1;
  }
}

export function startField(canvas, hooks = {}) {
  const ctx = canvas.getContext('2d');
  const reduced = window.matchMedia('(prefers-reduced-motion: reduce)');
  const F = {
    w: 0, h: 0, dpr: 1, cols: 0, rows: 0,
    theme: readTheme(),
    nodes: [],
    edges: [],
    streams: new Map(),   // node id -> { main, agents }
    travellers: new Map(), // edge key -> { pts, n, nextAt, t0 }
    stat: null,           // the static sparks
    raf: 0,
    lastFrame: 0,
    running: false,
    destroyed: false,
    hidden: document.hidden,
  };

  function resize() {
    const host = canvas.parentElement || canvas;
    const w = Math.max(1, Math.round(host.clientWidth || host.getBoundingClientRect().width));
    const h = Math.max(1, Math.round(host.clientHeight || host.getBoundingClientRect().height));
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    if (w === F.w && h === F.h && dpr === F.dpr) return;
    F.w = w; F.h = h; F.dpr = dpr;
    canvas.width = Math.round(w * dpr);
    canvas.height = Math.round(h * dpr);
    canvas.style.width = `${w}px`;
    canvas.style.height = `${h}px`;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    F.cols = Math.ceil(w / PITCH);
    F.rows = Math.ceil(h / PITCH);
    seedStatic();
    if (reduced.matches) drawStill();
  }

  // The static: a few cells that fade in and out, slowly, anywhere on the grid.
  function seedStatic() {
    const n = Math.max(6, Math.min(90, Math.round(F.cols * F.rows * STATIC_SHARE)));
    const st = { n, c: new Int16Array(n), r: new Int16Array(n), start: new Float64Array(n), period: new Float32Array(n) };
    const now = performance.now();
    for (let i = 0; i < n; i += 1) place(st, i, now - Math.random() * 6000);
    F.stat = st;
  }

  function place(st, i, now) {
    st.c[i] = Math.floor(Math.random() * F.cols);
    st.r[i] = Math.floor(Math.random() * F.rows);
    st.start[i] = now;
    st.period[i] = 3500 + Math.random() * 4500;
  }

  // ---- what the lineage tells us -----------------------------------------------------

  function update(nodes, edges = [], view = { x: 0, y: 0, k: 1 }) {
    if (F.destroyed) return;
    resize();
    F.nodes = nodes || [];
    const now = performance.now();
    const seen = new Set();
    for (const n of F.nodes) {
      if (n.state !== 'working') continue;
      seen.add(n.id);
      let s = F.streams.get(n.id);
      if (!s) {
        s = makeStream();
        s.spawnAt = now + 300;
        s.stepAt = now + STREAM_STEP;
        F.streams.set(n.id, s);
      }
      // Every step since the last look drops one cell, in that step's style.
      const recent = Array.isArray(n.recent) ? n.recent : [];
      const newest = recent.reduce((m, st) => Math.max(m, st.t || 0), 0);
      if (s.seen == null) {
        s.seen = newest;
      } else if (newest > s.seen) {
        const cols = Math.max(2, Math.floor(n.rect.width / PITCH) - 2);
        let dropped = 0;
        for (const st of recent) {
          if (!(st.t > s.seen) || dropped >= 6) continue;
          const kind = KIND[st.c] ?? FILL;
          if (kind === HOLLOW) spawn(s, kind, Math.floor(cols * 2 / 3), Math.ceil(cols / 3), 3);
          else spawn(s, kind, 0, Math.floor(cols * 2 / 3), 3);
          dropped += 1;
        }
        s.seen = newest;
        s.spawnAt = now + IDLE_EVERY;
      }
    }
    for (const id of [...F.streams.keys()]) if (!seen.has(id)) F.streams.delete(id);

    // Cells travel along a line into a chat that is working.
    const working = new Set(F.nodes.filter((n) => n.state === 'working').map((n) => n.id));
    const keep = new Set();
    for (const e of edges) {
      if (!e || !e.path || !working.has(e.to)) continue;
      const key = `${e.from}>${e.to}`;
      keep.add(key);
      let t = F.travellers.get(key);
      if (!t) {
        t = { pts: new Float32Array(SAMPLES * 2), n: SAMPLES, nextAt: now + 800 + Math.random() * TRAVEL_EVERY, t0: 0 };
        F.travellers.set(key, t);
      }
      sample(e.path, view, t.pts);
    }
    for (const key of [...F.travellers.keys()]) if (!keep.has(key)) F.travellers.delete(key);

    if (reduced.matches) drawStill();
    else start();
  }

  function sample(path, view, out) {
    let len = 0;
    try { len = path.getTotalLength(); } catch { len = 0; }
    for (let i = 0; i < SAMPLES; i += 1) {
      let p = { x: 0, y: 0 };
      try { p = path.getPointAtLength(len * (i / (SAMPLES - 1))); } catch { /* keep zero */ }
      out[i * 2] = p.x * view.k + view.x;
      out[i * 2 + 1] = p.y * view.k + view.y;
    }
  }

  function setTheme() {
    F.theme = readTheme();
    if (reduced.matches) drawStill();
  }

  // ---- the loop ---------------------------------------------------------------------

  function start() {
    if (F.running || F.destroyed || F.hidden) return;
    F.running = true;
    F.raf = requestAnimationFrame(tick);
  }

  function stop() {
    F.running = false;
    if (F.raf) cancelAnimationFrame(F.raf);
    F.raf = 0;
  }

  function busy() {
    if (F.streams.size || F.travellers.size) return true;
    for (const n of F.nodes) if (n.state === 'needs' || n.state === 'error' || n.state === 'open') return true;
    return false;
  }

  function tick(now) {
    if (!F.running) return;
    F.raf = requestAnimationFrame(tick);
    const fps = busy() ? 30 : 12;
    if (now - F.lastFrame < 1000 / fps) return;
    F.lastFrame = now;
    advance(now);
    draw(now);
  }

  function advance(now) {
    const st = F.stat;
    if (st) for (let i = 0; i < st.n; i += 1) if (now - st.start[i] > st.period[i]) place(st, i, now);
    for (const n of F.nodes) {
      if (n.state !== 'working') continue;
      const s = F.streams.get(n.id);
      if (!s) continue;
      const cols = Math.max(2, Math.floor(n.rect.width / PITCH) - 2);
      // The trickle between steps: a cell every 1.5 s at rest, quicker when steps have been
      // coming (the steps themselves drop their own cells as they happen).
      const rate = Math.max(0, Math.min(20, Number(n.rate) || 0));
      const every = IDLE_EVERY - (IDLE_EVERY - 500) * (rate / 20);
      stepStream(s, now, every, cols, n.agents > 0);
    }
  }

  function stepStream(s, now, every, cols, agents) {
    if (now >= s.stepAt) {
      s.stepAt = now + STREAM_STEP;
      for (let i = 0; i < STREAM_MAX; i += 1) {
        if (!s.alive[i]) continue;
        s.age[i] += 1;
        s.dy[i] += 1;
        if (s.age[i] % 3 === 0) s.dx[i] += 1;
        if (s.age[i] >= STREAM_MAX) { s.alive[i] = 0; s.count -= 1; }
      }
    }
    if (now >= s.spawnAt) {
      s.spawnAt = now + every * (0.75 + Math.random() * 0.5);
      // With an agent at work, every other trickle cell is one of its hollow cells.
      if (agents && Math.random() < 0.5) spawn(s, HOLLOW, Math.floor(cols * 2 / 3), Math.ceil(cols / 3));
      else spawn(s, FILL, 0, Math.floor(cols * 2 / 3));
    }
  }

  // ---- drawing ------------------------------------------------------------------------

  const cellAt = (c, r) => ctx.fillRect(c * PITCH, r * PITCH, CELL, CELL);
  const hollowAt = (c, r) => ctx.strokeRect(c * PITCH + 0.5, r * PITCH + 0.5, CELL - 1, CELL - 1);

  function draw(now) {
    const T = F.theme;
    ctx.clearRect(0, 0, F.w, F.h);
    ctx.lineWidth = 1;

    // The static.
    const st = F.stat;
    if (st) {
      ctx.fillStyle = T.quiet;
      for (let i = 0; i < st.n; i += 1) {
        const p = (now - st.start[i]) / st.period[i];
        if (p <= 0 || p >= 1) continue;
        ctx.globalAlpha = Math.sin(p * Math.PI) * 0.22 * T.gain;
        cellAt(st.c[i], st.r[i]);
      }
    }

    // Streams, open cells, travellers.
    for (const n of F.nodes) {
      const r = n.rect;
      if (n.state === 'working') {
        const s = F.streams.get(n.id);
        if (!s) continue;
        const c0 = Math.floor(r.left / PITCH);
        const r0 = Math.floor((r.top + r.height) / PITCH) + 1;
        drawStream(s, c0 + 1, r0, T);
      } else if (n.state === 'open') {
        ctx.fillStyle = T.accent;
        const on = (now % 3000) < 400;
        if (on) {
          ctx.globalAlpha = 0.75 * T.gain;
          cellAt(Math.floor(r.left / PITCH) + 1, Math.floor((r.top + r.height) / PITCH) + 1);
        }
      }
    }
    ctx.fillStyle = T.accent;
    for (const t of F.travellers.values()) {
      if (!t.t0 && now >= t.nextAt) { t.t0 = now; }
      if (!t.t0) continue;
      const p = (now - t.t0) / TRAVEL_MS;
      if (p >= 1) { t.t0 = 0; t.nextAt = now + TRAVEL_EVERY * (0.7 + Math.random() * 0.6); continue; }
      const i = Math.min(t.n - 1, Math.floor(p * (t.n - 1)));
      ctx.globalAlpha = 0.55 * T.gain;
      cellAt(Math.floor(t.pts[i * 2] / PITCH), Math.floor(t.pts[i * 2 + 1] / PITCH));
    }

    // Rings: needs you (amber), stopped (red).
    for (const n of F.nodes) {
      if (n.state !== 'needs' && n.state !== 'error') continue;
      const breath = 0.25 + 0.35 * (0.5 - 0.5 * Math.cos((now % 2400) / 2400 * Math.PI * 2));
      ctx.fillStyle = n.state === 'error' ? T.error : T.amber;
      ctx.globalAlpha = Math.min(1, breath * T.gain);
      ring(n.rect);
    }
    ctx.globalAlpha = 1;
  }

  function drawStream(s, c0, r0, T) {
    if (!s.count) return;
    for (let i = 0; i < STREAM_MAX; i += 1) {
      if (!s.alive[i]) continue;
      // Bright under the chat, gone well before the next lane.
      const a = 1 - s.age[i] / STREAM_MAX;
      ctx.globalAlpha = Math.min(1, 0.8 * a * Math.sqrt(a) * T.gain);
      const c = c0 + s.dx[i];
      const r = r0 + s.dy[i];
      if (r >= F.rows || c >= F.cols) continue;
      const kind = s.kind[i];
      const colour = kind === AMBER ? T.amber : kind === RED ? T.error : T.accent;
      if (kind === HOLLOW) { ctx.strokeStyle = colour; hollowAt(c, r); } else { ctx.fillStyle = colour; cellAt(c, r); }
    }
  }

  function ring(rect) {
    const c0 = Math.floor(rect.left / PITCH) - 1;
    const c1 = Math.floor((rect.left + rect.width) / PITCH) + 1;
    const r0 = Math.floor(rect.top / PITCH) - 1;
    const r1 = Math.floor((rect.top + rect.height) / PITCH) + 1;
    if (c1 - c0 > 200 || r1 - r0 > 200) return;
    for (let c = c0; c <= c1; c += 1) { cellAt(c, r0); cellAt(c, r1); }
    for (let r = r0 + 1; r < r1; r += 1) { cellAt(c0, r); cellAt(c1, r); }
  }

  // One frame, for people who asked for less motion.
  function drawStill() {
    stop();
    const T = F.theme;
    ctx.clearRect(0, 0, F.w, F.h);
    for (const n of F.nodes) {
      if (n.state === 'needs' || n.state === 'error') {
        ctx.fillStyle = n.state === 'error' ? T.error : T.amber;
        ctx.globalAlpha = Math.min(1, 0.42 * T.gain);
        ring(n.rect);
      } else if (n.state === 'open') {
        ctx.fillStyle = T.accent;
        ctx.globalAlpha = 0.75 * T.gain;
        cellAt(Math.floor(n.rect.left / PITCH) + 1, Math.floor((n.rect.top + n.rect.height) / PITCH) + 1);
      }
    }
    ctx.globalAlpha = 1;
  }

  // ---- lifecycle ----------------------------------------------------------------------

  const onVisibility = () => {
    F.hidden = document.hidden;
    if (F.hidden) stop();
    else if (!reduced.matches) start();
  };
  document.addEventListener('visibilitychange', onVisibility);
  const onMotion = () => { if (reduced.matches) drawStill(); else start(); };
  reduced.addEventListener('change', onMotion);
  const observer = new MutationObserver(setTheme);
  observer.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
  const scheme = window.matchMedia('(prefers-color-scheme: dark)');
  scheme.addEventListener('change', setTheme);
  let ro = null;
  if ('ResizeObserver' in window && canvas.parentElement) {
    ro = new ResizeObserver(() => { resize(); if (hooks.onResize) hooks.onResize(); });
    ro.observe(canvas.parentElement);
  }
  resize();
  if (!reduced.matches) start();

  function destroy() {
    F.destroyed = true;
    stop();
    document.removeEventListener('visibilitychange', onVisibility);
    reduced.removeEventListener('change', onMotion);
    scheme.removeEventListener('change', setTheme);
    observer.disconnect();
    if (ro) ro.disconnect();
    ctx.clearRect(0, 0, F.w, F.h);
  }

  return { update, setTheme, destroy, stats: () => ({ streams: F.streams.size, travellers: F.travellers.size, nodes: F.nodes.length, running: F.running, cells: F.cols * F.rows }) };
}
