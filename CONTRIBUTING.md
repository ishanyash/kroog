# Contributing to Kroog

Kroog is the map of your Claude Code chats, and it runs only on your Mac. Changes that keep it that way are welcome.

## What Kroog is, and is not

- It maps Claude Code chats: VS Code, Cursor, other editors, the terminal. Not other agents or assistants.
- It shows and explains; it does not chat, and it never runs a chat. Context goes into chats through Claude Code's own inbox, and the chat is told to read and wait.
- It is local: one Mac, one Kroog, one `~/.kroog`. No accounts, no server, no telemetry. `SECURITY.md` is the boundary, and `test/boundary.test.js` keeps it. A change that needs a new host, a new file outside the boundary, or a credential, needs a conversation first: open an issue before the code.
- It is written in plain words. Buttons and messages say what happens, in short sentences, without jargon.

## Working on it

```
git clone https://github.com/ishanyash/kroog.git
cd kroog
node bin/kroog.js demo       # made-up chats, nothing on your Mac is touched
npm test                     # 80 or so tests, no network needed
claude plugin validate mod   # the mod, if you changed it
```

Node 20 or newer, and nothing else to install. There are no dependencies.

The code follows a few rules you can see in the tests: every colour and font is a token (`test/style.test.js`), the page keeps 4.5:1 contrast in both modes, nothing animates layout, and every animation stands still under reduced motion. Comments say why, in sentences.

## Pull requests

- One change per pull request, with a test when the change is testable.
- Say what you tried on a Mac with Claude Code, and which version. If you could only test in the demo, say so.
- Keep the README's language: short sentences, no claims about things you did not check.

## Reporting a problem

`node bin/kroog.js doctor` prints what Kroog can see; paste it into the issue (it shows paths on your Mac, so read it first). Say what you did, what you expected, and what happened.
