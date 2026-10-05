# Changelog

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
