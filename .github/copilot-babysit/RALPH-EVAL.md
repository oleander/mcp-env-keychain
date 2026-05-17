# Ralph Wiggum Local Fallback — Evaluation

## TL;DR

We adopt the Ralph Wiggum **principle** ("each invocation does one
unit of work, then exits") inside the workflow controller, but we
**do not ship a Ralph shell loop** in this repository. Operators who
want a local agent fallback already have
[`/Users/linus/.claude/skills/babysit-pr/SKILL.md`](/Users/linus/.claude/skills/babysit-pr/SKILL.md);
it talks to the same controller-comment + label state machine via
the `<!-- copilot-local-active:<HEAD> -->` heartbeat marker.

## What Ralph Wiggum solves

[Ralph](https://ghuntley.com/ralph/) — popularized for PR review by
[xpepper/pr-review-agent-skill/ralph-wiggum-loop](https://github.com/xpepper/pr-review-agent-skill/blob/main/ralph-wiggum-loop/SKILL.md)
— is a `while [ ! -f DONE ]; do <agent> < INSTRUCTIONS; done` shell
loop that spawns a fresh agent session per comment. Each session is
short, cannot exhaust its context, and persists progress in
filesystem markers (`PR_COMMENTS_PLAN.md`, `PR_REVIEW_DONE`,
`.pr-review/plan-<comment>.md`).

It is genuinely useful when:

- A single PR has 30+ Copilot comments and an in-session agent would
  hit its context window limit.
- The operator runs an agent CLI locally and accepts that all state
  lives in their checkout.

## Why it is not the controller

A Ralph loop is a **local** orchestration pattern. The babysitter
needs **unattended cross-run** orchestration. The differences matter:

| Property | Ralph local loop | Babysitter workflow |
|----------|------------------|---------------------|
| Where state lives | Files in the local checkout | Labels + hidden PR comment |
| Survives a fresh GitHub Actions runner | No (`.pr-review/` is on the previous runner) | Yes |
| Visible to other contributors | No | Yes |
| Coordinates with cron retries | No | Yes |
| Can pause/resume from a phone | No (needs terminal) | Yes (slash command in PR) |
| Per-comment commits | Yes | No (we batch per Copilot iteration to avoid CI/Copilot waves) |

If we made the workflow a Ralph loop it would commit per comment
instead of per iteration, churn `git push`-driven CI runs, and put
state files in the checkout where they would not survive between
events. None of that suits unattended use.

## What we adopted

The Ralph principle does inform the workflow design:

- Each workflow run does one unit of work and exits — a fresh run
  takes the next decision from current PR state.
- State lives outside the runner (in the controller comment and
  HEAD-scoped markers) so any subsequent run resumes from authority.
- Cooldown markers provide the equivalent of `PR_REVIEW_DONE`: while
  a marker is fresh, no further work is scheduled on this HEAD.

## Local fallback handoff contract

If an operator wants to run a Ralph-style loop locally, they should:

1. Add the `<!-- copilot-local-active:<HEAD_SHA> -->` marker as a PR
   comment on the current HEAD.
2. PATCH the marker (re-write its body, no new comment) at least
   every 25 minutes so its `updated_at` stays under the 30-minute
   TTL.
3. When done, replace the marker with
   `<!-- copilot-local-converged:<HEAD_SHA> -->` (no TTL) so the cron
   monitor stops attempting to drive the same HEAD.

The workflow `gather.sh` already detects both markers
(`markers.localActivePresent`, `markers.localConvergedPresent`). The
shell guard in `act.sh` yields any
`request_copilot_review`/`comment_to_copilot`/`mark_ready`/`enable_auto_merge`
action to a `noop` while either marker is present.

The
[`babysit-pr` skill](/Users/linus/.claude/skills/babysit-pr/SKILL.md)
implements this contract; we deliberately do not duplicate it in the
repository.

## Decision

- **Adopt:** Ralph principle (one unit per run, state externalized)
  inside the workflow controller.
- **Do not adopt:** Ralph file-based local loop as a checked-in
  artifact in this repository. Operators already have a richer
  agent-driven local babysitter, and adding a parallel shell loop
  would introduce a third state store to keep in sync.
- **Document:** the marker handoff so any local agent — Claude
  Code, Codex, Cursor, hand-rolled — can interoperate with the
  workflow.
