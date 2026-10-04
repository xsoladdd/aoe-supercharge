# AoE v1.17.2: source notes (Phase 0)

These facts were read from `github.com/agent-of-empires/agent-of-empires` at tag `v1.17.2` (commit `ac1f582`) on 2026-10-04. Paths are relative to that repo. Use them when building the AoE client, the fake AoE server and the contract tests. Check them again on every AoE upgrade.

## Routes (`src/server/router.rs:16-357`)

Every route goes through four middleware layers (`:369-384`): host/origin check, token auth, CityHall gate, and a 1 MiB body limit.

### Sessions

| Method | Path | Notes | Source |
|---|---|---|---|
| GET | `/api/sessions?state=live\|trashed\|all` | Returns `{sessions: SessionResponse[], workspace_ordering}` | `api/sessions/list.rs:25-368`; struct in `src/daemon/wire.rs:117-240` |
| GET | `/api/sessions/{id}` | **Does not exist.** That path only takes PATCH (rename) and DELETE | `router.rs:56-59` |
| POST | `/api/sessions[?wait=ready]` | Body is `CreateSessionBody`; see below | `create.rs:15-100` |
| POST | `/{id}/start`, `/{id}/stop` | Both return a `SessionResponse` | `lifecycle.rs:919,1085` |
| POST | `/{id}/ensure` | Revives a dead pane | |
| POST | `/{id}/trash`, `/{id}/restore` | Soft delete | |
| DELETE | `/api/sessions/{id}` | Body `{delete_worktree, delete_branch, delete_sandbox, force_delete, keep_scratch}`; returns `{status: "deleted"\|"kept", messages}` | `delete.rs:8-21,436-510` |
| POST | `/{id}/send` | Body `{message, revive=true}`; returns `{sent:true}` | `docs/api.md:64-103` |
| GET | `/{id}/output?lines=&format=text\|ansi` | Returns `{id, lines, format, content}` | `docs/api.md:64-103` |

**`CreateSessionBody` fields:**
- `path`, `tool`, `title?`, `group`, `profile`
- worktree: `worktree_enabled`, `worktree_branch?`, `create_new_branch`, `base_branch?`, `extra_repo_paths[]`
- agent: `extra_args`, `extra_env[]`, `agent_name`, `model`, `effort`, `yolo_mode`, `view`
- other: `sandbox`, `scratch`, `trust_hooks`, `fork_from`, `import_acp_session_id`, `callback_url`, `idempotency_key`

**Create behaviour:**
- **There is no parent field.**
- Returns 201, or 200 when an idempotency key matches (`create.rs:892,987`).
- Errors look like `{error, message}` (`api/mod.rs:83`).
- A repo with untrusted hooks returns 403 `hooks_need_trust`.
- `extra_args` is rejected if it contains shell metacharacters (`api/mod.rs:168-181`; `create.rs:657-665`).

### Approvals and structured sessions

- `pending_approvals[] {nonce, tool_name, target, destructive, choice}` is filled only for structured (ACP) sessions that have a running worker (`list.rs:84-104`).
- Answer with `POST /{id}/acp/approvals/{nonce}` and body `{decision: Allow|AllowAlways|Deny|Cancelled, option_id?}` (`src/acp/protocol.rs:117-129`).
- **Terminal-mode Claude permission prompts have no REST surface.** The TUI answers them by sending the keys `1`, `2` or `3` (`src/agents.rs:488-492`).
- Prompt a structured session with `POST /{id}/acp/prompt`, body `{text, attachments[], prompt_id?, no_revive}` (`protocol.rs:86-102`).

### Other routes

| Route | Returns | Source |
|---|---|---|
| `GET /api/groups` | `[{path, session_count}]` | `system.rs:1177` |
| `GET\|POST /api/projects`, `PATCH\|DELETE /api/projects/{name}` | | |
| `GET\|POST /api/profiles` | | |
| `GET /api/git/branches` | | |
| `GET /api/about` | `version`, `auth_mode`, `read_only`, `profile`, `build_flavor`, … (token required) | `system.rs:1344-1424` |
| `GET /api/system/update-status` | `current_version`, `latest_version`, … | |
| `GET /api/system/health` | | |

### Streaming

- **There is no SSE or global event stream.**
- WebSockets are per session only:
  - `/sessions/{id}/live-ws` for terminal frames (`live_ws.rs:1-31`)
  - `/sessions/{id}/acp/ws` for structured-view events (`acp_ws.rs:30-45`)

## Auth (`auth.rs`, `access.rs`, `token.rs`)

- **Token file:** `<app_dir>/serve.token`, mode 0600, 64 hex characters (`token.rs:204-237,190`).
  - On startup, the token is reused if the file is less than 24 h old; otherwise a new one is generated.
  - It only rotates on a timer with `--remote` (every 4 h) (`startup.rs:221-228,841-853`).
- **Accepted forms:** the `aoe_token` cookie, `?token=`, `Authorization: Bearer`, or the WebSocket subprotocol `aoe-token.<t>` (`auth.rs:106-138,598`).
- Any `/api/*` request without a valid token gets 401 (`auth.rs:612-637`). With a valid token, unknown paths fall through to the SPA and return 200 `text/html`.
- **Host must be loopback** (or the bind host, or an allowed host). **Origin is checked only when present.** There is no CSRF token (`access.rs:109-204`).
- AoE's own internal client sends Bearer with no Origin and re-reads the token on each request (`src/acp/client/discovery.rs:18-28,146-157`).
- **App dir (macOS):** `~/.config/agent-of-empires` if it exists, otherwise `~/.agent-of-empires` (`session/mod.rs:199-222`).

## Status (`src/session/instance/status.rs:7-46`)

- **Values:** `Running, Waiting, Idle, Unknown, Stopped, Error, Starting, Deleting, Creating`. PascalCase in the API, lowercase in the CLI and hooks.
- **Claude hooks** live in `~/.claude/settings.json` (`agents.rs:303-331,470-475`) and map like this:

| Hook | Status |
|---|---|
| `Notification` (`permission_prompt`, `elicitation_dialog`, `agent_needs_input`) | Waiting |
| `PreToolUse` for `AskUserQuestion` | Waiting |
| `UserPromptSubmit`, other `PreToolUse` | Running |
| `Stop`, `Notification` with `idle_prompt` | Idle |

- **Pane scraping** (`src/tmux/detect/manifests/claude.toml`) reconciles the hook result. The daemon polls every 2 s (`status_poll.rs:129`).
- `Waiting` doesn't say why the session is waiting. The `urgent` flag is separate: a script sets it in `attention.json`.

## Parent / sub-sessions

- Stored as `Instance.parent_session_id` (`session/instance/mod.rs:177`) in `profiles/<profile>/sessions.json`.
- **Only `aoe add -P` sets it** (`cli/add.rs:55,488-497,525`).
  - Nesting is one level deep.
  - The child inherits the parent's group.
- **Not available over REST.** It is absent from `SessionResponse` and `CreateSessionBody`.
- **It is visible** in `aoe list --json` (`cli/list.rs:100,145,291`) and `aoe session show --json` (`cli/session.rs:361,380`).
- **Deleting a parent does not cascade.** Orphans keep the dangling id (`cli/session.rs:3270-3272`).

## Worktrees and `--extra-args`

- **Path:** `worktree.path_template`, default `../{repo-name}-worktrees/{branch}` (`session/config/mod.rs:2419-2429`).
  - In `{branch}`, the characters `/@#\:*?"<>|` become `-` (`git/template.rs:14-19`).
- **Base branch for `-b`:** `--base-branch`, then `worktree.default_base_branch`, then the repo's default branch.
- **`--extra-args`:**
  - Appended verbatim after the `claude` binary on the **shell** launch line, before AoE's own `--session-id`/`--resume` flags (`launch_command.rs:834-855`).
  - The profile default is `session.agent_extra_args.<tool>`.
  - It is ignored for structured sessions.

## `aoe send`

- **Terminal sessions:** tmux `send-keys -l`. Messages of 16 bytes or more, or containing newlines, go through a bracketed paste buffer. Enter follows after 150 ms for Claude (`cli/send.rs:26-99`; `tmux/session.rs:986-1026`).
- **Structured sessions:** the message goes to `POST /acp/prompt`.

## Versioning

- There is no API version prefix or header. The version comes from `/api/about.version`.
- Releases follow semver; a major bump means breaking config, CLI or on-disk changes (`docs/development/releases.md:38`).
- **v1.15.0 → v1.17.2** only added things:
  - routes: plugin worker restart, `/api/system/health`
  - `SessionResponse` fields: `context_resume`, `pending_approvals`, `rate_limit*`
- **v1.18.0** adds `/diff/file/raw` and `/file/raw`. `SessionResponse` is unchanged.
- **`aoe update`** uses the GitHub releases API (overridable with `AOE_UPDATE_API_BASE`) and caches results for 24 h (`src/update/mod.rs`).

## Push channels: none usable from a localhost daemon

| Channel | Why it doesn't work | Source |
|---|---|---|
| `callback_url` (create-time only) | Rejects loopback, private, CGNAT and link-local targets | `server/callback.rs:145-165` |
| `[status_hooks]` | Fire only from the TUI, not from `aoe serve` | `src/status_hooks.rs`; callers in `src/tui/…` |
| Web Push (`/api/push/subscribe`, VAPID) | Use by a server-side client is unconfirmed | |

**Conclusion:** poll `GET /api/sessions`.

## Not confirmed from source

- Whether `claude` accepts every flag we pass through `--extra-args`. (Claude Code 2.1.236 lists `--plugin-dir`, `--append-system-prompt-file`, `--remote-control` and `--permission-mode` in `--help`.)
- Whether `POST /send` with `"1"` answers a terminal permission prompt (send always adds Enter).
- AoE web dashboard deep-link format for "Open in AoE".
