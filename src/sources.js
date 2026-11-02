// Works out which app a chat runs in, from what the hook relay passes along:
//   entry  = CLAUDE_CODE_ENTRYPOINT ("claude-vscode" for the editor panel, "cli" for a terminal,
//            "claude-desktop" for the Claude app). Not a documented variable, so Kroog only
//            uses it as a hint.
//   bundle = __CFBundleIdentifier, set by macOS for apps opened from the Dock or Finder.
//   term   = TERM_PROGRAM, set by terminals ("vscode" inside VS Code and Cursor terminals).

const BUNDLES = [
  { test: (b) => b.includes('vscodeinsiders'), app: 'VS Code Insiders', kind: 'ide', editor: 'vscode-insiders' },
  { test: (b) => b === 'com.microsoft.vscode' || b.includes('vscode'), app: 'VS Code', kind: 'ide', editor: 'vscode' },
  { test: (b) => b.includes('todesktop') || b.includes('cursor'), app: 'Cursor', kind: 'ide', editor: 'cursor' },
  { test: (b) => b.includes('windsurf') || b.includes('exafunction'), app: 'Windsurf', kind: 'ide', editor: 'windsurf' },
  { test: (b) => b.includes('jetbrains'), app: 'JetBrains', kind: 'ide', editor: null },
  { test: (b) => b.includes('zed'), app: 'Zed', kind: 'ide', editor: null },
  { test: (b) => b.includes('claudefordesktop') || b.includes('com.anthropic.claude'), app: 'Desktop app', kind: 'desktop', editor: null },
  { test: (b) => b === 'com.apple.terminal', app: 'Terminal', kind: 'terminal', editor: null },
  { test: (b) => b.includes('iterm'), app: 'iTerm', kind: 'terminal', editor: null },
  { test: (b) => b.includes('warp'), app: 'Warp', kind: 'terminal', editor: null },
  { test: (b) => b.includes('ghostty'), app: 'Ghostty', kind: 'terminal', editor: null },
  { test: (b) => b.includes('kitty') || b.includes('alacritty') || b.includes('wezterm'), app: 'Terminal', kind: 'terminal', editor: null },
];

export function detectApp({ entry = '', bundle = '', term = '' } = {}) {
  const e = String(entry || '').trim();
  const b = String(bundle || '').trim().toLowerCase();
  const t = String(term || '').trim().toLowerCase();

  let found = b ? BUNDLES.find((x) => x.test(b)) : null;

  if (!found) {
    if (e === 'claude-desktop') found = { app: 'Desktop app', kind: 'desktop', editor: null };
    else if (e === 'claude-vscode' || t === 'vscode') found = { app: 'VS Code', kind: 'ide', editor: 'vscode' };
    else if (e.startsWith('sdk')) found = { app: 'Script', kind: 'sdk', editor: null };
    else if (e === 'cli') found = { app: 'Terminal', kind: 'terminal', editor: null };
    else found = { app: 'Unknown app', kind: 'unknown', editor: null };
  }

  // A chat started from the Claude app counts as the Desktop app even inside an editor.
  if (e === 'claude-desktop') found = { app: 'Desktop app', kind: 'desktop', editor: null };

  // Which part of the app: the Claude Code panel, or a terminal inside the editor.
  // No entry hint but an editor bundle: most likely the Claude Code panel.
  const inPanel = e === 'claude-vscode' || (e === '' && found.kind === 'ide' && t !== 'vscode');
  let place = found.app;
  if (found.kind === 'ide' && e === 'cli') place = `${found.app} terminal`;

  return {
    app: found.app,
    kind: found.kind,
    place,
    // Deep links only work for chats in the editor's Claude Code panel.
    editor: inPanel ? found.editor || 'vscode' : null,
    surface: inPanel ? 'panel' : e === 'cli' ? 'terminal' : e || 'unknown',
  };
}

// Scripts (`claude -p`, the Agent SDK) are never shown; the rest unless "only editor chats" is on.
export function isVisible(kind, ideOnly) {
  if (kind === 'sdk') return false;
  if (!ideOnly) return true;
  return kind === 'ide' || kind === 'kroog' || kind === 'unknown';
}
