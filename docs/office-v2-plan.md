# Office v2 plan

Seven features for `/office` (SPEC §14.5), built in eight phases. Each phase is its own commit(s) and
leaves the app working. All eight ship together as **0.5.0** (task AS-0001). This file is kept up to date as phases land. The owner's brief is
[office-v2-brief.md](office-v2-brief.md).

## Working on it

- **One task per phase, in order**: each builds on the one before. Read the brief and this plan first,
  and set the phase's status below when it lands.
- **Archive is office-only** (owner's decision, see Assumptions). Anything else that would delete or
  archive data: ask the owner first.
- **Before a phase is done:** `npm run lint`, `npm run typecheck`, `npm test`, and `npm run test:e2e`
  (Chromium, Firefox and WebKit). The Playwright ports 47391 and 47392 are fixed and shared between
  worktrees: if `lsof -nP -iTCP:47391 -iTCP:47392 -sTCP:LISTEN` shows another run, wait for it; never
  kill it.
- **Docs in the same phase:** SPEC §14.5 (and §12 for new API routes), the README's Dashboard and
  Configuration sections, and a CHANGELOG entry.
- **The repository is public:** no real transcript content, customer or company data in tests,
  fixtures or demo data.
- **Merging:** this repository is on GitHub, and Supercharge's MR stages watch GitLab only, so
  `supercharge stage mr_raised` does not apply here. The owner decides how a phase comes back (a pushed
  branch, a pull request, or a local merge).
- **Releasing** (after the merge, the owner's process): a "Release X.Y.Z" commit (CHANGELOG version and
  date, the README status line, `npm version X.Y.Z -w aoe-supercharge --no-git-tag-version`), push, fast-
  forward `main`, then `npm pack -w aoe-supercharge`, `npm install -g <tgz>` from `~`,
  `supercharge start`, and check `curl http://supercharge.localhost:4280/healthz`. Never push a `v*`
  tag: it would try to publish to npm.

## What exists (step 0)

- **Rendering:** a PixiJS v8 imperative scene (`packages/ui/src/lib/office/`: `scene.ts`, `art.ts`,
  `character.ts`, `camera.ts`, `iso.ts`), procedural art, our own A\* (`core/shared/pathfind.ts`),
  render on demand. No new rendering library is needed.
- **Plan:** `officeLayout` (`core/shared/office-layout.ts`): a team block per project (rug, team sign,
  lead desk, rows of desks), the pantry, your door with its roped line, the whiteboard, an entrance on
  the left wall with windows along it. The office grows with teams and desks.
- **Status to place:** `officeSpot` / `sessionSpot` / `leadSpot` (`core/shared/office.ts`) map a task,
  its AoE session and its Needs-you items to a zone (`door`, `desk`, `pantry`, `away`, `gone`), a pose,
  a prop and a reason. `buildOffice` (`ui/src/lib/office.ts`) builds the whole floor from the snapshot.
- **Live updates:** the daemon's `Store` emits typed events over SSE (`/api/events`) with a sequence
  number and a replay buffer; the UI keeps a snapshot and derives the office from it (no per-frame state).
- **Already built from the brief:** per-project areas and dynamic chips (feature 1, without walls),
  walk-in from the entrance and walk-out (feature 2, spawn half), no animation on first load,
  `prefers-reduced-motion` (jump instead of walk), the roster list view with every character.
- **Merge requests:** `MrWatcher` polls `glab` (`cli/src/mr/gitlab.ts`) for tasks in MR stages, with
  backoff on rate limits, and stores `TaskRecord.mr` (`iid` in the URL, `pipeline`, `unresolvedThreads`).
- **Tokens:** `TranscriptStore` (`cli/src/transcript.ts`) maps an AoE session to its live Claude
  conversation (AoE's SessionStart hook file, then `aoe session show`) and parses the JSONL
  incrementally. Each assistant record carries `message.usage` (`input_tokens`, `output_tokens`,
  `cache_creation_input_tokens`, `cache_read_input_tokens`, `cache_creation`, `speed`, …); the records of
  one message repeat the same usage, so it is counted once per `message.id` (checked on a local
  transcript, Claude Code 2.1.x).
- **Config:** `config.toml` validated by a zod schema (`core/node/config.ts`); the Settings page is
  generated from the schema, so new keys appear there and in the file.

## Data model

- **Zones** gain `review` (the review lounge) and `archived` (walked out, off the floor).
- **Review lounge** replaces the pantry for a worker with a deliverable: stages `mr_raised`,
  `watching_mr`, `ready_for_review`. It carries a folder: green = MR ready, red = pipeline failed or MR
  closed, amber = waiting (pipeline running or open review threads). **Assumption:** "MR ready" now waits
  in the review lounge with a green folder instead of queueing at your door; it stays in Needs you and
  still notifies. Your door keeps everything that stops work until you act.
- **Rooms:** each project's team block becomes a room: low glass partitions on its edges with a
  doorway, and a nameplate. Pathfinding learns edge walls (`Grid.wall`) so nobody walks through glass.
- **`buildOffice` moves to core** (pure, with the hold memory passed in), so the daemon can compute the
  floor for the history log and runaway/idle checks with the same rules as the UI.
- **Office state** (`<data>/office/office.json`, written under the `office/` folder's lock): per character `archivedAt`,
  `keptAt` (idle prompt dismissed for this idle stretch), `snoozedUntil`.

## Event model (history)

- The daemon recomputes the floor on every store change (and when a hold runs out), diffs each
  character's state (zone, reason, prop, stage, MR pipeline) and appends one record per change:

  ```
  { v: 1, type: "move", ts, key, sessionId, parentId, project, taskId, worktree, name, role, desk,
    from: Zone | null, to: Zone, reason, prop, stage, cost: { tokens, usd } | null,
    mr: { iid, url, pipeline, threads } | null }
  ```

- A `frame` record (every character's state) is written at daemon start, at the first write of each
  UTC day, and every 6 hours, so the state at any time is "the latest frame before it, plus the moves
  after it" (`officeAt(records, t)`, pure and tested).
- **Storage:** JSON lines per UTC day in `<state>/history/YYYY-MM-DD.jsonl`, like `audit.jsonl`. No
  SQLite: the app has no database, and `node:sqlite` still prints an ExperimentalWarning on Node 24.14.
  Retention: `office.history.retentionDays` (default 30); older files are deleted at start and daily.
- **API:** `GET /api/office/history?from&to[&project][&key]` returns the frame before `from` and the
  records in the range.

## Sources

- **Tokens and cost:** tokens from Claude Code transcripts (above), per AoE session's live
  conversation. Cost is an **estimate**: tokens × the per-model price table in one file
  (`core/shared/model-prices.ts`), shown as "≈ $" with "estimate" in labels. Prices are taken from
  Anthropic's published pricing at build time (to verify in phase 5; unknown models show tokens only).
  On a Claude plan this is the API-equivalent value, not a bill.
- **MR badge:** `TaskRecord.mr` from the existing glab watcher (no new polling). The "CodeRabbit count"
  is the number of unresolved resolvable threads, whoever opened them.
- **Weather:** Open-Meteo, fetched by the daemon, cached 15 minutes, clock only on failure (terms and
  response shape to verify in phase 7; see open questions).

## Settings (all in `config.toml`, all in the Settings page)

`ui.officeAnimations` · `office.history.retentionDays` · `office.runaway.{sessionTokens, usdPerHour,
stallMinutes}` · `office.idle.{promptMinutes, autoArchiveMinutes}` (0 = off) · `office.clocks.{home,
away}.{label, timeZone, latitude, longitude}` · `office.weather.enabled` · `office.windows`
(`activity` default, or `weather` to follow the home city's real day/night and weather).

## Phases

| # | Phase | Feature | Release | Status |
|---|---|---|---|---|
| 1 | `buildOffice` in core, office state file, history log + API, `officeAt` | 7 backend, 1 model | 0.5.0 | Done |
| 2 | Rooms: glass partitions with doorways, nameplates, edge walls in A\*, review/room layout capacity tests | 1 | 0.5.0 | |
| 3 | Finish errand (walk to the lead, hand over a folder, then on), spawn queue at the entrance, animations toggle | 2 | 0.5.0 | |
| 4 | Review lounge (pool table), folders, MR badges (click opens the MR), header count | 3 | 0.5.0 | |
| 5 | Token/cost meter on desks, characters and header; runaway detection, warning, notification | 4 | 0.5.0 | |
| 6 | Idle "go home" prompt (Archive / Keep / Snooze 30m), auto-archive, Archived list with Restore | 5 | 0.5.0 | |
| 7 | Activity lighting (day, dim, night), clocks with time difference, Stockholm weather, window ambience | 6 | 0.5.0 | |
| 8 | History mode (scrubber, play 1x/10x/60x, filters, Back to Live), "Since I was away" | 7 | 0.5.0 | |

Every phase: unit tests for its pure logic, Playwright for its UI (all three engines), README and SPEC
updated, demo data extended so it can be seen without real agents.

## Assumptions

- **Archive is office-only** (decided with the owner): a Supercharge flag. The AoE session, worktree
  and transcript are untouched. An archived character comes back by itself if its session starts working
  or needs you, and List view has Restore.
- "Today" in the header is the local calendar day; "now" is the sum over the conversations of the
  characters on the floor.
- History starts when phase 1 ships; there is no backfill.
- A history file is kept while any of its UTC day is inside the retention, so up to `retentionDays + 1`
  files exist. A daemon that starts again first writes a frame of the last state it had recorded, then
  the moves to the floor it finds, so what changed while it was down is one record at its start.
- The daemon logs nothing until both the ledger and AoE have loaded, so a start never records everyone
  leaving and coming back.
- Rooms keep the current grid of team blocks (2 to 3 per row) and grow with desks; 10 desks per project
  and 3 projects are tested not to overlap.

## Open questions

- Prices for the models in use (phase 5): the table needs checking against Anthropic's pricing page
  whenever models change. Fast mode (`usage.speed`) is priced differently.
- Open-Meteo's terms for its free API (non-commercial use, as I recall; to verify in phase 7). If so,
  using it on a work laptop may count as commercial use: **needs owner review**. `office.weather.enabled`
  turns it off.
