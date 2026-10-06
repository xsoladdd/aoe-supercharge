# Changelog

## Unreleased

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
