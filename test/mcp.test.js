import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { SecondBrain } from '../src/memory/index.js';
import { mcpAddArgs } from '../src/mcp.js';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

test('the kroog-brain MCP server answers over stdio', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kroog-mcp-'));
  const claudeDir = path.join(tmp, '.claude');
  fs.mkdirSync(path.join(claudeDir, 'rules'), { recursive: true });
  fs.writeFileSync(path.join(claudeDir, 'CLAUDE.md'), '# Me\n\nAlways run the linter before pushing.\n');
  fs.writeFileSync(path.join(claudeDir, 'rules', 'sql.md'), '# SQL\n\nPrefer CTEs over subqueries in dbt models.\n');
  const dir = path.join(tmp, 'brain');
  await new SecondBrain({ dir, claudeDir, embedder: null }).build();

  // A file URL, so a Windows path (C:\...) imports too.
  const code = `import(${JSON.stringify(pathToFileURL(path.join(ROOT, 'src', 'mcp.js')).href)}).then((m) => m.runMcp({ dir: ${JSON.stringify(dir)}, claudeDir: ${JSON.stringify(claudeDir)}, embedder: null }));`;
  const child = spawn(process.execPath, ['--input-type=module', '-e', code], { stdio: ['pipe', 'pipe', 'inherit'] });
  const replies = [];
  let buf = '';
  child.stdout.on('data', (d) => {
    buf += d;
    let i;
    while ((i = buf.indexOf('\n')) >= 0) { replies.push(JSON.parse(buf.slice(0, i))); buf = buf.slice(i + 1); }
  });
  const ask = async (msg, want) => {
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', ...msg })}\n`);
    const end = Date.now() + 5000;
    while (Date.now() < end) {
      const r = replies.find((x) => x.id === want);
      if (r) return r;
      await new Promise((res) => setTimeout(res, 20));
    }
    throw new Error(`no reply to ${msg.method}`);
  };
  try {
    const init = await ask({ id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '1' } } }, 1);
    assert.equal(init.result.serverInfo.name, 'kroog-brain');
    assert.deepEqual(init.result.capabilities, { tools: {} });
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n`);
    const list = await ask({ id: 2, method: 'tools/list' }, 2);
    assert.deepEqual(list.result.tools.map((t) => t.name), ['search_brain', 'read_brain_file']);
    const found = await ask({ id: 3, method: 'tools/call', params: { name: 'search_brain', arguments: { query: 'CTEs subqueries' } } }, 3);
    const text = found.result.content[0].text;
    assert.match(text, /sql\.md/);
    assert.match(text, /kind: instructions/);
    const p = /path: (\S+sql\.md)/.exec(text)[1];
    const read = await ask({ id: 4, method: 'tools/call', params: { name: 'read_brain_file', arguments: { path: p } } }, 4);
    assert.match(read.result.content[0].text, /Prefer CTEs/);
    const denied = await ask({ id: 5, method: 'tools/call', params: { name: 'read_brain_file', arguments: { path: '/etc/passwd' } } }, 5);
    assert.equal(denied.result.isError, true);
    const bad = await ask({ id: 6, method: 'nope' }, 6);
    assert.equal(bad.error.code, -32601);
  } finally {
    child.kill();
  }
  assert.deepEqual(mcpAddArgs('/usr/bin/node', '/k/bin/kroog.js'), ['mcp', 'add', '--scope', 'user', 'kroog-brain', '--', '/usr/bin/node', '/k/bin/kroog.js', 'mcp']);
});
