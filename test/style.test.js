// The floor under the look (v1.0). These are the rules Kroog's own CSS and templates must
// keep, read as text: tokens for every colour, contrast that passes in both modes, motion
// that stands still when asked, no "transition: all", edges you can see, and plain meta
// strings instead of dot-joined ones. They run without a browser.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'public');
const read = (f) => fs.readFileSync(path.join(root, f), 'utf8');
const cssFiles = fs.readdirSync(root).filter((f) => f.endsWith('.css'));
const jsFiles = fs.readdirSync(root).filter((f) => f.endsWith('.js'));
const styles = read('styles.css');

// Strip comments so a rule in a comment doesn't count either way.
const stripComments = (css) => css.replace(/\/\*[\s\S]*?\*\//g, '');

function tokenBlock(css, selector) {
  const i = css.indexOf(`${selector} {`);
  assert.notEqual(i, -1, `${selector} block exists`);
  const j = css.indexOf('}', i);
  const out = {};
  for (const m of css.slice(i, j).matchAll(/--([a-z0-9-]+):\s*(#[0-9a-f]{6})\b/gi)) out[m[1]] = m[2].toLowerCase();
  return out;
}

const lum = (hex) => {
  const c = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255).map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
  return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
};
const ratio = (a, b) => {
  const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p);
  return (x + 0.05) / (y + 0.05);
};

const light = tokenBlock(styles, ':root');
const dark = { ...light, ...tokenBlock(styles, '[data-theme="dark"]') };

// Text needs 4.5:1, edges and marks you must see need 3:1. Hairlines (--line, --line-2)
// are allowed to be faint; anything drawn with --edge is not.
const PAIRS = [
  ['ink', 'paper', 4.5], ['ink', 'paper-2', 4.5],
  ['ink-2', 'paper', 4.5], ['ink-2', 'paper-2', 4.5],
  ['ink-3', 'paper', 4.5], ['ink-3', 'paper-2', 4.5], ['ink-3', 'code-bg', 4.5],
  ['accent-ink', 'paper', 4.5], ['accent-ink', 'paper-2', 4.5], ['accent-ink', 'accent-soft', 4.5],
  ['amber-ink', 'paper', 4.5], ['amber-ink', 'amber-soft', 4.5],
  ['error', 'paper', 4.5],
  ['paper', 'ink', 4.5],
  ['accent', 'paper', 3], ['amber', 'paper', 3], ['edge', 'paper', 3], ['edge', 'paper-2', 3], ['focus', 'paper', 3], ['focus', 'paper-2', 3],
];

for (const [mode, t] of [['light', light], ['dark', dark]]) {
  test(`${mode} mode: every text and edge pair clears its contrast floor`, () => {
    const low = [];
    for (const [a, b, need] of PAIRS) {
      assert.ok(t[a], `token --${a} is a hex colour in ${mode}`);
      assert.ok(t[b], `token --${b} is a hex colour in ${mode}`);
      const r = ratio(t[a], t[b]);
      if (r < need) low.push(`${a} on ${b}: ${r.toFixed(2)} (need ${need})`);
    }
    assert.deepEqual(low, [], `low pairs in ${mode}`);
  });
}

test('dark mode is tinted paper, not black, and re-derives every light token it needs', () => {
  const d = tokenBlock(styles, '[data-theme="dark"]');
  for (const k of ['paper', 'paper-2', 'ink', 'ink-2', 'ink-3', 'line', 'line-2', 'edge', 'accent', 'accent-ink', 'accent-soft', 'amber', 'amber-ink', 'amber-soft', 'error', 'focus', 'pop-bg']) {
    assert.ok(d[k], `dark redefines --${k}`);
  }
  assert.notEqual(d.paper, '#000000');
  assert.ok(lum(d.paper) > 0.004, 'dark paper has some light in it');
  assert.ok(lum(d['paper-2']) > lum(d.paper), 'raised surfaces are lighter in dark mode');
  assert.ok(lum(light['paper-2']) < lum(light.paper), 'raised surfaces are darker in light mode');
});

test('colours live in the token blocks, not in rules', () => {
  const offenders = [];
  for (const f of cssFiles) {
    const css = stripComments(read(f));
    // Drop the two token blocks of styles.css, then look for hex or rgb() literals.
    const body = css.replace(/:root \{[\s\S]*?\}/, '').replace(/\[data-theme="dark"\] \{[\s\S]*?\}/, '');
    for (const m of body.matchAll(/#[0-9a-f]{3,8}\b|rgba?\(/gi)) {
      const line = body.slice(0, m.index).split('\n').length;
      offenders.push(`${f}:${line} ${m[0]}`);
    }
  }
  assert.deepEqual(offenders, []);
});

test('no "transition: all", and no transition on width, height, top or left', () => {
  const offenders = [];
  for (const f of cssFiles) {
    const css = stripComments(read(f));
    for (const m of css.matchAll(/transition:([^;]*);/g)) {
      const v = m[1];
      if (/\ball\b/.test(v) || /\b(width|height|top|left|right|bottom)\b/.test(v)) offenders.push(`${f}: transition:${v.trim()}`);
    }
  }
  assert.deepEqual(offenders, []);
});

test('the page cannot scroll sideways, and focus is visible and instant', () => {
  const css = stripComments(styles);
  assert.match(css, /html,\s*body\s*\{[^}]*overflow-x:\s*clip/);
  assert.match(css, /:focus-visible\s*\{[^}]*outline:\s*2px solid var\(--focus\)/);
  // Inputs keep a constant border and show focus as an inset outline.
  assert.match(css, /input:focus-visible,\s*textarea:focus-visible,\s*select:focus-visible\s*\{[^}]*outline-offset:\s*-2px/);
  // No rule throws focus away on something you can tab to.
  const none = [...css.matchAll(/([^{}]+)\{[^}]*outline:\s*none/g)].map((m) => m[1].trim());
  const allowed = none.filter((sel) => !/^\.view:focus$|^\.search input:focus-visible$/.test(sel));
  assert.deepEqual(allowed, [], 'outline: none only on the canvas and the wrapped search input');
});

test('every animation stands still under prefers-reduced-motion', () => {
  const css = stripComments(styles);
  const blocks = [...css.matchAll(/@media \(prefers-reduced-motion: reduce\)\s*\{([\s\S]*?)\n\}/g)].map((m) => m[1]);
  assert.ok(blocks.length >= 1, 'a reduced-motion block exists');
  const block = blocks.join('\n');
  // One blanket rule covers everything, including animations added later.
  assert.match(block, /animation-duration:\s*0\.001ms\s*!important/);
  assert.match(block, /transition-duration:\s*0\.001ms\s*!important/);
  // The canvases drawn from script ask the same question themselves (the lineage's own
  // glide is a CSS transition, which the blanket rule above already stops).
  for (const f of ['brainmap.js', 'field.js', 'water.js']) {
    if (fs.existsSync(path.join(root, f))) assert.match(read(f), /prefers-reduced-motion/, `${f} respects reduced motion`);
  }
});

test('controls you click are at least 32px tall, and fields show an edge you can see', () => {
  const css = stripComments(styles);
  assert.match(css, /\.btn\s*\{[^}]*min-height:\s*(3[2-9]|40)px/);
  const inputs = /input\[type="text"\][^{]*\{[^}]*border:\s*1px solid var\(--edge\)/.test(css) || /input,\s*textarea,\s*select\s*\{[^}]*border:\s*1px solid var\(--edge\)/.test(css) || /\binput\b[^{]*\{[^}]*border:\s*1px solid var\(--edge\)/.test(css);
  assert.ok(inputs, 'inputs use --edge');
  for (const sel of ['.search', '.seg', '.pill']) {
    const m = new RegExp(`${sel.replace('.', '\\.')}\\s*\\{[^}]*border:\\s*1px solid var\\(--edge\\)`).exec(css);
    assert.ok(m, `${sel} uses --edge`);
  }
});

test('no eyebrows: nothing is set in tracked capitals', () => {
  const offenders = [];
  for (const f of cssFiles) {
    const css = stripComments(read(f));
    for (const m of css.matchAll(/text-transform:\s*uppercase/g)) offenders.push(`${f}@${m.index}`);
    for (const m of css.matchAll(/letter-spacing:\s*0?\.(0[5-9]|[1-9])\d*em/g)) offenders.push(`${f}@${m.index} wide tracking`);
  }
  assert.deepEqual(offenders, []);
});

test('meta strings in the templates read as sentences, not dot-joined fragments', () => {
  const offenders = [];
  for (const f of jsFiles) {
    const js = read(f);
    js.split('\n').forEach((line, i) => {
      // A middle dot used as a separator inside a template or string literal.
      if (/['"`][^'"`\n]*\s·\s[^'"`\n]*['"`]/.test(line) || /join\(['"]\s*·\s*['"]\)/.test(line)) offenders.push(`${f}:${i + 1}`);
    });
  }
  assert.deepEqual(offenders, []);
});

test('fonts and sizes come from tokens', () => {
  const css = stripComments(styles);
  const bodyRule = /body\s*\{[^}]*font-family:\s*var\(--mono\)/.test(css) || /html\s*\{[^}]*font-family:\s*var\(--mono\)/.test(css) || /body\s*\{[^}]*font:\s*[^;]*var\(--mono\)/.test(css);
  assert.ok(bodyRule, 'body uses --mono');
  const families = [...css.matchAll(/font-family:\s*([^;]+);/g)].map((m) => m[1].trim()).filter((v) => !v.includes('var(') && !v.startsWith('"IBM Plex Mono"'));
  assert.deepEqual(families, [], 'every font-family is a token or the @font-face name');
});
