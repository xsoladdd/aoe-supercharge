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
The output also shows your task id, title, current stage and branch.

## 2. The stages

Every task moves through these stages, in order:

`planning` → `implementing` → `verifying` → `mr_raised` → `watching_mr` → `ready_for_review`

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
5. **Raise the merge request.** Push the branch and open the MR, then:

   ```bash
   supercharge stage mr_raised --mr <merge-request-url>
   ```

6. **After that, Supercharge watches the MR for you.** It moves the task to `watching_mr` and then to `ready_for_review` once the pipeline passes and no review threads are open. Never set those two stages yourself.
7. **Fixing review feedback or a failed pipeline:** `supercharge stage implementing`, fix, push, then `supercharge stage verifying` and `supercharge stage mr_raised --mr <url>` again.

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
