// Turns tool calls into short plain-language lines for the week view and the chat log.
import { truncate, shortPath, hostOf, clip } from './util.js';

export function describeTool(name, input = {}) {
  const i = input || {};
  switch (name) {
    case 'Bash':
    case 'PowerShell':
      return i.description ? `Running: ${truncate(i.description, 90)}` : `Running: ${truncate(i.command, 90)}`;
    case 'Read':
      return `Reading ${shortPath(i.file_path)}`;
    case 'Edit':
    case 'MultiEdit':
      return `Editing ${shortPath(i.file_path)}`;
    case 'Write':
      return `Writing ${shortPath(i.file_path)}`;
    case 'NotebookEdit':
      return `Editing ${shortPath(i.notebook_path)}`;
    case 'Grep':
      return `Searching the code for "${truncate(i.pattern, 50)}"`;
    case 'Glob':
      return `Finding files: ${truncate(i.pattern, 50)}`;
    case 'WebFetch':
      return `Opening ${hostOf(i.url)}`;
    case 'WebSearch':
      return `Searching the web for "${truncate(i.query, 60)}"`;
    case 'Task':
    case 'Agent':
      return `Starting a helper: ${truncate(i.description || i.subagent_type || 'side task', 70)}`;
    case 'TodoWrite':
    case 'TaskCreate':
    case 'TaskUpdate':
      return 'Updating its plan';
    case 'ExitPlanMode':
      return 'Presenting a plan';
    case 'AskUserQuestion':
      return 'Asking you a question';
    default:
      if (typeof name === 'string' && name.startsWith('mcp__')) {
        const [, server = '', tool = ''] = name.split('__');
        return `Using ${server}: ${tool.replace(/_/g, ' ')}`;
      }
      return `Using ${name || 'a tool'}`;
  }
}

// What a permission request is about, in words a person can decide on.
export function describePermission(name, input = {}) {
  const i = input || {};
  switch (name) {
    case 'Bash':
    case 'PowerShell':
      return { title: 'Run a command', detail: clip(i.command, 600), note: i.description ? truncate(i.description, 140) : '' };
    case 'Edit':
    case 'MultiEdit':
      return { title: `Edit ${shortPath(i.file_path, 3)}`, detail: clip(i.new_string || (i.edits && i.edits[0] && i.edits[0].new_string) || '', 400), note: i.file_path || '' };
    case 'Write':
      return { title: `Create or overwrite ${shortPath(i.file_path, 3)}`, detail: clip(i.content, 400), note: i.file_path || '' };
    case 'NotebookEdit':
      return { title: `Edit ${shortPath(i.notebook_path, 3)}`, detail: '', note: i.notebook_path || '' };
    case 'WebFetch':
      return { title: `Open ${hostOf(i.url)}`, detail: i.url || '', note: '' };
    case 'WebSearch':
      return { title: 'Search the web', detail: i.query || '', note: '' };
    case 'ExitPlanMode':
      return { title: 'Start working on its plan', detail: clip(i.plan, 800), note: '' };
    default: {
      let detail = '';
      try {
        detail = clip(JSON.stringify(i, null, 2), 500);
      } catch {
        detail = '';
      }
      const label = typeof name === 'string' && name.startsWith('mcp__') ? describeTool(name, i).replace(/^Using /, 'Use ') : `Use ${name || 'a tool'}`;
      return { title: label, detail, note: '' };
    }
  }
}

const STATE = { completed: 'done', in_progress: 'now', pending: 'todo' };

// Reads Claude's own to-do list from TodoWrite, or from the newer TaskCreate / TaskUpdate tools.
export function applyPlanTool(plan, name, input = {}, response = null) {
  const list = Array.isArray(plan) ? plan.map((p) => ({ ...p })) : [];
  if (name === 'TodoWrite' && Array.isArray(input.todos)) {
    return input.todos.map((t, idx) => ({ id: String(idx + 1), text: truncate(t.content || t.activeForm || '', 140), state: STATE[t.status] || 'todo' }));
  }
  if (name === 'TaskCreate' && input.subject) {
    if (response) {
      const match = JSON.stringify(response).match(/#\s?(\d+)/);
      const item = [...list].reverse().find((p) => p.text === truncate(input.subject, 140) && !p.id);
      if (match && item) item.id = match[1];
      return list;
    }
    list.push({ id: null, text: truncate(input.subject, 140), state: 'todo' });
    return list;
  }
  if (name === 'TaskUpdate' && input.taskId) {
    const item = list.find((p) => p.id === String(input.taskId));
    if (item) {
      if (input.status === 'deleted') return list.filter((p) => p !== item);
      if (input.status) item.state = STATE[input.status] || item.state;
      if (input.subject) item.text = truncate(input.subject, 140);
    }
    return list;
  }
  return list;
}

export function fileTouched(name, input = {}) {
  if (['Edit', 'MultiEdit', 'Write'].includes(name)) return input.file_path || null;
  if (name === 'NotebookEdit') return input.notebook_path || null;
  return null;
}
