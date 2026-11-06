# What Kroog touches, and what it never does

Kroog runs on your computer and maps the Claude Code chats on it. This page is the boundary it keeps, in plain words. `node bin/kroog.js doctor` prints the same list with your own paths.

## Reads

- `~/.claude/projects/**`: Claude Code's chat transcripts and its per-project memory (`memory/`). Kroog reads transcripts to show a conversation and to count what a chat cost; it never changes them.
- `~/.claude/sessions/`: Claude Code's registry of open chats: which are open, busy or idle, and each one's inbox address and inbox token.
- `~/.claude/settings.json`: to see its own hooks.
- For the brain, text files only (`.md`, `.mdx`, `.txt`): `~/.claude/CLAUDE.md`, `AGENTS.md`, `rules/`, `skills/`, `agents/`, `commands/`, `plans/` and `output-styles/`, and each project's `CLAUDE.md`, `CLAUDE.local.md`, `AGENTS.md` and `.claude/` docs.
- The VS Code and Cursor extension folders, to find which Claude Code version they carry and its command line.
- `~/.kroog/`: its own data, including its own `.env` if you add an API key.

Never: `~/.claude/.credentials.json`, the macOS Keychain, any other `.env`, your project's source files, other apps' data.

## Writes

- `~/.kroog/`: chats for the last 14 days, notes, briefs, each open chat's inbox address and token (copied from Claude Code's registry), usage readings for 30 days, the brain index (which holds the text of the files it indexed), settings, its token (mode 600), the hook script, backups of `~/.claude/settings.json`, and your API key in `.env` if you add one.
- `~/.claude/settings.json`: hook entries that run `~/.kroog/hook.sh`, after a backup.
- Claude Code's plugins: the Kroog mod at the user scope, from this folder when Kroog is a git clone, otherwise from the GitHub repository.
- Claude Code's MCP servers: the `kroog-brain` tool at the user scope, only when you press **add to claude code** on the brain page.
- `node bin/kroog.js unlink` removes the hooks, the mod and the brain tool.
- The clipboard, when you ask for context to be copied, or when a new chat did not appear in time.
- The system's temporary folder: for each AI helper call, a small folder with that call's system prompt and settings, deleted when the call ends.
- Nothing in any project folder.
- The demo (`node bin/kroog.js demo`) keeps its data in a temporary folder and writes nothing of the above.

## Network

- Kroog listens on `127.0.0.1` only. It answers only requests addressed to `127.0.0.1` or `localhost` on its port, the page cannot be framed, and actions refuse other origins.
- Everything needs Kroog's token (`~/.kroog/token`, readable by your user only). The page gets it once from the link `start` or `open` opens and keeps it as an HttpOnly, SameSite=Strict cookie; scripts can send it as `X-Kroog-Token`; hooks and the mod send it with every call. Only the app's own public files (its code, styles and fonts) load without it.
- Outbound, only:
  - `api.anthropic.com`, when you add your own API key for the AI helper;
  - Claude Code itself (`claude -p` with Haiku, with your login and plan), for the AI helper;
  - Ollama at `127.0.0.1:11434`: the brain checks every two minutes whether it is running, and uses it when it is; the AI helper uses it when you pick it;
  - GitHub, through Claude Code, only when `link` installs the mod outside a git clone.
- The mod talks to Kroog at `127.0.0.1` and nowhere else.
- No telemetry, no update checks, no crash reports, no analytics.

## Scope

- Claude Code chats on this computer: VS Code, Cursor, other editors, and the terminal. Scripts (`claude -p`, the Agent SDK) are not shown.
- Kroog never runs a chat. It sends a message into a chat only when you ask it to (a handoff), through the chat's inbox; Claude Code shows it as a message from another session and never treats it as your approval. The context it sends tells the chat to read and wait.
- Kroog approves nothing on its own. When a chat asks for a permission while a Kroog tab is open, Kroog holds the question for up to 30 seconds (Setup, "answer here first") so you can answer it there; after that, your editor asks as usual.
- One computer, one Kroog, one `~/.kroog`. Nothing is shared or synced.

## What someone else on your computer could do

- Another program running as you can do what you can: read `~/.claude` and `~/.kroog`, and with the token use Kroog (read chats, send context into them, answer a question Kroog is holding). Keep your user account yours.
- Another account on the same computer can connect to `127.0.0.1`, but gets nothing from Kroog without the token, which only your account can read.
- A web page in your browser cannot reach Kroog: it checks the host, the origin and the token.

## How this is checked

- `test/boundary.test.js` reads the source and fails if it names a host outside the allowed list, listens anywhere but `127.0.0.1`, mentions a credential path or the Keychain, or if the mod reads more than its one file or reaches more than one host. It is a check on the code's text, not a sandbox.
- `test/server.test.js` starts a real Kroog and checks that the page and the API refuse requests without the token, and that the demo leaves `~/.kroog` alone.
- `node bin/kroog.js doctor` prints this list with your paths.

## Reporting a problem

For anything sensitive, use GitHub's private reporting: the repository's **Security** tab, then **Report a vulnerability**. For everything else, open an issue. Say what Kroog read, wrote or sent that it should not have, and how to repeat it.
