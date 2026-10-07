# Office v2 brief

The owner's brief for extending the Office view, as given. The plan that answers it is
[office-v2-plan.md](office-v2-plan.md).

## Context

Supercharge is my opinionated UI on top of Agent of Empires (AoE). It tracks git worktrees, tasks and
Claude Code chats in a parent/child relationship (control chat per project, worker chats as children).
The Office page (`/office`) is an isometric floor view where each character represents one AI child chat:

- **Desks** = child is running
- **"Your office" (my door)** = child needs me (question, permission, review)
- **Pantry** = child is done or idle
- The header summary reads like "0 at your door · 4 at desks · 1 in the pantry"
- Zone tabs: Whole office, Your office, Pantry, and a per-project zone (e.g. `my-repo`)
- Stack: Tailwind CSS + shadcn/ui, runs as a local background server (macOS and Linux)
- Worker lifecycle: planning → implementation → verification → raise GitLab MR → watch MR for CodeRabbit
  feedback / pipeline status → nudge me to test and review before I merge manually

## Step 0: Before writing code

1. Read the existing Office implementation: how the isometric scene is rendered (SVG, canvas, CSS or a
   library), how characters, zones and tabs are modeled, and how live status reaches the UI (polling, SSE
   or WebSocket).
2. Reuse the existing rendering approach, art style, palette and state-to-zone mapping. Do not introduce
   a new rendering library unless the current one cannot do the job. If so, explain why first.
3. Write a short plan (`docs/office-v2-plan.md`) covering the data model changes, the event model, and the
   phase order below. Then proceed phase by phase. Each phase should be a separate commit or MR-sized
   chunk and leave the app working.

## Features

### 1. Multiple rooms per project / worktree

- Each **project (repo)** gets its own room with a nameplate (e.g. `my-repo`). Rooms are laid out in the
  isometric floor and selectable via the zone tabs, which should be generated dynamically from the
  projects that exist.
- Inside a room, the **control (parent) chat** sits at a head desk and its **worker (child) chats** are
  clustered around it, one desk per worktree or child. Handle 5-10 worktrees per project and 2-3 projects
  without overlap. Rooms can auto-size, or the layout can use a grid.
- Keep Your office, Pantry and the new Review area as shared spaces, not per-room.
- "Whole office" shows all rooms. Selecting a room zooms or pans to it.

### 2. Delegation animation

- **Spawn:** when a parent spawns a child, a new character walks in through the entrance door, crosses
  the floor and sits at a free desk in that project's room.
- **Finish:** when a child completes, it walks to its parent's desk, hands over a folder, then walks to
  the Pantry or the Review area (see feature 3).
- Use pathfinding or predefined waypoints between zones, and play animations only when a status
  transition is observed live.
- On initial page load or reconnect, place characters directly at their correct positions with no
  animation.
- Respect `prefers-reduced-motion`, and add a global "animations on/off" toggle in settings.
- Queue simultaneous transitions so characters don't spawn on top of each other.

### 3. Review shelf (pool table area)

- Add a **pool table / review lounge** space. Finished agents with a deliverable go here instead of the
  generic Pantry.
- Each finished character carries an object:
  - **green folder** = MR ready
  - **red folder** = failed / pipeline failing
  - Optional third state (e.g. amber) = CodeRabbit feedback pending
- Show a small **MR badge** on the character (MR number, pipeline status icon, CodeRabbit comment count).
  Data comes from GitLab via `glab`, so check how the app already shells out or integrates and reuse it.
  Poll with sensible backoff and cache results.
- Clicking the badge opens the MR URL in a new tab.
- The Pantry stays for agents that are idle with no deliverable.
- Update the header summary to include the review count.

### 4. Cost and token meter

- Show a small gauge (or compact number + bar) on each desk and character, plus a **total in the header**
  (today and current session).
- Find where token and cost data is available (Claude Code session transcripts or usage data, AoE data,
  or whatever the app already reads). Document the source in the plan. If cost must be estimated from
  tokens, keep the per-model price table in one config file and label the value as an estimate.
- Add a **runaway-agent warning**: configurable thresholds (tokens per session, spend per hour, or
  no-progress-for-N-minutes while burning tokens). A flagged character gets a visible warning icon and a
  toast or notification, and appears in a "needs attention" count.
- Thresholds are editable in the settings UI and persisted in config.

### 5. Idle timeout

- Agents idle in the Pantry beyond a configurable threshold (default 30 min) show a "go home" prompt with
  actions: **Archive**, **Keep**, **Snooze 30m**.
- Optional setting: auto-archive after a second, longer threshold.
- Archive means the character walks out the entrance door and is removed from the floor. It must **not**
  delete the underlying session, worktree or history. Archived agents remain visible in List view and in
  Office history, and can be restored.
- Add a clear confirmation for any destructive action.

### 6. Day/night cycle and clocks

- The window panes on the left wall already exist. Drive lighting from **office activity**: bright when
  agents are running, dimmed when nothing is running, and a distinct warm "night" look when idle for a
  long period. Interpolate smoothly. Also dim the whole scene slightly when no agents are active.
- Add a **clock widget** in the Office header (or a small floating panel) showing:
  - **Sweden** (`Europe/Stockholm`): time, date, and current weather (temperature + condition icon)
  - **Philippines** (`Asia/Manila`): time and date
  - The **time difference** between them (computed from the IANA time zones, so DST is handled
    automatically)
- Weather: use a free keyless source such as Open-Meteo for Stockholm, fetched server-side and cached
  about 15 minutes, with graceful failure (show clock only if the request fails). Verify the API's current
  terms and response shape before relying on it.
- The windows can optionally reflect the real Swedish day/night and weather (sun, rain, snow) as an
  ambience layer. Keep this behind a setting, with activity-based lighting as the default.

### 7. Office history (timeline scrubber)

- Persist **status transition events** server-side (SQLite or whatever the app already uses):
  `{timestamp, sessionId, parentId, project, worktree, fromState, toState, label/summary, cost snapshot,
  MR ref}`. Retention is configurable (default 30 days).
- Add a **History mode** in the Office view: a timeline scrubber and play/pause with speed control (1x /
  10x / 60x). The floor re-renders characters at their historical positions at the scrubbed time. Live
  mode is clearly separate, and a "Back to Live" button is always visible.
- Add a **"Since I was away" summary** (e.g. "Since 18:00: 3 agents finished, 2 MRs raised, 1 failed, $X
  spent") that can be opened from a button. This doubles as a standup view.
- Allow filtering by project and by agent.
- Backfill is not required. History starts from when this feature ships.

## Cross-cutting requirements

- Keep the existing live updates working. Avoid re-render storms: derive character positions from state
  and animate transitions only.
- All new settings (thresholds, timeouts, animation toggle, timezone/city config, retention) go in the
  existing config system and are editable from both the UI and the config file.
- Accessibility: every character and status must be reachable in List view too, so no information exists
  only in the isometric scene. Add tooltips or aria labels.
- Performance: stay smooth with about 30 characters on screen.
- Add tests for the pure logic (state-to-zone mapping, idle timer, runaway detection, time-difference
  calculation, history reconstruction).
- Do not hardcode project names, so everything is generated from real data. Use mock or fixture data in a
  dev-only mode to demo features without real agents.

## Phase order

1. Data model + event log (feature 7's backend) and the project/room model (feature 1)
2. Rooms layout + dynamic tabs (1)
3. Spawn/finish animations (2)
4. Review area + folders + MR badges (3)
5. Cost/token meter + runaway warning (4)
6. Idle timeout (5)
7. Day/night + clocks + weather (6)
8. History scrubber + "since I was away" (7)

## Deliverables

- Working implementation for each phase, with a short summary of what changed after each
- `docs/office-v2-plan.md` kept up to date
- A list of open questions or assumptions you made, especially around where token/cost data comes from
  and how MR data is fetched

If something is ambiguous, state your assumption and proceed rather than blocking, unless it affects data
deletion or archiving.
