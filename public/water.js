// The ascii-sharks ocean engine (MIT, github.com/stackedlol/ascii-sharks, see water-LICENSE.txt),
// as compiled for ishanyash.com, with Kroog's own glue at the end.
(function () {
"use strict";

// ---- math.ts
const TAU = Math.PI * 2;
const clamp = (v, lo, hi) => v < lo ? lo : v > hi ? hi : v;
const rand = (lo, hi) => lo + Math.random() * (hi - lo);
const randInt = (lo, hi) => Math.floor(rand(lo, hi + 1));
function smoothstep(e0, e1, x) {
    const t = clamp((x - e0) / (e1 - e0), 0, 1);
    return t * t * (3 - 2 * t);
}
/** Shortest signed angle from a to b, in (-PI, PI]. */
function angleDiff(a, b) {
    let d = (b - a) % TAU;
    if (d > Math.PI)
        d -= TAU;
    if (d < -Math.PI)
        d += TAU;
    return d;
}
/** Cheap integer hash → [0, 1). Deterministic, so textures stay stable. */
function hash3(x, y, z) {
    let h = Math.imul(x | 0, 374761393) ^
        Math.imul(y | 0, 668265263) ^
        Math.imul(z | 0, 1442695041);
    h = Math.imul(h ^ (h >>> 13), 1274126177);
    h ^= h >>> 16;
    return (h >>> 0) / 4294967296;
}
const K1 = 1 / 260;
const K2 = 1 / 310;
const K3 = 1 / 190;
const CURRENT_SCALE = 3400;
/**
 * Divergence-free ocean current: the curl of a slowly drifting stream
 * function ψ(x, y, t). Because it has no sources or sinks, it moves the
 * schools around without bunching them up in one corner.
 */
function current(x, y, t, out) {
    const a = x * K1 + t * 0.07;
    const b = y * K2 - t * 0.05;
    const c = (x + y) * K3 + t * 0.11;
    // u = ∂ψ/∂y, v = -∂ψ/∂x with ψ = sin(a)cos(b) + 0.5 sin(c)
    out.x = (-K2 * Math.sin(a) * Math.sin(b) + 0.5 * K3 * Math.cos(c)) * CURRENT_SCALE;
    out.y = (-K1 * Math.cos(a) * Math.cos(b) - 0.5 * K3 * Math.cos(c)) * CURRENT_SCALE;
    return out;
}


// ---- species.ts
const SPECIES = [
    {
        name: "sardine",
        cruise: 36, maxSpeed: 64, minSpeed: 18, weight: 3,
        schoolSize: [18, 28], spacing: [1.8, 1.1],
        align: 1.6, cohesion: 1.6, jitter: 40, mill: 70, verticalDrag: 0.5,
    },
    {
        name: "anchovy",
        cruise: 46, maxSpeed: 78, minSpeed: 22, weight: 3,
        schoolSize: [20, 32], spacing: [1.5, 1],
        align: 3.2, cohesion: 0.45, jitter: 30, mill: 0, verticalDrag: 1.4,
    },
    {
        name: "silverside",
        cruise: 40, maxSpeed: 70, minSpeed: 20, weight: 3,
        schoolSize: [12, 20], spacing: [2, 1.1],
        align: 2.4, cohesion: 1.1, jitter: 35, mill: 0, verticalDrag: 1.6,
    },
    {
        name: "mackerel",
        cruise: 32, maxSpeed: 60, minSpeed: 16, weight: 2,
        schoolSize: [5, 9], spacing: [2.6, 1.3],
        align: 2, cohesion: 0.9, jitter: 25, mill: 0, verticalDrag: 2,
    },
    {
        name: "goby",
        cruise: 26, maxSpeed: 56, minSpeed: 10, weight: 1,
        schoolSize: [8, 12], spacing: [1.4, 1.1],
        align: 0.35, cohesion: 1.4, jitter: 110, mill: 0, verticalDrag: 0.3,
    },
];
const TOTAL_WEIGHT = SPECIES.reduce((sum, s) => sum + s.weight, 0);
function pickSpecies() {
    let r = Math.random() * TOTAL_WEIGHT;
    for (let i = 0; i < SPECIES.length; i++) {
        r -= SPECIES[i].weight;
        if (r <= 0)
            return i;
    }
    return 0;
}


// ---- world.ts
/**
 * Artificial-life sim for the hero: tiny fish schools and the sharks that hunt them.
 *
 * Fish: Reynolds boids (separation / alignment / cohesion) in Couzin-style
 * zones, with a blind spot behind each fish. Alarm spreads from fish to fish
 * through the school (a "wave of agitation"), so a whole school bolts even
 * when only its edge can see the shark. Fleeing fish break sideways around the
 * shark's path, which gives the fountain effect seen in real bait balls.
 *
 * Sharks: Reynolds steering on a follow-the-leader spine, tuned to what tagged
 * sharks do. Cruising is a Lévy-style search: long, lazy, nearly straight runs
 * with the odd sharp turn to a new patch (Sims et al. 2008). A hungry shark
 * picks a straggler in a sparse spot, often circles the school first, then
 * commits: a slow approach from behind and a short burst at the end, the way
 * accelerometer tags record white-shark strikes. A miss is abandoned, not
 * chased; a meal is followed by slow digestion. Sharks rise out of the deep
 * (faint, then solid), patrol for a minute or two, and sink away again, so the
 * cast keeps changing. The big ones carry remoras, mostly on the belly and
 * back, which let go for a moment now and then and settle somewhere new.
 * Eaten fish come back later as new schools swimming in from the edges.
 */


const SHARK_NODES = 20;
// The landing hero: four of the same shark at different depths.
const DEFAULT_SHARKS = [
    { kind: "classic", size: 1 },
    { kind: "classic", size: 0.7 },
    { kind: "classic", size: 0.84 },
    { kind: "classic", size: 0.77 },
];
const FISH_SEPARATION_K = 420;
const FISH_ALIGN_K = 1.4;
const FISH_COHESION_K = 1;
const FISH_FLEE_K = 1100;
const BLIND_COS = -0.6; // ~127° either side of the heading is visible
class World {
    /** fishCount overrides the area-based population (the sidebar wants a single small school). */
    constructor(sharkSpecs = DEFAULT_SHARKS, fishCount) {
        this.sharkSpecs = sharkSpecs;
        this.fishCount = fishCount;
        this.width = 0;
        this.height = 0;
        this.time = 0;
        this.fish = [];
        this.sharks = [];
        this.events = [];
        this.pointer = { x: 0, y: 0, active: false };
        /** Page content to steer around; see setAvoid(). */
        this.avoid = [];
        /** Fish that a shark was closing on when a splash made it break off. */
        this.saved = 0;
        /** Fish eaten so far. */
        this.eaten = 0;
        /** Fish neighbourhood radius; the spatial hash bucket size matches it. */
        this.perception = 60;
        /** Per-species personal space in px (x, y). */
        this.sepX = [];
        this.sepY = [];
        this.foreignSep = 40;
        this.bucketCols = 0;
        this.bucketRows = 0;
        this.bucketHead = new Int32Array(0);
        this.bucketCount = new Uint16Array(0);
        this.bucketNext = new Int32Array(0);
        this.lastSpawn = 0;
        this.tmp = { x: 0, y: 0 };
        this.pendingWarm = false;
        this.nextSharkId = 1;
        this.baseLength = 300;
        /** Population: the water keeps between min and max sharks, drawing newcomers from pool. */
        this.popMin = 1;
        this.popMax = 1;
        this.pool = [];
        this.nextArrival = 0;
        this.remoraTmp = { x: 0, y: 0, tx: 1, ty: 0 };
    }
    resize(width, height, cellW, cellH) {
        const first = this.width === 0;
        this.width = width;
        this.height = height;
        // Spacing is set in grid cells so every fish lands in its own cell.
        this.sepX = SPECIES.map((sp) => sp.spacing[0] * cellW);
        this.sepY = SPECIES.map((sp) => sp.spacing[1] * cellH);
        this.perception = Math.max(cellH * 3, cellW * 5.5);
        this.foreignSep = cellW * 3;
        if (first || this.fish.length === 0) {
            this.seed();
            return;
        }
        for (const f of this.fish) {
            f.x = clamp(f.x, 0, width);
            f.y = clamp(f.y, 0, height);
        }
    }
    seed() {
        const { width: W, height: H } = this;
        const minSide = Math.min(W, H);
        this.baseLength = clamp(minSide * 0.52, 200, 520);
        const sharkCount = this.sharkSpecs.length;
        this.sharks = [];
        // The sharks start spread around a ring, but the ring itself is turned by
        // a random amount each load, so no two visits open on the same picture.
        const ring = rand(0, TAU);
        for (let i = 0; i < sharkCount; i++) {
            const spec = this.sharkSpecs[i];
            const orbitRadius = minSide * rand(0.28, 0.4);
            const a = ring + (i / sharkCount) * TAU + rand(-0.4, 0.4);
            const x = W / 2 + Math.cos(a) * orbitRadius * (W / minSide) * 0.9;
            const y = H / 2 + Math.sin(a) * orbitRadius;
            const heading = a + (Math.random() < 0.5 ? 1 : -1) * (Math.PI / 2);
            const sh = this.makeShark(spec, x, y, heading);
            // The opening cast is already up; one of them may still be on its way up.
            if (i === sharkCount - 1 && sharkCount > 1) {
                sh.life = "rising";
                sh.depth = rand(0, 0.3);
            }
            else {
                sh.life = "up";
                sh.depth = sh.surfaceDepth;
            }
            if (this.pool.length)
                sh.lifeUntil = this.time + rand(40, 140);
            this.sharks.push(sh);
        }
        this.nextArrival = 0;
        const total = this.fishCount ?? clamp(Math.round((W * H) / 4400), 85, 340);
        this.fish = [];
        while (this.fish.length < total) {
            const species = pickSpecies();
            const sp = SPECIES[species];
            const size = Math.min(randInt(sp.schoolSize[0], sp.schoolSize[1]), total - this.fish.length);
            const millDir = Math.random() < 0.5 ? 1 : -1;
            const cx = rand(W * 0.06, W * 0.94);
            const cy = rand(H * 0.08, H * 0.92);
            // Mostly level headings: fish cruise sideways far more than up or down.
            const dir = (Math.random() < 0.5 ? 0 : Math.PI) + rand(-0.5, 0.5);
            for (let k = 0; k < size; k++) {
                this.fish.push({
                    x: cx + rand(-1, 1) * this.sepX[species] * Math.sqrt(size),
                    y: cy + rand(-1, 1) * this.sepY[species] * Math.sqrt(size) * 0.6,
                    vx: Math.cos(dir) * sp.cruise,
                    vy: Math.sin(dir) * sp.cruise,
                    species,
                    alarm: 0,
                    alive: true,
                    respawnAt: 0,
                    phase: rand(0, TAU),
                    turn: 0,
                    depth: rand(0.55, 1),
                    millDir,
                });
            }
        }
        this.bucketNext = new Int32Array(this.fish.length);
        // Warm up on the first real step, not here: by then the page has told the
        // world which boxes of text to keep clear of.
        this.pendingWarm = true;
    }
    /**
     * Run the water for a few random seconds before anyone sees it, so the
     * schools have formed and the sharks are mid-patrol: a page opens on a
     * pond that was already there, not on a recording starting over.
     * Capped by wall-clock time so a slow phone never waits on it.
     */
    warm() {
        const seconds = rand(4, 12);
        const dt = 1 / 30;
        const budget = 90;
        const now = typeof performance !== "undefined" ? () => performance.now() : () => Date.now();
        const t0 = now();
        for (let t = 0; t < seconds && now() - t0 < budget; t += dt)
            this.step(dt);
        // Clear anything the warm-up queued for the renderer (eats, splashes).
        this.events.length = 0;
    }
    setAvoid(boxes) {
        this.avoid = boxes;
    }
    /**
     * Let the cast change over time: the water keeps between min and max sharks,
     * newcomers (drawn from pool) rise out of the deep, and sharks that have been
     * up for a minute or two sink away. Without this the opening sharks stay.
     */
    setPopulation(min, max, pool) {
        this.popMin = Math.max(0, min);
        this.popMax = Math.max(this.popMin, max);
        this.pool = pool;
        for (const sh of this.sharks)
            if (sh.lifeUntil === Infinity)
                sh.lifeUntil = this.time + rand(40, 140);
    }
    makeShark(spec, x, y, heading) {
        const length = this.baseLength * spec.size;
        const nodes = new Float32Array(SHARK_NODES * 2);
        const seg = length / (SHARK_NODES - 1);
        for (let n = 0; n < SHARK_NODES; n++) {
            nodes[n * 2] = x - Math.cos(heading) * seg * n;
            nodes[n * 2 + 1] = y - Math.sin(heading) * seg * n;
        }
        const big = spec.size >= 0.78;
        const remoras = [];
        // Remoras ride the big sharks: one to three, belly and back, a few on a flank.
        if (big) {
            const n = randInt(1, 3);
            for (let k = 0; k < n; k++) {
                remoras.push({
                    s: rand(0.2, 0.6),
                    v: rand(-0.5, 0.5),
                    attached: true,
                    until: this.time + rand(12, 40),
                    x,
                    y,
                    tx: 1,
                    ty: 0,
                    loopDir: Math.random() < 0.5 ? 1 : -1,
                });
            }
        }
        return {
            id: this.nextSharkId++,
            kind: spec.kind,
            length,
            nodes,
            heading,
            speed: 30,
            phase: rand(0, TAU),
            turn: 0,
            hunger: rand(0.2, 0.7),
            wander: 0,
            orbitDir: Math.random() < 0.5 ? 1 : -1,
            orbitRadius: Math.min(this.width, this.height) * rand(0.28, 0.4),
            target: null,
            retargetAt: 0,
            spookedUntil: 0,
            depth: 0,
            strike: 0,
            mode: "free",
            modeUntil: 0,
            boltX: 1,
            boltY: 0,
            chargeX: 0,
            chargeY: 0,
            life: "rising",
            surfaceDepth: clamp(0.55 + spec.size * 0.45 + rand(-0.12, 0.08), 0.5, 1),
            riseRate: 1 / rand(5, 9),
            lifeUntil: Infinity,
            runUntil: this.time + rand(1, 5),
            runTurn: 0,
            runSpeed: rand(0.85, 1.1),
            digestUntil: 0,
            circleUntil: 0,
            circleDir: Math.random() < 0.5 ? 1 : -1,
            peakClosing: 0,
            peakAt: 0,
            remoras,
        };
    }
    /** A newcomer rises somewhere clear of the words and of the other sharks. */
    spawnShark() {
        if (!this.pool.length)
            return null;
        const spec = this.pool[Math.floor(Math.random() * this.pool.length)];
        const L = this.baseLength * spec.size;
        const { width: W, height: H } = this;
        for (let attempt = 0; attempt < 12; attempt++) {
            const x = rand(L * 0.3, W - L * 0.3);
            const y = rand(L * 0.2, H - L * 0.2);
            const p = this.pushOut(x, y, L * 0.5, this.tmp);
            if (p.x !== 0 || p.y !== 0)
                continue;
            let crowded = false;
            for (const o of this.sharks) {
                if (Math.hypot(o.nodes[0] - x, o.nodes[1] - y) < (L + o.length) * 0.5) {
                    crowded = true;
                    break;
                }
            }
            if (crowded)
                continue;
            const sh = this.makeShark(spec, x, y, rand(0, TAU));
            sh.lifeUntil = this.time + 1 / sh.riseRate + rand(40, 140);
            this.sharks.push(sh);
            return sh;
        }
        return null;
    }
    /** Arrivals and departures, a few seconds apart, never all at once. */
    stepPopulation(dt) {
        const { time } = this;
        if (!this.pool.length)
            return;
        const up = this.sharks.filter((s) => s.life !== "diving").length;
        if (time >= this.nextArrival) {
            this.nextArrival = time + rand(7, 20);
            // More likely to send one up the emptier the water is.
            const room = (this.popMax - up) / Math.max(1, this.popMax);
            if (up < this.popMax && Math.random() < 0.35 + room * 0.6)
                this.spawnShark();
        }
        for (const sh of this.sharks) {
            if (sh.life !== "up" || sh.mode !== "free" || time < sh.lifeUntil)
                continue;
            if (up <= this.popMin) {
                // Not before a replacement is on its way.
                if (this.spawnShark()) {
                    sh.life = "diving";
                }
                else {
                    sh.lifeUntil = time + 20;
                }
            }
            else {
                sh.life = "diving";
            }
            break; // one departure per step at most
        }
    }
    /** The point on a shark's body at fraction s along the spine and v across it (-1 … 1), with the local tangent. */
    spinePoint(sh, s, v, out) {
        const n = sh.nodes;
        const f = clamp(s, 0, 0.999) * (SHARK_NODES - 1);
        const k = Math.floor(f);
        const t = f - k;
        const x = n[k * 2] + (n[k * 2 + 2] - n[k * 2]) * t;
        const y = n[k * 2 + 1] + (n[k * 2 + 3] - n[k * 2 + 1]) * t;
        // Tangent points towards the snout.
        let tx = n[k * 2] - n[k * 2 + 2];
        let ty = n[k * 2 + 1] - n[k * 2 + 3];
        const l = Math.hypot(tx, ty) || 1;
        tx /= l;
        ty /= l;
        // Half-width of the body: widest a third of the way back, tapering to the tail.
        const half = sh.length * 0.085 * clamp(1.15 - Math.abs(s - 0.3) * 1.4, 0.25, 1);
        out.x = x - ty * v * half;
        out.y = y + tx * v * half;
        out.tx = tx;
        out.ty = ty;
        return out;
    }
    /** Remoras ride along; now and then one lets go, loops beside the host and settles on a new spot. */
    stepRemoras(sh, dt) {
        const { time } = this;
        for (const r of sh.remoras) {
            const p = this.spinePoint(sh, r.s, r.v, this.remoraTmp);
            if (r.attached) {
                r.x = p.x;
                r.y = p.y;
                r.tx = p.tx;
                r.ty = p.ty;
                if (time >= r.until && sh.mode === "free" && sh.strike < 0.3) {
                    r.attached = false;
                    r.until = time + rand(1.5, 3.5);
                    r.loopDir = Math.random() < 0.5 ? 1 : -1;
                }
            }
            else {
                // A small loop out to the side and back, drifting with the host.
                const span = r.until - time;
                const k = clamp(1 - span / 2.5, 0, 1);
                const a = k * Math.PI;
                const off = Math.sin(a) * sh.length * 0.16;
                const nx = -p.ty * r.loopDir;
                const ny = p.tx * r.loopDir;
                r.x = p.x + nx * off - p.tx * Math.sin(a) * sh.length * 0.06;
                r.y = p.y + ny * off - p.ty * Math.sin(a) * sh.length * 0.06;
                r.tx = p.tx;
                r.ty = p.ty;
                if (time >= r.until) {
                    r.attached = true;
                    r.until = time + rand(12, 40);
                    // Settles somewhere nearby, mostly belly and back, now and then a flank.
                    r.s = clamp(r.s + rand(-0.15, 0.15), 0.15, 0.65);
                    r.v = Math.random() < 0.7 ? rand(-0.35, 0.35) : rand(-0.8, 0.8);
                }
            }
        }
    }
    /** Push away from every avoid box within `margin`; inside one, head for the nearest edge. */
    pushOut(x, y, margin, out) {
        out.x = 0;
        out.y = 0;
        for (const b of this.avoid) {
            const cx = clamp(x, b.l, b.r);
            const cy = clamp(y, b.t, b.b);
            const dx = x - cx;
            const dy = y - cy;
            const d = Math.hypot(dx, dy);
            if (d === 0) {
                const m = Math.min(x - b.l, b.r - x, y - b.t, b.b - y);
                if (m === x - b.l)
                    out.x -= 1;
                else if (m === b.r - x)
                    out.x += 1;
                else if (m === y - b.t)
                    out.y -= 1;
                else
                    out.y += 1;
            }
            else if (d < margin) {
                const k = 1 - d / margin;
                out.x += (dx / d) * k;
                out.y += (dy / d) * k;
            }
        }
        return out;
    }
    /** Does a straight line from (x, y) along (dx, dy) reach the edge of the frame without crossing text? */
    clearRun(x, y, dx, dy) {
        const { width: W, height: H } = this;
        for (let k = 0; k < 80; k++) {
            x += dx * 40;
            y += dy * 40;
            if (x < -40 || y < -40 || x > W + 40 || y > H + 40)
                return true;
            for (const b of this.avoid)
                if (x > b.l && x < b.r && y > b.t && y < b.b)
                    return false;
        }
        return true;
    }
    splash(x, y) {
        this.events.push({ kind: "splash", x, y });
        // A tap on a shark sends it bolting out of the frame. It comes back for the pointer.
        for (const sh of this.sharks) {
            if (sh.mode !== "free" || sh.depth < 0.5)
                continue;
            const L = sh.length;
            let best = Infinity;
            for (let k = 0; k < SHARK_NODES; k++) {
                const d = Math.hypot(sh.nodes[k * 2] - x, sh.nodes[k * 2 + 1] - y);
                if (d < best)
                    best = d;
            }
            if (best > L * 0.1 + 28)
                continue;
            const hx = sh.nodes[0];
            const hy = sh.nodes[1];
            // Away from the tap, biased to the current heading; of the eight compass
            // directions pick the one closest to that which leaves the frame without
            // running through the words.
            let ax = hx - x;
            let ay = hy - y;
            const al = Math.hypot(ax, ay);
            if (al < 1) {
                ax = Math.cos(sh.heading);
                ay = Math.sin(sh.heading);
            }
            else {
                ax = ax / al + Math.cos(sh.heading) * 0.5;
                ay = ay / al + Math.sin(sh.heading) * 0.5;
                const l2 = Math.hypot(ax, ay) || 1;
                ax /= l2;
                ay /= l2;
            }
            let bx = ax;
            let by = ay;
            let bestScore = -Infinity;
            for (let k = 0; k < 16; k++) {
                const a = (k / 16) * TAU;
                const dx = Math.cos(a);
                const dy = Math.sin(a);
                const score = dx * ax + dy * ay + (this.clearRun(hx, hy, dx, dy) ? 1.5 : 0);
                if (score > bestScore) {
                    bestScore = score;
                    bx = dx;
                    by = dy;
                }
            }
            sh.mode = "bolt";
            sh.modeUntil = this.time + 3;
            sh.boltX = bx;
            sh.boltY = by;
            sh.chargeX = x;
            sh.chargeY = y;
            if (sh.target && sh.target.alive && sh.hunger > 0.3)
                this.saved++;
            sh.target = null;
            sh.strike = 0;
            sh.wander = 0;
        }
        // A shark closing on a fish near the splash breaks off: that fish is saved.
        for (const sh of this.sharks) {
            const t = sh.target;
            if (t && t.alive && sh.hunger > 0.3 && Math.hypot(t.x - x, t.y - y) < 320) {
                this.saved++;
                sh.target = null;
                sh.spookedUntil = this.time + 3;
                sh.hunger = Math.max(0, sh.hunger - 0.1);
            }
        }
        const r = 240;
        for (const f of this.fish) {
            if (!f.alive)
                continue;
            const dx = f.x - x;
            const dy = f.y - y;
            const d = Math.hypot(dx, dy);
            if (d > r || d < 1e-3)
                continue;
            // Flash expansion: everybody nearby bolts straight out.
            const k = (1 - d / r) * 260;
            f.vx += (dx / d) * k;
            f.vy += (dy / d) * k;
            f.alarm = 1;
        }
    }
    step(dt) {
        if (this.pendingWarm) {
            this.pendingWarm = false;
            this.warm();
        }
        this.time += dt;
        this.rebuildHash();
        this.stepFish(dt);
        this.stepSharks(dt);
        this.stepPopulation(dt);
        this.respawn();
    }
    rebuildHash() {
        const size = this.perception;
        const pad = 2;
        this.bucketCols = Math.ceil(this.width / size) + pad * 2;
        this.bucketRows = Math.ceil(this.height / size) + pad * 2;
        const n = this.bucketCols * this.bucketRows;
        if (this.bucketHead.length !== n) {
            this.bucketHead = new Int32Array(n);
            this.bucketCount = new Uint16Array(n);
        }
        this.bucketHead.fill(-1);
        this.bucketCount.fill(0);
        if (this.bucketNext.length !== this.fish.length) {
            this.bucketNext = new Int32Array(this.fish.length);
        }
        for (let i = 0; i < this.fish.length; i++) {
            const f = this.fish[i];
            if (!f.alive)
                continue;
            const b = this.bucketOf(f.x, f.y);
            this.bucketNext[i] = this.bucketHead[b];
            this.bucketHead[b] = i;
            this.bucketCount[b]++;
        }
    }
    bucketOf(x, y) {
        const size = this.perception;
        const c = clamp(Math.floor(x / size) + 2, 0, this.bucketCols - 1);
        const r = clamp(Math.floor(y / size) + 2, 0, this.bucketRows - 1);
        return r * this.bucketCols + c;
    }
    stepFish(dt) {
        const { fish, sharks, pointer, width: W, height: H, time } = this;
        const R = this.perception;
        const R2 = R * R;
        const foreignSep = this.foreignSep;
        const size = this.perception;
        const cols = this.bucketCols;
        const rows = this.bucketRows;
        const head = this.bucketHead;
        const next = this.bucketNext;
        const cur = this.tmp;
        const calmDecay = Math.exp(-dt * 0.7);
        const contagion = Math.min(1, dt * 6);
        for (let i = 0; i < fish.length; i++) {
            const f = fish[i];
            if (!f.alive)
                continue;
            const sp = SPECIES[f.species];
            // Alarmed fish want more room: the school flashes apart around a
            // shark and closes back up once the threat fades.
            const spread = 1 + 1.8 * f.alarm;
            const sepX = this.sepX[f.species] * spread;
            const sepY = this.sepY[f.species] * spread;
            const speed = Math.hypot(f.vx, f.vy) || 1;
            const hx = f.vx / speed;
            const hy = f.vy / speed;
            let ax = 0;
            let ay = 0;
            let sx = 0;
            let sy = 0;
            let avx = 0;
            let avy = 0;
            let cx = 0;
            let cy = 0;
            let n = 0;
            let neighbourAlarm = 0;
            const bc = clamp(Math.floor(f.x / size) + 2, 0, cols - 1);
            const br = clamp(Math.floor(f.y / size) + 2, 0, rows - 1);
            for (let r = Math.max(0, br - 1); r <= Math.min(rows - 1, br + 1); r++) {
                for (let c = Math.max(0, bc - 1); c <= Math.min(cols - 1, bc + 1); c++) {
                    let j = head[r * cols + c];
                    while (j !== -1) {
                        if (j !== i) {
                            const o = fish[j];
                            const dx = o.x - f.x;
                            const dy = o.y - f.y;
                            const d2 = dx * dx + dy * dy;
                            if (d2 < R2 && d2 > 1e-6) {
                                const d = Math.sqrt(d2);
                                // Blind zone directly behind the fish.
                                if ((dx * hx + dy * hy) / d > BLIND_COS) {
                                    // Elliptical personal space: wide along x, tight along y.
                                    const qx = dx / sepX;
                                    const qy = dy / sepY;
                                    const q2 = qx * qx + qy * qy;
                                    if (q2 < 1) {
                                        const q = Math.sqrt(q2) || 1e-3;
                                        const k = (1 - q) / q;
                                        sx -= qx * k;
                                        sy -= qy * k;
                                    }
                                    if (o.species === f.species) {
                                        avx += o.vx;
                                        avy += o.vy;
                                        cx += dx;
                                        cy += dy;
                                        n++;
                                    }
                                    else if (d < foreignSep) {
                                        // Different species keep their own schools.
                                        const k = ((1 - d / foreignSep) / d) * 0.6;
                                        sx -= dx * k;
                                        sy -= dy * k;
                                    }
                                    if (o.alarm > neighbourAlarm)
                                        neighbourAlarm = o.alarm;
                                }
                            }
                        }
                        j = next[j];
                    }
                }
            }
            ax += sx * FISH_SEPARATION_K;
            ay += sy * FISH_SEPARATION_K;
            if (n > 0) {
                const alignK = FISH_ALIGN_K * sp.align;
                const cohesionK = FISH_COHESION_K * sp.cohesion * (1 - 0.8 * f.alarm);
                ax += (avx / n - f.vx) * alignK + (cx / n) * cohesionK;
                ay += (avy / n - f.vy) * alignK + (cy / n) * cohesionK;
                if (sp.mill > 0) {
                    // Circle the local centre: the school spins into a bait ball.
                    const cl = Math.hypot(cx, cy) || 1;
                    ax += (-cy / cl) * f.millDir * sp.mill * (1 - f.alarm);
                    ay += (cx / cl) * f.millDir * sp.mill * (1 - f.alarm);
                }
            }
            // Predators. Distance is measured to the nearest point along the front
            // half of the shark, so fish also give the flanks a wide berth.
            let fear = 0;
            for (const sh of sharks) {
                // A shark still deep down is no threat yet; a striking one is felt from further away.
                const presence = clamp((sh.depth - 0.3) / 0.35, 0, 1);
                if (presence <= 0)
                    continue;
                const fearR = (sh.length * 0.7 + 70) * (1 + 0.5 * sh.strike) * presence;
                let best = Infinity;
                let bx = 0;
                let by = 0;
                for (let k = 0; k <= 12; k += 3) {
                    const nx = sh.nodes[k * 2];
                    const ny = sh.nodes[k * 2 + 1];
                    const d2 = (f.x - nx) ** 2 + (f.y - ny) ** 2;
                    if (d2 < best) {
                        best = d2;
                        bx = nx;
                        by = ny;
                    }
                }
                const d = Math.sqrt(best);
                if (d >= fearR || d < 1e-3)
                    continue;
                let w = 1 - d / fearR;
                w *= w;
                const awayX = (f.x - bx) / d;
                const awayY = (f.y - by) / d;
                // Fountain effect: break to whichever side of the shark's path you're on.
                const shx = Math.cos(sh.heading);
                const shy = Math.sin(sh.heading);
                const side = shx * (f.y - sh.nodes[1]) - shy * (f.x - sh.nodes[0]) >= 0 ? 1 : -1;
                const flee = FISH_FLEE_K * w * (1 + 0.6 * sh.strike);
                ax += (awayX * 0.7 - shy * side * 0.9) * flee;
                ay += (awayY * 0.7 + shx * side * 0.9) * flee;
                fear = Math.max(fear, Math.sqrt(w));
            }
            if (pointer.active) {
                const pr = 130;
                const dx = f.x - pointer.x;
                const dy = f.y - pointer.y;
                const d = Math.hypot(dx, dy);
                if (d < pr && d > 1e-3) {
                    const w = (1 - d / pr) ** 2;
                    ax += (dx / d) * FISH_FLEE_K * w;
                    ay += (dy / d) * FISH_FLEE_K * w;
                    fear = Math.max(fear, Math.sqrt(w) * 0.8);
                }
            }
            // Alarm: direct threat sets it, neighbours pass it along (slightly
            // weaker each hop), and it fades on its own.
            let alarm = Math.max(f.alarm * calmDecay, fear);
            const relayed = neighbourAlarm * 0.86;
            if (relayed > alarm)
                alarm += (relayed - alarm) * contagion;
            f.alarm = alarm;
            // Text on the page is dry land.
            const po = this.pushOut(f.x, f.y, 48, this.tmp);
            ax += po.x * 900;
            ay += po.y * 900;
            // Soft walls.
            const m = 36;
            if (f.x < m)
                ax += (m - f.x) * 7;
            else if (f.x > W - m)
                ax -= (f.x - (W - m)) * 7;
            if (f.y < m)
                ay += (m - f.y) * 7;
            else if (f.y > H - m)
                ay -= (f.y - (H - m)) * 7;
            // Ambient current and a little individual restlessness.
            current(f.x, f.y, time, cur);
            ax += cur.x * 0.5 + (Math.random() - 0.5) * sp.jitter;
            ay += cur.y * 0.5 + (Math.random() - 0.5) * sp.jitter;
            // Swim level, except when bolting from danger.
            ay -= f.vy * sp.verticalDrag * (1 - 0.7 * f.alarm);
            // Relax toward a preferred speed that rises with panic.
            const preferred = sp.cruise * (1 + 1.3 * f.alarm);
            ax += (preferred - speed) * hx * 1.6;
            ay += (preferred - speed) * hy * 1.6;
            const before = Math.atan2(f.vy, f.vx);
            f.vx += ax * dt;
            f.vy += ay * dt;
            const maxSpeed = sp.maxSpeed * (1 + 1.8 * f.alarm);
            const s = Math.hypot(f.vx, f.vy);
            if (s > maxSpeed) {
                f.vx *= maxSpeed / s;
                f.vy *= maxSpeed / s;
            }
            else if (s < sp.minSpeed && s > 1e-3) {
                f.vx *= sp.minSpeed / s;
                f.vy *= sp.minSpeed / s;
            }
            f.turn += (angleDiff(before, Math.atan2(f.vy, f.vx)) / dt - f.turn) * Math.min(1, dt * 8);
            f.phase += dt * (7 + Math.hypot(f.vx, f.vy) * 0.12);
            f.x = clamp(f.x + f.vx * dt, -60, W + 60);
            f.y = clamp(f.y + f.vy * dt, -60, H + 60);
        }
    }
    stepSharks(dt) {
        const { sharks, width: W, height: H, time } = this;
        const cxW = W / 2;
        const cyW = H / 2;
        for (let si = sharks.length - 1; si >= 0; si--) {
            const sh = sharks[si];
            const L = sh.length;
            const nodes = sh.nodes;
            const hx = nodes[0];
            const hy = nodes[1];
            // Depth: rise out of the deep, hold, sink away and leave.
            if (sh.life === "rising") {
                sh.depth = Math.min(sh.surfaceDepth, sh.depth + dt * sh.riseRate);
                if (sh.depth >= sh.surfaceDepth)
                    sh.life = "up";
            }
            else if (sh.life === "diving") {
                sh.depth -= dt / 7;
                if (sh.depth <= 0) {
                    sharks.splice(si, 1);
                    continue;
                }
            }
            const up = sh.depth > 0.5;
            sh.hunger = Math.min(1, sh.hunger + dt * 0.025);
            this.stepRemoras(sh, dt);
            if (sh.mode !== "free") {
                this.stepTapped(sh, dt);
                continue;
            }
            // Momentum.
            let dx = Math.cos(sh.heading);
            let dy = Math.sin(sh.heading);
            // Wander: a slowly drifting offset on a circle ahead of the snout.
            sh.wander = clamp(sh.wander + (Math.random() - 0.5) * dt * 2.4, -0.9, 0.9);
            dx += Math.cos(sh.heading + sh.wander) * 0.3;
            dy += Math.sin(sh.heading + sh.wander) * 0.3;
            // Hunt: only once up near the surface, hungry, and not digesting.
            const canHunt = up && sh.life !== "diving" && sh.hunger > 0.45 && time >= sh.digestUntil;
            if (canHunt && time >= sh.retargetAt && time >= sh.spookedUntil) {
                const prev = sh.target;
                sh.target = this.findPrey(sh);
                sh.retargetAt = time + 0.45;
                if (sh.target && sh.target !== prev) {
                    sh.peakClosing = 0;
                    // Often a pass or two around the school first, the way a shark sizes up a bait ball.
                    const d = Math.hypot(sh.target.x - hx, sh.target.y - hy);
                    sh.circleUntil = d > L * 1.1 && Math.random() < 0.55 ? time + rand(1.5, 4) : 0;
                }
            }
            else if (!canHunt) {
                sh.target = null;
            }
            const t = sh.target;
            let hunting = false;
            let circling = false;
            let closing = 0;
            if (t && t.alive) {
                const tx0 = t.x - hx;
                const ty0 = t.y - hy;
                const d0 = Math.hypot(tx0, ty0) || 1;
                if (time < sh.circleUntil && d0 > L * 0.6) {
                    circling = true;
                    // Circle: steer along the tangent, holding about a body length off.
                    const radial = clamp((d0 - L * 0.9) / (L * 0.9), -1, 1);
                    dx += ((-ty0 / d0) * sh.circleDir + (tx0 / d0) * radial) * 1.2;
                    dy += ((tx0 / d0) * sh.circleDir + (ty0 / d0) * radial) * 1.2;
                    hunting = true;
                    closing = 0;
                }
                else {
                    // Commit: aim at where the fish is about to be.
                    const tx = t.x + t.vx * 0.35 - hx;
                    const ty = t.y + t.vy * 0.35 - hy;
                    const d = Math.hypot(tx, ty) || 1;
                    const w = 1.4 + 2.6 * sh.hunger;
                    dx += (tx / d) * w;
                    dy += (ty / d) * w;
                    hunting = true;
                    closing = clamp(1 - d / (L * 0.9), 0, 1);
                    if (closing > sh.peakClosing) {
                        sh.peakClosing = closing;
                        sh.peakAt = time;
                    }
                    // A near miss is let go, not chased round the lake: break off and look elsewhere.
                    if (sh.peakClosing > 0.85 && time - sh.peakAt > 1.2 && closing < sh.peakClosing - 0.35) {
                        sh.target = null;
                        sh.spookedUntil = time + rand(2.5, 5);
                        sh.runUntil = time;
                        hunting = false;
                        closing = 0;
                    }
                }
            }
            else {
                // Search: a Lévy-style walk. Long easy runs; every so often a sharp turn
                // to a new patch. Speed drifts a little from run to run.
                if (time >= sh.runUntil) {
                    const big = Math.random() < 0.28;
                    sh.runTurn = big ? rand(0.9, 2.2) * (Math.random() < 0.5 ? 1 : -1) : rand(-0.35, 0.35);
                    sh.runUntil = time + (big ? rand(0.8, 1.6) : rand(2.5, 9));
                    sh.runSpeed = rand(0.8, 1.12);
                }
                dx += Math.cos(sh.heading + sh.runTurn) * 0.7;
                dy += Math.sin(sh.heading + sh.runTurn) * 0.7;
                // A gentle pull back towards the middle so the water never empties.
                const toX = cxW - hx;
                const toY = cyW - hy;
                const dc = Math.hypot(toX, toY) || 1;
                const far = clamp((dc - Math.min(W, H) * 0.3) / (Math.min(W, H) * 0.5), 0, 1);
                dx += (toX / dc) * far * 0.35;
                dy += (toY / dc) * far * 0.35;
            }
            // The strike builds as the jaws close and fades once the moment has passed.
            sh.strike += ((hunting ? closing : 0) - sh.strike) * Math.min(1, dt * (hunting ? 7 : 2.5));
            // Give other sharks at a similar depth room.
            for (const other of sharks) {
                if (other === sh || Math.abs(other.depth - sh.depth) > 0.35)
                    continue;
                for (let k = 0; k < SHARK_NODES; k += 4) {
                    const ox = hx - other.nodes[k * 2];
                    const oy = hy - other.nodes[k * 2 + 1];
                    const d = Math.hypot(ox, oy);
                    const range = (L + other.length) * 0.45;
                    if (d < range && d > 1e-3) {
                        const w = (1 - d / range) * 3;
                        dx += (ox / d) * w;
                        dy += (oy / d) * w;
                    }
                }
            }
            // Keep the page's text clear: steer around every avoid box. The snout
            // looks furthest ahead; the mid-body gets a second, closer check so a
            // long tail does not sweep across the words after the head has turned.
            const po = this.pushOut(hx, hy, L * 0.9 + 80, this.tmp);
            dx += po.x * (hunting ? 4 : 6);
            dy += po.y * (hunting ? 4 : 6);
            const mid = (SHARK_NODES >> 1) * 2;
            const pm = this.pushOut(nodes[mid], nodes[mid + 1], L * 0.35 + 40, this.tmp);
            dx += pm.x * 3;
            dy += pm.y * 3;
            if (hunting && (po.x !== 0 || po.y !== 0) && Math.hypot(po.x, po.y) > 0.6) {
                // Prey that leads into the text is not worth it.
                sh.target = null;
                hunting = false;
                closing = 0;
            }
            // Turn back once the snout leaves the frame, so bodies dip off-screen
            // now and then but the sharks never wander away for good.
            const over = Math.max(-hx, hx - W, -hy, hy - H);
            if (over > -L * 0.05) {
                const w = clamp((over + L * 0.05) / (L * 0.35), 0, 1) * 3.5;
                const toX = cxW - hx;
                const toY = cyW - hy;
                const d = Math.hypot(toX, toY) || 1;
                dx += (toX / d) * w;
                dy += (toY / d) * w;
            }
            const desired = Math.atan2(dy, dx);
            // Sharks can't pivot on the spot: the turning circle grows with speed.
            // Committed = in pursuit (not the circling pass): quicker on the turn, and
            // speed builds from a brisk approach to the burst over the last body-length.
            const committed = hunting && !circling;
            const agility = Math.min(committed ? 1.7 + closing * 1.6 : hunting ? 1.1 : 0.8, sh.speed / (L * 0.22));
            const maxTurn = agility * dt;
            const turned = clamp(angleDiff(sh.heading, desired), -maxTurn, maxTurn);
            sh.heading += turned;
            sh.turn += (turned / dt - sh.turn) * Math.min(1, dt * 3);
            // Cruise is slow and economical; digestion slower still. A chase is a
            // slow build and then a burst: the last body-length at up to four times cruise.
            const digesting = time < sh.digestUntil;
            // 0.67: a third slower than the engine's original pace; the lake is for reading, not chasing.
            const cruise = (30 + L * 0.04) * 0.67 * sh.runSpeed * (digesting ? 0.75 : 1) * (sh.life === "diving" ? 0.85 : 1);
            const targetSpeed = committed ? cruise * (1.5 + closing * closing * 2.6) : circling ? cruise * 1.15 : cruise;
            sh.speed += (targetSpeed - sh.speed) * Math.min(1, dt * (committed && closing > 0.5 ? 3.5 : 1.1));
            sh.phase += dt * (2 + sh.speed / 24);
            nodes[0] += Math.cos(sh.heading) * sh.speed * dt;
            nodes[1] += Math.sin(sh.heading) * sh.speed * dt;
            // Follow-the-leader spine, with a stiffness limit per joint so the
            // body bends into a C at most and never folds back on itself.
            const seg = L / (SHARK_NODES - 1);
            const maxBend = 0.16;
            let prevAngle = sh.heading + Math.PI;
            for (let k = 1; k < SHARK_NODES; k++) {
                const px = nodes[(k - 1) * 2];
                const py = nodes[(k - 1) * 2 + 1];
                let angle = Math.atan2(nodes[k * 2 + 1] - py, nodes[k * 2] - px);
                angle = prevAngle + clamp(angleDiff(prevAngle, angle), -maxBend, maxBend);
                nodes[k * 2] = px + Math.cos(angle) * seg;
                nodes[k * 2 + 1] = py + Math.sin(angle) * seg;
                prevAngle = angle;
            }
            // Feed, once properly up.
            if (sh.depth > 0.65 && sh.hunger > 0.15)
                this.feed(sh, time);
        }
    }
    /**
     * A tapped shark: bolt straight out of the frame at speed, hold off-screen
     * for a beat, then come back fast at the pointer (or where the tap was),
     * and only then return to cruising and hunting.
     */
    stepTapped(sh, dt) {
        const { width: W, height: H, time } = this;
        const L = sh.length;
        const nodes = sh.nodes;
        const hx = nodes[0];
        const hy = nodes[1];
        const fast = Math.max(W, H);
        let desired = sh.heading;
        let targetSpeed = sh.speed;
        let agility = 1;
        if (sh.mode === "bolt") {
            desired = Math.atan2(sh.boltY, sh.boltX);
            targetSpeed = fast * 0.9;
            agility = 5;
            // Gone once the whole body is outside the frame.
            let inside = false;
            for (let k = 0; k < SHARK_NODES; k += 2) {
                const x = nodes[k * 2];
                const y = nodes[k * 2 + 1];
                if (x > -30 && y > -30 && x < W + 30 && y < H + 30) {
                    inside = true;
                    break;
                }
            }
            if (!inside || time >= sh.modeUntil) {
                sh.mode = "wait";
                sh.modeUntil = time + rand(0.5, 1.1);
            }
        }
        else if (sh.mode === "wait") {
            targetSpeed = 30 + L * 0.04;
            if (time >= sh.modeUntil) {
                // Turn round out of sight and lay the body out straight behind the head.
                const tx = (this.pointer.active ? this.pointer.x : sh.chargeX) - hx;
                const ty = (this.pointer.active ? this.pointer.y : sh.chargeY) - hy;
                sh.heading = Math.atan2(ty, tx);
                const seg = L / (SHARK_NODES - 1);
                for (let n = 1; n < SHARK_NODES; n++) {
                    nodes[n * 2] = hx - Math.cos(sh.heading) * seg * n;
                    nodes[n * 2 + 1] = hy - Math.sin(sh.heading) * seg * n;
                }
                sh.mode = "charge";
                sh.modeUntil = time + 4;
                sh.strike = 1;
            }
        }
        else {
            // charge
            const px = this.pointer.active ? this.pointer.x : sh.chargeX;
            const py = this.pointer.active ? this.pointer.y : sh.chargeY;
            const tx = px - hx;
            const ty = py - hy;
            const d = Math.hypot(tx, ty);
            let cx = tx / (d || 1);
            let cy = ty / (d || 1);
            // Still steer round the words on the way in.
            const po = this.pushOut(hx, hy, L * 0.5 + 40, this.tmp);
            cx += po.x * 1.5;
            cy += po.y * 1.5;
            desired = Math.atan2(cy, cx);
            targetSpeed = fast * 0.5;
            agility = 2.8;
            sh.strike = 1;
            if (d < L * 0.3 || time >= sh.modeUntil) {
                sh.mode = "free";
                sh.hunger = Math.max(sh.hunger, 0.6);
                sh.retargetAt = time + 0.2;
                sh.spookedUntil = 0;
                sh.strike = 0.6;
            }
        }
        const maxTurn = agility * dt;
        const turned = clamp(angleDiff(sh.heading, desired), -maxTurn, maxTurn);
        sh.heading += turned;
        sh.turn += (turned / dt - sh.turn) * Math.min(1, dt * 3);
        sh.speed += (targetSpeed - sh.speed) * Math.min(1, dt * 4);
        sh.phase += dt * (2 + sh.speed / 24);
        nodes[0] += Math.cos(sh.heading) * sh.speed * dt;
        nodes[1] += Math.sin(sh.heading) * sh.speed * dt;
        const seg = L / (SHARK_NODES - 1);
        const maxBend = 0.16;
        let prevAngle = sh.heading + Math.PI;
        for (let k = 1; k < SHARK_NODES; k++) {
            const px = nodes[(k - 1) * 2];
            const py = nodes[(k - 1) * 2 + 1];
            let angle = Math.atan2(nodes[k * 2 + 1] - py, nodes[k * 2] - px);
            angle = prevAngle + clamp(angleDiff(prevAngle, angle), -maxBend, maxBend);
            nodes[k * 2] = px + Math.cos(angle) * seg;
            nodes[k * 2 + 1] = py + Math.sin(angle) * seg;
            prevAngle = angle;
        }
        // A charging shark still eats what it runs through.
        if (sh.mode === "charge")
            this.feed(sh, time);
    }
    feed(sh, time) {
        const L = sh.length;
        const nodes = sh.nodes;
        const mouthR = L * 0.05 + 8;
        const mx = nodes[0];
        const my = nodes[1];
        for (const f of this.fish) {
            if (!f.alive)
                continue;
            if ((f.x - mx) ** 2 + (f.y - my) ** 2 < mouthR * mouthR) {
                f.alive = false;
                f.respawnAt = time + rand(3, 8);
                this.eaten++;
                sh.hunger = Math.max(0, sh.hunger - 0.3);
                sh.digestUntil = time + rand(6, 12);
                sh.target = null;
                sh.strike = 1;
                this.events.push({ kind: "eat", x: f.x, y: f.y });
                // The rest of the school feels it at once and bursts outward.
                const shockR = L * 0.5 + 90;
                for (const o of this.fish) {
                    if (!o.alive)
                        continue;
                    const d = Math.hypot(o.x - f.x, o.y - f.y);
                    if (d < shockR)
                        o.alarm = Math.max(o.alarm, 1 - (d / shockR) * 0.4);
                }
            }
        }
    }
    /**
     * Pick prey in the shark's forward cone, preferring close fish in sparse
     * buckets (stragglers) over fish buried in a dense school.
     */
    findPrey(sh) {
        if (sh.depth <= 0.5)
            return null;
        const range = sh.length * 0.9 + 160;
        const hx = sh.nodes[0];
        const hy = sh.nodes[1];
        const fx = Math.cos(sh.heading);
        const fy = Math.sin(sh.heading);
        let best = null;
        let bestScore = Infinity;
        let currentScore = Infinity;
        for (const f of this.fish) {
            if (!f.alive)
                continue;
            const dx = f.x - hx;
            const dy = f.y - hy;
            const d = Math.hypot(dx, dy);
            if (d > range || d < 1e-3)
                continue;
            const cos = (dx * fx + dy * fy) / d;
            if (cos < 0.2)
                continue;
            // Never chase a fish that is sheltering next to the text.
            if (this.avoid.length) {
                const p = this.pushOut(f.x, f.y, 48, this.tmp);
                if (p.x !== 0 || p.y !== 0)
                    continue;
            }
            const crowd = this.bucketCount[this.bucketOf(f.x, f.y)];
            // From behind is best: a fish swimming the shark's way sees it late.
            const fs = Math.hypot(f.vx, f.vy) || 1;
            const behind = (f.vx * fx + f.vy * fy) / fs; // 1 same way, -1 head on
            const score = d * (1 + (1 - cos) * 0.8) * (1 + crowd * 0.07) * (1 + (1 - behind) * 0.35);
            if (score < bestScore) {
                bestScore = score;
                best = f;
            }
            if (f === sh.target)
                currentScore = score;
        }
        // Stick with the current target unless something is clearly better.
        if (sh.target && currentScore < bestScore * 1.3)
            return sh.target;
        return best;
    }
    respawn() {
        const { time, width: W, height: H } = this;
        const due = [];
        for (const f of this.fish)
            if (!f.alive && f.respawnAt <= time)
                due.push(f);
        if (due.length === 0)
            return;
        if (due.length < 6 && time - this.lastSpawn < 9)
            return;
        this.lastSpawn = time;
        // A new school swims in from a random edge.
        const side = randInt(0, 3);
        const along = rand(0.15, 0.85);
        const x = side === 0 ? -20 : side === 1 ? W + 20 : along * W;
        const y = side === 2 ? -20 : side === 3 ? H + 20 : along * H;
        const inward = Math.atan2(H / 2 - y, W / 2 - x) + rand(-0.5, 0.5);
        const species = pickSpecies();
        const sp = SPECIES[species];
        const millDir = Math.random() < 0.5 ? 1 : -1;
        for (const f of due.slice(0, sp.schoolSize[1])) {
            f.alive = true;
            f.species = species;
            f.alarm = 0;
            f.turn = 0;
            f.millDir = millDir;
            f.x = x + rand(-1, 1) * this.perception;
            f.y = y + rand(-1, 1) * this.perception;
            f.vx = Math.cos(inward) * sp.cruise * 1.4;
            f.vy = Math.sin(inward) * sp.cruise * 1.4;
        }
    }
}


// ---- renderer.ts
/**
 * Draws the World as a grid of ASCII cells:
 *   1. a pure black cell grid
 *   2. a wake field that diffuses where things swim, lighting the dots cyan
 *   3. fish as single dashes, one per cell, in a quiet species tint
 *   4. sharks rasterised cell-by-cell with supersampled edges: grey blocks
 *      shaded by the light, dense glyphs, and shimmering accent colours
 */


const ALPHA_LEVELS = 6;
const FISH_ALPHAS = [0.5, 0.62, 0.75, 0.88, 1];
/** Per-species colour, as a multiplier on the palette's fish colour: silver-blue sardine,
 *  green-backed anchovy, pale silverside, green mackerel, sandy goby. */
const FISH_TINTS = [
    [0.86, 0.95, 1.12],
    [0.82, 1.02, 0.97],
    [1.03, 1.02, 0.98],
    [0.8, 0.98, 0.86],
    [1.12, 0.97, 0.78],
];
const DARK_PALETTE = {
    dark: true, bg: "#000", grid: "rgba(255,255,255,0.055)", paper: [230, 238, 255], ink: [14, 15, 19], fish: [230, 238, 255],
    accents: ["#e0892c", "#e03a32", "#b44ae0", "#33c8cc", "#3cb54a", "#3150e8", "#d9c14a"], eye: "#9aa0ad", heat: [255, 120, 60], wake: [110, 230, 255], wakeScale: 1,
};
const mix = (a, b, k) => `rgb(${Math.round(a[0] + (b[0] - a[0]) * k)},${Math.round(a[1] + (b[1] - a[1]) * k)},${Math.round(a[2] + (b[2] - a[2]) * k)})`;
const lerp = (a, b, k) => [
    a[0] + (b[0] - a[0]) * k,
    a[1] + (b[1] - a[1]) * k,
    a[2] + (b[2] - a[2]) * k,
];
const hexRgb = (hex) => {
    const n = parseInt(hex.slice(1), 16);
    return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
};
const mixA = (a, b, k, alpha) => `rgba(${Math.round(a[0] + (b[0] - a[0]) * k)},${Math.round(a[1] + (b[1] - a[1]) * k)},${Math.round(a[2] + (b[2] - a[2]) * k)},${alpha.toFixed(3)})`;
// Dot colour classes: blue, green, red, pale; the last entry is the cyan wake.
const DOT_RGB = [
    [48, 52, 235],
    [52, 205, 60],
    [228, 50, 44],
    [190, 212, 255],
    [110, 230, 255],
];
const DOT_BASE_ALPHA = [1, 1, 1, 1, 1];
const WAKE = DOT_RGB.length - 1;
const ACCENTS = ["#e0892c", "#e03a32", "#b44ae0", "#33c8cc", "#3cb54a", "#3150e8", "#d9c14a"];
// Sparse glyphs on bright skin, dense glyphs in shadow, so the texture
// reinforces the shading instead of fighting it.
const SKIN_RAMP = ":;t%SX8#@";
const FIN_GLYPHS = "%;tS:";
const RIDGE_GLYPHS = "@8%";
const EDGE_HEAVY = ":;";
const EDGE_LIGHT = ".',`";
const FLAG_BODY = 1;
const FLAG_EDGE = 2;
const FLAG_FIN = 3;
const FLAG_RIDGE = 4;
const FLAG_EYE = 5;
/** Dark skin markings: tiger bars, zebra-shark spots. */
const FLAG_MARK = 6;
const MARK_GLYPHS = "#%@";
// Sub-cell sample offsets for anti-aliased silhouettes.
const SUBSAMPLES = [0.25, 0.3, 0.75, 0.3, 0.25, 0.72, 0.75, 0.72];
/** Classic top-down half-width at s ∈ [0, 1] (snout → tail), as a fraction of length. */
function classicHalfWidth(s) {
    if (s < 0.13)
        return 0.09 * Math.pow(Math.sin(((s / 0.13) * Math.PI) / 2), 0.95);
    if (s < 0.3)
        return 0.09 + 0.016 * smoothstep(0.13, 0.3, s);
    if (s < 0.84)
        return 0.019 + 0.087 * Math.pow(1 - (s - 0.3) / 0.54, 1.25);
    const k = (s - 0.84) / 0.16;
    return 0.019 * (1 - k) + 0.012 * Math.sin(k * Math.PI);
}
const SHAPES = {
    classic: {
        halfWidth: classicHalfWidth,
        pectoral: [0.15, 0.43, 0.55, 0.26],
        falcate: true,
        pelvic: [0.57, 0.65, 0.69, 0.085],
        caudal: 0.085,
        dorsal: [0.33, 0.47],
        secondDorsal: [0.71, 0.76],
        eye: [0.1, 0.14],
        gills: [0.19, 0.29],
        tint: [0.92, 0.97, 1.05],
    },
    // Slim neck under a wide, swept-back cephalofoil (drawn in sampleShark),
    // tall first dorsal, long upper tail lobe. Bronze-olive grey.
    hammerhead: {
        halfWidth: (s) => {
            if (s < 0.06)
                return 0.045;
            if (s < 0.3)
                return 0.045 + 0.061 * smoothstep(0.06, 0.3, s);
            return classicHalfWidth(s) * 0.92;
        },
        head: { span: 0.17, sweep: 0.035, depth: 0.09, notch: 0 },
        pectoral: [0.17, 0.4, 0.5, 0.22],
        falcate: true,
        pelvic: [0.56, 0.63, 0.67, 0.075],
        caudal: 0.11,
        dorsal: [0.28, 0.44],
        secondDorsal: [0.7, 0.74],
        eye: null,
        gills: [0.16, 0.26],
        tint: [0.96, 0.98, 0.9],
    },
    // Blunt, square snout on a heavy body; barred back. Warm grey-brown.
    tiger: {
        halfWidth: (s) => {
            if (s < 0.13)
                return 0.1 * Math.pow(Math.sin(((s / 0.13) * Math.PI) / 2), 0.45);
            if (s < 0.3)
                return 0.1 + 0.014 * smoothstep(0.13, 0.3, s);
            if (s < 0.84)
                return 0.019 + 0.095 * Math.pow(1 - (s - 0.3) / 0.54, 1.2);
            const k = (s - 0.84) / 0.16;
            return 0.019 * (1 - k) + 0.012 * Math.sin(k * Math.PI);
        },
        pectoral: [0.15, 0.42, 0.53, 0.25],
        falcate: true,
        pelvic: [0.57, 0.65, 0.69, 0.085],
        caudal: 0.095,
        dorsal: [0.33, 0.46],
        secondDorsal: [0.71, 0.75],
        eye: [0.08, 0.12],
        gills: [0.19, 0.28],
        tint: [1.02, 0.95, 0.84],
    },
    // Short rounded head, body done by half-length, then a long ribbon of a
    // tail fin. Broad rounded pectorals, spotted sandy skin.
    zebra: {
        halfWidth: (s) => {
            if (s < 0.1)
                return 0.075 * Math.pow(Math.sin(((s / 0.1) * Math.PI) / 2), 0.7);
            if (s < 0.28)
                return 0.075 + 0.025 * smoothstep(0.1, 0.28, s);
            if (s < 0.55)
                return 0.022 + 0.078 * Math.pow(1 - (s - 0.28) / 0.27, 1.1);
            const k = (s - 0.55) / 0.45;
            return 0.022 * (1 - k * k) + 0.012 * Math.sin(k * Math.PI);
        },
        pectoral: [0.12, 0.3, 0.36, 0.19],
        falcate: false,
        pelvic: [0.42, 0.48, 0.51, 0.065],
        caudal: 0,
        dorsal: [0.36, 0.44],
        secondDorsal: [0.49, 0.53],
        eye: [0.06, 0.09],
        gills: [0.13, 0.2],
        tint: [1.08, 0.97, 0.74],
    },
    // Great hammerhead: a broader, nearly straight-edged cephalofoil with a notch at the centre,
    // a towering sickle first dorsal (drawn long and bright from above), and a cooler slate skin.
    greathammer: {
        halfWidth: (s) => {
            if (s < 0.05)
                return 0.04;
            if (s < 0.3)
                return 0.04 + 0.07 * smoothstep(0.05, 0.3, s);
            return classicHalfWidth(s) * 0.95;
        },
        head: { span: 0.21, sweep: 0.006, depth: 0.085, notch: 0.014 },
        pectoral: [0.16, 0.38, 0.49, 0.24],
        falcate: true,
        pelvic: [0.55, 0.62, 0.67, 0.085],
        caudal: 0.13,
        dorsal: [0.24, 0.45],
        secondDorsal: [0.68, 0.74],
        eye: null,
        gills: [0.15, 0.25],
        tint: [0.86, 0.93, 1.02],
    },
    // Shortfin mako: a long conical snout, a torpedo body that narrows hard to the tail stalk,
    // and a tall crescent tail. Metallic indigo back.
    mako: {
        halfWidth: (s) => {
            if (s < 0.17)
                return 0.088 * Math.pow(Math.sin(((s / 0.17) * Math.PI) / 2), 1.5);
            if (s < 0.32)
                return 0.088 + 0.012 * smoothstep(0.17, 0.32, s);
            if (s < 0.86)
                return 0.014 + 0.086 * Math.pow(1 - (s - 0.32) / 0.54, 1.45);
            const k = (s - 0.86) / 0.14;
            return 0.014 * (1 - k) + 0.01 * Math.sin(k * Math.PI);
        },
        pectoral: [0.18, 0.4, 0.5, 0.21],
        falcate: true,
        pelvic: [0.58, 0.64, 0.68, 0.06],
        caudal: 0.13,
        dorsal: [0.34, 0.45],
        secondDorsal: [0.76, 0.79],
        eye: [0.11, 0.15],
        gills: [0.2, 0.3],
        tint: [0.78, 0.9, 1.2],
    },
    // Thresher: a compact body over the front half, then the upper tail lobe as a long whip
    // that's as long as the shark itself. Big eyes, long sickle pectorals, bronze-violet skin.
    thresher: {
        halfWidth: (s) => {
            if (s < 0.08)
                return 0.07 * Math.pow(Math.sin(((s / 0.08) * Math.PI) / 2), 0.75);
            if (s < 0.2)
                return 0.07 + 0.02 * smoothstep(0.08, 0.2, s);
            if (s < 0.48)
                return 0.012 + 0.078 * Math.pow(1 - (s - 0.2) / 0.28, 1.3);
            // The whip: thin, with a slight sickle swell before it tapers out.
            const k = (s - 0.48) / 0.52;
            return 0.012 * (1 - k) + 0.006 * Math.sin(k * Math.PI * 0.9) + 0.002;
        },
        pectoral: [0.12, 0.27, 0.36, 0.2],
        falcate: true,
        pelvic: [0.37, 0.41, 0.44, 0.045],
        caudal: 0,
        dorsal: [0.24, 0.32],
        secondDorsal: [0.45, 0.47],
        eye: [0.05, 0.1],
        gills: [0.11, 0.18],
        tint: [1.0, 0.9, 1.08],
    },
    // Nurse shark: a blunt, broad head, a heavy flattened body with both dorsals set far back,
    // rounded paddle pectorals, and a long low tail with no lower lobe. Tawny brown.
    nurse: {
        halfWidth: (s) => {
            if (s < 0.08)
                return 0.085 * Math.pow(Math.sin(((s / 0.08) * Math.PI) / 2), 0.4);
            if (s < 0.3)
                return 0.085 + 0.02 * smoothstep(0.08, 0.3, s);
            if (s < 0.72)
                return 0.022 + 0.083 * Math.pow(1 - (s - 0.3) / 0.42, 1.1);
            const k = (s - 0.72) / 0.28;
            return 0.022 * (1 - k * k) + 0.014 * Math.sin(k * Math.PI);
        },
        pectoral: [0.16, 0.34, 0.4, 0.17],
        falcate: false,
        pelvic: [0.45, 0.52, 0.55, 0.075],
        caudal: 0,
        dorsal: [0.5, 0.58],
        secondDorsal: [0.63, 0.69],
        eye: [0.05, 0.075],
        gills: [0.14, 0.22],
        tint: [1.1, 0.96, 0.76],
    },
};
const KINDS = Object.keys(SHAPES);
function inTriangle(px, py, ax, ay, bx, by, cx, cy) {
    const d1 = (px - bx) * (ay - by) - (ax - bx) * (py - by);
    const d2 = (px - cx) * (by - cy) - (bx - cx) * (py - cy);
    const d3 = (px - ax) * (cy - ay) - (cx - ax) * (py - ay);
    const neg = d1 < 0 || d2 < 0 || d3 < 0;
    const pos = d1 > 0 || d2 > 0 || d3 > 0;
    return !(neg && pos);
}
/** Visible dark-grey cell grid, snapped to device pixels. Shared with the sidebar backdrop. */
function paintGrid(g, W, H, cw, ch, dpr, color = "rgba(255,255,255,0.055)") {
    g.setTransform(1, 0, 0, 1, 0, 0);
    g.strokeStyle = color;
    g.lineWidth = 1;
    g.beginPath();
    for (let c = 0; c <= Math.ceil(W / cw); c++) {
        const x = Math.round(c * cw * dpr) + 0.5;
        g.moveTo(x, 0);
        g.lineTo(x, H * dpr);
    }
    for (let r = 0; r <= Math.ceil(H / ch); r++) {
        const y = Math.round(r * ch * dpr) + 0.5;
        g.moveTo(0, y);
        g.lineTo(W * dpr, y);
    }
    g.stroke();
}
class AsciiRenderer {
    constructor(canvas) {
        this.canvas = canvas;
        this.dpr = 1;
        this.width = 0;
        this.height = 0;
        this.cw = 12;
        this.ch = 18;
        this.cols = 0;
        this.rows = 0;
        this.fontFamily = "ui-monospace, Menlo, monospace";
        this.dotKind = new Uint8Array(0); // 0 none, 1 blue, 2 green, 3 red, 4 pale
        this.dotPhase = new Float32Array(0);
        this.dotFreq = new Float32Array(0);
        this.energy = new Float32Array(0);
        this.energyTmp = new Float32Array(0);
        this.heat = new Float32Array(0);
        this.bucketOf = new Uint8Array(0);
        this.bucketOrder = new Int32Array(0);
        this.bucketCounts = new Int32Array(DOT_RGB.length * ALPHA_LEVELS + 1);
        this.dotStyles = [];
        this.sharkFlag = new Uint8Array(0);
        this.sharkShade = new Float32Array(0);
        this.sharkKey = new Uint32Array(0);
        this.sharkDepth = new Float32Array(0);
        this.sharkKind = new Uint8Array(0);
        /** How much of the strike flush each shark cell carries (head cells, while the jaws close). */
        this.sharkStrike = new Float32Array(0);
        /** Cells darkened by a shark's shadow on the seabed. */
        this.sharkShadow = new Uint8Array(0);
        this.spine = new Float32Array(SHARK_NODES * 2);
        this.arc = new Float32Array(SHARK_NODES);
        this.arcTotal = 1;
        this.shape = SHAPES.classic;
        this.sharkId = 0;
        this.finTipLeft = 0;
        this.finTipRight = 0;
        // Scratch outputs of sampleShark(), to avoid allocating per sample.
        this.hitFlag = 0;
        this.hitShade = 0;
        this.hitS = 0;
        this.hitV = 0;
        this.hitDist = 0;
        /** Cells holding a fish this frame (frame stamp); dots skip them. */
        this.fishStamp = new Uint32Array(0);
        this.frameId = 0;
        /** Fish bucketed by brightness × species, so each bucket is one fillStyle. Entries pack the
         *  cell index, whether the fish is near (two body cells) and its direction:
         *  (cell << 2) | (near ? 2 : 0) | (facingRight ? 1 : 0). */
        this.fishBuckets = Array.from({ length: FISH_ALPHAS.length * FISH_TINTS.length }, () => []);
        /** Accent-coloured fish (one in a dozen) by brightness; same packing. */
        this.fishAccentBuckets = FISH_ALPHAS.map(() => []);
        this.fishStyles = [];
        this.fishAccentStyles = [];
        this.fishGlyphStyle = "#000";
        this.palette = DARK_PALETTE;
        const ctx = canvas.getContext("2d", { alpha: false });
        if (!ctx)
            throw new Error("2D canvas unavailable");
        this.ctx = ctx;
        this.bg = document.createElement("canvas");
        this.setPalette(DARK_PALETTE);
    }
    /** Repaints every colour the renderer uses from a palette; call on theme change. */
    setPalette(p) {
        this.palette = p;
        this.fishStyles = [];
        for (let a = 0; a < FISH_ALPHAS.length; a++) {
            for (let sp = 0; sp < FISH_TINTS.length; sp++) {
                const t = FISH_TINTS[sp];
                const r = Math.min(255, Math.round(p.fish[0] * t[0]));
                const g = Math.min(255, Math.round(p.fish[1] * t[1]));
                const b = Math.min(255, Math.round(p.fish[2] * t[2]));
                this.fishStyles.push(`rgba(${r},${g},${b},${FISH_ALPHAS[a]})`);
            }
        }
        this.fishAccentStyles = FISH_ALPHAS.map((a) => p.accents.map((hex) => {
            const n = parseInt(hex.slice(1), 16);
            return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`;
        }));
        this.fishGlyphStyle = p.bg;
        this.dotStyles = [];
        for (let c = 0; c < DOT_RGB.length; c++) {
            const [r, g, b] = c === WAKE ? p.wake : DOT_RGB[c];
            for (let l = 0; l < ALPHA_LEVELS; l++) {
                const a = (DOT_BASE_ALPHA[c] * (l + 1) * (c === WAKE ? p.wakeScale : 1)) / ALPHA_LEVELS;
                this.dotStyles.push(`rgba(${r},${g},${b},${a.toFixed(3)})`);
            }
        }
        if (this.cols)
            this.paintBackground();
    }
    get cellWidth() {
        return this.cw;
    }
    get cellHeight() {
        return this.ch;
    }
    setFontFamily(family) {
        if (family)
            this.fontFamily = family;
    }
    resize(width, height, dpr) {
        const prevCols = this.cols;
        const prevRows = this.rows;
        this.width = width;
        this.height = height;
        this.dpr = dpr;
        this.cw = clamp(Math.round(width / 124), 8, 13);
        this.ch = Math.round(this.cw * 1.45);
        this.cols = Math.ceil(width / this.cw);
        this.rows = Math.ceil(height / this.ch);
        this.canvas.width = Math.round(width * dpr);
        this.canvas.height = Math.round(height * dpr);
        this.bg.width = this.canvas.width;
        this.bg.height = this.canvas.height;
        const n = this.cols * this.rows;
        if (this.cols !== prevCols || this.rows !== prevRows) {
            this.dotKind = new Uint8Array(n);
            this.dotPhase = new Float32Array(n);
            this.dotFreq = new Float32Array(n);
            this.energy = new Float32Array(n);
            this.energyTmp = new Float32Array(n);
            this.heat = new Float32Array(n);
            this.bucketOf = new Uint8Array(n);
            this.bucketOrder = new Int32Array(n);
            this.sharkFlag = new Uint8Array(n);
            this.sharkShade = new Float32Array(n);
            this.sharkKey = new Uint32Array(n);
            this.sharkDepth = new Float32Array(n);
            this.sharkStrike = new Float32Array(n);
            this.sharkKind = new Uint8Array(n);
            this.sharkShadow = new Uint8Array(n);
            this.fishStamp = new Uint32Array(n);
        }
        for (let i = 0; i < n; i++) {
            const col = i % this.cols;
            const row = (i / this.cols) | 0;
            // No ambient dots: the grid stays black. Only the cyan wake lights cells.
            this.dotKind[i] = 0;
            this.dotPhase[i] = hash3(col, row, 23) * Math.PI * 2;
            this.dotFreq[i] = 0.3 + hash3(col, row, 37) * 1.1;
        }
        this.paintBackground();
    }
    paintBackground() {
        const g = this.bg.getContext("2d");
        if (!g)
            return;
        const { width: W, height: H, dpr, cw, ch } = this;
        g.setTransform(dpr, 0, 0, dpr, 0, 0);
        g.fillStyle = this.palette.bg;
        g.fillRect(0, 0, W, H);
        paintGrid(g, W, H, cw, ch, dpr, this.palette.grid);
    }
    render(world, dt) {
        const { ctx, dpr, cols, ch } = this;
        if (cols === 0)
            return;
        const t = world.time;
        this.consumeEvents(world);
        this.rasterizeSharks([...world.sharks].sort((a, b) => a.depth - b.depth), t);
        this.depositWake(world);
        this.diffuse(dt);
        ctx.setTransform(1, 0, 0, 1, 0, 0);
        ctx.drawImage(this.bg, 0, 0);
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
        this.markFish(world);
        this.drawDots(t);
        ctx.font = `500 ${Math.round(ch * 0.74)}px ${this.fontFamily}`;
        ctx.textAlign = "center";
        ctx.textBaseline = "middle";
        this.drawHeat();
        this.drawFish();
        this.drawSharks(t);
        this.drawRemoras(world);
    }
    // ── simulation → field ──────────────────────────────────────────────
    cellIndex(x, y) {
        const c = Math.floor(x / this.cw);
        const r = Math.floor(y / this.ch);
        if (c < 0 || r < 0 || c >= this.cols || r >= this.rows)
            return -1;
        return r * this.cols + c;
    }
    stamp(field, x, y, radius, amount) {
        const c0 = Math.floor(x / this.cw);
        const r0 = Math.floor(y / this.ch);
        for (let r = r0 - radius; r <= r0 + radius; r++) {
            for (let c = c0 - radius; c <= c0 + radius; c++) {
                if (c < 0 || r < 0 || c >= this.cols || r >= this.rows)
                    continue;
                const d = Math.hypot(c - c0, (r - r0) * 1.4);
                if (d > radius + 0.5)
                    continue;
                const i = r * this.cols + c;
                field[i] = Math.min(1.6, field[i] + amount * (1 - d / (radius + 1)));
            }
        }
    }
    consumeEvents(world) {
        for (const e of world.events) {
            if (e.kind === "eat") {
                // A burst at the mouth, a ring of thrown-off scales, and a wide ripple.
                this.stamp(this.heat, e.x, e.y, 3, 1.4);
                for (let k = 0; k < 6; k++) {
                    const a = (k / 6) * Math.PI * 2 + Math.random();
                    const rr = this.cw * (3 + Math.random() * 4);
                    this.stamp(this.heat, e.x + Math.cos(a) * rr, e.y + Math.sin(a) * rr * 0.7, 0, 0.9 + Math.random() * 0.5);
                }
                this.stamp(this.energy, e.x, e.y, 5, 1.3);
            }
            else {
                this.stamp(this.energy, e.x, e.y, 6, 1.4);
            }
        }
        world.events.length = 0;
    }
    depositWake(world) {
        const { energy } = this;
        for (const f of world.fish) {
            if (!f.alive)
                continue;
            const i = this.cellIndex(f.x, f.y);
            if (i >= 0)
                energy[i] = Math.min(1.6, energy[i] + 0.012 + f.alarm * 0.03);
        }
        for (const sh of world.sharks) {
            // The tail sweeps the most water.
            for (let k = SHARK_NODES - 6; k < SHARK_NODES; k++) {
                const i = this.cellIndex(sh.nodes[k * 2], sh.nodes[k * 2 + 1]);
                if (i >= 0)
                    energy[i] = Math.min(1.6, energy[i] + 0.05 + sh.speed * 0.0012);
            }
        }
        if (world.pointer.active) {
            this.stamp(energy, world.pointer.x, world.pointer.y, 1, 0.08);
        }
    }
    /** Blur + decay so wakes spread out like ripples and fade. */
    diffuse(dt) {
        const { cols, rows, energy, energyTmp: tmp, heat } = this;
        const decay = Math.exp(-dt * 1.5);
        for (let r = 0; r < rows; r++) {
            for (let c = 0; c < cols; c++) {
                const i = r * cols + c;
                const l = c > 0 ? energy[i - 1] : energy[i];
                const rt = c < cols - 1 ? energy[i + 1] : energy[i];
                const u = r > 0 ? energy[i - cols] : energy[i];
                const d = r < rows - 1 ? energy[i + cols] : energy[i];
                tmp[i] = (energy[i] * 4 + l + rt + u + d) * 0.125 * decay;
            }
        }
        this.energy = tmp;
        this.energyTmp = energy;
        const heatDecay = Math.exp(-dt * 1.5);
        for (let i = 0; i < heat.length; i++)
            heat[i] *= heatDecay;
    }
    // ── sharks ──────────────────────────────────────────────────────────
    /**
     * Classify one point against the current shark (spine/arc already built).
     * Body coordinates: s along the spine (0 snout → 1 tail), v across it.
     * Writes hit* fields and returns whether the point is on the shark.
     */
    sampleShark(px, py, L) {
        const { spine, arc } = this;
        const N = SHARK_NODES;
        let best = Infinity;
        let bestS = 0;
        let bestSign = 1;
        let bestNx = 0;
        let bestNy = 0;
        for (let k = 0; k < N - 1; k++) {
            const ax = spine[k * 2];
            const ay = spine[k * 2 + 1];
            const sx = spine[(k + 1) * 2] - ax;
            const sy = spine[(k + 1) * 2 + 1] - ay;
            const len2 = sx * sx + sy * sy || 1;
            const u = clamp(((px - ax) * sx + (py - ay) * sy) / len2, 0, 1);
            const qx = ax + sx * u;
            const qy = ay + sy * u;
            const d2 = (px - qx) ** 2 + (py - qy) ** 2;
            if (d2 < best) {
                best = d2;
                const len = Math.sqrt(len2);
                bestS = (arc[k] + u * len) / this.arcTotal;
                bestSign = sx * (py - ay) - sy * (px - ax) >= 0 ? 1 : -1;
                bestNx = (-sy / len) * bestSign;
                bestNy = (sx / len) * bestSign;
            }
        }
        const a = Math.sqrt(best);
        const s = bestS;
        const u = s * L;
        const shape = this.shape;
        const w = shape.halfWidth(s) * L;
        this.hitDist = a;
        this.hitS = s;
        this.hitV = a * bestSign;
        const head = this.shape.head;
        if (head && u < L * (head.sweep + head.depth + head.notch)) {
            // Cephalofoil: a wide wing across the snout, its tips swept back toward the eyes,
            // and on a great hammerhead a shallow notch in the middle of the front edge.
            const span = L * head.span;
            const r = a / span;
            const front = L * head.sweep * r * r + L * head.notch * Math.max(0, 1 - r / 0.14);
            // Full depth almost to the tips, so the wing reads as a solid bar rather than a thin line.
            const depth = L * head.depth * (1 - 0.2 * r * r * r * r);
            if (r <= 1 && u >= front && u <= front + depth) {
                this.hitFlag = r > 0.84 ? FLAG_EYE : FLAG_BODY;
                this.hitShade = r > 0.84 ? 0 : 0.62 - 0.2 * r + (u < front + L * 0.012 ? 0.1 : 0);
                return true;
            }
        }
        if (a <= w) {
            const across = a / (w || 1);
            // Rounded back lit from the top-left; flanks fall off into shadow.
            const facing = (bestNx * -0.6 + bestNy * -0.8) * across;
            let shade = 0.58 - across * across * 0.42 + facing * 0.26;
            let flag = FLAG_BODY;
            if (s > shape.dorsal[0] && s < shape.dorsal[1] && across < 0.3) {
                // First dorsal fin, catching the light.
                flag = FLAG_RIDGE;
                shade = 1;
            }
            else if (s > shape.secondDorsal[0] && s < shape.secondDorsal[1] && across < 0.4) {
                shade = Math.max(shade, 0.82);
            }
            else if (shape.eye && s > shape.eye[0] && s < shape.eye[1] && across > 0.6) {
                flag = FLAG_EYE;
                shade = 0;
            }
            else if (s > shape.gills[0] && s < shape.gills[1] && across > 0.58) {
                // Five gill slits.
                if (Math.floor(((s - shape.gills[0]) / (shape.gills[1] - shape.gills[0])) * 5) % 2 === 0)
                    shade *= 0.45;
            }
            else if (s < 0.05) {
                // Pale snout tip.
                shade = Math.max(shade, 0.7);
            }
            else if (shape === SHAPES.zebra && s > 0.08 && s < 0.55 && (across < 0.1 || Math.abs(across - 0.6) < 0.08)) {
                // Zebra sharks carry pale ridges down the back.
                shade = Math.max(shade, 0.8);
            }
            else if (this.marked(s, a * bestSign, L, across)) {
                flag = FLAG_MARK;
            }
            this.hitFlag = flag;
            this.hitShade = shade;
            return true;
        }
        const tip = bestSign > 0 ? this.finTipRight : this.finTipLeft;
        const [p0, p1, p2] = shape.pectoral;
        if (inTriangle(u, a, L * p0, 0, L * p1, 0, L * p2, tip) &&
            // Falcate (sickle) fins get a concave trailing edge.
            !(shape.falcate && inTriangle(u, a, L * p1, 0, L * (p1 + (p2 - p1) * 0.33), tip * 0.55, L * p2, tip))) {
            this.hitFlag = this.marked(s, a * bestSign, L, 0) ? FLAG_MARK : FLAG_FIN;
            this.hitShade = 0.38 + 0.22 * (1 - clamp(a / tip, 0, 1));
            return true;
        }
        const [v0, v1, v2, vr] = shape.pelvic;
        if (inTriangle(u, a, L * v0, 0, L * v1, 0, L * v2, L * vr) ||
            // Forked caudal fin.
            (shape.caudal > 0 && inTriangle(u, a, L * 0.86, 0, L * 0.95, 0, L, L * shape.caudal))) {
            this.hitFlag = FLAG_FIN;
            this.hitShade = 0.36;
            return true;
        }
        return false;
    }
    /** Whether a body point (s along, v across) falls on a dark marking. */
    marked(s, v, L, across) {
        if (this.shape === SHAPES.tiger) {
            // Wavy vertical bars over the back half, fading out toward the head.
            if (s < 0.2 || s > 0.9 || across > 0.85)
                return false;
            const wobble = 0.35 * Math.sin((v / L) * 25 + s * 5);
            const bar = Math.sin(s * Math.PI * 2 * 9 + wobble);
            return bar > 0.65 - 0.5 * smoothstep(0.2, 0.42, s) + 0.4 * smoothstep(0.8, 0.9, s);
        }
        if (this.shape === SHAPES.zebra) {
            // Leopard spots on a jittered grid, so they ride along with the skin.
            if (s < 0.07)
                return false;
            const gu = (s * L) / (L * 0.06);
            const gv = v / (L * 0.045);
            const cu = Math.floor(gu);
            const cv = Math.floor(gv);
            const jx = hash3(cu, cv, this.sharkId) * 0.5 + 0.25;
            const jy = hash3(cu, cv, this.sharkId + 11) * 0.5 + 0.25;
            return (gu - cu - jx) ** 2 + (gv - cv - jy) ** 2 < 0.08;
        }
        return false;
    }
    /**
     * Build a smooth, undulating render spine from the sim spine, then
     * supersample every cell in the shark's bounding box against the shape.
     * Fully covered cells become solid skin; partial cells become edge glyphs.
     */
    rasterizeSharks(sharks, t) {
        const { sharkFlag, sharkShade, sharkKey, sharkDepth, sharkKind, sharkStrike, sharkShadow, spine, arc, cw, ch, cols, rows } = this;
        sharkFlag.fill(0);
        sharkShadow.fill(0);
        for (const sh of sharks) {
            const L = sh.length;
            const N = SHARK_NODES;
            const n = sh.nodes;
            const swim = clamp(sh.speed / 60, 0.4, 1.4);
            this.shape = SHAPES[sh.kind];
            this.sharkId = sh.id;
            const kindIndex = KINDS.indexOf(sh.kind);
            // Travelling body wave, growing toward the tail.
            for (let k = 0; k < N; k++) {
                const s = k / (N - 1);
                const a = Math.max(0, k - 1);
                const b = Math.min(N - 1, k + 1);
                let tx = n[a * 2] - n[b * 2];
                let ty = n[a * 2 + 1] - n[b * 2 + 1];
                const tl = Math.hypot(tx, ty) || 1;
                tx /= tl;
                ty /= tl;
                const amp = L * 0.05 * (0.1 + 0.9 * Math.pow(s, 1.8)) * swim;
                const off = amp * Math.sin(sh.phase - s * 5.2);
                spine[k * 2] = n[k * 2] - ty * off;
                spine[k * 2 + 1] = n[k * 2 + 1] + tx * off;
            }
            arc[0] = 0;
            for (let k = 1; k < N; k++) {
                arc[k] =
                    arc[k - 1] +
                        Math.hypot(spine[k * 2] - spine[(k - 1) * 2], spine[k * 2 + 1] - spine[(k - 1) * 2 + 1]);
            }
            this.arcTotal = arc[N - 1] || 1;
            // Bank into turns: the inside fin foreshortens, the outside one spreads.
            const bank = clamp(sh.turn * 0.45, -0.35, 0.35);
            const flex = 1 + 0.06 * Math.sin(sh.phase * 0.5);
            const reachFin = this.shape.pectoral[3];
            this.finTipRight = L * reachFin * flex * (1 - bank);
            this.finTipLeft = L * reachFin * flex * (1 + bank);
            let minX = Infinity;
            let minY = Infinity;
            let maxX = -Infinity;
            let maxY = -Infinity;
            for (let k = 0; k < N; k++) {
                minX = Math.min(minX, spine[k * 2]);
                maxX = Math.max(maxX, spine[k * 2]);
                minY = Math.min(minY, spine[k * 2 + 1]);
                maxY = Math.max(maxY, spine[k * 2 + 1]);
            }
            const reach = L * 0.36;
            const c0 = Math.max(0, Math.floor((minX - reach) / cw));
            const c1 = Math.min(cols - 1, Math.floor((maxX + reach) / cw));
            const r0 = Math.max(0, Math.floor((minY - reach) / ch));
            const r1 = Math.min(rows - 1, Math.floor((maxY + reach) / ch));
            if (c0 > c1 || r0 > r1)
                continue;
            const skipBeyond = reach + Math.hypot(cw, ch);
            const shadowDc = Math.round((L * 0.035) / cw) + 1;
            const shadowDr = Math.round((L * 0.02) / ch) + 1;
            for (let r = r0; r <= r1; r++) {
                for (let c = c0; c <= c1; c++) {
                    const x = c * cw;
                    const y = r * ch;
                    const centerHit = this.sampleShark(x + cw / 2, y + ch / 2, L);
                    if (!centerHit && this.hitDist > skipBeyond)
                        continue;
                    const flag = this.hitFlag;
                    const shade = this.hitShade;
                    const s = this.hitS;
                    const v = this.hitV;
                    let hits = centerHit ? 1 : 0;
                    for (let k = 0; k < SUBSAMPLES.length; k += 2) {
                        if (this.sampleShark(x + SUBSAMPLES[k] * cw, y + SUBSAMPLES[k + 1] * ch, L))
                            hits++;
                    }
                    if (hits === 0)
                        continue;
                    const coverage = hits / 5;
                    const i = r * cols + c;
                    // Body-anchored key so each glyph rides along with the skin.
                    const key = (hash3(Math.round(s * 52), Math.round(v / (cw * 0.9)), sh.id) * 4294967295) >>> 0;
                    sharkKey[i] = key;
                    sharkDepth[i] = sh.depth;
                    sharkKind[i] = kindIndex;
                    sharkStrike[i] = sh.strike * clamp(1 - s / 0.28, 0, 1);
                    if (centerHit && coverage >= 0.6) {
                        sharkFlag[i] = flag;
                        const flicker = (hash3(c, r, Math.floor(t * 6)) - 0.5) * 0.06;
                        sharkShade[i] = clamp(shade + flicker, 0, 1);
                        const sc = c + shadowDc;
                        const sr = r + shadowDr;
                        if (sc < cols && sr < rows)
                            sharkShadow[sr * cols + sc] = 1;
                    }
                    else {
                        sharkFlag[i] = FLAG_EDGE;
                        sharkShade[i] = coverage;
                    }
                }
            }
        }
    }
    drawSharks(t) {
        const { ctx, cols, rows, cw, ch, sharkFlag, sharkShade, sharkKey, sharkDepth, sharkKind, sharkStrike } = this;
        const n = cols * rows;
        const heatRgb = this.palette.heat;
        for (let i = 0; i < n; i++) {
            const flag = sharkFlag[i];
            if (!flag)
                continue;
            const strike = sharkStrike[i];
            const col = i % cols;
            const row = (i / cols) | 0;
            const x = col * cw;
            const y = row * ch;
            const key = sharkKey[i];
            const shade = sharkShade[i];
            // Depth: a shark still down in the deep is a faint silhouette; as it rises
            // its skin fills in and brightens.
            const depth = sharkDepth[i];
            const dim = 0.3 + 0.7 * depth;
            const fillA = clamp((depth - 0.12) / 0.5, 0, 1);
            const [tr, tg, tb] = SHAPES[KINDS[sharkKind[i]]].tint;
            // Colours re-roll on a staggered clock so the hide shimmers.
            const tick = Math.floor(t * 2.4 + (key % 997) / 97);
            const roll = hash3(key, tick, 7);
            if (flag === FLAG_EDGE) {
                // Soft, anti-aliased silhouette: no block, just a light glyph.
                const set = shade >= 0.5 ? EDGE_HEAVY : EDGE_LIGHT;
                const g = (70 + shade * 80) * dim;
                const pal = this.palette;
                ctx.fillStyle =
                    roll < 0.07 && fillA > 0.5
                        ? pal.accents[key % pal.accents.length]
                        : pal.dark
                            ? `rgb(${Math.round(g * tr)},${Math.round(g * tg)},${Math.min(255, Math.round(g * tb + 6))})`
                            : `rgba(${pal.ink[0]},${pal.ink[1]},${pal.ink[2]},${((0.25 + shade * 0.45) * dim).toFixed(3)})`;
                ctx.fillText(set[(key >>> 8) % set.length], x + cw / 2, y + ch / 2 + 1);
                continue;
            }
            let level;
            let glyph;
            if (flag === FLAG_RIDGE) {
                level = 226;
                glyph = RIDGE_GLYPHS[(key >>> 8) % RIDGE_GLYPHS.length];
            }
            else if (flag === FLAG_EYE) {
                level = 12;
                glyph = "o";
            }
            else if (flag === FLAG_MARK) {
                level = 24 + shade * 22;
                glyph = MARK_GLYPHS[(key >>> 8) % MARK_GLYPHS.length];
            }
            else if (flag === FLAG_FIN) {
                level = 40 + shade * 120;
                glyph = FIN_GLYPHS[(key >>> 8) % FIN_GLYPHS.length];
            }
            else {
                level = 46 + shade * 160;
                const jitter = ((key >>> 4) % 3) - 1;
                glyph = SKIN_RAMP[clamp(Math.floor((1 - shade) * 8.99) + jitter, 0, SKIN_RAMP.length - 1)];
            }
            level *= dim;
            const pal = this.palette;
            let body;
            if (pal.dark) {
                // Tinted per species; the classic tint is a cool blue-grey, like a back seen through deep water.
                body = [Math.min(255, level * tr), Math.min(255, level * tg), Math.min(255, level * tb + 4)];
            }
            else {
                // On paper the body is a block of greys: the lit back is the darkest, as ink would be.
                const k = 0.1 + (level / 255) * 0.62;
                body = [
                    pal.paper[0] + (pal.ink[0] * tr - pal.paper[0]) * k,
                    pal.paper[1] + (pal.ink[1] * tg - pal.paper[1]) * k,
                    pal.paper[2] + (pal.ink[2] * tb - pal.paper[2]) * k,
                ];
            }
            // The head flushes warm as the jaws close on a fish.
            const bodyFlushed = strike > 0.04
                ? [body[0] + (heatRgb[0] - body[0]) * Math.min(0.85, strike * 0.75), body[1] + (heatRgb[1] - body[1]) * Math.min(0.85, strike * 0.75), body[2] + (heatRgb[2] - body[2]) * Math.min(0.85, strike * 0.75)]
                : body;
            if (fillA > 0.02) {
                ctx.fillStyle = mixA(bodyFlushed, bodyFlushed, 0, fillA);
                ctx.fillRect(x + 1, y + 1, cw - 1, ch - 1);
            }
            // Glyph on the skin: dark on a filled block; when the block has not filled in
            // yet (deep water) the glyph itself carries the body colour, so the shark
            // reads as a ghost of characters before it reads as a shape.
            let onBlock;
            if (flag === FLAG_EYE)
                onBlock = fillA > 0.4 ? hexRgb(pal.eye) : bodyFlushed;
            else if (flag === FLAG_MARK)
                onBlock = pal.dark ? [70 * tr, 70 * tg, 70 * tb] : lerp(pal.paper, pal.ink, 0.3);
            else if (roll < 0.09 && fillA > 0.5)
                onBlock = hexRgb(pal.accents[key % pal.accents.length]);
            else if (roll < 0.13)
                onBlock = pal.dark ? [255, 255, 255] : lerp(pal.paper, pal.ink, 0.05);
            else if (pal.dark)
                onBlock = shade > 0.55 ? [14, 15, 19] : [27, 29, 36];
            else
                onBlock = level > 120 ? lerp(pal.paper, pal.ink, 0.08) : lerp(pal.paper, pal.ink, 0.85);
            const glyphRgb = fillA >= 1 ? onBlock : lerp(bodyFlushed, onBlock, fillA);
            ctx.fillStyle = `rgb(${Math.round(glyphRgb[0])},${Math.round(glyphRgb[1])},${Math.round(glyphRgb[2])})`;
            ctx.fillText(glyph, x + cw / 2, y + ch / 2 + 1);
        }
    }
    /**
     * Remoras: a small dark fish on a pale host (or pale on dark, on paper), one
     * cell with a short tail cell behind it along the body. Only drawn once the
     * host is near enough the surface to have a skin to sit on.
     */
    drawRemoras(world) {
        const { ctx, cw, ch, cols, rows } = this;
        const pal = this.palette;
        for (const sh of world.sharks) {
            if (!sh.remoras.length || sh.depth < 0.45)
                continue;
            const a = clamp((sh.depth - 0.45) / 0.3, 0, 1) * 0.95;
            const [tr, tg, tb] = SHAPES[sh.kind].tint;
            // The host's mid-tone skin, to sit the remora against.
            // In the palette, paper is the page background and ink the text colour, so on
            // dark water paper is the dark one. A remora is a dark fish on pale skin (or
            // the reverse on paper), so pick the tone that contrasts with the host.
            const darkRgb = pal.dark ? pal.paper : pal.ink;
            const lightRgb = pal.dark ? pal.ink : pal.paper;
            const skin = pal.dark ? [150 * tr, 150 * tg, 150 * tb + 4] : lerp(pal.paper, [pal.ink[0] * tr, pal.ink[1] * tg, pal.ink[2] * tb], 0.45);
            const bodyRgb = pal.dark ? lerp(skin, darkRgb, 0.78) : lerp(skin, lightRgb, 0.72);
            const glyphRgb = pal.dark ? lerp(skin, lightRgb, 0.3) : lerp(skin, darkRgb, 0.65);
            for (const r of sh.remoras) {
                const c = Math.floor(r.x / cw);
                const row = Math.floor(r.y / ch);
                if (c < 0 || row < 0 || c >= cols || row >= rows)
                    continue;
                const x = c * cw;
                const y = row * ch;
                // Attached: a dark cell on the skin. Free: the same fish, swimming beside the host.
                ctx.fillStyle = mixA(bodyRgb, bodyRgb, 0, r.attached ? a : a * 0.7);
                ctx.fillRect(x + 2, y + 3, cw - 3, ch - 5);
                ctx.fillStyle = mixA(glyphRgb, glyphRgb, 0, a);
                ctx.fillText("~", x + cw / 2, y + ch / 2 + 1);
                // Tail cell, one step back along the host's body.
                const tc = Math.floor((r.x - r.tx * cw * 1.1) / cw);
                const trow = Math.floor((r.y - r.ty * ch * 1.1) / ch);
                if ((tc !== c || trow !== row) && tc >= 0 && trow >= 0 && tc < cols && trow < rows) {
                    ctx.fillStyle = mixA(bodyRgb, bodyRgb, 0, a * 0.55);
                    ctx.fillText(Math.abs(r.tx) > Math.abs(r.ty) ? "-" : "|", tc * cw + cw / 2, trow * ch + ch / 2 + 1);
                }
            }
        }
    }
    // ── fish, dots, heat ────────────────────────────────────────────────
    /**
     * Snap each fish to a cell and bucket it by brightness: far fish are dim,
     * near fish brighter, and turning or panicking fish glint. Nearer fish
     * claim a cell first when two land in the same one.
     */
    markFish(world) {
        const { fishStamp, fishBuckets, fishAccentBuckets, sharkFlag } = this;
        const frame = ++this.frameId;
        for (const bucket of fishBuckets)
            bucket.length = 0;
        for (const bucket of fishAccentBuckets)
            bucket.length = 0;
        for (let pass = 0; pass < 2; pass++) {
            for (const f of world.fish) {
                if (!f.alive || (f.depth > 0.78 ? 0 : 1) !== pass)
                    continue;
                const i = this.cellIndex(f.x, f.y);
                if (i < 0 || fishStamp[i] === frame || sharkFlag[i])
                    continue;
                fishStamp[i] = frame;
                const glint = clamp(Math.abs(f.turn) / 3.5, 0, 1);
                const v = 0.3 + (0.4 * (f.depth - 0.55)) / 0.45 + 0.3 * Math.max(glint, f.alarm);
                const a = clamp(Math.floor(v * FISH_ALPHAS.length), 0, FISH_ALPHAS.length - 1);
                const packed = (i << 2) | (f.depth > 0.72 ? 2 : 0) | (f.vx >= 0 ? 1 : 0);
                // One fish in twelve wears an accent colour; phase is fixed per fish, so it is always the same ones.
                if (f.phase < 0.52)
                    fishAccentBuckets[a].push(packed);
                else
                    fishBuckets[a * FISH_TINTS.length + f.species].push(packed);
            }
        }
    }
    /**
     * Each fish is one cell: a short dash in its species' tint, the way the
     * original pond drew them. Near fish are brighter, far ones dimmer; the
     * glyph itself never gets bigger than a cell, so a school reads as grain.
     */
    drawFish() {
        const { ctx, cw, ch, cols, fishBuckets, fishAccentBuckets } = this;
        const draw = (bucket, style) => {
            ctx.fillStyle = style;
            for (const p of bucket) {
                const i = p >> 2;
                ctx.fillText("-", (i % cols) * cw + cw / 2, ((i / cols) | 0) * ch + ch / 2 + 1);
            }
        };
        for (let b = 0; b < fishBuckets.length; b++)
            if (fishBuckets[b].length)
                draw(fishBuckets[b], this.fishStyles[b]);
        for (let a = 0; a < fishAccentBuckets.length; a++) {
            const bucket = fishAccentBuckets[a];
            if (!bucket.length)
                continue;
            const styles = this.fishAccentStyles[a];
            for (let k = 0; k < styles.length; k++) {
                const part = bucket.filter((p) => ((p >> 2) % styles.length) === k);
                if (part.length)
                    draw(part, styles[k]);
            }
        }
    }
    drawHeat() {
        const { ctx, heat, cols, cw, ch } = this;
        for (let i = 0; i < heat.length; i++) {
            const h = heat[i];
            if (h < 0.08)
                continue;
            const col = i % cols;
            const row = (i / cols) | 0;
            const [hr, hg, hb] = this.palette.heat;
            ctx.fillStyle = `rgba(${hr},${hg},${hb},${Math.min(1, h * 1.3).toFixed(2)})`;
            ctx.fillText(h > 0.9 ? "*" : h > 0.45 ? "+" : "·", col * cw + cw / 2, row * ch + ch / 2 + 1);
        }
    }
    /**
     * Every cell's dot twinkles on its own clock, is modulated by slow
     * caustic light bands, and flares cyan where the wake field is strong.
     * Dots are bucketed by colour/alpha so each bucket is one fillStyle.
     */
    drawDots(t) {
        const { ctx, cols, rows, cw, ch, dotKind, dotPhase, dotFreq, energy, sharkFlag, sharkShadow, fishStamp, frameId } = this;
        const { bucketOf, bucketOrder, bucketCounts } = this;
        const n = cols * rows;
        const SKIP = bucketCounts.length - 1;
        bucketCounts.fill(0);
        for (let i = 0; i < n; i++) {
            const e = energy[i];
            const kind = dotKind[i];
            if (sharkFlag[i] || fishStamp[i] === frameId || (kind === 0 && e < 0.45)) {
                bucketOf[i] = SKIP;
                continue;
            }
            let bucket;
            if (e > 0.45) {
                const level = clamp(Math.floor((e - 0.45) * 5), 0, ALPHA_LEVELS - 1);
                bucket = WAKE * ALPHA_LEVELS + level;
            }
            else {
                const col = i % cols;
                const row = (i / cols) | 0;
                // Dots stay bright and crisp; the twinkle is a gentle breathe, not a fade.
                const twinkle = 0.5 + 0.5 * Math.sin(t * dotFreq[i] + dotPhase[i]);
                const caustic = 0.85 + 0.15 * Math.sin(col * 0.11 + t * 0.35) * Math.sin(row * 0.17 - t * 0.27);
                let v = clamp((0.55 + 0.45 * twinkle) * caustic + e * 2, 0, 1);
                if (sharkShadow[i])
                    v *= 0.2;
                bucket = (kind - 1) * ALPHA_LEVELS + clamp(Math.floor(v * ALPHA_LEVELS), 0, ALPHA_LEVELS - 1);
            }
            bucketOf[i] = bucket;
            bucketCounts[bucket]++;
        }
        // Counting sort cells by bucket.
        const starts = new Int32Array(bucketCounts.length);
        for (let b = 1; b < bucketCounts.length; b++)
            starts[b] = starts[b - 1] + bucketCounts[b - 1];
        const cursor = starts.slice();
        for (let i = 0; i < n; i++) {
            const b = bucketOf[i];
            if (b !== SKIP)
                bucketOrder[cursor[b]++] = i;
        }
        const small = Math.max(2, Math.round(cw * 0.19));
        const large = small + 1;
        for (let b = 0; b < SKIP; b++) {
            const count = bucketCounts[b];
            if (!count)
                continue;
            ctx.fillStyle = this.dotStyles[b];
            const size = b >= WAKE * ALPHA_LEVELS ? large : small;
            const start = starts[b];
            for (let k = start; k < start + count; k++) {
                const i = bucketOrder[k];
                const col = i % cols;
                const row = (i / cols) | 0;
                // Sit the dot low-right in its cell, as in the reference.
                ctx.fillRect(Math.round(col * cw + cw * 0.66 - size / 2), Math.round(row * ch + ch * 0.64 - size / 2), size, size);
            }
        }
    }
}


// ---- engine.ts


const STEP = 1 / 60;
const MAX_STEPS = 4;
/**
 * Wires World + AsciiRenderer to a canvas: fixed-timestep loop, resize,
 * pointer input, pausing off-screen, and prefers-reduced-motion.
 */
class OceanEngine {
    constructor(canvas, sharks, fishCount, interactive = true) {
        this.canvas = canvas;
        this.interactive = interactive;
        this.raf = 0;
        this.last = 0;
        this.acc = 0;
        this.visible = true;
        this.disposed = false;
        this.frame = (now) => {
            const dt = Math.min(0.1, (now - this.last) / 1000);
            this.last = now;
            this.acc += dt;
            let steps = 0;
            while (this.acc >= STEP && steps < MAX_STEPS) {
                this.world.step(STEP);
                this.acc -= STEP;
                steps++;
            }
            if (steps === MAX_STEPS)
                this.acc = 0;
            this.renderer.render(this.world, dt);
            this.raf = requestAnimationFrame(this.frame);
        };
        this.onMotionPreference = () => {
            if (this.reducedMotion.matches) {
                cancelAnimationFrame(this.raf);
                this.drawStill();
            }
            else {
                this.schedule();
            }
        };
        this.onPointerMove = (e) => {
            const { x, y, inside } = this.toLocal(e);
            const p = this.world.pointer;
            p.x = x;
            p.y = y;
            p.active = inside && e.pointerType !== "touch";
        };
        this.onPointerDown = (e) => {
            if (e.target?.closest?.("a, button, input, select, textarea"))
                return;
            const { x, y, inside } = this.toLocal(e);
            if (inside && !this.reducedMotion.matches)
                this.world.splash(x, y);
        };
        this.onPointerLeave = () => {
            this.world.pointer.active = false;
        };
        this.world = new World(sharks, fishCount);
        this.renderer = new AsciiRenderer(canvas);
        this.renderer.setFontFamily(getComputedStyle(canvas).fontFamily);
        this.reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)");
        this.resizeObserver = new ResizeObserver(() => this.resize());
        this.resizeObserver.observe(canvas);
        this.intersectionObserver = new IntersectionObserver(([entry]) => {
            this.visible = entry.isIntersecting;
            this.schedule();
        });
        this.intersectionObserver.observe(canvas);
        this.reducedMotion.addEventListener("change", this.onMotionPreference);
        if (this.interactive) {
            window.addEventListener("pointermove", this.onPointerMove, { passive: true });
            window.addEventListener("pointerdown", this.onPointerDown, { passive: true });
            document.documentElement.addEventListener("pointerleave", this.onPointerLeave);
            window.addEventListener("blur", this.onPointerLeave);
        }
        this.resize();
        // Canvas text can't trigger a webfont load; once the mono face is in, redraw.
        document.fonts?.load(`500 16px ${getComputedStyle(canvas).fontFamily}`).then(() => {
            if (!this.disposed && this.reducedMotion.matches)
                this.drawStill();
        });
        this.schedule();
    }
    destroy() {
        this.disposed = true;
        cancelAnimationFrame(this.raf);
        this.resizeObserver.disconnect();
        this.intersectionObserver.disconnect();
        this.reducedMotion.removeEventListener("change", this.onMotionPreference);
        window.removeEventListener("pointermove", this.onPointerMove);
        window.removeEventListener("pointerdown", this.onPointerDown);
        document.documentElement.removeEventListener("pointerleave", this.onPointerLeave);
        window.removeEventListener("blur", this.onPointerLeave);
    }
    resize() {
        const rect = this.canvas.getBoundingClientRect();
        if (rect.width < 1 || rect.height < 1)
            return;
        const dpr = Math.min(window.devicePixelRatio || 1, 2);
        this.renderer.resize(rect.width, rect.height, dpr);
        this.world.resize(rect.width, rect.height, this.renderer.cellWidth, this.renderer.cellHeight);
        if (this.reducedMotion.matches)
            this.drawStill();
    }
    schedule() {
        cancelAnimationFrame(this.raf);
        if (this.disposed || !this.visible || this.reducedMotion.matches)
            return;
        this.last = performance.now();
        this.raf = requestAnimationFrame(this.frame);
    }
    /** Reduced motion: let the ecosystem settle, then show a single frame. */
    drawStill() {
        if (this.world.time < 4) {
            for (let i = 0; i < 240; i++)
                this.world.step(STEP);
        }
        this.renderer.render(this.world, STEP);
    }
    toLocal(e) {
        const rect = this.canvas.getBoundingClientRect();
        const x = e.clientX - rect.left;
        const y = e.clientY - rect.top;
        const inside = x >= 0 && y >= 0 && x <= rect.width && y <= rect.height;
        return { x, y, inside };
    }
    /** Redraw once; used after a palette change when the loop is not running. */
    redraw() {
        this.renderer.render(this.world, STEP);
    }
}


// ---- Kroog glue
// The fish from the ishanyash.com ocean, without the sharks: never interactive,
// at most 30 frames a second, and the schools steer around the chats on the canvas.
(function () {
  function hexToRgb(h) {
    var m = /^#([0-9a-f]{6})$/i.exec(String(h || "").trim());
    if (!m) return null;
    var n = parseInt(m[1], 16);
    return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
  }
  function isDark() {
    return document.documentElement.getAttribute("data-theme") === "dark";
  }
  function palette() {
    var cs = getComputedStyle(document.documentElement);
    var v = function (n, d) { return hexToRgb(cs.getPropertyValue(n)) || d; };
    var paper = v("--paper", [237, 235, 229]), ink = v("--ink", [21, 25, 27]), ink2 = v("--ink-2", [61, 68, 71]);
    var accent = v("--accent", [30, 107, 96]), amber = v("--amber", [168, 114, 42]);
    var dark = isDark();
    var hex = function (c) { return "#" + c.map(function (x) { return ("0" + Math.round(x).toString(16)).slice(-2); }).join(""); };
    return {
      dark: dark,
      bg: hex(paper),
      grid: "transparent",
      paper: paper,
      ink: ink,
      fish: dark ? ink2.map(function (x, i) { return Math.round(x * 0.35 + ink[i] * 0.65); }) : ink.map(function (x, i) { return Math.round(x * 0.7 + ink2[i] * 0.3); }),
      accents: [hex(accent), hex(amber)],
      eye: dark ? hex(paper) : hex(ink),
      heat: amber,
      wake: accent,
      wakeScale: dark ? 0.55 : 0.35,
    };
  }

  function start(canvas) {
    if (!canvas || !canvas.getContext) return null;
    var rect = canvas.getBoundingClientRect();
    var area = Math.max(1, rect.width * rect.height);
    var coarse = window.matchMedia("(pointer: coarse)").matches;
    var fishCount = Math.max(36, Math.min(coarse ? 56 : 110, Math.round(area / 10000)));
    // No sharks: an empty cast and an empty pool, so none ever rise.
    var engine = new OceanEngine(canvas, [], fishCount, false);
    engine.renderer.setPalette(palette());
    engine.world.setPopulation(0, 0, []);

    // 30 frames a second is plenty for water in the background.
    var inner = engine.frame;
    var lastDrawn = 0;
    engine.frame = function (now) {
      if (now - lastDrawn < 32) {
        engine.raf = requestAnimationFrame(engine.frame);
        return;
      }
      lastDrawn = now;
      inner(now);
    };

    return {
      setAvoid: function (boxes) { engine.world.setAvoid(boxes || []); },
      setTheme: function () { engine.renderer.setPalette(palette()); engine.redraw(); },
      destroy: function () {
        engine.destroy();
        var ctx = canvas.getContext("2d");
        if (ctx) ctx.clearRect(0, 0, canvas.width, canvas.height);
      },
    };
  }

  window.KroogWater = { start: start };
})();
})();
