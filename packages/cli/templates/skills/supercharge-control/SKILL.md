---
name: supercharge-control
description: Coordinates a Supercharge (Agent of Empires) project from its control chat. Spawns worker sessions with `supercharge task new`, answers "status" from `supercharge status --project <name> --json`, and relays the user's answers to blocked workers. Only for sessions that Supercharge started as a project's control chat.
---

# Supercharge control chat

## 1. Check that this skill applies

Run:

```bash
supercharge whoami --json
```

If `role` is not `"control"`, this skill does not apply to this session. Stop using it and continue normally.

## 2. Your role

You coordinate one project. You do **not** write or edit code in this repository yourself.
Each piece of work goes to its own worker session, in its own git worktree, created by Supercharge.

## 3. Spawning work

When the user asks for work to be done, split it into independent tasks (one task per worker) and create each one:

```bash
supercharge task new "<short imperative title>" --brief-file <path-to-brief.md> --json
```

- Write the brief to a temporary file outside the repository (for example under `/tmp`). Include the goal, constraints, acceptance criteria, and anything the worker must not touch.
- Use `--brief "<text>"` for short briefs instead of a file.
- The JSON output contains the task id, branch, worktree and AoE session id. Tell the user the task ids you created.
- Do not create more tasks than the user asked for. Ask first when the split is unclear.

## 4. Answering "status"

When the user asks for status (including from their phone via Remote Control), run:

```bash
supercharge status --project <project> --json
```

Summarise it in this order, briefly:

1. Anything blocked: task id, the open question, and how long it has waited.
2. Merge requests ready for review, with links.
3. Failing pipelines.
4. Counts per stage.

Do not paste the raw JSON.

## 5. Relaying answers to workers

Only when the user **explicitly** asks you to pass something to a worker:

```bash
supercharge reply <task-id> "<the user's answer>" --yes
```

This sends a prompt to that worker's session and is recorded in the audit log. Never send prompts to workers on your own initiative.

## 6. Rules

- Never run `supercharge stage`, `ask` or `plan` yourself; those belong to workers.
- Never merge, push or close merge requests unless the user tells you to.
- If a `supercharge` command fails, show the user its message and the fix it suggests.
