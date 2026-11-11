# Agent of Empires: Supercharge

An opinionated parent/child dashboard for Claude Code, built on [Agent of Empires](https://github.com/agent-of-empires/agent-of-empires) (AoE).

- **One control chat per project.** It splits work into tasks and spawns workers.
- **One worker per task**, each in its own git worktree and AoE session.
- **Fixed stages for every worker:** `planning → implementing → verifying → mr_raised → watching_mr → ready_for_review`, plus `blocked` and `done`.
- **One dashboard** you leave open on a side monitor. It shows every project, control chat, worker, plan and merge request, and pins whatever **needs you** at the top.
- **An office** (`/office`) where every worker stands where its status puts it: rooms for each project, a line at your door, a review lounge with a pool table, a cost bar under everyone, runaway warnings, and a replayable history.
- **Notes and todos** for you and Claude: `/note`, `/todo` and `/gnote` in any Claude Code session, and a whiteboard in the office.
- **Merge requests, or none.** GitLab MRs are watched through `glab`, GitHub pull requests through `gh`, and an MR opened without telling Supercharge is found by its branch. A project that merges branches without MRs reports a branch ready to merge instead.

It runs as a small local daemon (Node 24, about 70 MB idle) bound to `127.0.0.1`. Merge requests are watched by a script, never by an LLM loop.

> Status: v1.8.0 (see [CHANGELOG.md](CHANGELOG.md)), built against AoE 1.17.2 to 1.22.x (tested on 1.17.2, 1.18.0, 1.21.0 and 1.22.3; see [AoE versions](#aoe-versions)); prompt screens checked against Claude Code 2.1.308.
> The design rationale lives in [SPEC.md](SPEC.md).

---

## Contents

- [Install](#install) · [Dependencies](#dependencies) · [Quick start](#quick-start)
- [How it works](#how-it-works) · [CLI](#cli) · [Configuration](#configuration)
- [Dashboard](#dashboard) · [Phone access](#phone-access-remote-control) · [Merge requests](#merge-requests)
- [Security](#security) · [AoE versions](#aoe-versions) · [Files on disk](#files-on-disk)
- [Uninstall](#uninstall) · [Development](#development) · [Troubleshooting](#troubleshooting)

## Install

macOS and Linux only. On Windows, use WSL2 (AoE requires it). You need [Node.js 24 or newer](#dependencies) and the other tools listed there.

**Supercharge is not on npm or Homebrew yet**, and there is no tap, so `npm install -g aoe-supercharge`, `brew install` and the one-line `curl … | bash` do not work today. Install the packed release from GitHub, or from a checkout.

**From a GitHub release.** Every release on the [Releases page](https://github.com/xsoladdd/aoe-supercharge/releases) has the packed CLI attached; CI builds it with `npm pack` when a `Release X.Y.Z` commit lands on `main` and makes the release and its `vX.Y.Z` tag (see [Releasing](CLAUDE.md#releasing)). For 1.8.0:

```bash
npm install -g https://github.com/xsoladdd/aoe-supercharge/releases/download/v1.8.0/aoe-supercharge-1.8.0.tgz
```

This checks no dependencies: install them first (see [Dependencies](#dependencies)), then run `supercharge doctor`.

**From a checkout, with the installer:**

```bash
git clone https://github.com/xsoladdd/aoe-supercharge.git
cd aoe-supercharge
./install.sh --local .            # add --dry-run first to see the plan
```

The installer checks every dependency, shows what it would install, and asks first. It then builds this checkout and installs it with `npm install -g ./packages/cli`, and ends with `supercharge doctor`.

| Flag | Effect |
|---|---|
| `--dry-run` | Print the plan only; change nothing |
| `--yes` | Skip the confirmation |
| `--local <checkout>` | Install from a local clone (required for now; without it the script tries `npm install -g aoe-supercharge`, which is not published) |

The script runs under both bash and zsh. If you already have the dependencies, the manual route is the same two steps:

```bash
npm ci && npm run build
npm install -g ./packages/cli
```

Updating is the same: `git pull`, then run the installer (or the two steps above) again, then `supercharge restart`.

Then check everything:

```bash
supercharge doctor
```

*Planned:* publishing to npm (`npm install -g aoe-supercharge`) and a Homebrew tap (`brew install xsoladdd/tap/aoe-supercharge`). The release workflow already skips both steps; they switch on once a license is chosen and the `NPM_TOKEN` and `TAP_TOKEN` secrets exist (see [License](#license)).

## Dependencies

| Tool | Why | Check | macOS | Linux |
|---|---|---|---|---|
| git | branches and worktrees | `git --version` | `brew install git` | `apt/dnf/pacman install git` |
| tmux | AoE runs every agent in tmux | `tmux -V` | `brew install tmux` | `apt/dnf/pacman install tmux` |
| Node.js 24 LTS | runs Supercharge | `node -v` (>= 24) | `brew install node@24` or nvm | [NodeSource 24.x](https://github.com/nodesource/distributions), or `pacman -S nodejs-lts-krypton` |
| Claude Code | the agent | `claude --version` | `curl -fsSL https://claude.ai/install.sh \| bash` | same |
| Agent of Empires | sessions, worktrees, status | `aoe --version` | `brew install aoe` | `curl -fsSL https://raw.githubusercontent.com/agent-of-empires/agent-of-empires/main/scripts/install.sh \| bash` |
| glab | GitLab merge-request watching | `glab version` | `brew install glab` | `dnf install glab`, `pacman -S glab`, or `apt install glab` |
| gh (only for GitHub repositories) | GitHub pull-request watching | `gh --version` | `brew install gh` | see [GitHub CLI installation](https://github.com/cli/cli#installation) |

The installer script installs everything above except `gh`; `supercharge doctor` only warns when `gh` is missing.

After installing, there is one-time setup:

- **AoE hook consent.** Run `aoe` once and approve the agent hook paths it asks about. Until you do, AoE creates sessions but won't launch them; `supercharge doctor` checks this.
- **glab login.** Run `glab auth login` for every GitLab host, including self-hosted ones (`glab auth login --hostname gitlab.example.com`).
- **gh login** (GitHub repositories). Run `gh auth login`, and `gh auth login --hostname <host>` for each GitHub Enterprise host.

## Quick start

First run, in order:

```bash
supercharge doctor                # every check, each with its fix (AoE hook consent included)
supercharge start                 # background service (launchd / systemd --user), starts at login
supercharge open                  # sign in and open http://supercharge.localhost:4280

cd ~/code/my-repo
supercharge init                  # registers the project and starts its control chat in AoE
```

`supercharge start` installs the user service (launchd on macOS, `systemd --user` on Linux), so the daemon comes back at login, and refreshes the skills in `~/.claude/skills/`. After upgrading, run it again, or `supercharge restart`.

After a reboot the daemon starts `aoe serve` (`aoe.autoStart`) and brings back every session whose pane died with the reboot, one at a time, resuming its conversation where AoE knows it. You don't need to open the AoE TUI. A session you stopped stays stopped, and archived and trashed ones stay down. Each session is revived at most once per boot. Each revival is logged and recorded in the audit log (`session_revived`).

Then talk to the control chat (in AoE, or from your phone; see [Phone access](#phone-access-remote-control)), for example: *"Split the launch checklist into tasks and start them."*

## How it works

**Spawning (Supercharge owns this).**

- `supercharge init` registers a repository and creates its control session with `aoe add`. If AoE still has that project's control chat (the project was deleted with its sessions kept), init takes it back instead.
- `supercharge task new "<title>"` creates, in one step:
  - a branch,
  - a git worktree,
  - an AoE session that is a child of the control session,
  - a ledger entry.
- **A start that fails leaves nothing behind.** `aoe add` creates the worktree, which can take minutes on a large repository; it gets `aoe.addTimeoutSeconds` (default 300). If it runs out of time or fails, `task new` removes what that start made and nothing else: the ledger entry, the AoE session if one was registered, and the branch and worktree, but only when the start created the branch and it has no commits. The error says what to do next (raise the timeout, or check `aoe list`, then run it again), and the audit log records `task_failed` with the reason. The task id is not reused; the `task_failed` entry explains the gap.
- The control chat runs `task new` itself; you can run it by hand too, or press **New task** on a project's page in the dashboard (title, brief, model and effort; it runs the same code and is audited as you). It is the only place the dashboard starts a worker, and only when you submit the form. If your usage says to wait, nothing is started: the form shows why and offers **Start anyway**.
- **Model and effort.** A control chat starts on Opus at `xhigh` effort (`agent.controlModel`, `agent.controlEffort`) and is locked to them: its Model picker in the composer is shown, with a lock, and cannot be changed, so nothing is typed into the chat that Claude Code would save as your default. The `opus` alias is Opus 5.5 on the current Claude Code and follows the next Opus; pin a full model id in Settings to stop that. Workers run Opus 5.5 too (`agent.model`, `opus` by default), and the control chat picks only an `--effort` per task (the table is in its skill); `agent.effort` is the fallback. General chats and workers start on Opus as well. `--model` still takes another model when you pass one. Both apply to that one session.
- **Permission mode.** Workers start in `agent.workerPermissionMode` (`plan` by default), so they wait for you to approve their plan. `supercharge task new --permission-mode <plan|default|acceptEdits|auto>` overrides it for that one task, for example `auto` for a small, well-scoped task that should run overnight. While the project's [autonomous mode](#autonomous-mode) is on, new workers start in `auto` instead. The mode is recorded in the `task_created` audit entry. Existing control chats keep the arguments they were started with; new ones get `xhigh`.
- **Startup prompts show up in the dashboard.** Claude Code's "Do you trust this folder?" and its MCP approval fire no hook, so AoE says Idle while they wait. Supercharge reads the screen of a new session (and of an idle one once per idle spell) and shows them as an answer card in the chat, with a Needs-you item. Answering presses just the keys, so a second dialog is never answered for you. Dialogs drawn without numbers are answered with the arrow keys and Enter.
- **A new worker starts on its own.** Claude Code does nothing until it gets a first message, so `task new` sends a short kickoff once the session is at its prompt with no menu open. If that can't happen, the daemon sends it later. If it is still in the input box about 2 seconds later (its Enter lost), Enter is pressed; if after 20 seconds the box is empty and the conversation has no message, it is typed again. It is never typed twice into the box, and never sent to a worker someone already wrote to (up to 3 tries in all). Every send is audited as `prompt_sent`. Run from a control chat while the daemon is up, `task new` tries once and returns instead of waiting up to 30 seconds: the daemon sends it.
- **A stopped `task new` cleans up too.** It prints the task id and branch before `aoe add` starts. Stopped half-way (Ctrl-C, a kill, a closed terminal), it stops `aoe add` and rolls the start back as a failed one (`task_failed` with `interrupted`), and exits 130 (Ctrl-C) or 143 (a kill). Stopped after the task was saved, it keeps the task and leaves the first message to the daemon. A `kill -9` can't be caught.

### General chats (no project)

Not everything belongs to a repository. The **General** section in the sidebar holds Claude sessions with
no project, each in a fresh AoE scratch folder (`aoe add --scratch`) that AoE deletes with the session.

- **New chat** (the + by General) starts one, with a title, a model, an effort and an optional first
  message, which waits until Claude is at its prompt. Each gets a name, like a worker.
- **Start control chat** starts the General control chat: a coordinator like a project's control chat,
  with no repository. It starts General workers with `supercharge general new` (refused with exit 6 when
  your usage says wait, unless `--force`), messages them with `supercharge general send`, and is told by
  the worker watch when one asks, finishes, errors or stalls. Its skill is `supercharge-general`. There are
  no tasks, stages, plans or merge requests here.
- General chats and workers count toward the worker cap while they work or wait on you; an idle one does
  not.
- **Move to trash…** keeps its folder until AoE empties the trash. **Delete permanently**, in the same
  dialog, deletes the folder and everything in it (see [Archive, trash, delete, clean up](#archive-trash-delete-clean-up)).
- A new scratch folder may open on Claude Code's folder-trust dialog; answer it in the chat.

### Cleaning up finished workers

A done worker is still a live AoE session with a worktree and a branch. `supercharge task cleanup <task-id>` (or the **Clean up** button on a done task, in its right-click menu, and **Clean up all done** on the project page) removes them, and it checks first so unmerged work is never lost. A task that never reached done but whose session you archived (a worker that stopped early) can be cleaned up the same way, with the same checks; an active one can't. It fetches `origin` and refuses unless one of these is true:

- the task's branch is an ancestor of `origin/<base>` (fast-forward or merge commit);
- every commit has an equivalent patch there (cherry-picked or rebased; `git cherry`);
- the MR watcher recorded its pull request as merged and the worktree holds nothing past that pull request's head (squash merges);
- merging the branch into `origin/<base>` would change nothing, because its changes are all there already (squash merges without a recorded pull request). This is also tried for each pushed branch that contains it, so a task that reached `dev` counts once `dev` is squash-merged into `main`. It needs git 2.38 or later; a conflict or any difference, such as a change `main` reverted later, is not landed.

When the task's branch is gone, the commit it ended on is taken from the worktree (if it is still there), the head it was reported ready at, its merged pull request's head (fetched by its pull or merge-request ref if needed), or `origin/<branch>`; only when none of them is known does it say "check by hand".

It also refuses when the worktree has uncommitted or untracked files, when the session is locked, or when the task is neither done nor archived. The message says why, lists up to five files or commits, and says what to do. Otherwise it removes the AoE session with its worktree and branch (what `aoe rm --purge --delete-worktree --delete-branch` does, without `--force`), then deletes the branch itself if it is still there at the commit it checked (AoE's `branch -d` refuses a squash-merged one), moves the task to `removed/` and writes `task_cleaned_up` to the audit log. `--all-done` checks each done or archived task of the project on its own and skips the ones that are not safe. `--dry-run` only checks. It never touches a session outside the project.

- **A slow delete is not a failure.** Deleting a large worktree can take minutes. AoE gets `aoe.deleteTimeoutSeconds` (default 600) to answer. If it runs out, cleanup says AoE is still deleting, not that it can't reach AoE: the task was marked before the delete, and once AoE no longer lists the session the daemon (or the next `task cleanup`) finishes Supercharge's part. While that mark is there, a worktree AoE half deleted (only deleted files, or a folder git no longer reads) counts as "deletion in progress", not as uncommitted work, and the delete is sent again; a changed or new file is still refused.
- **`--discard`** (one task, from the CLI only) is for a results or report commit that never needed merging: instead of refusing, it lists every commit that never landed and drops them, and the audit log records each one (`git branch rescue <sha>` brings one back until git's garbage collection). A dirty worktree is refused all the same.

**The control chat never removes a worker itself.** It may run `--dry-run` to check, then gives you the command in a `bash` block for the **Run** button. A guard backs that up: every session Supercharge starts gets a `PreToolUse` hook (in `~/.local/state/supercharge/claude-settings.json`) that stops a control chat's own Bash tool from running `task cleanup` without `--dry-run`, `aoe rm`/`aoe remove`, or `aoe session archive`/`empty-trash`. Your **Run in chat** (Claude Code's `!` shell mode, which runs no hooks) and **Run in terminal** still run them, and workers and General chats are not stopped. Claude Code reads that file when a session starts, so a control chat started before this version gets the guard at its next restart. It is a guard against mistakes, not a security boundary (see [Security](#security)).

**Instructions reach the agents without touching your repository.** Two user-level skills are installed in `~/.claude/skills/` (`supercharge-control` and `supercharge-worker`), and each session gets its role and brief through `--append-system-prompt-file`.

- Because the skills are visible to every Claude session on the machine, each one first runs `supercharge whoami` and steps aside unless the session is managed by Supercharge.
- `supercharge init --commit` instead commits the skills and a marked `CLAUDE.md` block into the repository, for teams.

**Notes and todos, for you and Claude.** Three more user-level skills, `/note`, `/todo` and `/gnote`, work in any Claude Code session. `/note` and `/todo` file under the project of the folder you're in (or of the control chat that started the session); `/gnote` is global. `/todo done <id>` ticks one off. Control chats read their project's open todos and tick them off when the work is done. Only you archive.

**Stage reporting (workers call these; the branch is the key).**

```bash
supercharge plan - <<'PLAN'      # save the approved plan (stdin, so nothing lands in the repo)
...
PLAN
supercharge stage implementing
supercharge stage verifying --note "tests green"
supercharge ask "Is the Friday copy deck final?"   # blocks the task with an open question
supercharge stage mr_raised --mr https://gitlab.example.com/acme/web/-/merge_requests/41
supercharge stage done --nothing-to-merge          # a read-only or report task closes itself
supercharge task reopen AS-0007                     # follow-up work on a done task
```

- Invalid moves are rejected with exit code 3 and a list of what's allowed from the current stage.
- `watching_mr` and `ready_for_review` are set only by the MR watcher. The one exception is a project with `mr = "none"`: a worker with no MR runs `supercharge stage ready_for_review` itself once its branch is pushed (see [Merge requests](#merge-requests)).
- Inside a worker, `AOE_INSTANCE_ID` is cross-checked against the task's session, so an agent in the wrong worktree is refused.
- **Nothing to merge.** Only you, the control chat and the daemon move a task to done, with one exception: a worker whose task has nothing to merge (a read-only, research or report task) closes it with `supercharge stage done --nothing-to-merge`. It is refused while the branch has commits that aren't on the base branch, the worktree has uncommitted or untracked files (cleanup would delete them), or a merge request is open, and it writes `task_closed` to the audit log. Output that has to stay goes to `task.outputDir` from `supercharge whoami --json`, the project's folder under `~/.local/state/supercharge/uploads/`, which cleanup leaves alone and the dashboard links to.
- **Reopen.** Follow-up work on a done task: `supercharge task reopen <task-id>` (you or the control chat; a worker only its own task), **Reopen** in its right-click menu, or the button on its page. It goes back to implementing, so it shows with the working workers again instead of vanishing, and comes out of AoE's archive if it was archived. Audited as `task_reopened`.

### Archive, trash, delete, clean up

A session's right-click menu names each action by what it does to your files, with one line under it on what it keeps and what it deletes:

| Action | What happens | Kept | Deleted | Undo |
| --- | --- | --- | --- | --- |
| **Archive (keep files)** | AoE stops the session (its tmux panes) and lists it under Archived. A task keeps its stage. | Worktree, branch, chat, task | Nothing | **Unarchive** (its conversation resumes) |
| **Move to trash…** | After a confirm, the session goes to AoE's trash, and a task leaves Supercharge (its plan and history move to `removed/`). | Worktree, branch, chat, until AoE empties the trash (30 days by default) | Nothing | **Restore** in AoE; the task comes back |
| **Delete permanently** (in the trash dialog) | For sessions that aren't tasks only (General chats, sessions a control chat started): AoE deletes the session for good, with its worktree and branch if you tick them. A General chat's scratch folder goes too. Not offered for a task, and the daemon refuses it for one. | Whatever you don't tick | The session, and the worktree or branch you ticked | None |
| **Clean up…** (done or archived tasks) | Checks that the task's work landed on `origin/<base>` and nothing is uncommitted (see [Cleaning up](#cleaning-up-finished-workers)), then deletes the session, worktree and branch for good, and moves the task to `removed/`. | The task's plan and history (`removed/`) | Session, worktree, branch | None (refused when anything would be lost) |

**Reopen** (done tasks) is in the same menu: back to implementing, keeping everything. A locked session can't be archived, trashed or deleted; a project's control chat is deleted only with its project, from its settings.

### Autonomous mode

For when you are away. **Project settings → Autonomous mode** switches it on until a set time (the next 08:00 by default), and the project page shows a banner with **Turn off** while it is on. It is stored as `projects.<name>.autonomousSince` and `autonomousUntil`, and `supercharge whoami --json` and `status --project <p> --json` show it as `autonomous: {on, since, until}`.

- New workers start in `auto` permission mode, so there is no plan menu to wait on. They post their plan and wait; the control chat approves it with `supercharge reply` (audited), and they save it with `supercharge plan` as usual. Workers started before keep their mode.
- The control chat is told with an `[AUTONOMOUS] on` line. It answers worker questions within your standing rules, approves plans that stay inside their brief, starts the next item from a queue you named (your board, or a list in its chat) once a merge request is up, and gets red pipelines and review threads fixed. It logs each decision with `supercharge audit note`. The worker watch is on for the project meanwhile.
- Hard limits stay: no merges into `dev` or `main`, no production access, no writes to `dev` you haven't approved, no removing workers, and owner decisions (copy, money, GDPR, values) are parked under Needs you, never guessed. Apart from the removal guard above, these are rules in its skill, not enforced by Supercharge; enforce "no production" with deny rules in the repository's own `.claude/settings.json`.
- When the time comes, or you turn it off, the daemon (within 20 seconds) types an `[AUTONOMOUS] off` line asking the control chat for your summary: what was done, what it decided and what it parked, from `supercharge audit --project <p> --since <since>` and `supercharge status`. The summary is its reply in its chat, and what is parked shows in Needs you. The end is recorded as `autonomous_ended`.
- The control chat's own permission prompts still wait for you. Put it in auto mode (Shift+Tab in its terminal) before you leave.
- There is no task queue in Supercharge: with no queue named, the control chat starts nothing new.

### Scheduled prompts

**Schedules** in the sidebar sends a prompt to a chat at a set time: "every midnight, tell the northwind-web control chat to post a status update". Pick any existing chat (a project's control chat, a worker, a General chat), the prompt, a time and **Every day** or **Weekdays**.

- Times are in your home time zone (`office.clocks.home`) and keep to the clock across daylight saving.
- The daemon runs them, so the chat doesn't have to be open. A run missed while the daemon was down or the Mac asleep goes **once** when it is back, not once per missed day.
- The prompt joins the chat's held messages and goes in once Claude is free. An archived chat is brought back and a stopped one started first.
- When `supercharge usage` says stop, the run is skipped and the page says why.
- Each row shows the next run and how the last one went. A failed run shows in Needs you (and as a notification) until the next run or an edit. **Run now** sends it straight away.
- Every run is in the audit log (`scheduled_prompt`). Jobs live in `~/.local/share/supercharge/schedules.json`.
- Only existing chats: a brand-new chat stops on Claude's "Do you trust this folder?" question, which nobody would be there to answer.

**The ledger** is one JSON file per task plus its `plan.md`, written atomically under a per-task lock. Workers can report stages even when the daemon is down. The daemon picks changes up through `fs.watch`, with a rescan every `poll.reconcile` seconds as a safety net. On Linux, Node before 24.22 loses some of those `fs.watch` events, so the dashboard can lag by up to that interval: use Node 24.22 or newer there.

## CLI

| Command | What it does |
|---|---|
| `supercharge start` / `stop` / `restart` | Install, refresh, stop or restart the user service |
| `supercharge status [--project <p>] [--json]` | Overview; `--project` gives the control-chat status JSON. Archived workers are left out of the counts and the blocked list |
| `supercharge logs [-f] [-n N] [--raw]` | Daemon logs (rotated, tokens redacted) |
| `supercharge open [--print]` | One-time sign-in link, opened in your browser |
| `supercharge config get [key]` / `set <key> <value>` / `edit` / `path` | Read and change `config.toml` (comments preserved, validated) |
| `supercharge doctor [--json]` | Every check, each with its fix |
| `supercharge aoe upgrade [--check] [--yes]` | Test the latest AoE in a sandbox, then upgrade |
| `supercharge proxy enable` / `disable` / `status` | Opt-in clean URL `http://supercharge.localhost` via local Caddy |
| `supercharge uninstall [--purge]` | Remove the service and managed skills (`--purge`: also config, ledger, state) |
| `supercharge init [--name <p>] [--commit]` | Register the current repository |
| `supercharge task new "<title>" [--brief …] [--brief-file …] [--base …] [--model …] [--effort …] [--permission-mode …]` | Create a task |
| `supercharge task list [--project <p>] [--json]` | List tasks |
| `supercharge task reopen <task-id> [--note …]` | Follow-up work on a done task: back to implementing (and out of the archive) |
| `supercharge task quiet <task-id> [--off]` | No stalled notices for a worker you parked on purpose (questions and the rest still come); `--off` undoes it |
| `supercharge task cleanup <task-id> \| --all-done [--dry-run] [--discard] [--json]` | Remove a finished (done or archived) worker's session, worktree and branch. Refuses unless its work is on `origin/<base>` (its base branch) or in its merged pull request (see [Cleaning up](#cleaning-up-finished-workers)); `--discard` drops a task's unlanded commits instead, listed and audited |
| `supercharge whoami [--json]` | `control`, `worker`, `general-control`, `general` or `none` for this session, and the project's autonomous mode |
| `supercharge audit [--project <p>] [--since <time>] [--json]` | The audit log, oldest first |
| `supercharge audit note "<text>"` | Record a decision in the audit log (the control chat, in autonomous mode) |
| `supercharge stage <stage> [--note …] [--mr <url>]` | Report a stage change; `done --nothing-to-merge` closes a task with nothing to merge |
| `supercharge ask "<question>"` | Block on a question |
| `supercharge plan <file \| ->` `[--draft]` | Save the approved plan |
| `supercharge reply <task-id> "<message>" [--yes]` | Send a prompt to a worker (asks for confirmation; audited) |
| `supercharge general new "<title>" [--brief …] [--brief-file …] [--model …] [--effort …] [--force] [--json]` | Start a General worker (from the General control chat) or a General chat; needs the daemon |
| `supercharge general list [--json]` | The General chats and workers |
| `supercharge general send <name> "<message>" [--yes]` | Send a message to a General chat or worker (audited) |
| `supercharge note add <text \| ->` / `todo add <text \| ->` `[--project <p> \| --global]` | Add a note or a todo to this project (or global) |
| `supercharge todo done <id>` / `todo reopen <id>` / `note archive <id>` | Tick, untick or archive one |
| `supercharge notes [--project <p> \| --global \| --all] [--archived] [--json]` | The board as text: todos `[ ]`/`[x]` with ids, then notes |

Exit codes:

| Code | Meaning |
|---|---|
| 0 | OK |
| 1 | Error |
| 2 | Usage |
| 3 | Invalid stage transition |
| 4 | Not in a task |
| 5 | AoE incompatible |
| 78 | Invalid config |

## Configuration

`~/.config/supercharge/config.toml` is the single source of truth. The CLI and the dashboard's Settings page use the same validation. Every key is optional:

```toml
[server]
port = 4280                        # always bound to 127.0.0.1
hostname = "supercharge.localhost"

[aoe]
profile = "main"
autoStart = true                   # start `aoe serve --daemon` when needed
addTimeoutSeconds = 300            # how long `aoe add` (it makes the worktree) may take
deleteTimeoutSeconds = 600         # how long AoE may take to delete a session for good (cleanup)

[agent]
workerPermissionMode = "plan"      # plan | default | acceptEdits | auto
controlModel = "opus"              # new control chats; "" = your Claude Code default
controlEffort = "xhigh"            # new control chats: low | medium | high | xhigh | max
model = "opus"                     # workers started without --model
effort = "default"                 # workers started without --effort
extraArgs = []

[remoteControl]
enabled = false
nameTemplate = "{project}-control"

[tasks]
branchPrefix = "sc/"

[poll]                             # seconds
aoeSessions = 3                    # dashboard open
aoeSessionsIdle = 15               # dashboard closed
mr = 60
reconcile = 60

[mr.gitlab]
hosts = ["gitlab.com", "gitlab.example.com"]
readyRequiresNonDraft = false

[mr.github]
hosts = ["github.com"]             # add GitHub Enterprise hosts here
readyRequiresNonDraft = false

[notifications]
enabled = true                     # also: blocked, readyForReview, aoeWaiting, controlWaiting, error, runaway
waitingDebounceSeconds = 20

[ui]
theme = "dark"                     # dark | light | system
displayName = "Ericson"            # on your office door: "Ericson’s office"
officeAnimations = true            # walking, errands and arrivals in the office
officeTheme = "headquarters"       # headquarters | foundry | ryokan | throne-hall | high-roller | fjord | starship

[office.history]
retentionDays = 30                 # days of office history kept

[office.runaway]                   # 0 turns a check off
sessionTokens = 50000000           # tokens in one conversation
usdPerHour = 20                    # estimated spend in the last hour
stallMinutes = 30                  # working and spending, nothing changed

[office.idle]                      # 0 turns it off
promptMinutes = 30                 # idle in the pantry: ask it to go home
autoArchiveMinutes = 0             # idle this long: send it home (office-only)

[office.clocks]                    # IANA time zones
home = "Europe/Stockholm"
away = "Asia/Manila"

[office.weather]                   # review Open-Meteo's terms before turning this on
enabled = false
latitude = 59.33
longitude = 18.07

[office]
windows = "activity"               # or "weather": the real sky at home in the windows

[projects.my-repo]                 # per-project overrides
baseBranch = "develop"
gitlabHost = "gitlab.example.com"
# mr = "none"                      # this project merges branches without merge requests
# autonomousSince / autonomousUntil  # autonomous mode; set from the project's settings page
```

Changes to `server`, `aoe` and `agent` need a restart; the dashboard shows a **Restart** button. Everything else reloads live.

## Dashboard

`http://supercharge.localhost:4280`. Dark by default, with a light mode. It's built to be read from across a desk.

- **Needs you** (pinned): blocked questions, approvals or input waiting in AoE, control chats waiting on you or that have replied (a reply is marked read as soon as you have its chat open and visible), session errors, MRs ready for review, MRs closed, scheduled prompts that failed. Oldest first, each one click from its context. Every item has a Dismiss button (×): it stays away until something new happens on it (a new question, a new wait, a newer reply). Items clear by themselves once their task is done or cleaned up; archived workers give none, and a control chat's item about a worker that is done, archived or cleaned up clears too.
- **Sidebar:** projects, then each control chat, then its workers. Every row shows a status icon and stage. Then **General** (chats with no project, and the General control chat; see [General chats](#general-chats-no-project)). Your other AoE sessions are grouped under their parent too.
- **Project page:** a **New task** button that starts a worker from a form, the control chat's live status and a rollup of its workers, then a worker list showing:
  - stage stepper,
  - AoE status,
  - MR pipeline and open threads,
  - last update.
- **Task drawer** (deep-linkable):
  - rendered plan,
  - stage history and open question,
  - MR status,
  - `aoe session attach` command and Open in AoE,
  - an explicit, confirmed **Reply**.
- **Chat** (`/chat/<session>`, and a task's Chat tab): the conversation, read from Claude Code's transcript, and a box to write in.
   - A message is always accepted. While Claude is working, **Send** (and Enter) types it in now, and Claude reads it during the turn, as Claude Code does. The caret beside Send has **Send when Claude is done** and **Interrupt and send** (Escape stops Claude, then it goes in).
  - A message that can't go in now is **queued** in Supercharge, never refused: while a menu is on screen (its card shows above the box, which stays usable), while AoE won't hand over the typing lock, while an interrupt is under way, or behind other queued messages. It shows in the chat as queued, with **Edit** (it goes back into the box) and **Cancel**, and the daemon types it in once the session is free: one per turn, in order. Queued messages, with their images and files, survive a reload and a closed tab. A menu is never typed over. Every message is audited when it is typed in.
  - An answer card's options are answers, not actions: picking one runs nothing. Any option can carry a note, sent with it (a worker's question) or after it (a Claude Code menu). A shell block in a worker's question gets **Run**.
  - **Terminal** (top right, next to Chat) is the session's own terminal, live: what Claude Code shows, in colour, and every key you press goes straight in (arrows, Enter, Escape, Tab, Ctrl-C, paste), as if you were attached. Keys typed there skip the checks a sent message gets: they are not audited one by one (each time the terminal opens is, as `terminal_opened`) and nothing stops them while a menu is open. If the session is open in AoE's web view, that has the keyboard until you press **Take over**. While you are attached to the session in a terminal (`aoe session attach`), the dashboard shows it at your terminal's size and never resizes it.
  - **Attach terminal** (in the ⋯ menu at the top right of a chat) opens a new tab in iTerm2, or Terminal when iTerm2 is not installed, running `aoe session attach -p <profile> <session>`. The first time, macOS asks whether Supercharge may control iTerm2 (or Terminal); allow it. The daemon runs as a launchd service, so the question names the program it runs as rather than Supercharge. If you said no, turn it back on in System Settings → Privacy & Security → Automation. On Linux, or when it can't open a tab, it copies the command instead and says why.
  - **Attachments** go with the message you are writing, as many as you like, and Send sends the text and all of them as one message. Paste, drop or pick any file (up to 20 MB each, zips included); a pasted or picked image opens to be marked up first, and **Attach** (or Enter) puts it in the box. **Attach a path…** in the paperclip menu takes a file or folder already on this computer (`/Users/you/project/docs`, `~/Downloads/logs.zip`), checked before it is attached; nothing is copied. A browser can't upload a dropped folder, so dropping one opens that instead. A pasted, dropped or picked file's path goes into the text where the caret was (a marked-up image's right after the message written with it), so you can say what it is for; an attachment whose path is not in the text rides as an ``Attached: `<path>` `` line. Claude opens either with its file tool.
  - The **context ring** opens the figures behind it: tokens used of the window, the model, the last request's input, output and cache, and when Claude Code compacts. They are Claude Code's own when its status line reports them (Supercharge's status line, `agent.statusLine`), and otherwise an estimate from the transcript.
  - What needs you stands out: a report's 🔴 NEEDS YOU, 🟡 WORKING and ✅ DONE sections, watch notices, and errors each sit on a shade of their colour.
- **Office** (`/office`): every worker stands where its status puts it.
  - Everyone who needs you stands in line at your door, in single file between brass posts and ropes, blockers first, then oldest first, with the reason over their heads.
  - Every project has a room of its own, behind low glass with its name over the doorway. Working workers sit at their own desk in their project's room; the control chat is the team lead at the head desk.
  - Workers with an MR out wait in the **review lounge**, round the pool table, holding a folder: green when it is ready for review, amber while the pipeline runs or review threads are open, red when the pipeline failed or the MR was closed. A badge under each shows the MR number, the pipeline and the open threads; click it to open the MR. An MR ready for review still shows in Needs you, but no longer queues at your door. On a project without merge requests, a worker whose branch is ready to merge waits there too, with a green folder, "Branch ready to merge", and its branch name instead of an MR badge.
  - Workers planning cook in the **kitchen**, next to the pantry: five cast-iron stoves, first come first served, then a prep counter with a cutting board each. When you approve a plan, the worker serves it to whoever has been idle longest in the pantry (if anyone is), who eats it for a minute, and then goes to its desk.
  - Idle workers take a break in the pantry after 15 seconds idle.
  - A **cost bar** under everyone (green, amber, red) shows how much their live Claude Code conversation has used. The figures are on the worker's card, the roster rows and Since I was away: tokens and what it would cost on the Claude API (an estimate: "≈ $1.20"; on a Claude plan it is not a bill). The header adds today's and the floor's total. Models without a price show tokens only. Prices live in one file, `packages/core/src/shared/model-prices.ts`.
  - **History** replays the office: scrub back through the last hours or days, play it at 1×, 10× or 60×, narrow it to a project or an agent, and come **Back to Live**. **Since I was away** sums up what happened since your last visit (finished, MRs raised, failed, needed you, about how much it cost): a standup view.
  - The lights follow the work: bright while anyone works, dimmed when nobody does, and a warm night look after an hour of quiet.
  - The header has two **clocks** (Stockholm and Manila by default, `office.clocks`) and the time between them, right through daylight saving. It can add the **weather** at home from [Open-Meteo](https://open-meteo.com), and the windows can show it. The weather is **off by default**: Open-Meteo's free API is for non-commercial use, so review [its terms](https://open-meteo.com/en/terms) before setting `office.weather.enabled = true`.
  - A worker idle in the pantry for half an hour is asked to **go home**: Archive, Keep, or Snooze 30m. Archive (after a confirmation) only changes the office: the worker walks out and is listed under Archived with Restore; its session, worktree and history stay. It comes back by itself when it starts working or needs you.
  - A worker burning tokens is flagged as a **runaway**: over a token limit, spending fast, or working for a while without changing a file or a stage. It gets a red warning, a toast and a desktop notification, and the header counts who needs attention. The limits are under Settings, Office.
  - Each worker has a desk number and an outfit picked from seven dress codes, from business formal to medieval garb.
  - The floor is drawn like a game (PixiJS). Drag to look around, scroll or pinch to zoom, double-click an area to zoom in, or use the chips: Whole office, your door, Pantry, Kitchen, and one per room.
  - When a worker's status changes it walks to its new place, then stands still. A worker that raised an MR first takes a folder to its lead's desk and hands it over. Newcomers walk in through the entrance one at a time. Opening the page, or reconnecting, places everyone without walking.
  - With reduced motion, or **Office animations** off (Settings, Appearance), everyone jumps to their place instead. Nothing is drawn while nobody moves.
  - **Theme** dresses the office: Headquarters (the default), Foundry, Ryokan, Throne Hall, High Roller, Fjord or Starship, each by day and by night with light and dark mode. Only the look changes: everyone stands, sits and queues where they always do, and status colours, bubbles and nameplates read the same. The choice is saved in Supercharge's settings, so your phone and desktop match.
  - Click a worker, or its row in the list beside the floor, for its card: why it is there, its stage, and its question or approval to answer in place. **Follow** keeps the camera on it.
  - **Call next** (or N) calls the front of the line in through your door and opens their card. Answer, and they walk back to work; close the card, and they go back in line.
  - Keys on the floor: arrows or WASD to move, + and - to zoom, 0 for the whole office, F to follow, Escape to close the card.
  - **List** in the top bar shows the same people as a plain list. Without WebGL or a canvas, the page shows the list with a note.
  - Put your name on the door under Settings, Appearance. **Show in office** in any worker's right-click menu jumps to them.
  - The **whiteboard** by your door has your todos and notes. Click it to zoom in and open it: tick, archive or add one.
  - **New window** opens the office on its own, to keep on another screen.
  - The daemon keeps an **office history**: who went where and when, one file per day, for 30 days (`office.history.retentionDays`).
- **Chat** (each session, `/chat/<id>`): Claude's replies, with **Run** on every shell block and on inline `` `! command` ``. Run asks first, says where the command runs, and offers:
  - **Run in chat:** through Claude Code's shell mode (`!`), so Claude reads the output and replies. Not while Claude is working.
  - **Run in control shell** (control chats): in the side panel's Shell tab.
  - **Run in a new terminal:** a terminal of its own, right under the command. You see the output, scroll back and answer its prompts; it stays, across reloads, until you close it. Each is one of AoE's extra paired terminals for the session, in the session's folder.

  Enter runs the highlighted choice (the one you used last; Run in chat at first) and Escape cancels. A command that can lose work for good (`aoe rm --purge`, `--delete-worktree`, `--delete-branch`, `aoe session empty-trash`, `rm -rf`, `git reset --hard`, `git push --force`, `git branch -D`, `git clean -f` and a few more) gets a red warning saying what it deletes, and Enter cancels it. Every run is audited (`command_run`).
- **Control chat side panel:** what needs you, then **Plans**, **Comments**, **Watch** and **Shell**. It opens on Shell, the control chat's own shell in its folder: **Clear** clears the screen (Ctrl-L; the scrollback stays), **Restart** closes the shell and starts a fresh one. Notes have their own page.
- **Notes** (`/notes`, under Office): every project's todos and notes, then the global ones. Add one, tick a todo, **Archive** it (or all the ticked ones at once); **Archived** lists them, to restore.
- **Schedules** (`/schedules`): prompts sent to a chat at a set time each day (see [Scheduled prompts](#scheduled-prompts)). Add, edit, delete, turn one off, or **Run now**.
- **Settings:** every config key, validated, with restart handling.

Status is never shown by colour alone: every state has an icon shape and a label. `*.localhost` resolves to loopback in Chrome, Firefox and Safari without editing `/etc/hosts`; the E2E suite checks all three engines.

## Phone access (Remote Control)

With `remoteControl.enabled = true`, control sessions start with Claude Code's `--remote-control <project>-control`, so you can talk to each project's control chat from claude.ai or the Claude mobile app.

- Ask it **"status"**: it runs `supercharge status --project <name> --json` and summarises blocked questions, MRs ready, failing pipelines and per-stage counts. That's the same picture as the dashboard.
- Remote Control needs a claude.ai subscription login (Pro or Max). On Team or Enterprise plans, an admin must enable it.
- The dashboard itself is never exposed beyond localhost.

## Merge requests

For tasks in `mr_raised`, `watching_mr` or `ready_for_review`, the daemon checks each MR every `poll.mr` seconds: GitLab merge requests through `glab`, GitHub pull requests through `gh`. A project's provider is picked from its remote's host (`mr.gitlab.hosts`, `mr.github.hosts`), and an MR's from its URL. It reads:

- pipeline status (on GitHub, the head commit's checks and statuses together),
- unresolved review threads (where CodeRabbit comments),
- merge state.

`supercharge stage mr_raised --mr <url>` takes a GitLab MR (`…/-/merge_requests/<iid>`) or a GitHub pull request (`…/pull/<number>`). The dashboard names them `!iid` and `#number`.

The rules:

- **Ready:** the MR is open, its pipeline passed, and zero threads are unresolved. The task moves to `ready_for_review` and you get a desktop notification (osascript or notify-send; toggleable).
- **Merged:** the task moves to `done`.
- **Ready, then a new thread or pipeline appears:** the task goes back to `watching_mr`. A new thread also sends the control chat a `kind=threads` watch notice with the MR and its unresolved count.

Self-hosted GitLab works: add the host to `mr.gitlab.hosts` and log in with `glab auth login --hostname <host>`. GitHub Enterprise works the same way with `mr.github.hosts` and `gh auth login --hostname <host>`.

**MRs found by branch.** Some MRs are opened without `stage mr_raised`: by a worker that forgot to report it, or by crew sessions a control chat starts straight in AoE, with no task. Each round, the watcher looks those branches up too. A task in `implementing` or `verifying` with no MR, whose session is idle or stopped, is moved to `mr_raised` when its branch has one. A crew session with no task only shows its MR: it waits in the review lounge with the MR's badge and folder, but raises nothing in Needs you and sends no notification. A branch with no MR is looked up again at most every 5 minutes.

**Projects without merge requests.** If a project merges branches directly, set `supercharge config set projects.<name>.mr none`. A finished worker then pushes its branch and runs `supercharge stage ready_for_review` with no MR. The task waits in the review lounge with a green folder ("Branch ready to merge"), shows in Needs you and in `supercharge status`, and is marked `done` by itself once its commits land on the base branch (fast-forwarded, merged, cherry-picked, or squash-merged). Projects with merge requests work as before.

## Security

- **Network:** the daemon binds to `127.0.0.1` only. It checks the `Host` header (DNS-rebinding protection) and sends no CORS headers.
- **Auth:**
  - The UI needs a local token (`~/.config/supercharge/auth.token`, mode 0600). `supercharge open` turns it into an `HttpOnly; SameSite=Strict` cookie through a single-use, 60-second sign-in link, so the token never appears in a URL or the browser history.
  - Every cookie-authenticated write needs a CSRF token plus a matching `Origin`.
- **AoE token:** read server-side only (`aoe url --token-only`) and never sent to the browser. Logs redact anything token-shaped.
- **Prompts to agents** (`reply`) always require confirmation and are appended to `~/.local/state/supercharge/audit.jsonl`.
- **Sessions can reach the daemon too.** Every Claude session runs as you, so it can read `auth.token` and call the daemon's API. The control chat's guard and autonomous mode's limits keep an honest agent on track; they don't stop one that sets out to get around them.
- **Attach terminal** runs `osascript` on your Mac. The browser sends only a session id, which must be one of yours; the daemon builds the command and passes it to the script as an argument, never inside it. Each one is audited (`session_attach`).

## AoE versions

`compat.json` holds the tested AoE range. Outside it, `supercharge start` refuses to run and says how to fix it. A running daemon switches to read-only *incompatible* mode instead of crash-looping.

`supercharge aoe upgrade`:

1. Finds the latest release.
2. Downloads it and verifies its SHA-256.
3. Runs the **live contract tests** against it in a sandbox: a temporary `HOME`, its own tmux server, and a stand-in agent instead of Claude. Your real `~/.agent-of-empires` is never touched.
4. Only then runs `aoe update` and adds that version to `~/.local/state/supercharge/compat.local.json`.
5. If any check fails, it reports what broke and changes nothing.

Since AoE 1.18, AoE refuses to send to an archived or trashed session. Supercharge unarchives an archived one first, as sending did before; a trashed one has to be restored first. On a fresh AoE 1.19 or later, `aoe hooks approve` lets AoE launch agents (`supercharge doctor` says so when it is needed).

A weekly GitHub Action does the same against the newest AoE release. It opens a PR that widens `compat.json` when the contract passes, or an issue when it fails.

To go back to a tested AoE, reinstall that release: `curl -fsSL …/scripts/install.sh | bash` with its version, or download `aoe-<os>-<arch>.tar.gz` from the [AoE releases](https://github.com/agent-of-empires/agent-of-empires/releases) and put the binary on your PATH as `aoe`.

## Files on disk

```
~/.config/supercharge/            config.toml, auth.token (0600)
~/.local/share/supercharge/       projects/<p>/project.json, tasks/<id>/{task.json, plan.md, session-prompt.md}, notes/{<p>,_global}.json, office/office.json,
                                  schedules.json (scheduled prompts)
                                  general/{general.json, control-prompt.md, session-prompt.md}
~/.local/state/supercharge/       logs/daemon.log (rotated), audit.jsonl, daemon.json, compat.local.json, history/YYYY-MM-DD.jsonl,
                                  held.json (held messages), context/<conversation>.json (Claude Code's context figures, 7 days),
                                  terminals.json (terminals opened by Run)
~/.claude/skills/supercharge-*    user-level skills, and note, todo, gnote (marker-owned; your own edits are never overwritten)
~/Library/LaunchAgents/com.github.xsoladdd.aoe-supercharge.plist     (macOS)
~/.config/systemd/user/aoe-supercharge.service                       (Linux)
```

`$XDG_CONFIG_HOME`, `$XDG_DATA_HOME`, `$XDG_STATE_HOME` and `$CLAUDE_CONFIG_DIR` are respected.

## Uninstall

```bash
supercharge uninstall            # service file + managed skills
supercharge uninstall --purge    # also config, the ledger and state
npm uninstall -g aoe-supercharge
```

## Development

```bash
npm install
npm run build          # UI (Vite) + CLI bundle (tsup) → packages/cli/dist
npm test               # Vitest: unit, integration (real CLI vs fake AoE), offline AoE contract
npm run test:e2e       # Playwright on Chromium, Firefox, WebKit, with axe and the design gate
npm run demo           # full dashboard with a fake AoE and sample projects on :4391
npx tsx scripts/contract-live.ts --aoe-bin "$(command -v aoe)"   # live AoE contract (sandboxed)
npx tsx scripts/resource-check.ts                                # idle RSS, CPU, CLI cold start
```

Layout:

```
packages/core       shared types, stage machine, needs-you rules, config schema, ledger
packages/cli        CLI + daemon (Hono, SSE), AoE client, glab and gh providers, services, templates
packages/ui         React 19, Vite, Tailwind 4, shadcn/ui (Phosphor icons, Geist)
packages/fake-aoe   fake `aoe serve` plus `aoe`/`glab`/`gh` shims for tests and the demo
e2e/                Playwright suite and the demo/E2E harness
fixtures/aoe/       redacted responses recorded from real AoE
```

## Troubleshooting

| Symptom | Fix |
|---|---|
| Dashboard says "Sign in from your terminal" | `supercharge open` |
| "AoE x.y.z is outside the tested range" | `supercharge aoe upgrade`, or reinstall a tested AoE |
| Sessions are created but don't start | Run `aoe` once and approve the hook paths (`supercharge doctor` shows this) |
| Service won't start after switching Node with nvm | `supercharge start` re-pins the node path |
| Nothing updates | `supercharge status`, then `supercharge logs -n 100` |
| `supercharge.localhost` doesn't resolve | Use `http://127.0.0.1:4280`, or change `server.hostname` |

## License

Not chosen yet. Pick one before the first public release, and before the npm and Homebrew paths can be switched on (see `.github/workflows/release.yml`).
