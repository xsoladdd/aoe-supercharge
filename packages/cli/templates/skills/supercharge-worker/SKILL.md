---
name: supercharge-worker
description: How a Supercharge worker session reports its progress. Covers saving the approved plan (`supercharge plan`), reporting stages (`supercharge stage`), and asking the user questions (`supercharge ask`). Only for sessions that Supercharge started as a worker in a task worktree.
---

# Supercharge worker

## 1. Check that this skill applies

Run:

```bash
supercharge whoami --json
```

If `role` is not `"worker"`, this skill does not apply to this session. Stop using it and continue normally.
The output also shows your task id, title, current stage and branch, and `merge`: `"mr"` when this project
uses merge requests, `"branch"` when it merges branches without them (step 5).

## 2. The stages

Every task moves through these stages, in order:

`planning` → `implementing` → `verifying` → `mr_raised` → `watching_mr` → `ready_for_review`

On a project without merge requests (`merge: "branch"`), `verifying` goes straight to `ready_for_review`.

Off the main path: `blocked` (you asked the user a question) and `done`.
Supercharge rejects invalid moves and tells you what is allowed instead.

## 3. What to do at each step

1. **Plan.** You start in plan mode. Investigate, then propose a plan and wait for the user to approve it.
2. **Save the approved plan.** After approval, save it into the ledger. Use stdin so nothing is written into the repository:

   ```bash
   supercharge plan - <<'PLAN'
   <the approved plan, in markdown>
   PLAN
   ```

3. **Start implementing:** `supercharge stage implementing`
4. **Verify.** When the implementation is done: `supercharge stage verifying`. Run the tests and checks. If they fail, go back with `supercharge stage implementing`.
5. **Hand the work over.** Check `merge` in `supercharge whoami --json`:
   - **`"mr"`: raise the merge request.** Push the branch and open the MR, then:

     ```bash
     supercharge stage mr_raised --mr <merge-request-url>
     ```

     The URL is a GitLab merge request (`https://<host>/<group>/<repo>/-/merge_requests/<iid>`) or a
     GitHub pull request (`https://<host>/<owner>/<repo>/pull/<number>`). Without `--mr`, Supercharge
     looks for an open one on your branch.

     After that, Supercharge watches the MR for you. It moves the task to `watching_mr` and then to
     `ready_for_review` once the pipeline passes and no review threads are open. Never set those two
     stages yourself.

   - **`"branch"`: report the branch ready to merge.** Do not open a merge request. Commit, push your
     branch, check the tests pass on what you pushed, then:

     ```bash
     supercharge stage ready_for_review
     ```

     The task waits in the review lounge until the user or the control chat merges your branch into the
     base branch. Supercharge marks it `done` by itself once your commits land there (fast-forwarded,
     merged or cherry-picked). Never push to the base branch yourself.

6. **Fixing review feedback or a failed pipeline:** `supercharge stage implementing`, fix, push, then
   `supercharge stage verifying` and hand it over again as in step 5.

Add `--note "<short note>"` to any stage change when it helps the user.

## 4. When you are stuck

If you need a decision, missing information, or approval that only the user can give:

```bash
supercharge ask "<one clear question>" --option "<first answer>" --option "<second answer>"
```

- Give up to 6 `--option`s when the answer is a choice; the user picks one in the dashboard with a click (they can still write their own). Leave them out for open questions.
- Ask with `supercharge ask`, not your built-in multiple-choice question tool: the dashboard can show and answer `supercharge ask`, while the built-in one can only be answered in the terminal.

Then **stop and wait**. Do not keep working while blocked. When the answer arrives, return to the stage you were in (for example `supercharge stage implementing`).

## 5. Rules

- One task per session. Stay inside this worktree and branch.
- Never write Supercharge files into the repository.
- If a `supercharge` command rejects a move, follow the hint it prints.
- Never wait in a loop. Do not `sleep` and re-check pipelines, merge requests or anything else; after `mr_raised`, stop. Supercharge watches the MR and the user brings you review feedback.
- Keep your context small: search for the code you need instead of reading whole large files or directories.
- If your conversation was cleared, run `supercharge whoami --json`: it shows your task and stage, and `task.planFile` is your approved plan. Read it and continue.
