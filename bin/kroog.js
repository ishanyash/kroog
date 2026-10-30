#!/usr/bin/env node
// Kroog (working name): a local board for the Claude Code chats in your editor.
//   node bin/kroog.js demo     try it with fake chats (changes nothing on your Mac)
//   node bin/kroog.js link     connect Claude Code to Kroog (adds hooks to ~/.claude/settings.json)
//   node bin/kroog.js start    run Kroog for your real chats
//   node bin/kroog.js unlink   remove Kroog's hooks again
//   node bin/kroog.js status   show what's linked and where things live
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import { claudeDir, migrateFromCrew, ensureHome, paths, loadSettings, saveSettings, readToken, readApiKey, writeApiKey, removeApiKey, DEFAULT_SETTINGS } from '../src/config.js';
import { link, unlink, linkStatus, refreshScript, hasOldCrewHooks } from '../src/link.js';
import { Inbox } from '../src/inbox.js';
import { doctor, printDoctor } from '../src/doctor.js';
import { Presence } from '../src/presence.js';
import { retitle } from '../src/titles.js';
import { SecondBrain } from '../src/memory/index.js';
import { runMcp, mcpAddArgs } from '../src/mcp.js';
import { cleanEnv } from '../src/claude-cli.js';
import { execFile, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import nodePath from 'node:path';
import { Store } from '../src/store.js';
import { Engine } from '../src/engine.js';
import { NoteWriter } from '../src/notes.js';
import { createServer } from '../src/server.js';
import { startDemo } from '../src/demo.js';
import { importRecent } from '../src/history.js';
import { Runner } from '../src/runner.js';
import { AiHelper } from '../src/ai.js';

const VERSION = '0.8.0';
const args = process.argv.slice(2);
const command = args.find((a) => !a.startsWith('-')) || 'help';
const flag = (name) => args.includes(`--${name}`);
const option = (name) => {
  const i = args.indexOf(`--${name}`);
  return i !== -1 ? args[i + 1] : undefined;
};

function openBrowser(url) {
  const opener = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'cmd' : 'xdg-open';
  const opts = process.platform === 'win32' ? ['/c', 'start', '', url] : [url];
  try {
    spawn(opener, opts, { stdio: 'ignore', detached: true }).unref();
  } catch {
    // Opening the browser is a convenience only.
  }
}

function checkNode() {
  const major = Number(process.versions.node.split('.')[0]);
  if (major < 20) {
    console.error(`Kroog needs Node 20 or newer. You have ${process.versions.node}. Install it from https://nodejs.org or with: brew install node`);
    process.exit(1);
  }
}

function printLinkResult(result) {
  console.log('Linked. Claude Code will now report your chats to Kroog.');
  console.log(`  Hooks added to: ${result.settingsPath}`);
  console.log(`  Backup of the old file: ${result.backupPath}`);
  console.log(`  Relay script: ${result.scriptPath}`);
  console.log('Start a new chat in VS Code or Cursor (or reload the window) and it appears on the Board.');
}

async function start({ demo }) {
  checkNode();
  const moved = demo ? false : migrateFromCrew();
  const p = ensureHome();
  let settings = loadSettings();
  const port = Number(option('port') || settings.port || DEFAULT_SETTINGS.port);
  if (moved) console.log('Crew is now called Kroog. Moved your data from ~/.crew to ~/.kroog.');
  if (!demo && hasOldCrewHooks()) {
    try {
      const r = link({ port });
      console.log(`Pointed Claude Code's hooks at the new ~/.kroog/hook.sh (backup: ${r.backupPath}).`);
    } catch (error) {
      console.log(`Could not update the hooks: ${error.message} Run: node bin/kroog.js link`);
    }
  }
  const token = readToken();
  const store = new Store({ file: demo ? null : p.state });
  const notes = new NoteWriter({ store, getKey: () => (demo ? null : readApiKey()), getSettings: () => settings });
  // In the demo, an empty registry: no real chat is open, so "continue here" runs pretend turns.
  const presence = new Presence({ dir: demo ? fs.mkdtempSync(nodePath.join(os.tmpdir(), 'kroog-demo-')) : nodePath.join(claudeDir(), 'sessions') });
  const engine = new Engine({ store, getSettings: () => settings, notes, inbox: new Inbox({ file: demo ? null : p.inboxes }), presence });
  // Readable titles for chats whose title was made from editor tags by older versions.
  if (!demo) for (const s of Object.values(store.data.sessions)) retitle(s);
  if (!demo) {
    try { if (refreshScript({ port })) console.log('Updated the hook relay script for this version of Kroog.'); } catch { /* not linked */ }
  }
  const runner = new Runner({ store, engine, getSettings: () => settings, demo });
  const ai = new AiHelper({ store, engine, runner, getSettings: () => settings, getKey: () => (demo ? null : readApiKey()), demo });
  notes.ai = ai;
  // The second brain: your ~/.claude files, project .claude docs and Kroog notes, searchable.
  const brain = new SecondBrain({
    dir: nodePath.join(p.home, 'brain'),
    claudeDir: claudeDir(),
    getSettings: () => settings,
    getProjects: () => [...new Set(Object.values(store.data.sessions).map((x) => x.cwd).filter(Boolean))],
    getNotes: () => store.data.notes,
    embedder: demo ? null : undefined,
  });
  let brainConnected = null;
  const detecting = runner.detect().catch(() => null);

  const info = () => ({
    mode: demo ? 'demo' : 'live',
    version: VERSION,
    port,
    link: linkStatus(),
    apiKey: demo ? false : Boolean(readApiKey()),
    notesError: notes.lastError,
    claude: { ...runner.status(), registry: presence.available, open: presence.all().length },
    ai: ai.status(),
    brain: brain.status(),
    brainConnected,
    lastEvents: store.data.lastEvents,
    paths: { home: p.home, settings: p.claudeSettings },
  });

  const updateSettings = (patch) => {
    const allowed = ['ideOnly', 'permissionHoldSeconds', 'driveMinutes', 'notesEnabled', 'defaultEditor', 'claudePath', 'kroogPermissionMode', 'aiProvider', 'aiSummaries', 'aiDailyLimit', 'ollamaModel', 'ollamaUrl'];
    const next = { ...settings };
    for (const key of allowed) if (key in patch) next[key] = patch[key];
    next.permissionHoldSeconds = Math.max(0, Math.min(Number(next.permissionHoldSeconds) || 0, 540));
    next.driveMinutes = Math.max(1, Math.min(Number(next.driveMinutes) || 5, 9));
    next.ideOnly = Boolean(next.ideOnly);
    if (!['default', 'acceptEdits'].includes(next.kroogPermissionMode)) next.kroogPermissionMode = 'default';
    if (!['auto', 'claude', 'api', 'ollama', 'off'].includes(next.aiProvider)) next.aiProvider = 'auto';
    if (!['finish', 'hover', 'off'].includes(next.aiSummaries)) next.aiSummaries = 'finish';
    next.aiDailyLimit = Math.max(10, Math.min(Number(next.aiDailyLimit) || 200, 2000));
    next.claudePath = String(next.claudePath || '').trim();
    next.ollamaModel = String(next.ollamaModel || 'llama3.2').trim().slice(0, 80);
    if (!/^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?\/?$/.test(String(next.ollamaUrl || ''))) next.ollamaUrl = 'http://127.0.0.1:11434';
    next.notesEnabled = Boolean(next.notesEnabled);
    settings = next;
    if (!demo) saveSettings(settings);
    return settings;
  };

  const actions = {
    link: async () => {
      if (demo) throw new Error('Demo mode never touches your Claude settings. Quit the demo and run: node bin/kroog.js link');
      const r = link({ port });
      return { message: `Linked. A backup of your old settings is at ${r.backupPath}` };
    },
    unlink: async () => {
      if (demo) throw new Error('Demo mode never touches your Claude settings.');
      const r = unlink();
      return { message: r.changed ? 'Unlinked. Your chats no longer report to Kroog.' : 'Kroog was not linked.' };
    },
    apikey: async ({ key }) => {
      if (demo) throw new Error('Notes are off in demo mode.');
      const k = String(key || '').trim();
      if (!/^sk-ant-[A-Za-z0-9_-]{20,}$/.test(k)) throw new Error('That does not look like an Anthropic API key. It starts with sk-ant-.');
      writeApiKey(k);
      return { message: 'Saved to ~/.kroog/.env on this Mac only.' };
    },
    import: async ({ days } = {}) => {
      if (demo) throw new Error('Demo mode shows fake chats only. Run node bin/kroog.js start to import your real chats.');
      const d = Math.max(1, Math.min(Number(days) || 7, 14));
      const r = await importRecent(store, { days: d, limit: 60 });
      if (!r.found) return { message: `No chats found from the last ${d} days in Claude Code's history.` };
      if (!r.added) return { message: `Nothing new. The ${r.found} chat${r.found === 1 ? '' : 's'} from the last ${d} days ${r.found === 1 ? 'is' : 'are'} already here.` };
      return { message: `Imported ${r.added} chat${r.added === 1 ? '' : 's'} from the last ${d} days.` };
    },
    run: async ({ cwd, prompt, permissionMode } = {}) => {
      await detecting;
      const folder = String(cwd || '');
      if (!folder) throw new Error('Pick a project folder.');
      const r = runner.run({ mode: 'new', cwd: folder, prompt, permissionMode: permissionMode === 'acceptEdits' ? 'acceptEdits' : undefined });
      if (!r.ok) throw new Error(r.error);
      return { id: r.id, message: 'Started. It runs here in Kroog.' };
    },
    'to-editor': async ({ id } = {}) => {
      const r = runner.toEditor(String(id || ''));
      if (!r.ok) throw new Error(r.error);
      return { url: r.url };
    },
    'claude-check': async () => {
      const st = await runner.detect();
      return { message: st.found ? `Found Claude Code ${st.version}.` : 'Kroog could not find Claude Code on this Mac.' };
    },
    summarize: async ({ id, force } = {}) => {
      const r = ai.summarize(String(id || ''), { force: Boolean(force) });
      if (!r.ok) throw new Error(r.error);
      return r;
    },
    'write-brief': async ({ sources = [], notes: noteIds = [], goal = '' } = {}) => {
      const text = await ai.writeBrief({ sources: (Array.isArray(sources) ? sources : []).map(String), notes: (Array.isArray(noteIds) ? noteIds : []).map(String), goal: String(goal || '').slice(0, 1000) });
      if (!text) throw new Error('The AI helper returned nothing. Try again.');
      return { text };
    },
    'brain-search': async ({ query = '', kinds = null, project } = {}) => ({ results: await brain.search(String(query).slice(0, 500), { kinds: Array.isArray(kinds) ? kinds : null, project }) }),
    'brain-recent': async () => ({ results: brain.recent(10) }),
    'brain-map': async () => {
      const chats = Object.values(store.data.sessions)
        .filter((x) => !x.archived && (x.lastPrompt || x.lastReply))
        .sort((a, b) => (b.lastAt || 0) - (a.lastAt || 0)).slice(0, 200)
        .map((x) => ({ id: x.id, title: x.title, project: x.project, cwd: x.cwd, gist: x.ai ? x.ai.gist : '', keywords: x.ai ? x.ai.keywords : [], lastReply: x.lastReply, lastPrompt: x.lastPrompt, status: x.status, lastAt: x.lastAt, live: engine.isLive(x), inputs: (x.inputs || []).map((i) => ({ kind: i.kind, from: i.from || [] })) }));
      return { map: await brain.map(chats) };
    },
    'brain-read': async ({ path: file } = {}) => ({ text: brain.readFile(String(file || '')) }),
    'brain-build': async () => {
      brain.build().catch(() => {});
      return { message: 'Updating the brain. It takes a few seconds, longer the first time.' };
    },
    'brain-connect': async () => {
      await detecting;
      if (!runner.available()) throw new Error('Kroog could not find Claude Code on this Mac. See setup.');
      const bin = runner.cli.path;
      const script = fileURLToPath(import.meta.url);
      const run = (args) => new Promise((resolve) => execFile(bin, args, { env: cleanEnv(), timeout: 30000 }, (error, stdout, stderr) => resolve({ error, out: `${stdout}${stderr}` })));
      await run(['mcp', 'remove', '--scope', 'user', 'kroog-brain']);
      const r = await run(mcpAddArgs(process.execPath, script));
      if (r.error) throw new Error(`Claude Code said: ${r.out.trim().slice(0, 200) || r.error.message}`);
      brainConnected = true;
      return { message: 'Connected. New Claude Code chats can now search your brain (the kroog-brain tool).' };
    },
    'apikey-remove': async () => {
      removeApiKey();
      return { message: 'API key removed. Notes are off.' };
    },
  };

  const { server, closeClients } = createServer({ port, token, engine, store, mode: demo ? 'demo' : 'live', getSettings: () => settings, updateSettings, info, actions });

  server.on('error', (error) => {
    if (error.code === 'EADDRINUSE') {
      whoIsOn(port).then((who) => {
        const l = listenerOnPort(port);
        if (who) console.error(`${who.name} ${who.version} is already running on port ${port}${(who.pid || (l && l.pid)) ? ` (process ${who.pid || l.pid})` : ''}.`);
        else if (l && looksLikeOurs(l.command)) console.error(`An older Crew or Kroog holds port ${port} but is not answering (process ${l.pid}: ${l.command}).`);
        else if (l) console.error(`Port ${port} is used by another program (process ${l.pid}: ${l.command}).`);
        else console.error(`Port ${port} is busy, and Kroog could not see by what.`);
        console.error(`To stop it and start this version: node bin/kroog.js stop && node bin/kroog.js start`);
        console.error('Or run on another port with --port 4878 (then run link again with the same --port).');
        process.exit(1);
      });
      return;
    }
    console.error(error.message);
    process.exit(1);
  });

  server.listen(port, '127.0.0.1', () => {
    const url = `http://127.0.0.1:${port}`;
    console.log('');
    console.log(demo ? `Kroog demo is running at ${url}` : `Kroog is running at ${url}`);
    console.log('Keep this window open. Press Ctrl+C to stop.');
    if (demo) {
      console.log('These are fake chats. Nothing on your Mac or in Claude Code is touched.');
    } else {
      const status = linkStatus();
      if (!status.linked) console.log('Not linked to Claude Code yet. Run: node bin/kroog.js link (or use the Setup page).');
      else if (status.scriptPort && status.scriptPort !== port) console.log(`Linked to port ${status.scriptPort}, but running on ${port}. Run link again with --port ${port}.`);
      else console.log('Linked to Claude Code. New events from your editor chats appear on the Board.');
      if (!flag('no-import')) {
        importRecent(store, { days: 7, limit: 40 })
          .then((r) => {
            for (const s of Object.values(store.data.sessions)) retitle(s);
            engine.syncPresence();
            if (r.added) console.log(`Imported ${r.added} recent chat${r.added === 1 ? '' : 's'} from Claude Code history (last 7 days).`);
            else if (!r.found) console.log('No chats from the last 7 days in Claude Code history.');
          })
          .catch((e) => console.log(`Could not read Claude Code history: ${e.message}`));
      }
    }
    console.log('');
    if (!demo) {
      detecting.then((st) => {
        if (st && st.found) console.log(`Claude Code ${st.version} found${st.from === 'vscode' || st.from === 'cursor' ? ` (the copy inside ${st.from === 'cursor' ? 'Cursor' : 'VS Code'})` : ''}. Kroog can run chats and use Haiku on your plan.`);
        else console.log('Claude Code was not found, so Kroog cannot run chats itself. Set its path in setup.');
      });
    }
    if (!flag('no-open')) openBrowser(url);
  });

  const stopDemo = demo ? startDemo({ engine, store }) : null;
  brain.start();
  // Every minute, drop inboxes of chats that have closed, so "live" stays true.
  // Claude Code's registry of open chats: read now and every few seconds.
  engine.syncPresence();
  if (!demo) setInterval(() => { try { engine.syncPresence(); } catch { /* registry hiccup */ } }, 4000).unref();
  const probeInboxes = async () => {
    for (const sid of await engine.inbox.probeAll()) {
      const s = store.session(sid);
      if (s) store.emit('session', s);
    }
  };
  probeInboxes();
  setInterval(probeInboxes, 60000).unref();
  if (!demo) {
    // Is the kroog-brain tool already added to Claude Code?
    detecting.then(() => {
      if (!runner.available()) return;
      execFile(runner.cli.path, ['mcp', 'get', 'kroog-brain'], { env: cleanEnv(), timeout: 20000 }, (error) => { brainConnected = !error; });
    });
  }

  const shutdown = () => {
    if (stopDemo) stopDemo();
    runner.stopAll();
    brain.stop();
    engine.releaseAll();
    store.saveNow();
    closeClients();
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 800).unref();
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

// What is listening on Kroog's port: an older Kroog or Crew, or something else.
async function whoIsOn(port) {
  let info = null;
  try {
    const r = await fetch(`http://127.0.0.1:${port}/api/state`, { signal: AbortSignal.timeout(1500) });
    if (r.ok) info = (await r.json()).info || null;
  } catch { /* not Kroog, or not answering */ }
  if (!info || !info.version) return null;
  const name = String((info.paths && info.paths.home) || '').includes('.crew') ? 'Crew' : 'Kroog';
  return { name, version: info.version, pid: pidOnPort(port) };
}

function pidOnPort(port) {
  const l = listenerOnPort(port);
  return l ? l.pid : null;
}

// The process listening on the port, with its command line (macOS and Linux).
function listenerOnPort(port) {
  let out = '';
  try {
    out = execFileSync('lsof', ['-nP', `-iTCP:${port}`, '-sTCP:LISTEN', '-Fpc'], { encoding: 'utf8', timeout: 5000 });
  } catch {
    return null;
  }
  const pid = Number((out.match(/^p(\d+)/m) || [])[1]);
  if (!Number.isInteger(pid) || pid <= 0) return null;
  let command = (out.match(/^c(.+)/m) || [])[1] || '';
  try { command = execFileSync('ps', ['-p', String(pid), '-o', 'command='], { encoding: 'utf8', timeout: 5000 }).trim() || command; } catch { /* keep the short name */ }
  return { pid, command };
}

const looksLikeOurs = (command) => /(crew|kroog)\.js|[\\/]\.?(crew|kroog)[\\/]|\bcrew\b|\bkroog\b/i.test(String(command || ''));

async function endProcess(pid, label) {
  const alive = () => { try { process.kill(pid, 0); return true; } catch { return false; } };
  try { process.kill(pid, 'SIGTERM'); } catch { /* already gone */ }
  let until = Date.now() + 4000;
  while (alive() && Date.now() < until) await new Promise((r) => setTimeout(r, 200));
  if (alive()) {
    // Hung: no more waiting.
    try { process.kill(pid, 'SIGKILL'); } catch { /* gone */ }
    until = Date.now() + 2000;
    while (alive() && Date.now() < until) await new Promise((r) => setTimeout(r, 100));
  }
  console.log(alive() ? `Could not stop ${label} (process ${pid}). Try: kill -9 ${pid}` : `Stopped ${label} (process ${pid}).`);
}

async function stop() {
  const settings = loadSettings();
  const port = Number(option('port') || settings.port || DEFAULT_SETTINGS.port);
  const who = await whoIsOn(port);
  const l = listenerOnPort(port);
  if (who && (who.pid || (l && l.pid))) {
    await endProcess(who.pid || l.pid, `${who.name} ${who.version}`);
    return;
  }
  if (!l) {
    console.log(`Nothing is listening on port ${port}. Kroog is not running.`);
    return;
  }
  if (looksLikeOurs(l.command) || flag('force')) {
    await endProcess(l.pid, looksLikeOurs(l.command) ? 'an older Crew or Kroog that was not answering' : `the process on port ${port}`);
    return;
  }
  console.log(`Port ${port} is used by another program, so Kroog left it alone:`);
  console.log(`  process ${l.pid}: ${l.command}`);
  console.log(`To stop it anyway: node bin/kroog.js stop --force   (or: kill ${l.pid})`);
  console.log('Or run Kroog on another port: node bin/kroog.js link --port 4878 && node bin/kroog.js start --port 4878');
}

function status() {
  const p = paths();
  const s = linkStatus();
  const settings = loadSettings();
  console.log(`Kroog ${VERSION}`);
  console.log(`  Linked to Claude Code: ${s.linked ? 'yes' : s.partial ? 'partly (run link again)' : 'no'}`);
  if (s.error) console.log(`  Problem: ${s.error}`);
  console.log(`  Claude settings file: ${s.settingsPath}`);
  console.log(`  Kroog folder: ${p.home}`);
  console.log(`  Port: ${settings.port}${s.scriptPort && s.scriptPort !== settings.port ? ` (hooks point at ${s.scriptPort})` : ''}`);
  console.log(`  API key for notes: ${readApiKey() ? 'saved' : 'not set'}`);
}

function help() {
  console.log(`Kroog ${VERSION}

  node bin/kroog.js demo      Try it with fake chats. Changes nothing.
  node bin/kroog.js link      Connect Claude Code to Kroog (backs up ~/.claude/settings.json first).
  node bin/kroog.js start     Run Kroog for your real chats, then open http://127.0.0.1:${DEFAULT_SETTINGS.port}
  node bin/kroog.js unlink    Remove Kroog's hooks from ~/.claude/settings.json.
  node bin/kroog.js status    Show what's linked and where Kroog keeps its files.
  node bin/kroog.js stop      Stop the Kroog (or old Crew) that is running.
  node bin/kroog.js doctor    Check everything Kroog needs, and say what to fix.

Options: --port 4878 (use the same port for link and start), --no-open (don't open the browser), --no-import (don't bring in chats from the last 7 days)`);
}

try {
  if (['link', 'unlink', 'status', 'set-key'].includes(command) && migrateFromCrew()) console.log('Crew is now called Kroog. Moved your data from ~/.crew to ~/.kroog.');
  switch (command) {
    case 'start':
      await start({ demo: false });
      break;
    case 'demo':
      await start({ demo: true });
      break;
    case 'link': {
      checkNode();
      const settings = loadSettings();
      const port = Number(option('port') || settings.port || DEFAULT_SETTINGS.port);
      if (port !== settings.port) saveSettings({ ...settings, port });
      printLinkResult(link({ port }));
      break;
    }
    case 'unlink': {
      const r = unlink();
      console.log(r.changed ? `Unlinked. Kroog's hooks were removed from ${r.settingsPath}. Backup: ${r.backupPath}` : 'Kroog was not linked. Nothing changed.');
      break;
    }
    case 'status':
      status();
      break;
    case 'mcp':
      // Started by Claude Code as the kroog-brain tool. Only protocol messages on stdout.
      await runMcp({ dir: nodePath.join(paths().home, 'brain'), claudeDir: claudeDir(), getSettings: loadSettings, version: VERSION });
      break;
    case 'stop':
      await stop();
      break;
    case 'doctor':
      printDoctor(await doctor({ version: VERSION }));
      break;
    case 'set-key': {
      const key = option('key') || args[args.indexOf('set-key') + 1];
      if (!key || !/^sk-ant-/.test(key)) {
        console.log('Usage: node bin/kroog.js set-key sk-ant-...');
        break;
      }
      writeApiKey(key.trim());
      console.log('Saved to ~/.kroog/.env on this Mac only. It is never added to your shell.');
      break;
    }
    default:
      help();
  }
} catch (error) {
  console.error(error.message);
  process.exit(1);
}
