#!/usr/bin/env node
// A stand-in for Claude Code in tests. It logs how it was called and answers like the real one.
import fs from 'node:fs';
const args = process.argv.slice(2);
if (args.includes('--version')) { console.log('9.9.9 (Claude Code)'); process.exit(0); }
let input = '';
process.stdin.on('data', (d) => { input += d; });
process.stdin.on('end', () => {
  if (process.env.FAKE_LOG) fs.appendFileSync(process.env.FAKE_LOG, JSON.stringify({ args, input, cwd: process.cwd(), kroogRun: process.env.KROOG_RUN || '' }) + '\n');
  const fmt = args[args.indexOf('--output-format') + 1];
  if (fmt === 'json') {
    const result = /merge/i.test(args.join(' ')) || /Goal of the new work/.test(input) ? 'Goal\nShip it\n\nWhat is done\n- a' : JSON.stringify({ gist: 'Rounding fixed in cart.js', keywords: ['cart.js', 'rounding'] });
    console.log(JSON.stringify({ type: 'result', is_error: false, result }));
    return;
  }
  const i = args.indexOf('--session-id');
  const r = args.indexOf('--resume');
  const sid = i >= 0 ? args[i + 1] : args[r + 1];
  const out = (o) => process.stdout.write(JSON.stringify({ session_id: sid, ...o }) + '\n');
  out({ type: 'system', subtype: 'init' });
  out({ type: 'assistant', message: { content: [{ type: 'tool_use', id: 't1', name: 'Read', input: { file_path: 'README.md' } }] } });
  const delay = Number(process.env.FAKE_DELAY || 50);
  setTimeout(() => {
    if (/please fail/.test(input)) { out({ type: 'result', subtype: 'error_during_execution', is_error: true, result: 'It broke' }); process.exit(1); }
    out({ type: 'result', subtype: 'success', is_error: false, result: `fake reply to: ${input.slice(0, 40)}` });
  }, delay);
});
