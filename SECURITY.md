# What Kroog touches, and what it never does

Kroog runs on your computer and maps the Claude Code chats on it. This page is the boundary it keeps, in plain words. `test/boundary.test.js` fails the build if the code steps outside it, and `node bin/kroog.js doctor` prints the live version of this list.

## Reads

- `~/.claude/projects/**`: Claude Code's chat transcripts and its per-project memory (`memory/`). Kroog reads transcripts to show a conversation and to count what a chat spent; it never changes them.
- `~/.claude/sessions/`: Claude Code's registry of open chats (which chats are open, busy or idle, and each one's inbox address).
- `~/.claude/settings.json`: to see its own hooks.
- `~/.claude/CLAUDE.md`, `~/.claude/rules`, `~/.claude/skills`, `~/.claude/agents`, `~/.claude/commands`, `~/.claude/plans`, and each project's `CLAUDE.md`, `CLAUDE.local.md` and `.claude/` docs: markdown only, for the brain.
- `~/.kroog/`: its own data.

Never: `~/.claude/.credentials.json`, the macOS Keychain, any `.env`, your project's source files (the brain indexes markdown under `.claude/` only), other apps' data.

## Writes

- `~/.kroog/`: chats for the last 14 days, notes, briefs, inbox addresses, usage readings for 30 days, the brain index, settings, its token (mode 600), the hook script, and backups of `~/.claude/settings.json`.
- `~/.claude/settings.json`: hook entries that run `~/.kroog/hook.sh`, after a backup. `node bin/kroog.js unlink` removes them.
- Claude Code's plugin list: the Kroog mod at the user scope, installed from the `mod/` folder of this repository. `unlink` removes it.
- The clipboard, when you ask for context to be copied.
- Nothing in any project folder.

## Network

- Kroog listens on `127.0.0.1` only. Hooks and the mod must carry Kroog's token; pages must come from `127.0.0.1` or `localhost` on Kroog's port; the page cannot be framed; the API refuses other origins.
- Outbound, only: `api.anthropic.com` when you add your own API key for the AI helper; Ollama at `127.0.0.1:11434` when you pick it; and Claude Code itself (`claude -p`, with your login and plan) for the AI helper. The mod talks to Kroog at `127.0.0.1` and nowhere else.
- No telemetry, no update checks, no crash reports, no analytics.

## Scope

- Claude Code chats on this computer: VS Code, Cursor, other editors, and the terminal. Claude Code's cloud sessions show up only as the local sessions they drive.
- Kroog never runs a chat and never approves anything. A message from Kroog arrives in a chat as a message from another session, which Claude Code will not treat as your approval. The context a new chat receives tells it to read and wait.
- One computer, one Kroog, one `~/.kroog`. Nothing is shared or synced.

## What someone else on your computer could do

- Read `~/.kroog`: your notes, briefs and chat summaries, and the usage readings. Keep your user account yours.
- With Kroog's token (`~/.kroog/token`, readable by your user only), send messages into your open chats through Kroog. Those messages cannot approve anything.
- A web page in your browser cannot reach Kroog's API: it checks the host and origin, and the hook and mod endpoints need the token.

## Reporting a problem

For anything sensitive, use GitHub's private reporting: the repository's **Security** tab, then **Report a vulnerability**. For everything else, open an issue. Say what Kroog read, wrote or sent that it should not have, and how to repeat it.
