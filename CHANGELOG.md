# Changes

Dates are 2026.

## 1.5.0, 2 November: ready for the public

- A README for people who have never heard of Kroog, a one-page website in `docs/` (for GitHub Pages), a 30-second tour as a GIF and a video, screenshots, and a social preview image.
- Terminal chats show by default. Scripts (`claude -p`, the Agent SDK) never show. "Only editor chats" is still in Setup, and a setting saved before is kept.
- Kroog's own updates (an AI summary, hiding a chat) no longer move a chat's time; only what the chat does moves it.
- Try it without installing: `npx github:ishanyash/kroog demo`. Outside a git clone, `link` installs the mod from GitHub. The mod honours `KROOG_HOME`. The install line for the mod is the Terminal one. On Windows, `link` says to use WSL.
- Burn keeps fractions of a cent, so a short Haiku chat no longer reads as 0. Haiku 5.5 prices checked against Claude Code's own figure.
- "This computer" instead of "this Mac". The demo's projects and text are generic, in dollars.
- GitHub Actions runs the tests on macOS and Linux, Node 20 and 22.
- Tested end to end on Linux with real Claude Code 2.1.316: the hooks and the map, the mod installed from GitHub and from a clone with its readings arriving, the context sent into an open chat and into a brand-new chat (each replied in a few lines with no tool calls), and the burn report from real transcripts.

## 1.4.1, 30 October

- Burn counts only the seven days it shows. Before, a chat used this week counted with everything it had spent since it started, so the header could be many times the sum of the days.
- Cost per chat is Claude Code's own figure, which it writes into each transcript. Kroog's own pricing is only for chats without one, marked ~.
- The price table is corrected: Opus 5.5 is $4 in, $20 out, $0.20 cache read; Fable 5.1 has its own row; 1-hour cache writes have their own rate; Haiku 5.5 has two tiers. Opus and Fable reproduce Claude Code's totals to the cent.
- "How it adds up": tokens and dollars by kind (cache reads, cache writes, output, input), requests, and the average conversation re-read per request.
- The page says what the dollars are: API list price, not what a Pro or Max plan costs.

## 1.4.0, 30 October

- Burn: the plan's 5-hour and weekly windows as a chip at the top, and a page with the week's pace and where the spend went (by day, project, model, chat).
- The Kroog mod, a Claude Code plugin in `mod/`, sends the windows and each chat's cost to Kroog. `link` installs it; `doctor` checks it.
- Cost per chat from the transcript, at list price, for chats the mod has not seen.
- MIT licence, SECURITY.md (the boundary), a boundary test, CONTRIBUTING, this file.

## 1.3.0, 30 October

- The context a new chat receives says it is background, not a task, and ends with "read it, reply in a few lines, then wait". Tested against the real Claude Code: no tool calls in 8 of 8 runs.
- Every destination (a new chat, an open chat, a closed chat) gets the context through the chat's inbox. Kroog never runs a chat.
- Delivery receipts: Kroog says when a chat has not taken the message.
- Chats an older Kroog started itself are marked as ones VS Code cannot open.

## 1.2.0, 30 October

- A new chat gets its context through its inbox: VS Code opens the chat, Kroog finds it in Claude Code's registry, and sends.
- Times carry their day everywhere but the week view.

## 1.1.0, 30 October

- The profile is a short read: done so far, from here, the rest under "more".
- Quiet group cards. Haiku is asked again only when the chats change.
- Speed: trimmed payloads, coalesced updates, async saves, fewer redraws.

## 1.0.0, 30 October

- The look follows Hallmark's rules, kept by `test/style.test.js`. Dark mode re-derived.
- The activity field: pixels behind the week view that show what each chat is doing.

## 0.9.0 and before

- Kroog was called Crew. The week view, the profile, the second brain, suggested groups, presence from Claude Code's registry, the inbox, the import of older chats.
