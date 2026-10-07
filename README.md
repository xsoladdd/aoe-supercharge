# Agent of Empires: Supercharge

An opinionated parent/child dashboard for Claude Code, built on [Agent of Empires](https://github.com/agent-of-empires/agent-of-empires) (AoE).

- **One control chat per project.** It splits work into tasks and spawns workers.
- **One worker per task**, each in its own git worktree and AoE session.
- **Fixed stages for every worker:** `planning → implementing → verifying → mr_raised → watching_mr → ready_for_review`, plus `blocked` and `done`.
- **One dashboard** you leave open on a side monitor. It shows every project, control chat, worker, plan and merge request, and pins whatever **needs you** at the top.

It runs as a small local daemon (Node 24, about 70 MB idle) bound to `127.0.0.1`. Merge requests are watched by a script, never by an LLM loop.

> Status: v0.4.0 (see [CHANGELOG.md](CHANGELOG.md)), built against AoE 1.17.2 (1.18.0 passes the live contract too; see [AoE versions](#aoe-versions)).
> The design rationale lives in [SPEC.md](SPEC.md).

---

## Contents

- [Install](#install) · [Dependencies](#dependencies) · [Quick start](#quick-start)
- [How it works](#how-it-works) · [CLI](#cli) · [Configuration](#configuration)
- [Dashboard](#dashboard) · [Phone access](#phone-access-remote-control) · [Merge requests](#merge-requests)
- [Security](#security) · [AoE versions](#aoe-versions) · [Files on disk](#files-on-disk)
- [Uninstall](#uninstall) · [Development](#development) · [Troubleshooting](#troubleshooting)

## Install

macOS and Linux only. On Windows, use WSL2 (AoE requires it).

**Installer script.** It checks every dependency, shows what it would install, and asks first:

```bash
curl -fsSL https://raw.githubusercontent.com/xsoladdd/aoe-supercharge/main/install.sh | bash
```

| Flag | Effect |
|---|---|
| `--dry-run` | Print the plan only; change nothing |
| `--yes` | Skip the confirmation |
| `--local <checkout>` | Install from a local clone instead of npm |

The script runs under both bash and zsh.

**npm:**

```bash
npm install -g aoe-supercharge
```

**Homebrew** (the tap is created by the release workflow):

```bash
brew install xsoladdd/tap/aoe-supercharge
```

Then check everything:

```bash
supercharge doctor
```

## Dependencies

| Tool | Why | Check | macOS | Linux |
|---|---|---|---|---|
| git | branches and worktrees | `git --version` | `brew install git` | `apt/dnf/pacman install git` |
| tmux | AoE runs every agent in tmux | `tmux -V` | `brew install tmux` | `apt/dnf/pacman install tmux` |
| Node.js 24 LTS | runs Supercharge | `node -v` (>= 24) | `brew install node@24` or nvm | [NodeSource 24.x](https://github.com/nodesource/distributions), or `pacman -S nodejs-lts-krypton` |
| Claude Code | the agent | `claude --version` | `curl -fsSL https://claude.ai/install.sh \| bash` | same |
| Agent of Empires | sessions, worktrees, status | `aoe --version` | `brew install aoe` | `curl -fsSL https://raw.githubusercontent.com/agent-of-empires/agent-of-empires/main/scripts/install.sh \| bash` |
| glab | GitLab merge-request watching | `glab version` | `brew install glab` | `dnf install glab`, `pacman -S glab`, or `apt install glab` |

After installing, there is one-time setup:

- **AoE hook consent.** Run `aoe` once and approve the agent hook paths it asks about. Until you do, AoE creates sessions but won't launch them; `supercharge doctor` checks this.
- **glab login.** Run `glab auth login` for every GitLab host, including self-hosted ones (`glab auth login --hostname gitlab.example.com`).

## Quick start

```bash
supercharge start                 # background service (launchd / systemd --user), starts at login
supercharge open                  # sign in and open http://supercharge.localhost:4280

cd ~/code/my-repo
supercharge init                  # registers the project and starts its control chat in AoE
```

Then talk to the control chat (in AoE, or from your phone; see [Phone access](#phone-access-remote-control)), for example: *"Split the launch checklist into tasks and start them."*

## How it works

**Spawning (Supercharge owns this).**

- `supercharge init` registers a repository and creates its control session with `aoe add`.
- `supercharge task new "<title>"` creates, in one step:
  - a branch,
  - a git worktree,
  - an AoE session that is a child of the control session,
  - a ledger entry.
- The control chat runs `task new` itself; you can run it by hand too.

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
```

- Invalid moves are rejected with exit code 3 and a list of what's allowed from the current stage.
- `watching_mr` and `ready_for_review` are set only by the MR watcher.
- Inside a worker, `AOE_INSTANCE_ID` is cross-checked against the task's session, so an agent in the wrong worktree is refused.

**The ledger** is one JSON file per task plus its `plan.md`, written atomically under a per-task lock. Workers can report stages even when the daemon is down. The daemon picks changes up through `fs.watch`.

## CLI

| Command | What it does |
|---|---|
| `supercharge start` / `stop` / `restart` | Install, refresh, stop or restart the user service |
| `supercharge status [--project <p>] [--json]` | Overview; `--project` gives the control-chat status JSON |
| `supercharge logs [-f] [-n N] [--raw]` | Daemon logs (rotated, tokens redacted) |
| `supercharge open [--print]` | One-time sign-in link, opened in your browser |
| `supercharge config get [key]` / `set <key> <value>` / `edit` / `path` | Read and change `config.toml` (comments preserved, validated) |
| `supercharge doctor [--json]` | Every check, each with its fix |
| `supercharge aoe upgrade [--check] [--yes]` | Test the latest AoE in a sandbox, then upgrade |
| `supercharge proxy enable` / `disable` / `status` | Opt-in clean URL `http://supercharge.localhost` via local Caddy |
| `supercharge uninstall [--purge]` | Remove the service and managed skills (`--purge`: also config, ledger, state) |
| `supercharge init [--name <p>] [--commit]` | Register the current repository |
| `supercharge task new "<title>" [--brief …] [--brief-file …] [--base …]` | Create a task |
| `supercharge task list [--project <p>] [--json]` | List tasks |
| `supercharge whoami [--json]` | `control`, `worker` or `none` for this session |
| `supercharge stage <stage> [--note …] [--mr <url>]` | Report a stage change |
| `supercharge ask "<question>"` | Block on a question |
| `supercharge plan <file \| ->` `[--draft]` | Save the approved plan |
| `supercharge reply <task-id> "<message>" [--yes]` | Send a prompt to a worker (asks for confirmation; audited) |
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

[agent]
workerPermissionMode = "plan"      # plan | default | acceptEdits | auto
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

[notifications]
enabled = true                     # also: blocked, readyForReview, aoeWaiting, controlWaiting, error
waitingDebounceSeconds = 20

[ui]
theme = "dark"                     # dark | light | system
displayName = "Ericson"            # on your office door: "Ericson’s office"

[office.history]
retentionDays = 30                 # days of office history kept

[projects.my-repo]                 # per-project overrides
baseBranch = "develop"
gitlabHost = "gitlab.example.com"
```

Changes to `server`, `aoe` and `agent` need a restart; the dashboard shows a **Restart** button. Everything else reloads live.

## Dashboard

`http://supercharge.localhost:4280`. Dark by default, with a light mode. It's built to be read from across a desk.

- **Needs you** (pinned): blocked questions, approvals or input waiting in AoE, control chats waiting on you or that have replied, session errors, MRs ready for review, MRs closed. Oldest first, each one click from its context.
- **Sidebar:** projects, then each control chat, then its workers. Every row shows a status icon and stage. Your other AoE sessions are grouped under their parent too.
- **Project page:** the control chat's live status and a rollup of its workers, then a worker list showing:
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
- **Office** (`/office`): every worker stands where its status puts it.
  - Everyone who needs you stands in line at your door, in single file between brass posts and ropes, blockers first, then oldest first, with the reason over their heads.
  - Working workers sit at their own desk in their project's team. A project's control chat is the team lead.
  - Idle workers, and those waiting on an MR pipeline or review, take a break in the pantry after 15 seconds idle.
  - Each worker has a desk number and an outfit picked from seven dress codes, from business formal to medieval garb.
  - The floor is drawn like a game (PixiJS). Drag to look around, scroll or pinch to zoom, double-click an area to zoom in, or use the chips: Whole office, your door, Pantry, and one per team.
  - When a worker's status changes it walks to its new place, then stands still. With reduced motion it jumps there instead. Nothing is drawn while nobody moves.
  - Click a worker, or its row in the list beside the floor, for its card: why it is there, its stage, and its question or approval to answer in place. **Follow** keeps the camera on it.
  - **Call next** (or N) calls the front of the line in through your door and opens their card. Answer, and they walk back to work; close the card, and they go back in line.
  - Keys on the floor: arrows or WASD to move, + and - to zoom, 0 for the whole office, F to follow, Escape to close the card.
  - **List** in the top bar shows the same people as a plain list. Without WebGL or a canvas, the page shows the list with a note.
  - Put your name on the door under Settings, Appearance. **Show in office** in any worker's right-click menu jumps to them.
  - The **whiteboard** by your door has your todos and notes. Click it to zoom in and open it: tick, archive or add one.
  - **New window** opens the office on its own, to keep on another screen.
  - The daemon keeps an **office history**: who went where and when, one file per day, for 30 days (`office.history.retentionDays`).
- **Notes** (`/notes`, under Office): every project's todos and notes, then the global ones. Add one, tick a todo, **Archive** it (or all the ticked ones at once); **Archived** lists them, to restore.
- **Settings:** every config key, validated, with restart handling.

Status is never shown by colour alone: every state has an icon shape and a label. `*.localhost` resolves to loopback in Chrome, Firefox and Safari without editing `/etc/hosts`; the E2E suite checks all three engines.

## Phone access (Remote Control)

With `remoteControl.enabled = true`, control sessions start with Claude Code's `--remote-control <project>-control`, so you can talk to each project's control chat from claude.ai or the Claude mobile app.

- Ask it **"status"**: it runs `supercharge status --project <name> --json` and summarises blocked questions, MRs ready, failing pipelines and per-stage counts. That's the same picture as the dashboard.
- Remote Control needs a claude.ai subscription login (Pro or Max). On Team or Enterprise plans, an admin must enable it.
- The dashboard itself is never exposed beyond localhost.

## Merge requests

For tasks in `mr_raised`, `watching_mr` or `ready_for_review`, the daemon checks each MR every `poll.mr` seconds through `glab`. It reads:

- pipeline status,
- unresolved resolvable discussion threads (where CodeRabbit comments),
- merge state.

The rules:

- **Ready:** the MR is open, its pipeline passed, and zero threads are unresolved. The task moves to `ready_for_review` and you get a desktop notification (osascript or notify-send; toggleable).
- **Merged:** the task moves to `done`.
- **Ready, then a new thread or pipeline appears:** the task goes back to `watching_mr`.

Self-hosted GitLab works: add the host to `mr.gitlab.hosts` and log in with `glab auth login --hostname <host>`.

## Security

- **Network:** the daemon binds to `127.0.0.1` only. It checks the `Host` header (DNS-rebinding protection) and sends no CORS headers.
- **Auth:**
  - The UI needs a local token (`~/.config/supercharge/auth.token`, mode 0600). `supercharge open` turns it into an `HttpOnly; SameSite=Strict` cookie through a single-use, 60-second sign-in link, so the token never appears in a URL or the browser history.
  - Every cookie-authenticated write needs a CSRF token plus a matching `Origin`.
- **AoE token:** read server-side only (`aoe url --token-only`) and never sent to the browser. Logs redact anything token-shaped.
- **Prompts to agents** (`reply`) always require confirmation and are appended to `~/.local/state/supercharge/audit.jsonl`.

## AoE versions

`compat.json` holds the tested AoE range. Outside it, `supercharge start` refuses to run and says how to fix it. A running daemon switches to read-only *incompatible* mode instead of crash-looping.

`supercharge aoe upgrade`:

1. Finds the latest release.
2. Downloads it and verifies its SHA-256.
3. Runs the **live contract tests** against it in a sandbox: a temporary `HOME`, its own tmux server, and a stand-in agent instead of Claude. Your real `~/.agent-of-empires` is never touched.
4. Only then runs `aoe update` and adds that version to `~/.local/state/supercharge/compat.local.json`.
5. If any check fails, it reports what broke and changes nothing.

A weekly GitHub Action does the same against the newest AoE release. It opens a PR that widens `compat.json` when the contract passes, or an issue when it fails.

To go back to a tested AoE, reinstall that release: `curl -fsSL …/scripts/install.sh | bash` with its version, or download `aoe-<os>-<arch>.tar.gz` from the [AoE releases](https://github.com/agent-of-empires/agent-of-empires/releases) and put the binary on your PATH as `aoe`.

## Files on disk

```
~/.config/supercharge/            config.toml, auth.token (0600)
~/.local/share/supercharge/       projects/<p>/project.json, tasks/<id>/{task.json, plan.md, session-prompt.md}, notes/{<p>,_global}.json, office/office.json
~/.local/state/supercharge/       logs/daemon.log (rotated), audit.jsonl, daemon.json, compat.local.json, history/YYYY-MM-DD.jsonl
~/.claude/skills/supercharge-*    user-level skills, and note, todo, gnote (marker-owned; your own edits are never overwritten)
~/Library/LaunchAgents/com.github.xsoladdd.aoe-supercharge.plist     (macOS)
~/.config/systemd/user/aoe-supercharge.service                       (Linux)
```

`$XDG_CONFIG_HOME`, `$XDG_DATA_HOME`, `$XDG_STATE_HOME` and `$CLAUDE_CONFIG_DIR` are respected.

## Uninstall

```bash
supercharge uninstall            # service file + managed skills
supercharge uninstall --purge    # also config, the ledger and state
npm uninstall -g aoe-supercharge # or: brew uninstall aoe-supercharge
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
packages/cli        CLI + daemon (Hono, SSE), AoE client, glab provider, services, templates
packages/ui         React 19, Vite, Tailwind 4, shadcn/ui (Phosphor icons, Geist)
packages/fake-aoe   fake `aoe serve` plus `aoe`/`glab` shims for tests and the demo
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

Not chosen yet. Pick one before the first public release (see `.github/workflows/release.yml`).
