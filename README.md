# Kroog

Kroog is one browser tab for all your Claude Code chats: in VS Code, Cursor or the Terminal.

- **See what every chat is doing.** One week at a time, project by project. Hover over a chat for a one-line summary.
- **Talk to them from one place.** Open a chat to read its real conversation, as Claude Code shows it. Type a message and it goes straight into that chat in VS Code, even if the chat is idle. You can also allow or deny what a chat wants to do.
- **Connect chats.** Use the link key to merge what one or more chats worked out into another chat. It can also start a new chat, which then opens in VS Code.
- **A second brain.** Your `CLAUDE.md` files, rules, skills and Claude Code's own memory become searchable, in Kroog and from inside every Claude Code chat.

It runs only on your Mac, with no editor plugin. Kroog was called Crew while it was a draft.

---

## What you need

- A Mac with the Claude Code extension working in VS Code or Cursor, version 2.1.224 or newer. That version is the first where Kroog can message chats. To check, type `/status` in a chat and look for a "Peer address" line.
- Node.js 20 or newer. Check with `node -v`; get it from [nodejs.org](https://nodejs.org) if needed.
- Optional: [Ollama](https://ollama.com), for searching the second brain by meaning (`ollama pull embeddinggemma`).

## Install

```
git clone https://github.com/ishanyash/kroog.git ~/kroog
cd ~/kroog
node bin/kroog.js demo      # try it with made-up chats; changes nothing
node bin/kroog.js link      # connect Claude Code to Kroog (backs up ~/.claude/settings.json first)
node bin/kroog.js start     # run it; opens http://127.0.0.1:4877
```

Keep the Terminal window with `start` open while you use Kroog. To update later, run `git pull` in `~/kroog`, then `start` again.

**Coming from Crew?** Just run `start` (or `link`). Kroog moves `~/.crew` to `~/.kroog` and repoints Claude Code's hooks itself.

**Something not working?** Run `node bin/kroog.js doctor`. It checks everything Kroog needs and says what to fix.

## Using it

### The week view

- Each column is a day, Monday to Sunday. Move between weeks with ‹ and › at the top, or with the ← and → keys.
- Each project is a band, and each box is a chat, placed on the day it started.
- A dashed line runs from a chat to the last day it was used.
- Lines between chats show where they came from:
  - a solid line is a brief
  - a dotted line is project memory
  - a line ending in a ring is a branch
- Hover over a chat for its one-line summary.

### The four states

Every chat is in one of four states:
- **working**: busy right now
- **needs you**: waiting for an answer (a permission, or a question)
- **open**: finished its turn and still open in VS Code, Cursor or a terminal, waiting for you. A small dot marks open chats.
- **done**: not open anywhere. You can still carry it on, from Kroog or from VS Code.

Kroog reads Claude Code's own registry of open chats, so it knows which chats are open from the moment it starts. Chats with no messages in them (panels that were opened and closed) are hidden.

### A chat

Click a chat to open its panel.
- **At the top:** its title, where it is ("open in VS Code", or "not open now"), its project, and a one-line summary.
- **In the middle:** the real conversation, read from Claude Code's own history: your messages, Claude's replies, and each step on one line. When it asks to edit a file or run a command, allow and deny show up here.
- **At the bottom:** the message box. Under it, Kroog says where your message goes:
  - **open chat:** straight in. If it's working, it reads your message after its current step; if it's idle, it starts on it right away, in VS Code. Your message shows as "sent" until the chat has it.
  - **done chat:** Kroog carries the same chat on, one turn at a time, with Claude Code on your Mac. VS Code can open it again afterwards. Permission questions show up in the panel.
- **open in VS Code:** always there, at the top. For an open chat it switches to its tab; for a done chat it resumes it there.
- **More (⋯):** hand off from this chat, start a branch here, summarise again, hide.

In VS Code, a message from Kroog arrives as a message from another session. That's how Claude Code labels these messages, so a message from Kroog can never approve anything for you.

### Connect chats (link key)

1. Click the small link key on a chat. Add more chats with their keys.
2. Click the chat that should receive them, or **+ new chat** in a project.
3. Choose what to carry over (last reply, plan, files, notes), or press **write it with ai** for one merged brief you can edit.
4. Send it.
   - **To a live chat:** the brief goes straight in.
   - **To a new chat:** Kroog starts it in the project folder with the brief. It answers with a short plan, then opens in VS Code, where you carry on. Kroog keeps showing it.

### Brain

The **brain** page is a map of what Claude Code knows about your work, with your recent chats on it. Files and chats sit in their project's cluster and are linked when they are about the same things. Search highlights the matching nodes; click a node to read it, open it in VS Code, or add it to a brief. The results also appear as a list under the map.

It indexes:
- your `~/.claude/CLAUDE.md` and rules, skills, agents, commands and plans
- Claude Code's own memory for each project (`~/.claude/projects/<project>/memory/`)
- each project's `CLAUDE.md` and `.claude` docs
- your Kroog notes

It never reads settings, keys or chat transcripts. With Ollama running, it searches by meaning; without it, by keyword. Press **add to claude code** to add the `kroog-brain` tool to Claude Code; new chats can then look things up in your brain on their own. "Use in a brief" adds a result to a handoff.

### The AI helper

The AI helper writes the one-line summaries, merged briefs and library notes. By default it uses Claude Code with Haiku, on your Claude plan. Each call takes about 3 seconds, never shows up as a chat, and counts toward your plan's usage like any chat. Instead, you can pick your own Anthropic API key or a local Ollama model in **Setup**, and set a daily cap.

## Commands

| Command | What it does |
| --- | --- |
| `node bin/kroog.js demo` | Try it with made-up chats. Changes nothing. |
| `node bin/kroog.js link` | Connect Claude Code to Kroog. |
| `node bin/kroog.js start` | Run Kroog. Also brings in your chats from the last 7 days (`--no-import` to skip). |
| `node bin/kroog.js doctor` | Check everything and say what to fix. |
| `node bin/kroog.js status` | Show what is linked and where Kroog keeps its files. |
| `node bin/kroog.js unlink` | Remove Kroog's hooks. |
| `node bin/kroog.js mcp` | The `kroog-brain` tool. Claude Code starts this itself. |

Add `--port 4878` to `link` and `start` to use another port.

## Where things live

| What | Where |
| --- | --- |
| The app | wherever you cloned it, for example `~/kroog` |
| Kroog's data: chats for the last 14 days, notes, briefs, chat inboxes, the brain index, settings, token, hook script, backups | `~/.kroog` |
| The hooks | `~/.claude/settings.json` |
| The page | `http://127.0.0.1:4877`, on your Mac only |

## How it works

- **Hooks.** `link` adds hooks to Claude Code's settings. Each one runs `~/.kroog/hook.sh`, which tells Kroog what the chat is doing and where its inbox is. When Kroog isn't running, the hook gives up in a moment and changes nothing.
- **The registry.** Claude Code keeps a list of its running chats in `~/.claude/sessions/` (id, folder, busy or idle, inbox). Kroog reads it every few seconds. That's how a chat opened before Kroog started still shows as open.
- **Inboxes.** Since Claude Code 2.1.224, every chat has a private inbox, a socket only your user can reach. Kroog sends your messages and briefs there.
- **Conversations.** The conversation shown in a chat's panel comes from Claude Code's own history file for that chat.
- **Chats Kroog starts.** These run Claude Code on your Mac (`claude -p`), with your usual login, settings and permission rules. If `claude` isn't installed for the Terminal, Kroog uses the copy inside the VS Code extension.

## Safety

- Kroog only listens on `127.0.0.1`. Other computers can't reach it.
- Hooks must carry a secret token, and other websites can't send commands to Kroog or show it inside their pages.
- Kroog never edits your code. A message from Kroog can't approve permissions; Claude Code always asks you.
- The AI helper's input goes to Anthropic, like any Claude Code chat. With Ollama it stays on your Mac. The brain index stays on your Mac.

## Limits

- Messaging chats and seeing which are open need Claude Code 2.1.224 or newer.
- **open in VS Code** for a chat Kroog started needs VS Code to have that project folder open. Kroog opens the folder first.
- While Kroog holds a permission question, VS Code shows that chat as busy.
- Claude Code's history format and hook behaviour can change between versions.

## Credits

- The font is IBM Plex Mono, under the SIL Open Font License (`public/fonts/LICENSE-IBM-Plex.txt`).
- The fish come from the [ascii-sharks](https://github.com/stackedlol/ascii-sharks) ocean (MIT License, `public/water-LICENSE.txt`), as set up for ishanyash.com, with the sharks left out.
