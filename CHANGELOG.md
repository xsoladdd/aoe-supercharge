# Changelog

## 0.5.0 (unreleased)

Office v2: rooms, errands, a review lounge, a cost meter, going home, day and night, and the office's
history.

- **A room for every project.** Each team works in its own room, behind low glass with a doorway in
  front and the project's name over it. People walk in and out through the doorway, never through the
  glass. The chips are made from your projects; one flies you to that room. Three projects with ten
  desks each fit without overlap. `npm run demo` adds a third, busy project to look at.
- **Errands and arrivals.** A worker who raises an MR walks to its lead's desk with a folder, hands it
  over, and goes on. Newcomers walk in through the entrance one at a time, so nobody appears on top of
  anyone. Opening the office, or reconnecting, places everyone where they are without walking.
  **Office animations** in Settings, Appearance turns walking off (as reduced motion does).
- **The office keeps a history.** The daemon writes down every time someone in the office moves, or
  their reason changes, in a file per day under `~/.local/state/supercharge/history/`. It keeps 30 days
  (`office.history.retentionDays`). `GET /api/office/history` reads it back. History starts with this
  version.

## 0.4.0 (2026-10-07)

Notes and todos, for you and Claude, and a proper line at your door.

- **`/note`, `/todo` and `/gnote`** in any Claude Code session. `/note` and `/todo` file under the
  project you're in (or the project of the control chat that started the session); `/gnote` is global.
  `/todo done <id>` ticks one off. They're installed with the other skills on `supercharge start`.
  Control chats read their project's open todos when they start and when you ask for status, and tick
  them off when the work is done. Only you archive. On the command line: `supercharge note add`,
  `todo add`, `todo done`, `todo reopen`, `note archive` and `supercharge notes`.
- **A whiteboard in the office**, on the back wall by your door, with the open todos, the ticked ones
  struck through, and the notes. Click it (or the Whiteboard chip) to fly up close and open it: tick a
  box, archive, or add a line.
- **Notes**, a new page under Office in the sidebar: each project's todos and notes, then the global
  ones, with who wrote each (you or Claude) and when. Tick a todo, archive it or all the ticked ones;
  **Archived** lists them, to restore. The sidebar shows how many todos are open.
- **The line at your door stands.** The waiting chairs are gone: everyone in line stands in single file
  on a runner straight out from your door, facing it, between brass posts and ropes. Whoever is first is
  right at the door, and a long line carries on past the ropes.
- Notes are kept in `~/.local/share/supercharge/notes/` and never leave your machine. Syncing them to
  your phone is for later (Google Keep's API can't tick or archive, so it would be Google Tasks).

## 0.3.7 (2026-10-07)

- **A message you send from the chat shows once.** A message of several lines showed twice: once as
  Claude Code recorded it, wrapped in `<pasted_content>` tags, and once as the dashboard's own "Sent"
  or "Queued" copy, which never matched it. The chat now shows what you wrote, once.

## 0.3.6 (2026-10-07)

- **Message a control chat from the office.** Pick a team's lead on the office floor and its card has a
  box to write to its control chat, ready to type in. Enter sends, Shift+Enter adds a line. It goes into
  the control chat like a message from its chat page, and is recorded in the audit log. At your door, the
  lead's list of things for you sits right above it, so you can answer without leaving the office.

## 0.3.5 (2026-10-07)

Names for every worker, and the office in a window of its own.

- **Workers your control chat starts through AoE get names** like the ones `supercharge task new` gives
  ("Conrad", "William"), the first time Supercharge sees them. The name shows in the office, the sidebar,
  the project page and the chat's breadcrumb, with the session's AoE title beside it. A name is never
  given twice in a project, and a session adopted as a task keeps its name.
- **New window** on the office floor opens the office on its own, with no sidebar or header, to keep on
  another screen. Whatever you open from it (a task, a chat) opens in your dashboard window, so the
  office stays put. It keeps its own Show/Hide list setting, and leaves the Needs-you sound to the
  dashboard window.

## 0.3.4 (2026-10-07)

Run a command in your control chat's own terminal.

- **Run in terminal.** A command your control chat asks you to run (a `bash` block, or `` `! command` ``
  in its text, which now gets a Run button too) can run in the control chat's own shell instead of
  through Claude: the dialog offers Run in chat or Run in terminal. The terminal opens in the side panel's
  new Shell tab, in the project's folder, and you can type in it like any terminal. It is the same shell
  as AoE's Terminal tab: if you have it open in AoE, Take over moves the keyboard here. Each command run
  this way is recorded in the audit log.
- **"Control chat replied" no longer sends the control chat to your door** in the office. It still shows
  in Needs you and notifies you; only what it actually asks of you (its NEEDS YOU list) puts it in line.

## 0.3.3 (2026-10-07)

- **Workers your control chat starts through AoE are in the office.** A session started with
  `aoe add -P <control>` instead of `supercharge task new` takes a free desk in its project's team, and
  goes to the pantry, your door or away as its session does. Waiting on a menu, it can be answered from
  its card. Its Needs-you items count for its project.
- A control chat's list of things for you is found under the other headings control chats use for it
  too: "Still waiting on you", "Waiting for your answers", "Blocked on you", "Your call", not only
  "NEEDS YOU". At your door, its card lists them, blockers marked.

## 0.3.2 (2026-10-07)

What your control chat says needs you puts it in line at your door.

- **A control chat's NEEDS YOU list counts.** When a control chat's latest reply has a `🔴 NEEDS YOU`
  section, each item shows in Needs you, and the control chat waits in line at your door in the office,
  with how many things it has for you. It leaves the line once a reply has nothing under NEEDS YOU. An
  item that says work is blocked shows as Blocked on you, and notifies like a worker's question.
- **Blockers go to the front of the line.** Whoever has work stopped until you act (a worker's question,
  permission prompt or plan, a blocked control chat item, a session error) stands ahead of the rest. The
  rest stay oldest first.
- The control skill reports what needs you under `🔴 NEEDS YOU`, and writes "Blocked" where work is
  stopped.
- `supercharge start` no longer fails with "Bootstrap failed: 5: Input/output error" when the service is
  already running. It waits for launchd to unload the old daemon before loading the new one.

## 0.3.1 (2026-10-07)

Claude's questions one at a time, and the sessions a control chat starts on its own.

- **Previous and Next on Claude's questions.** When Claude asks several questions in one go, the card
  shows them one at a time, the way Claude's terminal does, with a chip per question that marks it
  answered. Enter moves to the next question, and the last one sends. Sending with a question unanswered
  takes you back to it. The card used to stack every question in one long scrolling form.
- The control skill asks Claude to put several questions in one call (up to four), instead of one call
  per question numbered "[2/5]", where only the one in front of you could be answered.
- **Sessions a control chat starts through AoE are listed with its project.** A worker started with
  `aoe add -P <control>` instead of `supercharge task new` used to land under Other AoE sessions as
  Standalone. It now shows in the sidebar under its project, and on the project page under Started by
  the control chat.

## 0.3.0 (2026-10-07)

The office floor, commands you can run from the chat, and control chats that stay on Opus.

- Right-click menu on sessions and workers (open, pin, lock, mark read, stop or start, archive, delete),
  with Ctrl/⌘ and Shift to select several. A worker whose AoE session is trashed or deleted leaves the
  lists, and comes back if the session is restored.
- `supercharge usage --connect`: every Claude Code session you run records your 5-hour and weekly usage,
  not only the ones Supercharge starts.
- Workers get medieval names (Gareth, Godfrey, Isolde…), with the task id beside them.
- Typing `/` in a chat suggests Claude Code's commands and your skills; Tab completes.
- Control chats start on Opus (`agent.controlModel`). The control panel opens on Notes, hides with a
  visible toggle, and Start fresh sits under the message box once a chat gets long.
- The chat follows `/clear` at once, instead of up to 30 seconds later.
- **Run commands from the chat.** A `bash` block in Claude's reply has a Run button. After you confirm, it
  runs in the session through Claude Code's shell mode (`!`), as you, and Claude reads the output and
  replies. What you ran and what it printed show in the chat, also for `!` commands typed in the
  terminal. The control skill now asks Claude to put commands for you in `bash` blocks.
- **Answers go through while the session is open in AoE.** Supercharge used to refuse when AoE's web view
  or TUI held the session's typing lock. It now takes the lock over for the one keypress it needs, and
  AoE's view takes it back by itself.
- **A control chat off its model says so.** When a control chat runs on something other than
  `agent.controlModel` (Sonnet, after `/model opusplan` for example), the chat offers to switch it back.
  When it still runs a Claude Code older than 2.1.284 while a newer one is installed, it offers to restart
  it, which resumes the same conversation on the 5.5 models.
- Settings: the agent settings say they apply to chats started from now on, instead of asking for a
  daemon restart that would not change a running chat. The model menu marks the current model.
- **Workers always plan with Opus.** A worker for Sonnet-level work (or started without `--model`)
  starts on `opusplan`: Claude Code runs it on Opus while it is in plan mode and on Sonnet once you
  approve the plan. `--model opus` plans and builds on Opus. The control skill picks the build model.
- The chat shows a `/model` switch at once. Claude Code prints the new model's display name in colour,
  sometimes in a different record, so the chat used to keep showing the last reply's model. `opusplan`
  shows as Opus Plan, and a control chat on it is flagged, since it answers with Sonnet outside plan mode.
- **The office** (`/office`): a Restaurant City style floor where a worker's place is its status.
  Everyone who needs you queues at your door, oldest first, with a bubble for why; working workers sit
  at their desk in their project's team; idle ones, and those waiting on an MR, take a break in the
  pantry. Workers walk to their new place when their status changes (they jump with reduced motion),
  each in an outfit from one of seven dress codes. Zoom and pan, or jump with the area chips. Click a
  worker for its card and answer its question there; **Call next** (N) brings the front of the line in.
  Put your name on the door with `ui.displayName` (Settings, Appearance). **Show in office** is in the
  right-click menu, and **List** shows the same people as a list.
- The office looks like a study: your door at the far east end of the back wall (walnut double door,
  bookcases, brass sconces, leather club chairs on a runner for the line), the pantry in the west, the
  teams between. Dark is the study at night (near-black panelling, walnut, cognac leather), light the
  navy study by day (white moulding, espresso floor, cream rugs, curtains, a world map). Characters are
  sticker-style chibis with ink outlines, dot eyes and chunky hair, and face the room while they wait.
- `npm run demo -- --live` keeps the demo's workers busy (three teams, new arrivals, questions, MRs that
  merge), and `npm run demo:open` opens the running demo signed in.

## 0.2.1 (2026-10-06)

Spend less of your Claude plan limits.

- The control chat picks a model per worker: `supercharge task new --model sonnet` for well-scoped work
  (bug fixes with a clear repro, CI and review follow-ups, tests, docs), `--model opus` for the harder
  work. `--effort` and `opusplan` (Opus plans, Sonnet builds) work too; the task page shows what a worker
  started on.
- Usage limits: sessions Supercharge starts get a status line that records your 5-hour and weekly usage
  (your own status line still shows). `supercharge usage` and the sidebar show it. `task new` refuses
  (exit 6) when the worker cap is reached or a window is nearly used, and allows fewer workers at once
  while a window fills up (`[limits]` in Settings). `--force` overrides it when you say so.
- New sessions auto-compact at 500k tokens instead of the model's full window (`agent.autoCompactWindow`).
- Start fresh: the chat menu clears a conversation with `/clear`; the task, plan and stage stay in
  Supercharge, and workers find their plan again with `supercharge whoami`.
- The skills tell the control chat to check usage before spawning, keep one fresh worker per story and
  never poll in loops, and tell workers not to wait on pipelines in a loop.
- `supercharge doctor` warns when Claude Code is older than 2.1.284, where `opus` and `sonnet` still start
  the 5.0 models.
- The "needs you" sound plays once per item instead of every time an item drops out and comes back.

## 0.2.0 (2026-10-05)

The dashboard becomes the place you work from: chats rendered like Claude, answers to whatever a worker is
waiting on, and a control chat that manages its workers.

### Chats

- Every session opens as a full-page chat rendered from Claude Code's transcript: markdown, tables,
  highlighted code with copy, folded tool calls. The raw terminal is one click away.
- Paste, drop or pick files. Images open in a mark-up editor (circle, box, arrow, pen) before they are sent;
  attachments are stored outside the repository and sent as paths Claude opens.
- Under the message box: model and effort (switch with `/model`, `/effort`, after a warning that Claude
  Code also saves them as defaults), a context meter, and a working clock.

### Answering workers

- Plan approvals, permission prompts and Claude's own multiple-choice questions show as answer cards
  (task page, chat, and the control chat). Messages are refused while a menu is open, so a typed Enter can
  never approve a plan by accident.
- `supercharge ask --option` gives clickable answers.
- Select text in a plan to comment; comments go to the worker in one message (as "Tell Claude what to
  change" while the plan waits).

### Control chat

- A side panel: what needs you in the project (with a sound and a pulse when something new arrives), the
  active plans, your comments, and notes.
- Workers' questions are asked right in the control chat.

### Projects and tasks

- Each task is a page with Overview, Chat and Plan tabs.
- Adopt an existing AoE parent session and its children as a project; Add a project from the sidebar.
- Delete a project from its settings (optionally with its AoE sessions, worktrees and branches).
- Model and effort defaults for new sessions; `--add-dir` for the uploads folder.

### Look and feel

- Compact chat, task page and sidebar; an interface size setting (Small to Larger).

### Fixes

- The control chat no longer goes blank after answering (a clipped container was being scrolled).
- Project-page links no longer double their path; the sidebar status icon is no longer clipped.

## 0.1.0 (2026-10-05)

First release: control chats and workers on top of AoE, the stage machine, GitLab MR watching, the
dashboard, and the launchd/systemd service.
