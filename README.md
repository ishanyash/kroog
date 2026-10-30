# Kroog

Kroog is the map of your Claude Code chats. One browser tab shows every chat in VS Code, Cursor or the Terminal: what each one is about, what it did, which agents it used, and how the chats came from each other. Chats stay in Claude Code; Kroog is where you understand them and where you start the next one with the right context.

- **See.** One week at a time, project by project. Four states: working, needs you, open, done. Hover over a chat for a one-line summary.
- **Understand.** Open a chat for its profile: what was asked, what got done, the files, the agents and what they came back with, the notes it left, where it came from. The full conversation is one click away.
- **Connect.** Pick two or three chats (a suggested group, or the link keys) and open a new Claude Code chat whose first message is the context they established. The chat reads it and waits for you.
- **Remember.** A second brain: your `CLAUDE.md` files, rules, skills and Claude Code's own memory, as a map and a search, usable from inside every Claude Code chat.
- **Burn.** Your plan's 5-hour and weekly windows at the top of every page, and a page that shows the week's pace and where the spend went: by chat, project, day and model.

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
node bin/kroog.js link      # connect Claude Code to Kroog (backs up ~/.claude/settings.json first) and install its mod
node bin/kroog.js start     # run it; opens http://127.0.0.1:4877
```

Keep the Terminal window with `start` open while you use Kroog. To update later, run `git pull` in `~/kroog`, then `node bin/kroog.js stop` and `start` again. If `start` says the port is busy, an older copy is still running: `stop` ends it.

**Coming from Crew?** Just run `start` (or `link`). Kroog moves `~/.crew` to `~/.kroog` and repoints Claude Code's hooks itself.

**Something not working?** Run `node bin/kroog.js doctor`. It checks everything Kroog needs and says what to fix.

## Using it

### The week view

- Each column is a day, Monday to Sunday. Move between weeks with ‹ and › at the top, or with the ← and → keys. Times on the week view are just times, because the column says the day; everywhere else a time comes with its day ("today, 1:43 pm", "yesterday, 1:43 pm", "27 oct, 1:43 pm").
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

### How chats connect

Every box on the week view is one Claude Code chat, and it lives in your editor. Kroog never runs a chat itself. From any chat there are two things to do:
- **open in VS Code** goes to that chat (it says **go to it** when the chat is open right now). VS Code can open chats it made and terminal chats from the same folder.
- **new chat from this** starts the next chat with this one's context.

To combine chats, pick them first, then say where the context goes:
1. **Pick.** Take a suggested group on the **list** page (**new chat from these**), or click the small link key on a chat and add more chats with their keys, or press **new chat from this** in a profile.
2. **Say where.** The panel lists the chats you picked. The context can go to **a new chat** (the usual case), to **an existing chat**, or into **project memory** for every future chat in that folder. Add a goal if you have one. Then press the button.
3. **Kroog gets the context into the chat.** For a new chat, VS Code opens one on the project folder; the moment it appears in Claude Code's registry, Kroog sends the context into it through the chat's own inbox, so it is the chat's first message. For an existing chat that is open, it goes straight in as the next message; for one that is closed, Kroog opens it in VS Code first and then sends. If the chat does not show up within 45 seconds, the context goes on your clipboard and Kroog says so: paste it and press Enter.
4. **The chat reads and waits.** The message says it is background, not a task, and ends with what to do now: reply in a few lines with what it now knows (and how it would go about your goal, if you gave one), then stop and wait, and not read, run or change anything until you ask. The chat is named after your goal, or after the chats it came from, and Kroog draws the lines from them to it.
5. **Kroog checks that it arrived.** Claude Code runs Kroog's hook for the message, which is the receipt. If no receipt comes within ten seconds, Kroog says so. The usual reason: a chat that skips permission prompts makes Claude Code hold messages from other sessions for your approval; approve it in the chat, or put `"crossSessionInbound": "accept"` in `~/.claude/settings.json` so they go straight in.

What the context contains, per chat: what was asked, what it did and what was left (the AI helper's short lines when it has written them, else the last reply), its plan, the files it changed, and its notes. **choose what to take from each** (folded away in the panel) changes that per chat; **write it with ai** merges everything into one short brief you can edit; **copy** puts the whole message on your clipboard for anywhere else.

Nothing rides in a link: VS Code drops long prompts from links, and sessions started with `claude -p` are left out of Claude Code's session picker, so a link cannot resume them. That is why chats that an older Kroog started itself cannot be opened from Kroog; their profile says so, and **new chat from this** still works for them.

The first time, VS Code asks "Allow 'Claude Code for VS Code' extension to open this URI?": tick "Do not ask me again" and press Open. If Kroog had to open the project folder through a link, macOS also asks whether to open the folder in Code: tick "Allow opening local paths without asking" and press Yes. Kroog avoids that second one when VS Code's own `code` command is installed (in VS Code: "Shell Command: Install 'code' command in PATH"); **Setup** says whether it was found.

**+ new chat** on a project band opens a plain new chat in VS Code on that folder; a first message, if you give one, goes in the same way.

### Chats about the same work

The **list** page starts with suggested groups: chats that look like the same piece of work. Each card has a name, the chats in it, and **new chat from these**, which jumps to the lineage with those chats picked and the panel ready. The × hides a suggestion. With the AI helper on, Haiku (on your plan) proposes and names the groups (the reason is a tooltip on the name); without it, Kroog groups by shared words. Haiku is asked again only when the set of chats changes, or with **look again**; the page never waits for it.

### Burn

The chip at the top shows your plan's two windows, the 5-hour one and the week, each as a thin bar with a mark where an even pace would be. Amber means ahead of pace. The **burn** page has the same two with their reset times, the week as a burn-up line against an even pace ("at this pace the week runs out Thursday 3 pm"), and where the last seven days' spend went: by day, by project, by model, and by chat.

The numbers come from Kroog's **mod**, a small Claude Code plugin in this repo (`mod/`). After every turn, and whenever a window moves, Claude Code tells it the windows and the chat's cost, and it sends them to this Kroog at 127.0.0.1. It reads one file (Kroog's token), talks to no other host, and never sees your credentials. `node bin/kroog.js link` installs it from this folder (it updates with `git pull`); or, in any chat:

```
/plugin install kroog --marketplace ishanyash/kroog
```

Windows appear only on a claude.ai plan (Pro or Max). Cost per chat is Claude Code's own figure where the mod reported it; for other chats, including old ones, Kroog estimates it from the chat's transcript at list price and marks it with ~. The prices it uses are in **Setup**.

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
| `node bin/kroog.js link` | Connect Claude Code to Kroog, and install the mod (`--no-mod` to skip). |
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
| Kroog's data: chats for the last 14 days, notes, briefs, chat inboxes, usage readings (30 days), the brain index, settings, token, hook script, backups | `~/.kroog` |
| The hooks | `~/.claude/settings.json` |
| The page | `http://127.0.0.1:4877`, on your Mac only |

## How it works

- **Hooks.** `link` adds hooks to Claude Code's settings. Each one runs `~/.kroog/hook.sh`, which tells Kroog what the chat is doing and where its inbox is. When Kroog isn't running, the hook gives up in a moment and changes nothing.
- **The registry.** Claude Code keeps a list of its running chats in `~/.claude/sessions/` (id, folder, busy or idle, inbox). Kroog reads it every few seconds. That's how a chat opened before Kroog started still shows as open.
- **Sending context into a chat** uses that chat's inbox, a private socket Claude Code opens for each chat. In the editor it arrives as a message from another session, so it can never approve anything for you. A new chat from Kroog works the same way: VS Code opens it, the registry shows it, and the context goes in.
- **Inboxes.** Since Claude Code 2.1.224, every chat has a private inbox, a socket only your user can reach. Kroog sends your messages and briefs there.
- **Conversations.** The conversation shown in a chat's panel comes from Claude Code's own history file for that chat.
- **What the page gets.** The browser gets each chat's newest 40 steps and the counts of the rest, not the whole chat, and a working chat's updates a few times a second at most. Kroog saves its state at most every 5 seconds, off the main thread. With a few hundred chats, the earlier way of doing all three was what made it slow.
- **Claude Code on your Mac.** The AI helper uses Claude Code itself (`claude -p`, with Haiku), with your usual login and settings. If `claude` isn't installed for the Terminal, Kroog uses the copy inside the VS Code extension.

## Safety and privacy

- Kroog only listens on `127.0.0.1`. Other computers can't reach it.
- Hooks and the mod must carry a secret token, and other websites can't send commands to Kroog or show it inside their pages.
- Kroog never edits your code and never runs a chat. A message from Kroog can't approve permissions; Claude Code always asks you.
- The AI helper's input goes to Anthropic, like any Claude Code chat. With Ollama it stays on your Mac. The brain index and the usage readings stay on your Mac. There is no telemetry.
- Kroog never reads your credentials: not `~/.claude/.credentials.json`, not the Keychain. `SECURITY.md` lists exactly what it reads, writes and connects to, `test/boundary.test.js` fails the build if the code steps outside that, and `node bin/kroog.js doctor` prints the list with your paths.

## Limits

- Messaging chats and seeing which are open need Claude Code 2.1.224 or newer.
- **open in VS Code** for a chat Kroog started needs VS Code to have that project folder open. Kroog opens the folder first.
- While Kroog holds a permission question, VS Code shows that chat as busy.
- Claude Code's history format and hook behaviour can change between versions.

## Licence

MIT. See `LICENSE`, and `NOTICE` for what Kroog ships with. Contributions: `CONTRIBUTING.md`.

## Credits

- The font is IBM Plex Mono, under the SIL Open Font License (`public/fonts/LICENSE-IBM-Plex.txt`).
- The fish come from the [ascii-sharks](https://github.com/stackedlol/ascii-sharks) ocean (MIT License, `public/water-LICENSE.txt`), as set up for ishanyash.com, with the sharks left out.
- The look follows the floor set by [Hallmark](https://github.com/nutlope/hallmark) (MIT License): colours and type as tokens, contrast in both modes, visible focus, no animated layout, and motion that stops when you ask it to. `test/style.test.js` keeps those rules.
