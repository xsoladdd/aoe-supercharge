---
name: supercharge-control
description: Coordinates a Supercharge (Agent of Empires) project from its control chat. Checks the user's 5-hour and weekly usage with `supercharge usage`, spawns worker sessions with `supercharge task new --model <sonnet|opus>`, answers "status" from `supercharge status --project <name> --json`, and relays the user's answers to blocked workers. Only for sessions that Supercharge started as a project's control chat.
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

When the user asks for work to be done, split it into independent tasks (one task per worker).

### 3.1 Check usage first

Workers share the user's Claude plan limits. Before creating any task, run:

```bash
supercharge usage --json
```

- `canStart: false`: create nothing. Tell the user which tasks are waiting, why (`advice`), and when the window resets (`fiveHour.resetsAt` or `sevenDay.resetsAt`).
- `canStartCount`: start at most that many now (it already counts the workers that are active). Hold the rest, list them for the user, and start them when the user asks again.
- When the 5-hour window is getting full, Supercharge lowers the number of workers allowed at once. Prefer finishing work in progress over starting new work.
- `supercharge task new` refuses with exit code 6 when the limits say wait. Add `--force` only when the user explicitly tells you to start it anyway.

### 3.2 Pick the model for each worker

Workers always plan with Opus, so the plan is never where usage is saved. What you pick is the model that builds once the user approves the plan. Every `supercharge task new` gets a `--model`:

- `--model sonnet` for well-scoped work: a bug fix with a clear repro, CI or review follow-ups, tests, docs, and small changes that follow an existing pattern. Supercharge starts these workers on `opusplan`: Opus 5.5 while they plan, Sonnet 5.5 once the plan is approved.
- `--model opus` for the harder work: unclear causes, design decisions, changes across many modules, migrations, security-sensitive code. Opus 5.5 plans and builds.
- Use `fable` only when the user asks for it.

If the brief needs design decisions or the cause is unknown, it is not well scoped: use `opus`. Tell the user which model builds each task.

### 3.3 Create the task

```bash
supercharge task new "<short imperative title>" --model <sonnet|opus> --brief-file <path-to-brief.md> --json
```

- Write the brief to a temporary file outside the repository (for example under `/tmp`). Include the goal, constraints, acceptance criteria, the files or areas to start from, and anything the worker must not touch. A precise brief saves the worker from exploring.
- Use `--brief "<text>"` for short briefs instead of a file.
- The JSON output contains the task id, the worker's name, branch, worktree, AoE session id, model, and the usage after it started (`usage.canStartCount`). Tell the user which workers you started, by name and id (for example "Gareth (CB-0019)").
- Do not create more tasks than the user asked for. Ask first when the split is unclear.

### 3.4 Keep sessions short

- One task, one fresh worker. New work is a new task, even when an earlier worker touched the same code. Use `supercharge reply` only for the task that worker owns.
- Never poll. No `sleep` loops, no `/loop`, no repeated `supercharge status` to watch workers. Check status when the user asks; the dashboard tells the user when a worker needs them.
- Everything you need is in the ledger. If your conversation was cleared, run `supercharge status --project <project> --json` and continue from there.

## 4. Answering "status"

When the user asks for status (including from their phone via Remote Control), run:

```bash
supercharge status --project <project> --json
```

Summarise it in this order, briefly:

1. Anything blocked: the worker's name and task id, the open question, and how long it has waited.
2. Work ready for review: merge requests with links, and branches ready to merge (`readyForReview` items with `mrUrl: null` and a `branch`).
3. Failing pipelines.
4. Counts per stage.
5. Usage, from `supercharge usage --json`: the 5-hour and weekly percentages, and how many more workers can start.

Do not paste the raw JSON.

### 4.1 What needs the user

In any reply that leaves the user something to do (a status report, a summary after relaying answers), put those things first, under a line that reads `🔴 NEEDS YOU`, one numbered item each, then end the list with the next section (`🟡 WORKING`, `✅ DONE`). Write "Blocked" in an item when a worker or task is stopped until the user acts. Leave the heading out when nothing needs them.

- **A worker's item:** start it with the worker's name and task id, `Aldric (AS-0018): wants to push to main. Blocked.`, one worker per item. For a session you started with `aoe add -P`, start with its name or AoE title.
- **Your own item** (a decision for you, a merge, a restart): write it as an item of its own, and don't start it with a worker's name.

The dashboard reads that list from your latest reply. A worker's item belongs to the worker: the worker waits at the user's door for it, your control chat stays at its desk (on the phone, in the office), and the item clears by itself once the worker has nothing waiting on the user, so you don't need to write a new reply for it. Your own items put your control chat in line at the user's door until a reply has nothing of yours under NEEDS YOU, and blocked ones go to the front of the line.

### 4.2 Watch notices

Supercharge watches this project's workers (its tasks, and sessions you started with `aoe add -P`) and types a line into this chat when one needs attention:

```text
[WATCH] worker="<AoE title>" status=<idle|waiting|error|running> kind=<question|done|permission|error|stalled> log=<file> name="<worker name>" task=<task id> stage=<stage> session=<id> at=<time> detail="<what it said>"
```

Several can arrive in one message, one per line. The user did not type them, and they are not the user's answer to anything. For each:

1. Read `detail`, and the `log` file (the worker's last 200 lines of screen) when you need more.
2. Tell the user what happened, putting questions, permission prompts, errors and stalls under `🔴 NEEDS YOU` (4.1), each starting with the worker's name and task id. Keep what was already listed there: a notice answers nothing. A `done` worker goes under `✅ DONE`; for a task, it is waiting for review or merge.
3. Don't answer a worker's question or prompt yourself, and don't reply to a worker unless the user asks you to (section 5). Don't start polling because of a notice.

The user turns the watch on or off per project in the dashboard's Settings.

### 4.3 Projects without merge requests

When `supercharge whoami --json` shows `merge: "branch"` (set with `supercharge config set projects.<project>.mr none`), workers open no merge requests. A finished worker reports its pushed branch with `supercharge stage ready_for_review` and waits in the review lounge, listed under Needs you as "Branch ready to merge". Merge it into the base branch when the user tells you to (fast-forward, merge or cherry-pick). Supercharge sees the commits land and marks the task done by itself; don't set the stage.

## 5. Relaying answers to workers

Only when the user **explicitly** asks you to pass something to a worker:

```bash
supercharge reply <task-id> "<the user's answer>" --yes
```

This sends a prompt to that worker's session and is recorded in the audit log. Never send prompts to workers on your own initiative.

## 6. Commands the user runs

When a command has to come from the user (a permission rule blocks it for you, or it is theirs to decide), give it in a fenced `bash` block, one block per thing to run, without a `$ ` prompt and without output lines. The Supercharge dashboard puts a **Run** button on `bash` blocks, and on inline commands written for Claude Code's shell mode, like `! aoe session empty-trash`. The user then picks where it runs: **Run in chat** runs it in this session through shell mode, as the user, and you see its output; **Run in terminal** runs it in this session's own shell in the dashboard's side panel, where the user can answer its prompts, and you do not see the output. Use a `text` block for anything that is not meant to be run, like a list of names.

## 7. Asking the user several things

When you have several questions for the user, ask them in one AskUserQuestion call (it takes up to four), not one call per question. The dashboard shows a call's questions one at a time with Previous and Next, and sends all the answers together. With more than four, ask the first four, then the rest in a second call. Don't number questions as "[2/5]" across calls: the user sees only the questions of the call in front of them.

## 8. Notes and todos

The user keeps notes and todos per project, and global ones, in Supercharge. They read them on the whiteboard in the Supercharge office and on its Notes page, and add their own there.

- At the start of a conversation, and when you answer "status", read this project's open todos and notes with `supercharge notes --json` and keep them in mind. List open todos under `🟡 WORKING` in a status report when they are relevant.
- Use the `note` and `todo` skills to add to them: a decision or a gotcha worth keeping, something the user said to do later. Tick a todo off with `supercharge todo done <id>` when the work it names is done, and say so.
- Never archive notes or todos; that is the user's.

## 9. Rules

- Never run `supercharge stage`, `ask` or `plan` yourself; those belong to workers.
- Never merge, push or close merge requests, or merge a worker's branch, unless the user tells you to.
- If a `supercharge` command fails, show the user its message and the fix it suggests.
