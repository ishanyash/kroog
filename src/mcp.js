// kroog-brain: a small MCP server, so every Claude Code chat (VS Code included) can search
// your second brain. Claude Code starts it over stdio: `node bin/kroog.js mcp`.
// It reads the index Kroog keeps in ~/.kroog/brain/ and does not need Kroog to be running.
import readline from 'node:readline';
import { SecondBrain } from './memory/index.js';

export const SERVER_NAME = 'kroog-brain';
const PROTOCOL = '2025-06-18';

const TOOLS = [
  {
    name: 'search_brain',
    description: 'Search the user\'s second brain: their Claude Code instructions (CLAUDE.md, rules), skills, agents, commands, plans, Claude Code auto memory for each project, project .claude docs, and notes kept in Kroog. Use it to recall decisions, conventions, how-tos and context from other projects and earlier chats.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'What to look for, in plain words.' },
        limit: { type: 'integer', minimum: 1, maximum: 30, description: 'How many results (default 8).' },
        project: { type: 'string', description: 'Only this project (folder name), or "all projects" for user-level files.' },
      },
      required: ['query'],
    },
  },
  {
    name: 'read_brain_file',
    description: 'Read the full text of one file from the second brain, by the path a search result gave.',
    inputSchema: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] },
  },
];

export function mcpAddArgs(nodePath, scriptPath) {
  return ['mcp', 'add', '--scope', 'user', SERVER_NAME, '--', nodePath, scriptPath, 'mcp'];
}

export function formatResults(results) {
  if (!results.length) return 'Nothing in the second brain matches that.';
  return results.map((r, i) => [
    `${i + 1}. ${r.title}${r.heading && r.heading !== r.title ? ` — ${r.heading}` : ''}`,
    `   kind: ${r.kind} · project: ${r.project} · path: ${r.path}`,
    `   ${r.snippet}`,
  ].join('\n')).join('\n\n');
}

export function runMcp({ dir, claudeDir = '', getSettings = () => ({}), input = process.stdin, output = process.stdout, version = '0.7.0', embedder = undefined } = {}) {
  const send = (msg) => output.write(`${JSON.stringify({ jsonrpc: '2.0', ...msg })}\n`);
  const brain = () => new SecondBrain({ dir, claudeDir, getSettings, embedder });
  const rl = readline.createInterface({ input, crlfDelay: Infinity });

  const handle = async (msg) => {
    const { id, method, params = {} } = msg;
    const isRequest = id !== undefined && id !== null;
    try {
      if (method === 'initialize') {
        return send({ id, result: { protocolVersion: params.protocolVersion || PROTOCOL, capabilities: { tools: {} }, serverInfo: { name: SERVER_NAME, version } } });
      }
      if (method === 'notifications/initialized' || (method && method.startsWith('notifications/'))) return null;
      if (method === 'ping') return send({ id, result: {} });
      if (method === 'tools/list') return send({ id, result: { tools: TOOLS } });
      if (method === 'tools/call') {
        const name = params.name;
        const args = params.arguments || {};
        if (name === 'search_brain') {
          const b = brain();
          if (!b.meta.chunks.length) return send({ id, result: { content: [{ type: 'text', text: 'The second brain is empty. Open Kroog once so it can index your ~/.claude files.' }] } });
          const results = await b.search(String(args.query || ''), { limit: Math.max(1, Math.min(Number(args.limit) || 8, 30)), project: args.project || null });
          return send({ id, result: { content: [{ type: 'text', text: formatResults(results) }] } });
        }
        if (name === 'read_brain_file') {
          try {
            const text = brain().readFile(String(args.path || ''));
            return send({ id, result: { content: [{ type: 'text', text: text.slice(0, 200000) }] } });
          } catch (error) {
            return send({ id, result: { content: [{ type: 'text', text: error.message }], isError: true } });
          }
        }
        return send({ id, error: { code: -32602, message: `Unknown tool: ${name}` } });
      }
      if (isRequest) return send({ id, error: { code: -32601, message: `Method not found: ${method}` } });
      return null;
    } catch (error) {
      if (isRequest) send({ id, error: { code: -32603, message: error.message } });
      return null;
    }
  };

  rl.on('line', (line) => {
    if (!line.trim()) return;
    let msg;
    try { msg = JSON.parse(line); } catch {
      send({ id: null, error: { code: -32700, message: 'Parse error' } });
      return;
    }
    handle(msg);
  });
  return rl;
}
