# Agent of Empires: Supercharge — SPEC

> Status: **DRAFT for approval** (Phase 0 output). No application code has been written.
> Everything below was checked against the real machine on 2026-10-04 unless marked **[verify]**.
> Section 2 records the decisions you made on 2026-10-04. Approving this spec starts Phase 1.

- Product name: **Agent of Empires: Supercharge** ("Supercharge" in UI chrome)
- CLI binary: `supercharge`
- npm package: `aoe-supercharge` (the `supercharge` name is taken on npm)
- Homebrew: `brew install xsoladdd/tap/aoe-supercharge`
- Source: `github.com/xsoladdd/aoe-supercharge`

---

## 1. Phase 0 findings

### 1.1 Environment (this machine)

| Tool | Found | Notes |
|---|---|---|
| macOS | 26.5.1 (arm64) | launchd `gui/$UID` domain |
| Node | v24.14.0 via **nvm** | v24 "Krypton" is the Active LTS (latest 24.21.0). v26 becomes LTS later this month **[verify date]**. The service file must pin an absolute node path. |
| git | 2.53.0 | |
| tmux | 3.7c | |
| Claude Code | 2.1.236 | Has `--remote-control [name]`, `--plugin-dir`, `--append-system-prompt[-file]`, `--permission-mode` |
| AoE | **1.17.2** (tarball install, `~/.local/bin/aoe`) | `aoe update --check`: 1.18.0 is available. Not upgraded. |
| glab | 1.94.0 | Logged in to `gitlab.com` only. Two config files exist; glab warns on **stderr**, JSON stays on stdout. |
| gh | 2.102.0 | |
| Caddy | not installed | Only needed for the opt-in clean-URL proxy |
| Playwright | MCP available; cached Chromium + WebKit browsers | No Firefox cached |

### 1.2 Agent of Empires (AoE) — what it actually exposes

Observed live:

- `aoe serve` was **already running** (`aoe serve --status`: PID, mode `local`, `http://127.0.0.1:8080/?token=…`, log `~/.agent-of-empires/debug.log`).
- **Auth.** `GET /api/sessions` returns 401 without auth and 200 with `Authorization: Bearer <token>`. Read the token server-side with `aoe url --token-only`; it is never logged or sent to the browser. AoE also sets an `aoe_token` cookie (`HttpOnly; SameSite=Strict`) and a strict CSP.
- **Catch-all route trap.** Once authed, every unknown `/api/*` path returns **200 `text/html`** (the SPA fallback). Status codes alone can't detect a missing endpoint, so the AoE client and the contract tests **must assert `content-type: application/json`**.
- **`GET /api/sessions` shape.** It returns `{ sessions: Session[], workspace_ordering: string[] }`. Each session has: `id` (16 hex), `title`, `project_path`, `branch`, `main_repo_path`, `base_branch`, `group_path`, `tool`, `status`, `created_at`, `last_accessed_at`, `idle_entered_at`, `last_error`, `unread`, `urgent`, `favorited`, `has_managed_worktree`, `has_terminal`, `dormant`, `yolo_mode`, `profile`, `acp_*`, `context_resume`, `cleanup_defaults`, `workspace_repos`, plus about 10 more fields. See `fixtures/aoe/1.17.2/GET_api_sessions.json`.
- **Status values seen live:** `Idle`, `Running`. `aoe status --json` counts `waiting | running | idle | stopped | error`. The full enum from source is below, and the dashboard mapping is in §10.2.
- **No parent field in the REST API.** The parent link lives in **`aoe list --json`** as `parent_session_id` (19 of 21 sessions on this machine are children of a control session). That output also gives `worktree: { branch, main_repo_path, managed_by_aoe, base_branch }`.
- **`aoe add` covers spawning natively.** `aoe add <repo> -t <title> -P <parent> -w <branch> -b [--base-branch <b>] --tool claude --extra-args "<claude flags>" [-l]`. Worktrees default to `worktree.path_template = "../{repo-name}-worktrees/{branch}"` (AoE replaces `/` and other unsafe characters in `{branch}` with `-`).
- **Worker identity.** Every agent process launched by AoE has `AOE_INSTANCE_ID` (equal to the AoE session id, verified) and `AOE_PROFILE` in its environment.
- **AoE's own status detection** runs through hooks it installs in `~/.claude/settings.json` (`Notification`, `Stop`, `PreToolUse`, …). Supercharge must not touch these.
- **Other useful commands:** `aoe send <id> <msg>` (revives dead sessions unless `--no-revive`), `aoe session color <id> red|amber|green|none`, `aoe session current -q`.
- **Upgrades.** `aoe update [--check|--dry-run|-y]` installs **latest only**; there is no version pin.
- **Isolation.** Profiles (`aoe profile create`) give isolated workspaces. There is no `AOE_HOME`-style variable; the app dir comes from `HOME`, so a sandbox runs AoE with a temporary `HOME`. **Verified**: the live contract leaves the real AoE data, tmux server and Claude settings byte-identical.

**From AoE source at tag `v1.17.2` (commit `ac1f582`); file and line references are in `docs/phase0/aoe-1.17.2-source-notes.md`:**

- **Routes Supercharge uses.**
  - `GET /api/sessions?state=live` (there is **no** `GET /api/sessions/{id}`; filter the list instead).
  - `GET /api/about` returns `version` and is the **only API version signal**: no `/api/vN` prefix, no version header.
  - `POST /api/sessions/{id}/send` takes `{message, revive}`.
  - `GET /api/sessions/{id}/output?lines=` returns pane text.
  - `GET /api/groups`, `/api/profiles`, `/api/projects`, `/api/system/health`, `/api/system/update-status`.
- **Create.** `POST /api/sessions` supports worktree, new branch, `extra_args` and `idempotency_key`, **but has no parent field**. Only `aoe add -P` sets `parent_session_id`, and it is one level deep. **Spawning therefore goes through the CLI.**
- **Delete.** `DELETE /api/sessions/{id}` takes `{delete_worktree, delete_branch, …}`. Deleting a parent does **not** cascade, and orphans keep a dangling `parent_session_id`.
- **Status enum:** `Running, Waiting, Idle, Unknown, Stopped, Error, Starting, Deleting, Creating`. The API uses PascalCase; the CLI uses lowercase.
  - For Claude, status comes from AoE's hooks (`Notification` permission/elicitation → Waiting, `UserPromptSubmit`/`PreToolUse` → Running, `Stop`/idle prompt → Idle), reconciled by pane scraping.
  - AoE polls every 2 s. **Waiting is not broken down by cause** (permission prompt or question).
- **Approvals.**
  - Terminal-mode Claude permission prompts have **no REST surface**. You answer them in the pane.
  - Structured (ACP) sessions expose `pending_approvals[]` and `POST /{id}/acp/approvals/{nonce}`.
- **No global event stream.** There is no SSE, and WebSockets are per session (terminal frames or ACP events).
  - `callback_url` rejects loopback and private targets.
  - `[status_hooks]` fire only from the TUI, not from `aoe serve`.
  - So **Supercharge polls `GET /api/sessions`**, as AoE's own dashboard does (every 3 s).
- **Auth details.**
  - The token lives in `<app_dir>/serve.token` (0600). It can be regenerated when `aoe serve` restarts (if the file is older than 24 h), so the client re-reads it on a 401.
  - Accepted: Bearer, the `aoe_token` cookie, or `?token=`.
  - The Host header must be loopback. Origin is checked only when present. There is no CSRF.
  - The Node client therefore sends `Authorization: Bearer` and **no Origin header**, which is what AoE's own internal client does.
- **`--extra-args` lands verbatim on a shell command line** after `claude`. REST rejects shell metacharacters in `extra_args`; the CLI doesn't. Supercharge must generate args only from sanitised values (see §8).
- **App dir.** On macOS it is `~/.config/agent-of-empires` if that exists, otherwise `~/.agent-of-empires`. Sessions are stored in `profiles/<profile>/sessions.json`.
- **1.17.2 → 1.18.0** only adds routes (`/diff/file/raw`, `/file/raw`); `SessionResponse` is unchanged. It's a good first candidate for `supercharge aoe upgrade`.

Recorded fixtures (redacted, allowlist-based, produced by `scripts/phase0-redact-fixtures.mjs`; see `fixtures/aoe/1.17.2/meta.json`): `GET /api/sessions`, `/api/about`, `/api/groups`, `/api/profiles`, `/api/projects`, `/api/system/health`, `/api/system/update-status`, `aoe list --json`, `aoe session show --json`, `aoe status --json`, `aoe --version`, `aoe serve --status`.

### 1.3 Claude Code (2.1.236) facts that shape the design

- Project skills live in `.claude/skills/<name>/SKILL.md` and load from the working directory up to the repo root.
- `CLAUDE.local.md` is still loaded. `@~/…` imports are supported but need a one-time approval.
- **Plugins via `--plugin-dir <dir>`** load for that session only, with no install step. A plugin is `.claude-plugin/plugin.json` (`name` is the only required field) plus `skills/<name>/SKILL.md` and an optional `hooks/hooks.json`. Plugin skills are namespaced (`supercharge:worker`) and the model invokes them automatically.
- `--append-system-prompt-file` works in interactive mode.
- **Remote Control.** Start with `claude --remote-control "<name>"`.
  - It needs a claude.ai subscription login (Pro/Max/Team/Enterprise). API keys don't work.
  - On Team/Enterprise an admin must enable it. **You confirmed it already works on your account.**
  - It works inside tmux.
  - The user-level `remoteControlAtStartup` setting would turn it on for *every* session, so Supercharge uses the per-session flag instead.
- **Git fact, verified in a scratch repo.** A worktree only contains *tracked* files. Untracked or excluded `.claude/skills/*` and `CLAUDE.local.md` in the main checkout **do not appear in worker worktrees**. A managed block added to a *tracked* `CLAUDE.md` shows up as a modification (` M CLAUDE.md`) and is missing from new worktrees. `.git/info/exclude` lives in the common git dir, so it **does** apply to every worktree.

### 1.4 GitLab via glab (1.94.0)

- `glab mr view <iid|branch> -R <repo> -F json` returns `state`, `draft`, `detailed_merge_status`, `has_conflicts`, `head_pipeline.status`, `blocking_discussions_resolved`, `web_url`.
- `blocking_discussions_resolved` is **true whenever the project doesn't require resolved threads**, so it can't be trusted. Unresolved threads are counted directly from `glab api projects/:id/merge_requests/:iid/discussions` (notes where `resolvable && !resolved`). This is where CodeRabbit's threads show up.
- Self-hosted hosts: `glab auth login --hostname <host>`, and `glab api --hostname <host> …`.

### 1.5 URL `http://supercharge.localhost:<port>`

| Client | Result |
|---|---|
| macOS system resolver (`dscacheutil`) | resolves to `127.0.0.1` and `::1` |
| curl 8.7.1 | resolves |
| Chrome 153 | resolves |
| Safari 26.5 | resolves |
| Firefox 155 (Playwright) | resolves (E2E suite, 2026-10-05) |

No `/etc/hosts` edits are needed. On Linux, systemd's `nss-myhostname`/`resolved` map `*.localhost` to loopback, and Chrome and Firefox hardcode it anyway **[verify on Ubuntu CI]**.

### 1.6 Build-time skills

They were missing because they're project-level installs: they only existed in a koino worktree (`.claude/worktrees/project-docs-design-overhaul-b8aa32/.claude/skills/`), and project skills only load inside their own repo. I copied the same files into this repo's `.claude/skills/`. They're hidden via `.git/info/exclude` because they're third-party and not part of the product.

| Requested | Installed as | Source | How it's used here |
|---|---|---|---|
| taste | `design-taste-frontend` | `Leonxlnx/taste-skill` (MIT), byte-identical to upstream HEAD | Its own scope excludes dashboards (§13 of the skill), so only the dashboard-relevant rules are used. They're listed in §14.0. |
| web-design-guidelines | `web-design-guidelines` | `vercel-labs/agent-skills` (no license file, so not committed) | Audits UI code against Vercel's Web Interface Guidelines at the end of every UI phase |
| image-decode | `image-to-code` **(assumed to be what you meant)** | `Leonxlnx/taste-skill` | Only the image-analysis half applies (reading your reference screenshots). Its image-generation half is a Codex capability that Claude Code doesn't have. |
| awesome-design | `docs/design/references/linear.app.DESIGN.md` | `VoltAgent/awesome-design-md@f696123` (MIT). It's a DESIGN.md collection, not a skill. | Secondary reference you chose. Used for density, hierarchy and surface principles, not Linear branding. |
| Playwright | `playwright-cli` skill + Playwright MCP + `@playwright/test` | `microsoft/playwright` | E2E tests and screenshots for visual review |

The palette in §14.3 still starts from **pixel samples of your Orax screenshots**. The skills above then constrained it.

---

## 2. Decisions (resolved 2026-10-04)

| # | Decision | Effect on this spec |
|---|---|---|
| D1 | **User-level skill install.** Skills go in `~/.claude/skills/supercharge-control/` and `~/.claude/skills/supercharge-worker/`. Each session's role and brief are passed with `--append-system-prompt-file`. | **Client repos are never touched**: no skill files, no `CLAUDE.md` edits, no exclude lines, no plan drafts. Because these skills are visible in *every* Claude session on the machine, each one starts with a guard (`supercharge whoami --json`) and does nothing unless the session is Supercharge-managed (§8.3). `init --commit` stays as the opt-in to also commit skills and a `CLAUDE.md` block for teams. |
| D2 | **Gradient B.** The primary button background is `#d11db0 → #855cd9 → #ba29e7` (your reference hues, deepened) with white text, ≥ 4.6:1 at every point of the gradient. | Same gradient in both themes. The pastel reference gradient survives only on the brand mark, which has no text (§14.3). |
| D3 | **`aoe-supercharge`** on npm and as the Homebrew formula name (`xsoladdd/tap/aoe-supercharge`). The CLI is still `supercharge`. | Already reflected throughout |
| D4 | **Design skills installed**, plus Linear's DESIGN.md as a secondary reference | §1.6, §14 |
| D5 | **Remote Control works on your account.** | `remoteControl.enabled` is fully supported. `doctor` only checks that the Claude Code version has the flag. |

Notes from Phase 0 that aren't decisions:
- AoE already models parent/child sessions natively (`aoe add -P`), so Supercharge uses that instead of inventing its own.
- **Worker identity is checked twice.** The task is looked up by **branch** (the key, as you specified), then `AOE_INSTANCE_ID` must match the ledger's `aoeSessionId`. This catches an agent running in the wrong worktree.
- **Approvals can't be answered from the dashboard.** AoE has no REST surface for terminal-mode Claude permission prompts, so the "approval waiting" item links into AoE.
- **AoE gives no push channel we can use.** `callback_url` refuses loopback and `[status_hooks]` fire only in the TUI. Session state is polled (§10.1): one local JSON GET every 3–15 s.
- **Spawning uses the AoE CLI, not REST**, because only `aoe add -P` can set the parent.
- **AoE 1.18.0 is available** and you're on 1.17.2. I didn't upgrade it. The source diff shows only added routes, so it's the first real test for `supercharge aoe upgrade`.

---

## 3. Architecture

```
          ┌────────────────────── browser (side monitor) ──────────────────────┐
          │ React SPA (Vite build, shadcn/Tailwind)  ◄── SSE /api/events ───┐  │
          └───────────────┬────────────────────────────────────────────────┼──┘
                          │ cookie auth + CSRF                             │
┌─────────────────────────▼────────────────────────────────────────────────┴───────┐
│ supercharge daemon (one Node 24 process, Hono, bound to 127.0.0.1:<port>)        │
│                                                                                   │
│  http/  ─ static UI, /api/*, /api/events (SSE), auth, CSRF, Host/Origin gate      │
│  state/ ─ in-memory Snapshot { projects, sessions, tasks, needsYou, health }      │
│           + EventBus → SSE fan-out (monotonic event ids, Last-Event-ID replay)    │
│  watchers/                                                                        │
│     aoe-sessions  ─ poll AoE REST /api/sessions (no event stream exists) + list  │
│     ledger        ─ fs.watch(projects/**) + periodic reconcile                    │
│     mr            ─ MrProvider (gitlab/glab) on an interval, only for MR stages   │
│     config        ─ fs.watch(config.toml) → hot reload or "restart required"     │
│  notify/  ─ osascript (macOS) / notify-send (Linux), debounced, per-type toggles  │
│  audit/   ─ JSONL log of every prompt sent to an agent + config changes          │
└────────┬──────────────────────────┬──────────────────────────┬───────────────────┘
         │ REST (Bearer, server-side)│ child_process            │ child_process
         ▼                           ▼                          ▼
   aoe serve (127.0.0.1:8080)   aoe CLI (add/list/send)     glab CLI (mr view, api)

┌──────────────────────── supercharge CLI (same package) ─────────────────────────┐
│ service mgmt · doctor · config · init · task new · stage/ask/plan · reply · status │
│ Ledger writes go straight to disk (atomic + per-task lock), so workers can report  │
│ stages even when the daemon is down. The daemon picks them up through fs.watch.    │
└───────────────────────────────────────────────────────────────────────────────────┘
```

**Principles**
- **The ledger on disk is the source of truth for workflow state.** AoE is the source of truth for session runtime state. The daemon only reads and merges these two, and adds MR state.
- **The daemon is never required for correctness.** Every worker command works with the daemon stopped. The daemon adds live UI, MR watching and notifications.
- **No busy polling.** Ledger changes come from fs events. AoE and glab polls run on configurable intervals and slow down when no browser is connected (§15).
- **Seams, not features.**
  - `AgentAdapter`: Claude Code only.
  - `MrProvider`: GitLab only.
  - `Authenticator`: local cookie and bearer only.
  - `ServiceManager`: launchd and systemd.

### 3.1 Repository layout (npm workspaces)

```
packages/
  core/       config schema (zod), ledger, stage machine, paths (XDG), shared types
  cli/        commander CLI + daemon (Hono); bundled with tsup into dist/supercharge.mjs
  ui/         React 19 + Vite 8 + Tailwind 4 + shadcn/ui; built to cli/dist/ui
  fake-aoe/   Hono fake of the AoE API (fixtures + scriptable state) for UI/E2E tests
  templates/  user-level skills, role prompts, launchd plist, systemd unit, CLAUDE.md block (--commit)
fixtures/aoe/<version>/   recorded, redacted AoE responses (1.17.2 recorded in Phase 0)
fixtures/glab/<version>/  recorded glab JSON (Phase 3)
scripts/    record-aoe-fixtures.ts, contract-live.ts, release helpers
compat.json             tested AoE range
install.sh              bash, zsh-compatible installer
Formula/aoe-supercharge.rb.tmpl
.github/workflows/      ci.yml, aoe-compat.yml (weekly), release.yml
```

Pinned stack (current versions today): Hono 4.13 + @hono/node-server 2.1, React 19.3, Vite 8.3, Tailwind 4.3, shadcn 4.21, TypeScript 7.0, Vitest 5.0, @playwright/test 1.63, zod 4.6, commander 15, smol-toml 1.9 (parse), @decimalturn/toml-patch 3.3 (comment-preserving writes), pino 10 + rotating-file-stream 3, @tanstack/react-query 5, wouter (routing), react-markdown 10 + rehype-sanitize, @phosphor-icons/react 2.1, @fontsource-variable/geist + geist-mono 5.3 (self-hosted fonts, no CDN), @axe-core/playwright (a11y gate).

---

## 4. CLI surface

```
supercharge start | stop | restart        install/refresh the user service and (re)start it
supercharge status [--project <p>] [--json]
                                          no flag: daemon + AoE + compat + per-project counts
                                          --project: the control-chat status (same JSON as GET /api/projects/:p/status)
supercharge logs [-f] [-n <lines>] [--raw] pretty-print daemon logs, follow mode
supercharge open                          one-time login nonce → opens http://supercharge.localhost:<port>/
supercharge config get <key> | set <key> <value> | edit | path
supercharge doctor [--json]               every check below, each failure with its fix command
supercharge aoe upgrade [--check] [--yes] test the latest AoE in a sandbox, then upgrade + widen the range
supercharge uninstall [--purge]           remove service files; --purge also removes config/data/state

supercharge init [--name <p>] [--commit] [--base <branch>]   (run inside a repo)
supercharge task new "<title>" [--project <p>] [--brief <text> | --brief-file <f>] [--base <branch>]
supercharge task list [--project <p>] [--json]

# worker-facing (cwd = worker worktree; branch is the key, AOE_INSTANCE_ID is cross-checked)
supercharge whoami [--json]               role (control | worker | none), project, task. Skills call this first.
supercharge stage <stage> [--note "..."] [--mr <url>]
supercharge ask "<question>"
supercharge plan <path-to-plan.md | -> [--draft]   "-" reads the plan from stdin (no file in the repo)

# control-facing
supercharge reply <task-id> "<message>"   explicit and audited; delivers via `aoe send`

supercharge daemon                        (hidden) foreground daemon, used by launchd/systemd
```

- Exit codes: 0 ok, 1 error, 2 usage, 3 invalid stage transition, 4 not inside a managed task, 5 AoE incompatible, 78 config invalid.
- Every command supports `--json` where output is data.
- Human output is short and actionable. Invalid stage transitions print the allowed next stages and the exact command to run.

**`doctor` checks:**
1. OS supported; Node ≥ 24 and the service's pinned node path still exists.
2. git, tmux, claude, glab found, with versions.
3. AoE found and inside the compat range; `aoe serve` running and reachable; token readable.
4. glab authenticated for every configured GitLab host.
5. Config valid; directory permissions correct (config dir 0700, token 0600).
6. Service installed and loaded; daemon reachable on the configured port; port not owned by something else.
7. `supercharge.localhost` resolves.
8. `osascript` or `notify-send` present.
9. If Remote Control is enabled: the Claude Code version supports `--remote-control`.
10. The user-level skills `~/.claude/skills/supercharge-{control,worker}` exist, carry the `.supercharge-managed` marker, and match the installed version.

---

## 5. Configuration — `~/.config/supercharge/config.toml`

This file is the single source of truth. One zod schema (`core/config`) validates it for the CLI, the daemon and the UI. The UI receives the JSON Schema form via `z.toJSONSchema`. Writes are atomic and preserve comments (toml-patch).

```toml
[server]
port = 4280                      # 1024–65535
hostname = "supercharge.localhost"
# bind is fixed to 127.0.0.1 in v1 (not configurable; validation rejects other values)

[aoe]
binary = "aoe"
profile = "main"                 # the AoE profile Supercharge manages
autoStart = true                 # run `aoe serve --daemon` if not running
url = ""                         # "" = discover via `aoe url`

[agent]
kind = "claude-code"             # only value in v1
extraArgs = []                   # appended to every session's claude args (validated: no shell metacharacters)
workerPermissionMode = "plan"    # workers start in plan mode

[remoteControl]
enabled = false
nameTemplate = "{project}-control"   # slug only; it lands on AoE's shell command line

[tasks]
branchPrefix = "sc/"
idPrefix = ""                    # "" = derived from project name, e.g. "NW"

[poll]                           # all in seconds
aoeSessions = 3                  # when a dashboard is connected
aoeSessionsIdle = 15             # when no dashboard is connected
mr = 60
reconcile = 60

[mr]
provider = "gitlab"
[mr.gitlab]
hosts = ["gitlab.com"]           # add self-hosted hosts, e.g. "gitlab.example.com"
glabBinary = "glab"
readyRequiresNonDraft = false

[notifications]
enabled = true
blocked = true
readyForReview = true
aoeWaiting = true                # approvals / input waiting in AoE
controlWaiting = true
error = true
waitingDebounceSeconds = 20

[ui]
theme = "dark"                   # dark | light | system
density = "comfortable"          # comfortable | compact
displayName = ""                 # your name on the office door (§14.5); empty reads "Your office"

[logging]
level = "info"
maxFileMb = 10
maxFiles = 5

[projects.<name>]                # optional per-project overrides
gitlabHost = "gitlab.example.com"
baseBranch = "develop"
branchPrefix = "feature/"
```

- **Hot-reload:** poll, notification, ui and logging settings.
- **Restart required:** `server.*`, `aoe.*` and `agent.*`. The UI shows a "Restart required" bar with the Restart button.
- `config set` coerces values using the schema type.
- `config edit` opens `$EDITOR`, re-validates on save, offers to re-edit if invalid, and keeps `config.toml.bak`.

---

## 6. Files on disk (XDG; `$XDG_*` respected on both OSes)

```
~/.config/supercharge/         0700
  config.toml
  auth.token                   0600, 32 random bytes hex (UI + CLI bearer)
~/.local/share/supercharge/
  agent/claude-code/roles/     control.md, worker.md (role prompt templates)
  projects/<project>/
    project.json
    tasks/<task-id>/task.json
    tasks/<task-id>/plan.md
    control-prompt.md                  (control role + project, passed via --append-system-prompt-file)
    tasks/<task-id>/session-prompt.md  (worker role + brief, passed via --append-system-prompt-file)
    tasks/<task-id>/.lock              (transient)
~/.claude/skills/              (D1: user-level, written by `supercharge start` / upgrade)
  supercharge-control/SKILL.md + .supercharge-managed   (marker = version + content hash)
  supercharge-worker/SKILL.md  + .supercharge-managed
~/.local/state/supercharge/
  logs/daemon.log (+ rotated .gz)
  audit.jsonl
  compat.local.json            versions verified by `supercharge aoe upgrade`
  daemon.json                  pid, port, started_at, last_error
```

### 6.1 `project.json`
```json
{ "schema": 1, "name": "northwind", "repoPath": "/abs/main/checkout",
  "remoteUrl": "git@gitlab.example.com:group/northwind.git",
  "controlSessionId": "1a0872a3ed0f4d4d", "idPrefix": "NW", "nextTaskSeq": 8,
  "installMode": "user|commit", "createdAt": "…", "updatedAt": "…" }
```

### 6.2 `task.json` (ledger record)
```json
{
  "schema": 1, "rev": 12,
  "id": "NW-0007", "project": "northwind", "title": "Content entry",
  "brief": "…",
  "branch": "sc/nw-0007-content-entry", "baseBranch": "main",
  "worktreePath": "/abs/northwind-worktrees/sc-nw-0007-content-entry",
  "aoeSessionId": "6b7e474bdb1c4275", "parentSessionId": "1a0872a3ed0f4d4d",
  "stage": "blocked", "blockedFrom": "implementing",
  "openQuestion": { "text": "Final copy from client?", "askedAt": "…", "answeredAt": null },
  "plan": { "status": "approved", "savedAt": "…", "sha256": "…" },
  "mr": { "provider": "gitlab", "host": "gitlab.example.com", "repo": "group/northwind",
          "iid": 42, "url": "https://…/merge_requests/42", "state": "opened", "draft": false,
          "pipeline": "running", "unresolvedThreads": 2,
          "detailedMergeStatus": "not_approved", "checkedAt": "…" },
  "createdAt": "…", "updatedAt": "…",
  "history": [ { "at": "…", "from": "implementing", "to": "blocked",
                 "by": "worker", "note": "Final copy from client?" } ]
}
```

- **Atomic writes:** write to `task.json.<pid>.<rand>.tmp` in the same directory, `fsync`, `rename`, then `fsync` the directory.
- **Two writers share a task file:** the worker CLI and the daemon's MR watcher. Each does read-modify-write inside a per-task lock (`mkdir .lock`, stale after 10 s), bumps `rev`, and holds the lock for milliseconds.
- **Separate files keep tasks independent.** Parallel workers never share a file.
- **Logs:** `history` is append-only, and `audit.jsonl` records every prompt sent to an agent (actor, session, full text, timestamp) and every config change.

---

## 7. Stage machine

```
planning ─► implementing ─► verifying ─► mr_raised ─► watching_mr ─► ready_for_review ─► done
               ▲               │             │              │                 │
               └───────────────┴─────────────┴──────────────┴─────────────────┘  (back to implementing)
any active stage ─ask─► blocked ─► (return to blockedFrom, or any stage allowed from it)
any stage ─► done (user/control, or the daemon on merge)
```

| From → To | Who may do it | Guard |
|---|---|---|
| planning → implementing | worker | Plan saved and **approved** (`supercharge plan <file>` without `--draft`) |
| implementing → verifying | worker | — |
| verifying → implementing | worker | — (verification failed) |
| verifying → mr_raised | worker | `--mr <url>` given **or** the provider finds an open MR for the branch |
| mr_raised → watching_mr | **daemon** | First successful MR poll |
| watching_mr → ready_for_review | **daemon** | Ready rule (§11.2) holds |
| ready_for_review → watching_mr | **daemon** | Ready rule stops holding (new pipeline, or a new unresolved thread) |
| mr_raised / watching_mr / ready_for_review → implementing | worker | Fixing CI or review feedback |
| any active → blocked | worker (`ask`) | A question is required; stores `blockedFrom` |
| blocked → `blockedFrom` (or a stage allowed from it) | worker | Sets `openQuestion.answeredAt` if not already set |
| any → done | user / control (`stage done`), daemon on MR merged | — |
| done → * | — | Terminal. `--force` reopens with a history note. |

- **Rejections** exit with code 3. Example: `Can't go planning → verifying. Next allowed: implementing (needs an approved plan: supercharge plan <file>), blocked (supercharge ask "…").`
- **Daemon-only moves:** a worker calling `stage watching_mr` or `stage ready_for_review` is told those happen automatically once the MR watcher sees it.
- **Tests:** the machine is one pure function, `transition(task, to, actor, ctx) → Result`. It is table-tested over every (from × to × actor) combination.

---

## 8. Workflow integration

### 8.1 `supercharge init` (inside a repo)
1. Resolve the main checkout (`git rev-parse --git-common-dir`), the project name (`--name` or the directory name, slugged to `[a-z0-9-]`), the remote URL, and the MR host.
2. Write `project.json` and `control-prompt.md`.
3. Make sure the user-level skills are installed and current (normally `supercharge start` already did this).
   - The skills are only written if missing, or if the marker shows Supercharge owns them.
   - If you've edited a skill, the marker hash no longer matches and the skill is left alone; `doctor` reports it.
4. Install mode:
   - **Default (D1): no change to the repo at all.**
   - **`--commit`:** write `.claude/skills/supercharge-{control,worker}/SKILL.md` and a `CLAUDE.md` block between `<!-- supercharge:begin v1 -->` and `<!-- supercharge:end -->` (replaced in place on update, removed cleanly), then commit. Project-level and user-level skills then share the same names; which one Claude Code prefers is **[verify in Phase 2]**. The contents are identical either way.
5. Create the control session:
   `aoe add <repo> -t "<project> control" -g supercharge/<project> --tool claude -l --extra-args "--append-system-prompt-file <control-prompt.md> [--remote-control <project>-control]"`.
   Record its id. Idempotent: re-running `init` reuses a live control session.

### 8.2 `supercharge task new "<title>"`
1. Resolve the project (cwd or `--project`). Allocate `NW-0008` (under the project lock). Branch is `<prefix><id-lower>-<slug>`.
2. Write `tasks/<id>/session-prompt.md` (worker role + title + brief + task id).
3. `aoe add <repo> -t "<id> <title>" -P <control id> -w <branch> -b --base-branch <base> --tool claude -l --extra-args "--append-system-prompt-file <session-prompt.md> --permission-mode <agent.workerPermissionMode>"`. The title goes through argv, not the shell, so free text is safe there.
4. Read back the session id and worktree path from `aoe list --json`, matched on `worktree.branch` and `parent_session_id`. The REST create response can't be used because REST can't set a parent. Write `task.json` with `stage: planning` and `parentSessionId` set to the control id. If any step fails after `aoe add` succeeded, roll back with `DELETE /api/sessions/{id}` and `delete_worktree: true` so nothing is left orphaned.
5. Print the task id, branch, worktree and session id. JSON is available with `--json`. The control chat uses this.

### 8.3 Skills (user-level, rendered from `packages/templates`)
Both skills start with the same guard: *"Run `supercharge whoami --json`. If `role` isn't `control`/`worker`, this skill doesn't apply; stop."* Their `description` frontmatter also names Supercharge explicitly, so the model doesn't pull them into unrelated sessions. The per-session prompt file tells the agent its role, so the skill is invoked deliberately.

- **supercharge-control:**
  - You coordinate and don't write code.
  - Spawn work with `supercharge task new`.
  - Answer "status" with `supercharge status --project <p> --json`, summarised as: per-stage counts, blocked questions with age, MRs ready, failing pipelines.
  - Relay my answers to workers with `supercharge reply` **only when I explicitly ask**.
- **supercharge-worker:**
  - Start in plan mode.
  - After I approve the plan, save it with `supercharge plan -` (heredoc on stdin, so no file lands in the repo), then `supercharge stage implementing`.
  - Report every stage change.
  - When stuck, run `supercharge ask "…"`, then **stop and wait**.
  - After opening the MR, run `supercharge stage mr_raised --mr <url>`.
  - Never run `stage watching_mr` or `stage ready_for_review` yourself.

### 8.4 Answering questions
- I answer in the worker's AoE session directly, or through the control chat.
- `supercharge reply <task> "<msg>"` and (Phase 4) the dashboard's Reply action both:
  1. require explicit confirmation (CLI prompt or `--yes`; a UI dialog),
  2. append to `audit.jsonl`,
  3. call `aoe send <session> <msg>`,
  4. set `openQuestion.answeredAt`.
- The task stays `blocked` until the worker moves it.

---

## 9. Agent seam

```ts
interface AgentAdapter {
  id: 'claude-code';
  aoeTool: 'claude';
  sessionArgs(role: 'control' | 'worker', ctx: SessionCtx): string[]; // → aoe add --extra-args
  installUserAssets(paths: AssetPaths, version: string): Promise<void>; // ~/.claude/skills/supercharge-* + role prompts (D1)
  removeUserAssets(paths: AssetPaths): Promise<void>;                   // only marker-owned files
  installRepoAssets?(repo: string, mode: 'commit'): Promise<void>;      // --commit path
  removeRepoAssets?(repo: string): Promise<void>;
  supportsRemoteControl: boolean;
}
```
Only `ClaudeCodeAdapter` is built. The rest of the code depends on the interface only.

---

## 10. AoE integration

### 10.1 Client
- `AoeClient` (REST) reads the base URL from `aoe url` and the bearer token from `aoe url --token-only`, both at daemon start. The token stays in memory only and pino redacts it in logs.
- Every response is checked for `application/json` and validated against zod schemas in `core/aoe-schemas.ts`. These are the same schemas the contract tests use.
- `AoeCli` wraps the CLI for anything the REST API lacks: `add`, `list --json` (parent links), `send`, `serve --status|--daemon`, `--version`. It always passes `-p <profile>`, uses argv arrays (no shell), and has timeouts.

- **Polling:** `GET /api/sessions?state=live` every `poll.aoeSessions` seconds (3 s with a dashboard open, 15 s without). Nothing faster exists (§1.2).
  - The client diffs by `id` against the last snapshot and emits SSE `session` events only for changes.
  - Parent links and the worktree object come from `aoe list --json`, re-read on the slower reconcile tick or when a new session id appears.
- **Version check:** both `aoe --version` (the installed binary) and `GET /api/about.version` (the **running** daemon) must be in range. After `aoe update`, the old `aoe serve` keeps running until restarted. If the two differ, `doctor` says so and suggests `aoe serve --restart`.
- **Generated `--extra-args`:**
  - Project names are slugs (`[a-z0-9-]`).
  - Paths are absolute XDG paths. If they contain whitespace or shell metacharacters, init refuses with a fix.
  - The Remote Control name is built from the slug, so no user free text ever reaches the shell line.

### 10.2 Status mapping (AoE → dashboard)

| AoE status | Dashboard | Needs-you? |
|---|---|---|
| `Running`, `Starting`, `Creating` | Working | — |
| `Waiting` | Waiting on you | Yes. Worker: "Approval / input in AoE". Control: "Control chat waiting". Debounced by `notifications.waitingDebounceSeconds`. |
| `Idle` | Idle | Control session with `unread = true`: "Control chat replied" |
| `Error` | Error (shows `last_error`) | Yes |
| `Stopped` | Stopped | — |
| `Unknown`, `Deleting` | Unknown | — |
| *(not in AoE list)* | Missing session | Yes, when the ledger task isn't `done` |

- **Answering in AoE:** "Approval waiting" items open the session in AoE, because terminal-mode prompts can only be answered there.
- **ACP sessions:** for structured sessions, `pending_approvals[]` is shown with `tool_name`/`target`. Answering from the dashboard is out of scope for v1.

### 10.3 Compatibility pinning — `compat.json`
```json
{ "aoe": { "range": ">=1.17.2 <1.18.0", "tested": ["1.17.2"], "fixtures": "fixtures/aoe" } }
```
- **On start** (CLI `start` and daemon boot), Supercharge runs `aoe --version` and checks it against `compat.json` ∪ `~/.local/state/supercharge/compat.local.json`.
  - Out of range, `start` refuses with: `AoE 1.18.0 is outside the tested range >=1.17.2 <1.18.0. Fix: run "supercharge aoe upgrade" to test it, or reinstall a tested AoE release (see README#aoe-versions).`
  - If AoE changes underneath a running daemon, the daemon doesn't crash-loop. It switches to **incompatible mode**: no AoE calls, and the dashboard shows the same message and fix.
- **Contract tests**:
  - *Offline:* zod schemas against `fixtures/aoe/<v>/*`, in every CI run.
  - *Live:* `scripts/contract-live.ts --aoe-bin <path>` runs a real AoE in a sandbox. That means a temporary `HOME`, a separate tmux socket (`TMUX_TMPDIR`), a throwaway git repo, and `-c sh` instead of Claude. It creates a control session and a child worktree session, then checks list, parent link, worktree fields, status, send and remove.

### 10.4 `supercharge aoe upgrade`
1. `aoe update --check` finds the latest version. If it's already allowed, report and exit.
2. Download that release's tarball for this OS/arch from GitHub releases into a temp dir and verify its checksum.
3. Run the live contract tests against the candidate binary in the sandbox. This **never touches the real `~/.agent-of-empires`**, because a newer AoE may run data migrations.
4. **On failure:** print the failing checks and a diff of response shapes. Nothing changes.
5. **On success:** confirm (unless `--yes`), run `aoe update -y`, and re-check `aoe --version`. If a newer release landed in between, repeat from step 2. Then add the version to `compat.local.json`, record new fixtures under `~/.local/state/supercharge/fixtures/`, and restart the daemon.

### 10.5 Weekly CI — `.github/workflows/aoe-compat.yml`
- Cron runs Mondays at 06:00 UTC, plus manual dispatch.
- Steps: get the latest AoE release, run live contract tests on `macos-latest` and `ubuntu-latest`, and re-record fixtures.
- **Pass and out of range:** open a PR that widens `compat.json` and adds fixtures.
- **Fail:** open or update an issue titled `AoE <v> incompatible` with the failing checks.
- Uses `GITHUB_TOKEN` with `contents: write`, `pull-requests: write`, `issues: write`.

---

## 11. MR watcher

### 11.1 Provider seam
```ts
interface MrProvider {
  id: 'gitlab';
  matches(remoteUrl: string): boolean;                          // host ∈ mr.gitlab.hosts
  findOpenMrForBranch(repo: RepoRef, branch: string): Promise<MrRef | null>;
  status(ref: MrRef): Promise<MrStatus>; // state, draft, pipeline, unresolvedThreads, mergeStatus, url
  doctor(): Promise<Check[]>;                                    // glab present + auth per host
}
```
`GitLabGlabProvider`:
- `glab mr view <iid> -R <host>/<repo> -F json`
- `glab api --hostname <host> projects/<id>/merge_requests/<iid>/discussions --paginate`
- Reads stdout only; stderr goes to debug logs. Timeout 20 s, concurrency 2, jittered schedule. On rate limit it backs off ×2, up to 10 min.

### 11.2 Rules (pure function, unit-tested against glab fixtures)
- **Ready:** `state = opened` ∧ `head_pipeline.status = success` ∧ unresolved resolvable threads = 0 (∧ `!draft` if `mr.gitlab.readyRequiresNonDraft`). The watcher then moves the task to `ready_for_review` and sends a desktop notification.
- **Merged:** the task moves to `done`.
- **Closed without merge:** the stage stays as is, and a Needs-you item reads "MR closed".
- **Pipeline failed:** the task stays in `watching_mr` and the dashboard shows the failure. No automatic prompts to the worker in v1.
- Only tasks in `mr_raised`, `watching_mr` or `ready_for_review` are polled. This script does the watching, not an LLM.

---

## 12. Daemon HTTP API

Bound to **127.0.0.1 only**. Requests are rejected unless the `Host` header is `supercharge.localhost:<port>`, `localhost:<port>` or `127.0.0.1:<port>` (DNS-rebinding gate). There are **no CORS headers**, the same strict CSP as AoE, and `frame-ancestors 'none'`.

| Method | Path | Auth | Purpose |
|---|---|---|---|
| GET | `/healthz` | none | `{ ok, version }` (service checks) |
| GET | `/auth/callback?nonce=` | nonce | Single-use, 60 s nonce from `supercharge open`. Sets the `sc_session` cookie (`HttpOnly; SameSite=Strict; Path=/`) and redirects to `/`. |
| POST | `/api/auth/nonce` | bearer | CLI asks for a login nonce |
| POST | `/auth/logout` | cookie+CSRF | |
| GET | `/api/csrf` | cookie | CSRF token (HMAC of the session) |
| GET | `/api/snapshot` | ✓ | Full state for first paint |
| GET | `/api/events` | ✓ | SSE: `snapshot`, `task`, `task.removed`, `session`, `project`, `needs_you`, `health`, `config`. 20 s heartbeat; `Last-Event-ID` replay from a 500-event ring, otherwise a fresh `snapshot` |
| GET | `/api/projects` | ✓ | |
| GET | `/api/projects/:p/status` | ✓ | Same JSON as `supercharge status --project <p> --json` |
| GET | `/api/tasks/:id` | ✓ | Record + history + `plan.md` (raw markdown, sanitised when rendered) |
| GET | `/api/config` | ✓ | Parsed config + JSON Schema + "requires restart" metadata |
| PUT | `/api/config` | ✓+CSRF | Partial patch, validated by the same zod schema; atomic, comment-preserving write; audited |
| POST | `/api/daemon/restart` | ✓+CSRF | Asks the service manager to restart (`launchctl kickstart -k` / `systemctl --user restart`) |
| POST | `/api/notifications/test` | ✓+CSRF | |
| POST | `/api/tasks/:id/reply` | ✓+CSRF | Phase 4. Body `{ message, confirm: true }` → audit + `aoe send` |
| GET (WebSocket) | `/api/sessions/:id/shell/ws` | cookie + dashboard `Origin` | The session's paired shell (AoE's Terminal tab), relayed from AoE's `/sessions/{id}/terminal/live-ws`. A `{type:"run",command}` message is audited (`command_run`, `where: terminal`), then pasted (bracketed) and entered |
| GET | `/api/notes[?archived=1]` | ✓ | Notes and todos (§14.6) not archived, or only the archived ones |
| POST | `/api/notes` | ✓+CSRF | Body `{ kind: "note" \| "todo", text, project }` (`project: null` is global); `by: you` |
| PATCH | `/api/notes/:id` | ✓+CSRF | Body `{ done }`, `{ text }` or `{ archived }`: tick a todo, edit, archive or restore |
| GET | `/api/office/history?from&to[&project][&key]` | ✓ | The office history (§14.5): `{ start, records }`, the state at `from` as a frame, then the records up to `to` (ISO times; default the last 24 h), narrowed to a project or a character key |

- **Auth model:** an `Authenticator` chain with two strategies: the `sc_session` cookie (browser) and `Authorization: Bearer <auth.token>` (CLI).
- **CSRF** applies to cookie-authenticated mutating requests: an `X-CSRF-Token` header plus `Origin` equal to the configured origin.
- **The long-lived token never appears in a URL.** The cookie value is `HMAC(token, "ui")`, so it survives daemon restarts, and rotating the token invalidates it.
- **Room for remote access later:** add a strategy and drop the bind restriction. Both are blocked in v1 by config validation.
- **"Open in AoE":** a link to the AoE web dashboard (you're already logged in there with its own cookie; Supercharge never passes AoE's token), plus a copy button for `aoe session attach <id>`. The deep-link format is **[verify]**.

---

## 13. Service ("run and forget")

**macOS:** `~/Library/LaunchAgents/com.github.xsoladdd.aoe-supercharge.plist`
- Keys: `RunAtLoad`, `KeepAlive = true`, `ThrottleInterval = 10`.
- `ProgramArguments = [<abs node>, <abs supercharge.mjs>, "daemon"]`.
- `EnvironmentVariables.PATH` is captured at `start`. It includes the directories holding aoe, tmux, git, glab and claude, because launchd's default PATH has none of them.
- stdout/stderr go to `logs/launchd.out` (tiny; real logs go through pino with rotation).
- Commands: `launchctl bootstrap gui/$UID <plist>`, `bootout gui/$UID/<label>`, `kickstart -k`.

**Linux:** `~/.config/systemd/user/aoe-supercharge.service`
- Settings: `Restart=on-failure`, `RestartSec=5`, `RestartPreventExitStatus=78`, `Environment=PATH=…`, `WantedBy=default.target`.
- Commands: `systemctl --user daemon-reload && systemctl --user enable --now`.
- Starts at login. Lingering is not enabled.

**Behaviour:**
- `start` always re-renders the service file. This fixes stale nvm node paths; `doctor` flags them.
- `uninstall` removes exactly the files it created: service files and the user-level skills that still carry the `.supercharge-managed` marker. `--purge` also removes config, data and state.
- **Boot sequence:** load config, check AoE compat, ensure `aoe serve` is running (`--status`, else `aoe serve --daemon`), discover the URL and token, load the ledger, start watchers, start HTTP.
- **Bad config doesn't crash-loop:** the daemon serves the dashboard in degraded mode on the last good port (default 4280), with the error and a link to Settings.
- **Logs:** pino JSON goes to `~/.local/state/supercharge/logs/daemon.log`, rotated at 10 MB × 5 and gzipped. `supercharge logs -f` pretty-prints it.

**Opt-in clean URL (Phase 4):** `supercharge proxy enable` shows exactly what it will install (Caddy plus a site block for `http://supercharge.localhost` → `127.0.0.1:4280`) and needs explicit consent, because binding :80 needs admin rights. `proxy disable` reverses it.

---

## 14. UI

### 14.0 Design read and rules

**Design read:** a local operations dashboard for one developer, glanced at from across a desk. It uses a dark Orax/Linear-style product language, built on customised shadcn/ui + Tailwind v4 with static-first motion.

**Dials** (taste-skill vocabulary, set for a dashboard rather than its landing-page defaults):

| Dial | Value | Why |
|---|---|---|
| `DESIGN_VARIANCE` | 3 | A predictable grid; you build muscle memory for where things are. |
| `MOTION_INTENSITY` | 3 | CSS transitions only, no animation library. Things move only when state changes. |
| `VISUAL_DENSITY` | 6 | Daily-app density. Not cockpit-dense, because it has to be readable from a distance. |

**Rules adopted.** Where each comes from: [T] = taste skill, [L] = Linear DESIGN.md, [W] = web-design-guidelines audit.

1. **One system, customised.**
   - shadcn/ui only, and no component ships in its default look [T].
   - Theme set once at the root; the page never inverts per section [T].
2. **Colour locks.**
   - One accent: violet for active, selected and focus.
   - The gradient appears **only** on the primary button (D2) and the brand mark. It's never used as a section fill [T][L].
   - Status colours are semantic, not accents.
   - No pure `#000` or `#fff` for surfaces or body text [T]. The single exception is `#ffffff` text on the gradient button: off-white drops it to 4.2:1.
3. **Type:** Geist Variable + Geist Mono Variable, self-hosted (`@fontsource-variable/*`, OFL). The taste skill discourages Inter as a default, and the Linear doc names Geist as a close substitute.
   - All numbers use tabular figures.
   - Task IDs, branches and counts are set in mono.
   - Large numbers get slight negative tracking (-0.02em) [L].
4. **Icons:** Phosphor (`@phosphor-icons/react`, MIT). One family, one weight ("regular") [T].
   - lucide isn't used. Icon imports in generated shadcn components are swapped to Phosphor.
   - Verified: shadcn's `iconLibrary: "phosphor"` emits Phosphor imports directly.
5. **Radius scale (shape lock):** badges are pills; buttons and inputs 8 px; cards 12 px; drawer and panels 16 px. This applies everywhere [T][L].
6. **Depth comes from a surface ladder plus 1 px hairlines, not shadows.** Shadows (tinted) appear only on floating layers: drawer, dialog, popover, toast [L].
7. **Cards only where elevation means hierarchy** [T].
   - The control box and Needs-you items are cards.
   - The worker list is rows with one hairline *between* rows (never top + bottom).
   - Sidebar rows are flat.
8. **Status indicators only for real live state** (AoE status, stage). One per row, never decorative on nav items or labels [T].
9. **Copy:**
   - Sentence case, verb first.
   - **No em or en dashes in any UI string** [T]. Use hyphens, colons or line breaks.
   - At most one middle dot per line, and no uppercase-tracked eyebrow labels above sections [T].
   - Button labels are at most 3 words and stay on one line. One label per intent: "New task" everywhere [T].
   - Empty values read as words ("No MR"), never as a bare dash.
10. **States:** every view has three [T]:
    - a skeleton matching its final layout, not a spinner,
    - an empty state that says how to fill it (e.g. "No projects yet. Run `supercharge init` inside a repo."),
    - contextual errors: inline for forms, a banner for AoE or daemon problems. Toasts are reserved for transient confirmations.
11. **Forms (Settings):** label above the field, helper text, error below, never a placeholder used as a label. A visible AA focus ring (violet, 5:1 against cards) [T][W].
12. **Motion:** every animation has a one-sentence reason [T].
    - Allowed:
      - press feedback (`scale(0.98)`),
      - a single 600 ms highlight when a Needs-you item arrives or a stage changes (a state transition),
      - the drawer slide.
    - **No perpetual loops.** Working sessions don't need your attention; waiting ones do, and they get a static yellow treatment plus a notification.
    - Everything is gated by `prefers-reduced-motion`.
    - No scroll listeners.
13. **Targets:** interactive targets at least 40 px tall [L]. Row height at least 44 px.
14. **z-index:** a single documented scale in one constants file (sidebar < sticky strip < drawer < dialog < toast) [T].

### 14.1 Layout (readable from across a desk)
```
┌────────────┬───────────────────────────────────────────────────────────────────┐
│ ◉ Super-   │ Needs you  4                                                      │ ← pinned strip
│   charge   │ [? NW-0007 Final copy from client  2h] [✋ NW-0011 approval  6m]  │
│            │ [✋ Control waiting  12m]             [✓ NW-0004 ready for review] │
│ ▾ northwind├───────────────────────────────────────────────────────────────────┤
│   ◉ control│ Northwind                                          [ + New task ] │
│   ├ NW-0007│ ┌ Control chat ───────────────────────────────────────────────┐   │
│   ├ NW-0008│ │ ⚡ Working   Remote Control on                               │   │
│   └ NW-0004│ │ Planning 1   Implementing 2   Verifying 1   MR 2   Ready 1   │   │
│ ▸ apollo   │ │ Oldest blocked: NW-0007, 2h                                  │   │
│            │ └─────────────────────────────────────────────────────────────┘   │
│            │ Workers                                                           │
│            │ NW-0008  Build templates   ●─●─◐─○─○─○  ⚡ Working   No MR    4m   │
│            │ NW-0007  Content entry     ●─⊘ Blocked  ○ Idle      No MR    2h   │
│ ⚙ Settings │ NW-0004  Hosting setup     ●─●─●─●─●─✓  ○ Idle   !42 ✓ 0 open 1m │
└────────────┴───────────────────────────────────────────────────────────────────┘
```

- **Sidebar** (shadcn `Sidebar`, collapsible to icons): projects, then the control session, then workers. Each row has one status icon, plus a stage badge with icon and text.
- **Needs-you strip:**
  - Contents: blocked questions; AoE approvals or input (a worker session in `Waiting`, which AoE doesn't break down by cause); control chats waiting on me (`Waiting`, or `Idle` + `unread`); session errors or missing sessions; MRs ready; MRs closed.
  - Oldest first. One click opens the task drawer or the control box.
  - Empty state: "Nothing needs you."
- **Project view:** a control status box (live AoE status, Remote Control indicator, per-stage counts, oldest blocked, MRs ready) sits above a worker list. Each worker row shows:
  - a 6-step stage stepper,
  - AoE status,
  - an MR badge (pipeline icon + label, unresolved thread count),
  - last update (relative, with an absolute tooltip).
- **Task drawer** (shadcn `Sheet`):
  - rendered `plan.md` (react-markdown + rehype-sanitize, no raw HTML),
  - stage history, open question, MR link,
  - "Open in AoE" plus a copy-attach command,
  - (Phase 4) Reply.
- **Settings:** a form generated from the config JSON Schema, with server-side validation errors shown inline. It has a "Restart required" bar and a **Restart** button behind a confirm dialog. The theme toggle sits in the header.
- **Routes:** `/`, `/p/:project`, `/p/:project/t/:taskId`, `/settings`, `/office` (§14.5).
- **Sizing:** works from 1080 px (portrait side monitor) to 2560 px.

### 14.2 Status vocabulary (never colour alone: icon shape + text label, and `aria-label` when the label is collapsed)

| Concept | Icon (Phosphor) | Label | Dark colour |
|---|---|---|---|
| planning | `CircleDashed` | Planning | slate `#9d9fa1` |
| implementing | `CircleHalf` | Implementing | blue `#3b9bff` |
| verifying | `Gauge` | Verifying | cyan `#38c6e0` |
| mr_raised | `GitPullRequest` | MR raised | violet `#b780e5` |
| watching_mr | `Eye` | Watching MR | violet `#b780e5` |
| ready_for_review | `CheckCircle` | Ready for review | green `#34d27b` |
| blocked | `Prohibit` | Blocked | red `#f85d5f` |
| done | `Checks` | Done | muted `#8f9193` |
| AoE working | `Lightning` (static) | Working | blue |
| AoE waiting | `HandPalm` | Waiting on you | yellow `#f9cd03` |
| AoE idle | `Circle` | Idle | muted |
| AoE error | `WarningOctagon` | Error | red |
| AoE stopped | `Stop` | Stopped | muted |

Badges follow the reference screenshots: a tinted pill (colour at about 14% alpha), icon, and a coloured label.

### 14.3 Design tokens

Dark (default):

| Token | Value | Source / check |
|---|---|---|
| `--background` (canvas, sidebar) | `#17191a` | sampled |
| `--surface` (main panel) | `#1f2125` | sampled |
| `--card` | `#27292d` | sampled |
| `--raised` (hover, selected row, active nav) | `#2e3034` | ladder step 4 [L] |
| `--border` / `--border-strong` | `#2c2e33` / `#3a3d43` | hairlines [L] |
| `--foreground` | `#f4f4f5` | off-white [T]; 13.3:1 on card |
| `--foreground-secondary` | `#9d9fa1` | sampled; 5.5:1 on card |
| `--foreground-muted` | `#8f9193` | sampled; 5.6:1 on bg |
| `--accent` (active, selected, focus ring) | `#b780e5` | sampled; 5.5:1 on surface |
| `--gradient-primary` (primary button only) | `linear-gradient(120deg, #d11db0 0%, #855cd9 48%, #ba29e7 100%)` | **D2**; ≥ 4.6:1 with white everywhere along it |
| `--on-gradient-primary` | `#ffffff` | the one pure-white exception (rule 2) |
| `--gradient-brand` (brand mark only, no text) | `linear-gradient(120deg, #eb6fd4 0%, #a88ae4 48%, #d171ef 100%)` | sampled from your reference |
| blue / yellow / red / orange / green / cyan | `#3b9bff` / `#f9cd03` / `#f85d5f` / `#f08a24` / `#34d27b` / `#38c6e0` | all ≥ 4.6:1 on card |
| progress fill | `#0787fd` | sampled |

The primary button's hover state darkens it 4% and adds a 1 px inner top highlight. It never gets **lighter**, because lighter would drop below 4.5:1. Pressed adds `scale(0.98)`.

Light:

| Token | Value |
|---|---|
| background / surface / card / raised | `#eef0f2` / `#f7f8fa` / `#fcfcfd` / `#f0f1f4` |
| border / border-strong | `#e4e5e9` / `#d5d7dd` |
| foreground / secondary / muted | `#16171a` / `#5c5f66` / `#63666d` (muted changed from `#6b6e75`, which was 4.47:1 and failed AA; now ≥ 5.0:1) |
| accent | `#7c3aed` (5.4:1) |
| gradient-primary | same as dark (D2), white text |
| blue / amber / red / orange / green | `#0a66c8` / `#8a6100` / `#c8282b` / `#b35300` / `#13804a` (all ≥ 4.9:1) |

**Type scale** (base 16 px, minimum 13 px):

| Use | Size / weight |
|---|---|
| KPI numbers | 32 / 600, tracking -0.02em |
| Page title | 22 / 600 |
| Section title | 16 / 600 |
| Body | 16 / 400 |
| Row meta | 14 / 400 |
| Mono IDs and branches | Geist Mono 14 |

Spacing is a 4 px grid.

**Theme:** dark by default through a class on `<html>`; `light` and `system` are available. The choice is saved in `config.toml` (`ui.theme`). Tokens are defined once as CSS variables in the shadcn theme layer (Tailwind v4 `@theme`), and components never use raw hex.

### 14.4 Design gate (exit criterion for every UI phase)
1. **Screenshots:** Playwright captures at 1440×900 and 1080×1920, in both themes, attached to the phase summary for your review.
2. **`web-design-guidelines` audit** of every changed UI file. Findings are fixed or listed with a reason.
3. **Automated checks in E2E:**
   - `@axe-core/playwright` with no serious or critical violations (contrast included),
   - a test that fails on any em or en dash in UI strings,
   - one run with `reducedMotion: 'reduce'`.
4. **Dashboard pre-flight**, adapted from the taste skill's checklist: one accent, one radius scale, no decorative dots, every view has loading, empty and error states, buttons on one line, no duplicate button intent, no eyebrow labels, theme parity.
5. **Reference check against your screenshots** (`image-to-code` analysis): surfaces, badge style and gradient usage match the intent.

### 14.5 Office

A Restaurant City style office at `/office`, for tracking every worker at once. **Where a worker stands is its status**: everyone who needs you queues at your door, working workers sit at their own desk, idle and waiting ones go to the pantry. It is built in gated phases: **A** an accessible roster (built), **B** a PixiJS canvas with zoom and pan (built), **C** walking (built), **D** extras.

**Placement** is a pure function, `officeSpot` in `packages/core/src/shared/office.ts`, so the dashboard and the CLI agree. The first rule that matches wins:

| # | Condition | Zone | Prop or pose |
|---|---|---|---|
| 1 | stage `done` | gone home (not shown) | waving |
| 2 | any Needs-you item for the task but `mr_ready`, `mr_closed` (review lounge) and `control_replied` | door queue, oldest item first, ties by key | question: speech bubble; plan_approval: scroll; permission: shield; approval: raised hand; session_error: warning; session_missing: lost placard |
| 3 | AoE `working` | own desk | planning: sketching; implementing: typing; verifying: inspecting |
| 4 | AoE `stopped`, or archived | away | none |
| 5 | AoE `waiting` inside the Needs-you debounce | stays where it was | |
| 6 | AoE `unknown`, `error` with no item yet, or the session is missing | stays where it was | |
| 7 | AoE `idle` or `stopped`, stage `mr_raised`, `watching_mr` or `ready_for_review` | review lounge (0.5.0; was the pantry) | a folder: green ready, amber waiting, red failed or closed |
| 8 | AoE `idle`, stage `blocked`, question answered | pantry | reading your reply |
| 9 | AoE `idle`, any other stage | pantry once idle for 15 s (finishing up at the desk until then) | coffee |

- A worker with several items queues once, at its oldest, carrying the most urgent prop (question, permission, plan, approval, then the rest).
- Each project's control chat is its **team lead**: at the lead desk, or at your door for `control_waiting` or for what its latest reply lists under NEEDS YOU (`control_needs`, `control_blocker`). `control_replied` is only a notification: it shows in Needs you and notifies, but does not put the lead in line.
- **Whoever blocks work goes first** in the door queue (a question, permission, plan approval, `control_blocker`, `session_error`); the rest stay oldest first.
- **Workers a control chat starts straight through AoE** (`aoe add -P <control>`, no task) sit at the free desks after the tasks', oldest first, and go where their session's status puts them (`sessionSpot`). The daemon names each one with `pickWorkerName` the first time it sees it, from the same pool as the project's tasks, and keeps the name in `ProjectRecord.crew` (session id to name), also after the session is gone, so a name is never given twice. Adopting such a session as a task keeps its name.
- "Stays where it was" keeps characters from pacing during short-lived states. On first sight, rule 5 and 6 workers stand at their desk.
- **Desks** are stored as `TaskRecord.desk` (from 1, unique among the project's open tasks). `task new` and adoption pick the lowest free desk. The daemon backfills missing desks and settles clashes (a restored worker, two `task new` at once) on the newer task, without touching `updatedAt`. A done worker's desk is free again.
- **Outfits** come from `outfitFor(taskId, project)` (`outfit.ts`): a dress code (business formal, smart casual, startup hoodie, cozy knit, Hawaiian shirt, sporty, medieval garb) and layered parts (skin, hair style and colour, top, bottom, shoes, one accessory). It is seeded by project and task id, so a worker keeps its clothes. It never depends on the name.
- **The door** reads `ui.displayName` + "’s office", or "Your office" while the setting is empty (Settings, Appearance).
- **The roster** is the accessible face of the floor and lists everyone by zone: the door queue as an ordered list, desks per team, the pantry and away. Every row has the name, id, reason (icon plus label) and time in place. In the list view (`?view=list`) a row is a link to the task; beside the floor it is a button that picks the worker. It carries `data-zone`, `data-task`, `data-project`, `data-since` and `data-worker` for tests. Zone changes are announced in a polite live region. `?worker=<id>&project=<name>` highlights and focuses a worker; `?focus=door|desk|pantry|<project>` scrolls to an area. The session menu has **Show in office**.

**The floor** (`/office`, the default view) is a PixiJS canvas in its own lazy chunk, loaded only by this view:
- **Plan:** `officeLayout` (`office-layout.ts`) lays out a 2:1 isometric tile grid: the pantry in the back-left corner, the team blocks in rows (lead desk, then rows of desks), and your door at the far east end of the back wall, with a lamp on either side. The entrance is on the left wall. The office grows with teams and desks.
- **The line at your door** stands, nobody sits: single file on a runner straight out from your door, one to a tile, each facing the one ahead, so the front faces your door. Brass posts and ropes run along both sides of its first six places and block the tiles beside them, so people join at the back and walk up the line. A longer line carries on past the ropes to the front of the office, then turns west.
- **Walking:** A\* (`pathfind.ts`, 8 directions, never cutting a corner past furniture) at 4.5 tiles a second. Long walks speed up so none takes more than 6 s. Legs and arms swing only while walking. New workers walk in from the entrance; done and away workers walk out. The queue moves up when the front leaves. The pantry keeps each worker's spot while it stays.
- **Render on demand:** frames are drawn only while a worker walks, the camera flies or glides, or a bubble pops. Then drawing stops. The host carries `data-frames`, and the page root carries `data-renderer` (`loading`, `webgl`, `webgpu`, `canvas`, `fallback`), `data-camera-focus` (an area, a worker key, or `free`), `data-walking` (how many are walking), `data-motion` (`walk` or `jump`), `data-called` and `data-selected`, for tests.
- **Camera:** drag to pan with a glide, wheel or pinch to zoom at the pointer (30% to 250%), eased fly-to for the area chips (snaps under reduced motion), double-click an area to zoom in. Keys: arrows/WASD, + and -, 0, N (Call next), F (follow), Escape.
- **Worker card:** reason, stage, live status, where, since, outfit. For a task at your door it holds the same answer cards as the task page (`TaskAsks`). Open task, Open chat, MR, and Follow. A team lead's card has a box to message its control chat (`POST /api/sessions/:id/send`, audited), focused when you pick the lead.
- **Call next:** the first in line walks in through your door (it opens) and their card opens. When their zone changes they come back out and walk to it. Closing the card, or picking someone else, sends them back to the line.
- **Theme:** the art palette follows the page's theme and reads the status colours and accent from the page's tokens.
- **Office window** (`/office/window`, from **New window** on the floor): the floor and its list and nothing else, to keep on another screen. It opens as a popup named `supercharge-office`, so a second click brings the same one back. Pages opened from it (Open task, Open chat, a list row) open in the dashboard window that opened it, by a same-origin `postMessage` that the dashboard only accepts as a path on itself, or in a window named `supercharge-main` when there is no opener. Only the dashboard window plays the Needs-you sound and badges the tab title. The window keeps its own Show/Hide list setting.
- **No renderer** (no WebGL or canvas): a note, and the roster in place of the floor. The dashboard's CSP forbids `eval`, so the floor loads `pixi.js/unsafe-eval`, which swaps Pixi's generated code for plain functions. Despite its name, it is what makes Pixi run *without* unsafe-eval.

#### Office v2 (0.5.0)

Seven features from the owner's brief (`docs/office-v2-brief.md`), planned in `docs/office-v2-plan.md`.

- **One model.** `buildOffice` (`office-model.ts`) builds the floor from the snapshot, pure, with the hold memory passed in: the dashboard keeps one across visits, the daemon its own. Zones are `door`, `desk`, `pantry`, `review`, `away`, `archived` and `gone`.
- **Office marks** (`$XDG_DATA_HOME/supercharge/office/office.json`, written atomically under a lock): per character key, `archivedAt`, `keptAt` and `snoozedUntil`. They are office-only and never touch a session, worktree or transcript. The snapshot carries them as `office.marks`, and an `office` event sends changes.
- **History.** The daemon (`OfficeWatcher`) builds the floor 250 ms after every change (and when a hold runs out) and appends one `move` record per character whose zone, reason, prop, stage, desk or MR (state, pipeline) changed, its arrival (`from: null`) and its departure (`zone: "gone"`). A move carries `{ ts, key, sessionId, parentId, project, taskId, worktree, name, role, desk, from, zone, reason, prop, stage, cost, mr }`. A `frame` (everyone's state just before) is written at daemon start, at the first write of each UTC day, and at least every 6 hours. The state at any time is the latest frame before it plus the moves after it (`officeAt`, pure). Records go in `$XDG_STATE_HOME/supercharge/history/YYYY-MM-DD.jsonl` (UTC days). Days older than `office.history.retentionDays` (default 30) are deleted at start and daily. History starts when 0.5.0 runs; there is no backfill. `GET /api/office/history` serves it (§12).
- **Rooms.** Each project's team block is a room: low glass panes along every edge of its rug (`TeamPlan.walls`), a doorway two tiles wide in the middle of its front edge (`TeamPlan.doorway`) with posts, a lintel and the project's nameplate in its team colour, and its team sign inside. The grid knows the panes as edge walls (`Grid.wall`, keyed by `edgeKey`): A\* never steps across one, nor diagonally past either end of one, so everyone comes and goes through the doorway. Rooms keep the grid of team blocks (2 to 3 per row, a corridor between them) and grow with desks; 2 to 3 projects with 5 to 10 desks each are tested not to overlap. The chips are generated from the projects; a room's chip flies the camera to it, and the floor root carries `data-rooms` (the room names, in order) for tests. Each pane is drawn as its own piece at its middle's depth, so the back glass is behind whoever is inside and the front glass in front of them.
- **Arrivals and errands.** `planMoves(seen, model)` (`office-moves.ts`, pure) says how each character moves from what the scene last saw: `place` (nothing seen: first load or a reconnect, so nobody walks), `spawn` (new: in through the entrance), `finish`, `walk` or `stay`. **Finish** (`isFinish`): a worker leaves its desk for the review lounge, or for the pantry with an MR open (`mr_raised`, `watching_mr`, `ready_for_review`), and its team has a lead. It walks to the front of the lead's desk carrying a folder, stands there while the lead holds it up (`HANDOVER_MS`, 1.4 s), then walks on. A new place while on the errand cancels it. **Spawns** queue at the entrance (`EntranceQueue`): each newcomer waits out of sight until `SPAWN_GAP_MS` (0.9 s) after the one before. A whole new snapshot (a reconnect that could not replay, counted as `epoch` by the live store) places everyone again with no walking, errands or queue. The floor root carries `data-errands` (who is on the errand) and `data-arriving` (how many wait outside) for tests.
- **Review lounge** (`review` zone; `layout.review`, in front of the pantry: a pool table, a cue rack, places round the table first). A worker in `mr_raised`, `watching_mr` or `ready_for_review` whose session is idle (after the same 15 s at the desk) or stopped waits here instead of the pantry; working on feedback puts it back at its desk. `mr_ready` and `mr_closed` no longer put anyone at your door: they still show in Needs you and notify, and the worker waits in the lounge with its folder (`folderFor`): **red** (`folder_red`) when the pipeline failed or was cancelled, or the MR was closed; **green** (`folder`) when the stage is `ready_for_review` or the MR merged; **amber** (`folder_amber`) while the pipeline runs or review threads are open ("2 review threads open"). Under each character in the lounge an **MR badge** shows `!iid`, the pipeline (tick, cross, dot while it runs, ring when there is none) and the open review threads; clicking it opens the MR in a new tab. The roster has a **Review lounge** section whose rows carry the same badge as a link (`data-mr-badge`, an `aria-label` that says it all). The header reads "N at your door · N at desks · N in review · N in the pantry", and a **Review lounge** chip flies there. The MR data is `TaskRecord.mr` from the existing `glab` watcher: no new polling. "Review threads" are the unresolved resolvable threads, whoever opened them (CodeRabbit's included).
- **Cost and tokens.** Source: each AoE session's live Claude Code conversation (the transcript `TranscriptStore` already reads for the chat view). Every assistant record carries `message.usage`; the records of one reply repeat it, so it is counted once per `message.id` (`TranscriptParser.usage`); sidechains are skipped; cache writes are split by TTL from `usage.cache_creation` (5-minute when it is missing) and `usage.speed` is kept. The cost is an **estimate**: tokens times the per-model price table in `core/shared/model-prices.ts` (Claude API first-party rates, checked against Anthropic's pricing page on 2026-10-07; cache writes 1.25x and 2x input, reads per model; fast mode on its own rates for the models that have it). A model not in the table shows tokens only. On a Claude plan it is the API-equivalent value, not a bill, and every figure says "≈" and "estimate". The daemon (`CostWatcher`) reads what is new every 15 s for the sessions on the floor and puts a `SessionCost` per session in the snapshot (`costs`, by session id; a `costs` event on change): the whole conversation, today (since local midnight), the last hour, by kind, the model, and when it last showed progress (an Edit, Write, MultiEdit or NotebookEdit call, or its task changing stage). A /clear starts a new conversation and the meter starts again.
- **Meters:** under each character a small bar fills towards `office.runaway.sessionTokens` (green, amber from 60%, red from 90%) beside its estimate; the roster rows and the worker card show the same ("≈ $1.20 · 2.3M tokens"; the card adds today, the last hour and the model). The header adds "Today ≈ $X · now ≈ $Y (estimate)": now is the live conversations of everyone on the floor, today the part of them since local midnight; unpriced tokens are counted apart.
- **Runaways** (`runawayReasons`, pure): over `office.runaway.sessionTokens` tokens in one conversation (default 50,000,000, every kind, cache reads included); over `office.runaway.usdPerHour` estimated in the last hour (default 20); or working, replying in the last two minutes, and no progress for `office.runaway.stallMinutes` (default 30). 0 turns a check off. A flagged character wears a red warning triangle, its row and card say why, the header shows "N need attention" (click: pick the first), the dashboard toasts once when someone is newly flagged, and the daemon sends one desktop notification per runaway (`notifications.runaway`, default on).
- **Animations** can be turned off: `ui.officeAnimations` (Settings, Appearance, **Office animations**; default on). Off, or under `prefers-reduced-motion`, everyone jumps to their place and there are no errands or arrival queue.

**Exceptions to §14.0, for this page only** (they apply from Phase B):
- Characters walk to a new spot when their status changes, then hold a still pose. There are no perpetual loops. Under `prefers-reduced-motion` they jump instead.
- The walking motion is hand-written in the renderer's ticker. No animation library is added. PixiJS (WebGL/WebGPU) draws the canvas, in its own lazy chunk.
- Props and character art on the canvas are drawn, not Phosphor icons. Their colours are art (`outfit.ts`), not UI tokens. The UI around the canvas keeps every rule above.

---

### 14.6 Notes and todos

A shared notebook for you and Claude, per project and global: on a **whiteboard** in the office, on the **Notes** page (in the sidebar under Office), and in the CLI.

- **Records** (`NoteRecord`): `kind` (`note` or `todo`), `text` (up to 4000 characters), `project` (null for a global note), `done` and `doneAt` for todos, `archivedAt`, `by` (`claude` when written from a Claude Code shell, where `CLAUDECODE=1`, else `you`), `sessionId` (`AOE_INSTANCE_ID`, when there is one) and times. The id is four letters and digits without look-alikes (no 0/o, 1/l/i), so it can be read off the board and typed.
- **Storage:** `$XDG_DATA_HOME/supercharge/notes/<project>.json` and `_global.json` (project names are slugs, so they can't clash), written atomically under one lock. Archiving keeps a note, out of sight; nothing deletes one.
- **CLI:** `supercharge note add <text>`, `todo add <text>` (`-` reads stdin), `todo done|reopen <id>`, `note archive <id>`, `notes [--project|--global|--all] [--archived] [--json]`. Without `--project` or `--global`, a note goes to the project of the folder you are in, else to the project whose control chat started (or is) this AoE session (`crew`, `controlSessionId`, a task's session); else it is refused with a hint. `supercharge notes` prints the board as text: per project then Global, todos as `[ ]`/`[x]` with ids, then notes.
- **Skills:** `note`, `todo` and `gnote` are user-level skills (`~/.claude/skills`, installed and removed with the role skills, never committed into a repository), so `/note`, `/todo` and `/gnote` work in any Claude Code session. They pipe the text to the CLI. `/todo done <id or words>` ticks one. The control skill reads the open todos at the start and for status, and ticks a todo off when its work is done. Only you archive.
- **Daemon:** a watcher on the notes folder (and a periodic rescan) puts the notes that are not archived in the snapshot (`notes`) and sends a `notes` event on change. The dashboard writes through `/api/notes` (§12).
- **Notes page** (`/notes`): add a todo or a note for a project or Global (Enter adds), filter chips per project, each scope's todos (open first) with a box to tick, then its notes; every row has who wrote it, when, its id and **Archive**; `Archive N done` clears the ticked ones. `?archived=1` lists the archive with **Restore**. The sidebar item shows the number of open todos.
- **Whiteboard:** it hangs on the back wall just west of your corner (`layout.board`, four tiles; the world map moves over). The scene writes the open todos, the ticked ones (struck through) and the notes, newest first, one line each, slanted along the wall and rendered at 8x so they stay sharp at 250%; what does not fit becomes "+N more". Clicking it (or the **Whiteboard** chip) flies the camera close enough to read and opens the whiteboard card: the same board as the Notes page, with boxes to tick, Archive and a line to add. Double-click zooms to it. Escape closes the card.
- **Later:** phone sync. Google Keep's API cannot tick a checkbox, archive or label a note (create, get, list and delete only), so the candidate is Google Tasks (a list per project, Global and Archive; `tasks.move` with `destinationTasklist`), as a separate adapter over this store.

## 15. Resource targets
- **Idle RSS < 100 MB.** Expected around 55–70 MB on Node 24 **[measure]**. Exposed in `/api/snapshot.health` and `doctor`. CI starts the daemon against fake AoE, idles 60 s, samples RSS, fails above 100 MB on Ubuntu, and reports numbers in the job summary for both OSes.
- **No busy polling:**
  - Ledger changes come from `fs.watch` (recursive, Node 24) plus a 60 s reconcile scan.
  - AoE: 3 s with a dashboard connected, 15 s without. AoE has no event stream to subscribe to (§1.2), and it polls its own panes every 2 s anyway.
  - MRs: 60 s, and only for MR-stage tasks.
  - All intervals are configurable. Timers are `unref`'d.
- **Fast CLI:** `supercharge stage` starts in under 150 ms (single bundled ESM, lazy imports) **[measure]**.

---

## 16. Install & distribution

### 16.1 `install.sh` (bash; also runs under zsh; supports `curl | bash`)
1. Detect OS (Darwin/Linux; anything else exits with a WSL2 note) and the package manager: brew, else apt / dnf / pacman.
2. Plan each dependency:

| Dependency | Check | macOS | apt | dnf | pacman |
|---|---|---|---|---|---|
| git | `git --version` | brew | `apt install git` | `dnf install git` | `pacman -S git` |
| tmux | `tmux -V` | brew | apt | dnf | pacman |
| Node LTS (≥24) | `node -v` (respects nvm/fnm/volta) | `brew install node@24` | NodeSource 24.x **[verify]** | NodeSource **[verify]** | `nodejs-lts-krypton` **[verify]** |
| Claude Code | `claude --version` | `curl -fsSL https://claude.ai/install.sh \| bash` (verified in the Claude Code docs) | same | same | same |
| AoE | `aoe --version` + compat | `brew install aoe` | AoE's `scripts/install.sh` | same | same |
| glab | `glab version` | `brew install glab` | GitLab .deb **[verify]** | `dnf install glab` **[verify]** | `pacman -S glab` **[verify]** |

3. Print the plan (installed ✓ / to install, with the exact commands) and ask for confirmation unless `--yes`. `--dry-run` prints the plan only.
4. Install, verify each tool afterwards, then `npm i -g aoe-supercharge` (or `brew install xsoladdd/tap/aoe-supercharge`), then `supercharge start`, then `supercharge doctor`.

The README documents every dependency with manual install steps, the AoE version policy, and uninstall.

### 16.2 Packages
- **npm:** `aoe-supercharge`, published from CI with provenance. `engines.node >=24`. `os: [darwin, linux]`.
- **Homebrew:** formula in `xsoladdd/homebrew-tap`.
  - `depends_on "node"`, `"tmux"`, `"git"`, `"glab"`.
  - AoE and Claude Code are listed in `caveats`, because a formula can't depend on a cask or a third-party tarball.
  - `release.yml` opens a PR to the tap with the new version and sha256.

---

## 17. Testing

| Layer | Tooling | Covers |
|---|---|---|
| Unit | Vitest 5 | Stage machine (exhaustive table); ledger (atomic write, lock contention with 20 parallel writers, crash-mid-write leaves the last good file); config (schema, coercion, comment-preserving round-trip); compat ranges; glab parsing and ready rule (fixtures); XDG paths; Host/Origin/CSRF middleware; notification argument escaping; service file rendering (snapshots) |
| Contract (offline) | Vitest + zod | `fixtures/aoe/*/` against the client schemas, every CI run |
| Contract (live) | `scripts/contract-live.ts` | Real AoE in a sandbox HOME + tmux socket; used by `aoe upgrade` and the weekly workflow |
| Integration | Vitest | Daemon + fake AoE + fake `glab` (a PATH shim returning fixtures) + temp XDG dirs: CLI ↔ ledger ↔ SSE events |
| E2E | Playwright 1.63, projects chromium / firefox / webkit | Sidebar tree, Needs-you strip, control box, drawer, settings save + validation + restart, theme toggle, live SSE updates, cookie/CSRF flow via `supercharge open`, `.localhost` resolution per engine, axe-core a11y scan, no-dash string check, reduced-motion run. **Screenshots** at 1440×900 and 1080×1920 in dark and light, uploaded as CI artifacts for visual review (§14.4) |
| Installer | shellcheck + `install.sh --dry-run` under bash and zsh | macOS + Ubuntu runners; Fedora/Arch containers in dry-run |
| Resource | CI job | Idle RSS and CLI cold-start time, reported in the job summary |

**CI** (`ci.yml`): matrix `macos-latest` × `ubuntu-latest`, Node 24. Steps are lint (eslint + prettier), typecheck (tsc 7), unit, contract-offline, build, e2e, resource. GitHub runners can't host real launchd/systemd user sessions reliably, so service install is covered by rendering tests plus a documented manual checklist **[verify whether systemd --user can run in a container job]**.

---

## 18. Phases & exit criteria

Each phase ends with green CI, an updated README, a summary of what changed and what's next, and a stop for review.

1. **Skeleton**
   - Deliverables: CLI scaffold; config (schema, get/set/edit); paths; daemon (Hono, auth cookie/nonce, CSRF, Host gate, SSE heartbeat); launchd + systemd; `start/stop/restart/status/logs/open/doctor/uninstall`; `install.sh`; compat check; AoE client + `aoe serve` ensure; read-only dashboard listing AoE sessions (grouped by parent via `aoe list --json`); themes and tokens.
   - Exit: Playwright passes on 3 engines, §14.4 design gate passed, idle RSS measured, Firefox `.localhost` verified.
2. **Workflow**
   - Deliverables: `init`, `task new`, ledger, `stage`/`ask`/`plan`, `reply`, `whoami`, user-level skills + role prompts (D1), sidebar tree, control status box, worker list with stepper, Needs-you strip (blocked, approvals, control waiting).
   - Exit: an E2E run of the full flow against fake AoE, the §14.4 design gate, plus one manual run on a real repo with real AoE.
3. **MR watcher**
   - Deliverables: GitLab glab provider (+ self-hosted hosts), ready rule, merged→done, notifications (macOS/Linux, toggles, debounce), glab fixtures.
4. **Polish**
   - Deliverables: plan drawer, Settings UI + Restart, Reply action, Remote Control option, `aoe upgrade`, opt-in Caddy proxy, Homebrew tap, npm publishing, weekly compat CI.

---

## 19. Out of scope for v1
Windows; agents other than Claude Code; GitHub provider (`gh`); exposing the dashboard beyond localhost; automatic prompts to workers (for example on CI failure); managing AoE beyond ensuring `aoe serve` is running.

---

## 20. Implementation notes (v0.1.0, 2026-10-05)

All four phases are built. The verification behind each claim below is listed in §20.4.

### 20.1 Deviations from this spec

| Spec said | Built | Why |
|---|---|---|
| pino + rotating-file-stream | A small JSON-lines logger with gzip rotation and token redaction (`packages/cli/src/util/logger.ts`) | One self-contained bundle with no worker-thread transports; log volume is tiny |
| @tanstack/react-query | A ~90-line `useSyncExternalStore` store fed by SSE (`packages/ui/src/lib/live.ts`) | One stream, one snapshot; smaller bundle |
| `GET /api/tasks/:id` | `GET /api/tasks/:project/:id` | Task ids are only unique per project |
| Restart through `launchctl kickstart` / `systemctl restart` | The daemon exits with code 75. launchd `KeepAlive` or systemd `Restart=on-failure` brings it back; a foreground run has a tiny built-in supervisor | Same behaviour everywhere, and the Restart button also works in the foreground |
| Status colours in §14.3 | Re-solved so that text stays at least 4.6:1 even on its own 14% tint (dark: blue `#61afff`, red `#fa8486`, violet `#c599ea`, …; light: blue `#095db7`, amber `#7d5800`, …) | The axe gate caught 3.9:1 on tinted pills |
| "New task" button | Builds the exact `supercharge task new …` command to copy | The dashboard never spawns agents on its own (§8.2) |
| — | `?session=<id>` deep links the session drawer; `?done=1` shows done tasks | Web Interface Guidelines audit: URL reflects state |
| `license` in package.json | Left out | Choosing a license is the owner's call; needed before the first publish |

### 20.2 New AoE facts found while building

- **Hook consent.** A fresh AoE refuses to *launch* agents until `has_acknowledged_agent_hooks = true` is set in `<app_dir>/state.toml` (approved once in the TUI). `aoe add` still creates the session and exits non-zero.
  - `init` and `task new` now keep the session and print the fix (`aoe session start <id>`).
  - `doctor` checks the flag.
- **`aoe add -c`** only accepts known agent names. The sandbox uses `--tool claude --cmd-override <stand-in agent>`.
- **`aoe add -b`** fetches the base branch from `origin`.
- **`aoe serve` picks up CLI-created sessions after a short delay.** The contract test waits for them; the daemon's reconcile handles it.
- **App dir on macOS:** `$XDG_CONFIG_HOME/agent-of-empires` if it exists, else `~/.agent-of-empires`. AoE creates the XDG dir on first use when `XDG_CONFIG_HOME` is set.
- **AoE 1.18.0 release binary** is named `aoe-<os>-<arch>`. 1.18 only recognises its own daemon when the binary is named `aoe`, so the upgrade path renames it.
- **AoE 1.18.0 passes all 18 live contract checks.** `supercharge aoe upgrade` is ready to move from 1.17.2 to 1.18.0.
- **`POST /api/sessions/{id}/send` types the text literally, then presses Enter** (`src/tmux/session.rs`, `send_keys_with_delay`; bracketed paste from 16 bytes up). There is no way to send keys without the Enter. The live terminal websocket accepts raw input only from the client that owns the window size, so the dashboard does not use it.
- **Answering Claude Code menus (Claude Code 2.1.236, read from its `Select` component and checked in a sandbox):**
  - A digit confirms that option at once, with no Enter. AoE's Enter then lands on the empty prompt and does nothing.
  - On a text-input option (the plan's "Tell Claude what to change") with no text, the digit only focuses the row. The Enter after it cancels the menu (`onSubmit` with empty text calls `onCancel`). Feedback is therefore sent as a second, normal message once the menu has closed.
  - Free text sent while a menu is open would select the highlighted option (a plan's option 1 is "Yes, and use auto mode"). So `sendToSession` refuses with `menu_open` / 409 while the pane shows a menu, and the UI swaps the composer for the answer card.
  - AskUserQuestion moves to its next question (and a Submit tab) on each digit, and in multi-select the Enter toggles the highlighted row. So it is not driven by digits. Instead Supercharge presses **Escape**, which closes it (`onCancel`) and stops Claude, then sends the answers as a message.
- **Escape needs AoE's live-terminal websocket** (`/sessions/{id}/live-ws`, bearer auth). Sent through REST `send`, Escape and the trailing Enter merge into one key that Claude Code ignores (checked on its trust dialog).
  - Over the websocket, `{"type":"claim_if_vacant"}` returns `size_owner`.
  - Binary frames are raw pane input. Supercharge sends no `resize`, so the window keeps its size, and closing the socket releases the lock.
  - If someone is viewing the session in AoE, `claim_if_vacant` fails. Supercharge then sends `{"type":"claim"}`, AoE's explicit take-over: with no `resize` sent, the window keeps the viewer's size. It closes the socket right after the Escape, and AoE's web view takes the lock back within about 1.5 s (its capture loop reclaims a vacant lock while it is at the live edge). Supercharge says `terminal_busy` only if the take-over fails too. (AoE 1.17.2 `src/server/live_ws.rs`, `steal_size_owner` in `src/tmux/session.rs`.)
  - Verified in a sandboxed AoE 1.17.2: a lone `1b`, then a separate `32`, with an unchanged 80×24 window. A lone Escape cancels Claude Code menus.
- **A session's own shell (AoE 1.17.2, `src/server/live_ws.rs`, `src/server/api/sessions/ensure.rs`).** AoE keeps a paired shell next to each session, in its folder, as its own tmux session: its web view's Terminal tab, and the TUI's terminal (index 0 is shared with them).
  - `POST /api/sessions/{id}/terminal` starts it: 201 `created`, or 200 `exists`.
  - `/sessions/{id}/terminal/live-ws` speaks the agent pane's protocol. Down: JSON `frame` messages, each the whole window as ANSI text (history lines first, the live screen as the last `rows` lines), with `cursor`, plus `size_owner`. Up: binary raw input, and JSON `resize` (takes the size lock and sizes the window), `claim`, `window` (lines of history), `cadence`.
  - The dashboard's Shell tab relays it through the daemon (`/api/sessions/:id/shell/ws`), so AoE's token stays server-side. It never asks for `caps`, so frames stay JSON text. It paints each frame into xterm.js whole.
  - A command run there is pasted as `ESC[200~…ESC[201~` and then entered. In a sandboxed AoE 1.17.2 with zsh, a two-line paste waited whole at the prompt until the Enter, then ran both lines.
- **Claude Code does not always write an AskUserQuestion call to the transcript before it is answered**, while ExitPlanMode is written while waiting. So the question on screen, its options and descriptions, and the other questions' headers (from the tab bar) are read from the pane. The full set is used when the transcript has it.
  - The daemon reads menus from the pane (`parseTerminalMenu`) for waiting sessions only. It takes the kind (plan, permission, question) from the pending tool call in the transcript. An answer is delivered only while a menu with the same key is still on screen.

- **Model and effort (Claude Code 2.1.236).**
  - New sessions take `--model <alias|id>` and `--effort <low|medium|high|xhigh|max>`, which apply to that session only. `agent.model` and `agent.effort` set them for new control chats and workers.
  - A running session can only be changed by typing `/model <alias>` or `/effort <level>`, and AoE cannot change a session's launch flags (`PATCH /api/sessions/{id}` only renames it).
  - Typed in the TUI, `/model` is saved to `userSettings` as the default for new sessions. So is `/effort` low to xhigh; `max` and `auto` are session-only. The dashboard confirms each change with that spelled out, and offers only aliases. Aliases stay under AoE's 16-byte literal-send limit, so AoE's trailing space keeps autocomplete from eating the Enter.
  - Each assistant record carries `message.model` and a top-level `effort`. Commands leave `<local-command-stdout>Set model to …` / `Set effort level to …` echoes. The chat bar reads both.

- **Attachments.** Claude Code turns a pasted image path into an inline image only when the whole paste is the path, and AoE's Enter would then send it alone. So attachments are uploaded to `<state>/uploads/<session>/` (never the repo) and sent as `Attached: <path>` lines that Claude opens with its Read tool. New sessions get `--add-dir` for that folder.
- **Plan comments and notes** live in the ledger: `tasks/<id>/comments.json` and `projects/<name>/notes.md`. Sending comments while the worker shows its plan for approval uses that menu's "Tell Claude what to change"; otherwise they go as one message.

### 20.3 Measured

| Metric | Target | Result |
|---|---|---|
| Daemon idle RSS (worker) | < 100 MB | 71–81 MB |
| Foreground supervisor RSS | — | about 41 MB (foreground only; absent under launchd/systemd) |
| Idle CPU | — | 0.3–0.5% |
| CLI cold start, `--version` | < 150 ms | 60–92 ms |
| CLI cold start, `whoami` | < 150 ms | about 130 ms |

### 20.4 Verification

- **Vitest, 305 tests:**
  - exhaustive stage machine,
  - ledger with 20 concurrent writers,
  - config round-trip that keeps comments,
  - glab parsing and the ready rule,
  - service file rendering (the plist passes `plutil -lint`),
  - offline contract against the recorded fixtures,
  - integration: the real CLI and daemon against fake AoE, covering auth, CSRF, the Host gate, SSE, and the MR watcher.
- **Playwright, 46 tests across Chromium, Firefox and WebKit:**
  - axe has no serious or critical findings in either theme,
  - no em or en dashes in UI text,
  - reduced motion,
  - screenshots at 1440×900 and 1080×1920 in both themes.
- **`web-design-guidelines` audit.** Findings were fixed, except Title Case, which conflicts with the sentence case chosen in §14.0.
- **Live contract** against the real AoE 1.17.2 and 1.18.0 binaries: 18/18 each, sandboxed.
- **`install.sh --dry-run`** under bash, zsh, and piped.

### 20.5 Still open

- Node 26 becomes LTS later in October 2026. Raise `engines` and CI after that.
- Whether project-level or user-level skills win when `init --commit` creates both with the same names (§8.1): not exercised against a real Claude session yet.
- A systemd `--user` test in a CI container (§17).
- CI workflows are written and their YAML is validated, but they have not run on GitHub yet; nothing has been pushed.
