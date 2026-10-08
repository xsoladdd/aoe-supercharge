# Changelog

## 1.4.0 (2026-10-09)

- **Clean up finished workers, safely.** `supercharge task cleanup <task-id>` (and `--all-done`) removes a
  done worker's AoE session, worktree and branch, but only when its work is on `origin/main`: it fetches
  first, then accepts a branch that is an ancestor, one whose commits all have an equivalent patch there
  (cherry-picked or rebased), or one whose pull request the watcher recorded as merged (squash merges). It
  refuses, and says why and what to do, when commits are not on main or the worktree has uncommitted
  changes. Done tasks get a **Clean up** button (task page, right-click menu), and the project page a
  **Clean up all done**. Each cleanup is in the audit log (`task_cleaned_up`). `--dry-run` only checks.
- The control skill now gives `supercharge task cleanup <id>` in a bash block instead of raw `aoe rm`
  commands, which delete unpushed commits without asking.
- **"Control chat replied" no longer sticks.** A chat that is open and visible in the dashboard is marked
  read, also when a reply arrives while you watch (and after `/clear`), so its item leaves Needs you. The
  control chat's side panel has a Dismiss button on that item too.
- **Control chats run on Opus at xhigh effort.** New setting `agent.controlEffort` (default `xhigh`),
  separate from the workers' `agent.effort`. Both are launch flags of that one session, so your Claude Code
  default is never changed. The control chat's Model picker now shows what it runs on, locked; changing it
  is refused (the one exception is switching back to the control model). An empty `agent.controlModel` no
  longer falls back to the worker model. Control chats that already exist keep their old arguments.
- **The right effort per worker.** The control skill now passes `--effort` along with `--model` on every
  `task new`, by kind of task (medium for small follow-ups up to xhigh for migrations and anything that can
  lose data).
- **Releases are trunk and tag.** Changes go to `main` through pull requests; a release is a
  `Release X.Y.Z` commit plus a `vX.Y.Z` tag, with no `release/X.Y` branches. When a `Release X.Y.Z` commit
  lands on `main`, the release workflow now tests it, runs `npm pack`, and creates the GitHub Release (and
  its tag) with the tarball attached. npm publish and the Homebrew tap are skipped until `NPM_TOKEN` and
  `TAP_TOKEN` exist, so the workflow no longer fails on every release. `CLAUDE.md` says who does which step.
- **Office themes.** **Theme** on the Office page dresses the floor in one of seven looks, each by day
  and by night: **Headquarters** (today's office, the default, unchanged), **Foundry** (brick, steel
  and concrete), **Ryokan** (tatami, shoji screens and a garden), **Throne Hall** (stone, banners,
  torches and a red carpet to your door), **High Roller** (casino carpet, slot machines and a roulette
  table), **Fjord** (birch and a view of the northern lights) and **Starship** (deck plates, viewports
  and a blast door). Pick one and the floor changes at once; the menu stays open to try the next. Only
  the look changes: rooms, desks, your line and every path stay put, and status colours, bubbles and
  nameplates read the same in every theme. The choice is saved as `ui.officeTheme`, so every device
  shows the same; a theme it doesn't know shows Headquarters.
- **Run in a new terminal.** Run now offers three ways to run a command: in the chat (shell mode, as
  before), in the control shell (the side panel's Shell tab; it was "Run in terminal"), and in a new
  terminal of its own that opens right under the command. You see its output there, scroll back through
  it and answer its prompts, and it stays until you close it, across reloads too. It is one of AoE's
  extra paired terminals for the session, so it runs in the session's folder and needs nothing new
  installed. A terminal whose command the chat no longer shows (after Start fresh) is listed at the end
  of the chat. Every run is audited.
- **A red warning on commands that lose work.** Before you run `aoe rm` with `--purge`,
  `--delete-worktree` or `--delete-branch`, `aoe session empty-trash`, `rm -rf`, `git reset --hard`,
  `git push --force`, `git branch -D`, `git clean -f` and similar, the Run dialog says in red what the
  command deletes, and keeps the focus on Cancel.
- **Enter confirms.** In the Run dialog Enter runs the highlighted choice (the one you used last; Run in
  chat at first) and Escape cancels; for a command that loses work, Enter cancels. In Start fresh,
  Enter clears the conversation.
- **A slimmer side panel.** The control chat's panel has Plans, Comments, Watch and Shell, and opens on
  Shell. Its Notes tab is gone; notes and todos stay on the Notes page.
- **Clear and Restart in the Shell tab.** Clear clears the screen (Ctrl-L; the scrollback stays).
  Restart closes the shell and starts a fresh one in the same folder. The Shell tab now has a terminal of
  its own (AoE's extra paired terminal 31), since AoE won't close the terminal it shares with its TUI;
  after upgrading it starts as a new shell.
- **Messages wait while Claude works.** In the chat, Send no longer types into a turn under way: the
  message is held in Supercharge, shown in the chat with **Edit** (back into the box) and **Cancel**, and
  typed in once Claude is done, one per turn, in order. Held messages keep their images and files and
  survive a reload or a closed tab, because the daemon holds them. The caret beside Send offers **Send
  now** (as before: Claude reads it during the turn) and **Interrupt and send** (Escape stops Claude, then
  it goes in). A menu on screen is still never typed over, and every message is audited when it goes in.
  A message whose sending failed is never sent again by itself: it waits with Retry, Edit and Cancel.
- **Drafts are kept.** What you were writing in a chat, text, pasted images and files, stays with that
  chat when you switch to another one or reload, until you send it. Files upload as you add them and are
  not uploaded again when you send.
- **The context ring opens.** Click it for tokens used of the window, the model, the last request's
  input, output, cache reads and cache writes, and when Claude Code compacts, with Start fresh. The
  figures are Claude Code's own, from its status line, when it reports them; otherwise an estimate.
- **1M context shown right.** A 1M session no longer reads its context against 200k: the window comes
  from Claude Code's status line, and without it, more than 200k in use means 1M. Output tokens no longer
  count as context, as in Claude Code.
- **What needs you stands out.** A reply's 🔴 NEEDS YOU, 🟡 WORKING and ✅ DONE sections sit on a muted
  shade of their colour, and a "Blocked" item is marked. Watch notices, failed tool calls, session errors
  and warnings take the same shades, in light and dark.

## 1.3.0 (2026-10-08)

The worker queues at your door, and planning moves to the kitchen.

- **One line at your door per thing.** When a control chat lists something a worker asked you under
  NEEDS YOU, the worker waits at your door for it and the control chat no longer queues behind it. It
  stays at its desk on the phone, ringing, calling for that worker ("Calling for Aldric"); hover it to
  see who for, click it for the list, each with a button to that worker. In Needs you the item shows as
  **Passed on**, links to the worker, and is not counted, sounded or notified twice.
- **Answer the worker, and the control chat's mention goes too.** Once the worker has moved on (you
  answered it, granted the permission, approved the plan, it got back to work), the item clears by
  itself: no new reply, nothing typed into the control chat. A stall, or anything else the control chat
  asks itself, still puts it in line until you reply.
- The control skill now starts each worker item under NEEDS YOU with `Name (TASK-ID):`, one worker per
  item, its own asks apart. Replies that don't are still matched by task id, worker name or session
  title.
- **A kitchen for planning.** A worker working on its plan no longer sits at its desk looking busy: it
  cooks in the office's new kitchen, beside the pantry. Five cast-iron stoves go first come first
  served (nobody is bumped), and anyone past them chops at the prep counter. When you approve the plan,
  the worker carries the dish to whoever has been idle longest in the pantry, who eats it for about a
  minute (hover the plate to see whose plan it was), then goes to its desk. With nobody in the pantry it
  goes straight to its desk. The list has a Kitchen section, the header counts it, and a chip flies
  there. History replays it.

## 1.2.0 (2026-10-08)

A whiteboard in every room, and fewer false alarms from the worker watch.

- **A whiteboard in every room.** Each project's room in the office has its own whiteboard, standing
  against its left glass, half way down it, with that project's open todos and notes. Click it (or use
  the **Whiteboard** button on the team in the list, or `?focus=board:<project>`) to read it up close
  and tick todos off. The whiteboard by your door now keeps only the global notes. A room's sign now
  stands at the room's west end, and a board focus waits until the board is in its place.
- **No false stall while background shells run.** A worker that is waiting on its own background
  shells is no longer reported as stalled.
- **No runaway flag for control chats.** A control chat is no longer flagged as a runaway session.

## 1.1.0 (2026-10-08)

The built-in worker watch, and `[WATCH]` notices shown as notices in chat.

- **Worker watch.** Each project's control chat hears about its workers by itself: when a task's
  worker, or a session the control chat started with `aoe add -P`, asks a question, is done, waits on
  a permission prompt, errors or sits idle 15 minutes with nothing to report. One notice per event and
  one per stall, also across restarts. Notices wait while the control chat is busy and go in together
  once it is free, as `[WATCH] worker=… status=… kind=… log=…` lines (the shape `control-watch.sh`
  used), with a capture of the worker's pane to read. Turn it off per project, or change the stall
  time, under Settings, Worker watch. The control chat's side panel has a **Watch** tab with what it
  was told and when.
- **Notices, not bubbles.** `[WATCH]` lines in a chat, from Supercharge or from your own watcher, show
  as compact notice rows (worker, what happened, when, Open and Log) instead of a message from you.
  Messages typed while Claude was busy now show in the chat too.
- **A notice is not your answer.** A control chat's reply to a notice can add to its NEEDS YOU list
  but no longer clears it, so its lead stays in line at your door until you reply.

## 1.0.0 (2026-10-08)

GitHub pull requests, MRs found by branch, merging without PRs, and new workers that start on
their own.

- **New workers start on their own.** Claude Code does nothing with a new worker until it gets a
  first message, and nothing sent one, so every new worker sat idle at an empty prompt. `task new`
  now sends a short kickoff once the session is at its prompt with no menu open (the trust dialog,
  say). If it can't, the daemon sends it later. It goes once, and a worker someone already wrote to
  is left alone.
- **A lost kickoff is sent again.** A kickoff can still get lost: typed before Claude Code was
  ready, taken by a menu, or dropped by a restart. It only counts once it shows up in the worker's
  transcript. If the worker sits idle with no menu 20 s later and its conversation has no message
  yet, it is sent again, up to 3 times. If the daemon is down and the worker isn't at its prompt
  yet, `task new` tells you nobody will send it later.
- **Just the cost bar on the floor.** The meter under each character is now only the bar (green,
  amber, red). The figure is still on the worker card, the roster and in Since I was away.
- **Ready to merge without a PR.** On a project that merges branches without merge requests
  (`supercharge config set projects.<name>.mr none`), a finished worker pushes its branch and runs
  `supercharge stage ready_for_review`. It waits at the pool table with a green folder, "Branch ready
  to merge", and shows in Needs you and in `status`. Once its commits land on the base branch
  (fast-forwarded, merged or cherry-picked), Supercharge marks the task done by itself. Projects with
  merge requests work as before.
- **GitHub pull requests.** Projects on GitHub are watched through `gh`, next to GitLab through
  `glab`: the pipeline (the head commit's checks), open review threads and the merge state, with the
  same rules for ready. The provider is picked from the project's remote, and `stage mr_raised --mr`
  takes a pull request URL too. GitHub Enterprise hosts go in `mr.github.hosts`. `supercharge doctor`
  checks `gh` and its login, but only warns, since only GitHub repositories need it.
- **MRs found by branch.** An MR opened without `stage mr_raised` is found by its branch. A worker in
  implementing or verifying that has gone quiet is moved to `mr_raised` when its branch has one. A crew
  session a control chat started straight in AoE, with no task, waits in the review lounge with its
  MR's badge and folder, without anything in Needs you.
- **The README install guide matches what works.** Supercharge is not on npm or Homebrew yet, so it
  says to install the packed CLI attached to the GitHub release, or from a checkout
  (`./install.sh --local .`). It lists the requirements (`gh` only for GitHub repositories) and the
  first run (`supercharge doctor`, `supercharge start`, `supercharge init`), and the features added
  since 0.4.0.

## 0.5.0 (2026-10-07)

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
- **A review lounge with a pool table.** Workers with an MR out wait there instead of the pantry,
  holding a folder: green when it's ready for review, amber while the pipeline runs or review threads
  are open, red when the pipeline failed or the MR was closed. A badge under each shows the MR number,
  pipeline and open threads; click it to open the MR. An MR that is ready or closed still shows in
  Needs you and still notifies, but no longer queues at your door. The header counts who is in review,
  and the list has a Review lounge section with the same badges.
- **What it costs.** A meter under everyone in the office shows their conversation's tokens and an
  estimate of what it would cost on the Claude API ("≈ $1.20"), read from Claude Code's transcripts.
  The header adds today and now. It is an estimate: on a Claude plan it is not a bill. Prices are in
  one file, checked against Anthropic's pricing page on 2026-10-07; models without a price show tokens
  only.
- **Runaway workers are flagged.** Over a token limit, spending fast, or working half an hour without
  changing anything: a red warning on the floor, a toast, a desktop notification, and a "needs
  attention" count in the header. Set the limits in Settings, Office (`office.runaway`).
- **Dismiss "Control chat replied".** It used to stay until you opened the chat in AoE. Its card in
  Needs you, and the team lead's card in the office, now have a Dismiss button; it stays away until the
  control chat replies again. Nothing else in Needs you can be dismissed.
- **Office history mode and "Since I was away".** Replay the office: a scrubber over the last hour to
  7 days, play at 1×, 10× or 60×, filters by project and agent, and Back to Live always in view.
  "Since I was away" sums up what happened since your last visit: agents finished, MRs raised,
  pipelines failed, who needed you, and the estimated spend.
- **Day and night, clocks and weather.** The office lights follow the work: bright while anyone works,
  dimmed when nobody does, a warm night after an hour of quiet, easing between them. The header shows
  two clocks (Stockholm and Manila by default) and the time between them, right through daylight
  saving. The weather at home (Open-Meteo) can sit beside its clock and show in the windows. **It is off
  by default (`office.weather.enabled`): Open-Meteo's free API is for non-commercial use, so the owner
  must review its terms before turning it on.**
- **Idle workers go home.** After half an hour idle in the pantry a worker asks to go home: Archive,
  Keep, or Snooze 30m. Archive asks first and only changes the office: the worker walks out and waits
  under Archived with Restore, and comes back by itself when it works or needs you. Its session,
  worktree and history are never touched. `office.idle.autoArchiveMinutes` sends idle workers home by
  themselves (off by default).
- **Fixed:** a character leaving the floor while everyone was placed again at once (a reconnect) could
  stop the floor drawing.
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
