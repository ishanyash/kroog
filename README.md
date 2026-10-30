# Kroog

Kroog is the map of your Claude Code chats. One browser tab shows every chat in VS Code, Cursor or the Terminal: what each one is about, what it did, which agents it used, and how the chats came from each other. Chats stay in Claude Code; Kroog is where you understand them and where you start the next one with the right context.

- **See.** One week at a time, project by project. Four states: working, needs you, open, done. Hover over a chat for a one-line summary.
- **Understand.** Open a chat for its profile: what was asked, what got done, the files, the agents and what they came back with, the notes it left, where it came from. The full conversation is one click away.
- **Connect.** Pick two or three chats with the link key and open a new Claude Code chat whose first message is the context they established.
- **Remember.** A second brain: your `CLAUDE.md` files, rules, skills and Claude Code's own memory, as a map and a search, usable from inside every Claude Code chat.

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

Keep the Terminal window with `start` open while you use Kroog. To update later, run `git pull` in `~/kroog`, then `node bin/kroog.js stop` and `start` again. If `start` says the port is busy, an older copy is still running: `stop` ends it.

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

### What moves behind the chats

The week view sits on a field of pixels that shows what is going on right now. Every step a working chat takes drops a short run of cells under its box: teal for a tool call, a hollow cell for an agent's, amber when it asked you, red when a step failed. Between steps a slow trickle keeps the stream alive. A chat that needs you breathes amber; an open chat blinks now and then; a cell travels along the line into a chat that is working from one it came from. When nothing is happening the field is a calm, sparse static, and it stands still altogether if your Mac is set to reduce motion. In **Setup** you can swap the field for the fish from ishanyash.com, or for still paper.

### Light and dark

Kroog follows your Mac, or pick light or dark at the top right. Dark is its own rendering, not an inversion: tinted paper, lighter surfaces as they rise, and a calmer accent. Both modes keep every bit of text at 4.5:1 contrast and every edge at 3:1, and `npm test` checks that.

### The four states

Every chat is in one of four states:
- **working**: busy right now
- **needs you**: waiting for an answer (a permission, or a question)
- **open**: finished its turn and still open in VS Code, Cursor or a terminal, waiting for you. A small dot marks open chats.
- **done**: not open anywhere. You can still carry it on, from Kroog or from VS Code.

Kroog reads Claude Code's own registry of open chats, so it knows which chats are open from the moment it starts. Chats with no messages in them (panels that were opened and closed) are hidden.

### A chat's profile

Click a chat to open its profile. It is a short read, not a report:
- **At the top:** its state, where it is ("open in VS Code", or "not open now"), its project, when it started, and a one-line summary with keywords.
- **done so far:** up to three lines on what has actually been done.
- **from here:** up to two lines on what is left, open or failing, when there is something.
- **At the bottom:** **open in VS Code**, and **new chat from this**.

With the AI helper on, Haiku writes those lines (and keeps them current as the chat moves); without it, Kroog takes them from the chat's own plan and last reply.

Everything else is under **more**: what was asked, the plan, the files, how many edits, reads and commands, the agents it started and what each came back with, the notes Kroog kept from it, where it came from and what it led to, and the real conversation from Claude Code's own history. The **⋯** menu has summarise again, write notes, copy a summary, and hide.

When a chat asks to edit a file or run a command, the question shows at the top of its profile. Answer it in your editor, or here if Kroog is holding it.

### Start a new chat from what others worked out

1. Take a suggested group on the **list** page (**new chat from these**), or click the small link key on a chat and add more chats with their keys, or press **new chat from this** in a profile.
2. The panel lists the chats. Add a goal if you have one, pick the project folder, and press **open a new chat in VS Code**.
3. Kroog starts the chat in that folder with the context as its first message ("Context from Kroog, the map of my Claude Code chats: what earlier chats on this work established…"). Haiku reads it and replies in a few lines with what it understood; that takes a few seconds. Then VS Code opens on the chat and you carry on there. Kroog draws the lines from the old chats to the new one.

If you would rather nothing runs before you say so, pick **I paste it myself**: VS Code opens a new, empty chat on that folder and the context is on your clipboard. Paste it and press Enter.

**choose what to take from each** (folded away in the panel) picks the parts per chat: last reply, what was asked, plan, files, notes. **write it with ai** merges everything into one short brief you can edit.

The first time, your Mac asks twice. VS Code asks "Allow 'Claude Code for VS Code' extension to open this URI?": tick "Do not ask me again" and press Open. If Kroog had to open the project folder through a link, macOS asks whether to open the folder in Code: tick "Allow opening local paths without asking" and press Yes. Kroog avoids the second one when VS Code's own `code` command is installed (in VS Code: "Shell Command: Install 'code' command in PATH"); **Setup** says whether it was found.

**+ new chat** on a project band opens a plain new chat in VS Code on that folder, with an optional first message.

### Chats about the same work

The **list** page starts with suggested groups: chats that look like the same piece of work. Each card has a name, the chats in it, and **new chat from these**, which jumps to the lineage with those chats picked and the panel ready. The × hides a suggestion. With the AI helper on, Haiku (on your plan) proposes and names the groups (the reason is a tooltip on the name); without it, Kroog groups by shared words. Haiku is asked again only when the set of chats changes, or with **look again**; the page never waits for it.

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
| `node bin/kroog.js stop` | Stop the Kroog (or old Crew) that is running. |
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
- **Sending context into an open chat** uses that chat's inbox, a private socket Claude Code opens for each chat. In the editor it arrives as a message from another session, so it can never approve anything for you.
- **Inboxes.** Since Claude Code 2.1.224, every chat has a private inbox, a socket only your user can reach. Kroog sends your messages and briefs there.
- **Conversations.** The conversation shown in a chat's panel comes from Claude Code's own history file for that chat.
- **What the page gets.** The browser gets each chat's newest 40 steps and the counts of the rest, not the whole chat, and a working chat's updates a few times a second at most. Kroog saves its state at most every 5 seconds, off the main thread. With a few hundred chats, the earlier way of doing all three was what made it slow.
- **Claude Code on your Mac.** The AI helper and "Claude reads it first" use Claude Code itself (`claude -p`), with your usual login, settings and permission rules. If `claude` isn't installed for the Terminal, Kroog uses the copy inside the VS Code extension.

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
- The look follows the floor set by [Hallmark](https://github.com/nutlope/hallmark) (MIT License): colours and type as tokens, contrast in both modes, visible focus, no animated layout, and motion that stops when you ask it to. `test/style.test.js` keeps those rules.
