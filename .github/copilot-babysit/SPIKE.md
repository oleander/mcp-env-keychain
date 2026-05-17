# Babysitter spike — verification runbook

A manual runbook to confirm the simple babysitter does the right
thing on a real PR. Run through this once after the workflow lands,
and re-run only when you change `copilot-request-review.yml` or
adjust `MAX_COPILOT_REVIEWS`.

## Prerequisites

- [`copilot-request-review.yml`](../workflows/copilot-request-review.yml)
  is on the default branch.
- The `copilot:*` labels exist (use `gh label create` per
  [README.md](README.md)).
- The repository's `copilot_code_review` ruleset rule has
  `review_on_push: false` (or the rule is removed). Otherwise the
  ruleset and the workflow will race.
- You have Copilot access for this org/repo
  ([access management](https://docs.github.com/en/copilot/concepts/agents/cloud-agent/access-management)).

## Spike 1 — cap-respecting auto-request

1. `git checkout -b babysit-spike-1`, commit a small change, push,
   open a PR.
2. **Expect:** the `Copilot Request Review` workflow runs, finds
   `count == 0 < MAX_COPILOT_REVIEWS`, and calls
   `gh pr edit <N> --add-reviewer @copilot`.
3. **Verify:**
   - A `Running Copilot Code Review` dynamic check appears.
   - The timeline has one new `review_requested` event with
     `requested_reviewer.login == "Copilot"`.
   - The workflow step summary shows `count=1`, `cap=5`.
4. Push four more commits. After each, repeat step 2/3 with the
   counter bumping by one.
5. Push a sixth commit. **Expect:**
   - The workflow refuses to call `gh pr edit --add-reviewer`.
   - The PR is converted back to draft (`isDraft: true`).
   - The `copilot:loop-exhausted` label is applied.
   - A PR comment from `github-actions[bot]` explains the cap.

## Spike 2 — paused PR

1. Add the `copilot:paused` label to the PR.
2. Push another commit.
3. **Expect:** the workflow runs, the `Skip when paused` step is
   visible in the run logs, and no `review_requested` event lands.
4. Remove the `copilot:paused` label.
5. Push another commit.
6. **Expect:** the workflow runs the cap-checked path again.

## Spike 3 — force-review escape hatch

1. With the PR in `copilot:loop-exhausted` state (from spike 1):
2. Add the `copilot:force-review` label.
3. **Expect:**
   - The workflow's `preflight` job sets `force=true`.
   - The PR is marked ready if it was in draft.
   - `gh pr edit --add-reviewer @copilot` succeeds.
   - The workflow removes both `copilot:force-review` and
     `copilot:loop-exhausted`.
   - One new `review_requested` event appears.
4. Note: the lifetime counter has now passed the cap, so the next
   push will park the PR again unless the operator force-reviews
   again or raises `MAX_COPILOT_REVIEWS`.

## Spike 4 — token paths

`gh pr edit --add-reviewer @copilot` requires gh CLI v2.88.0+. The
runner image used by `ubuntu-latest` ships a recent enough gh as of
this writing, but if a runner regresses, the workflow falls back to
the REST endpoint
`POST /repos/{owner}/{repo}/pulls/{pr}/requested_reviewers` with
`reviewers[]=copilot-pull-request-reviewer[bot]`.

In a test PR, force the REST path by setting `GH_VERSION_OLD=1`
(no such logic is wired; instead temporarily remove the gh-CLI step
from the workflow) and confirm:

- The REST call returns HTTP 201.
- A `review_requested` timeline event appears with
  `requested_reviewer.login == "Copilot"`.

If the REST call fails for a reason other than rate-limiting, you
likely need a PAT instead of `GITHUB_TOKEN`. See
[future-architect/uzomuzo-oss](https://github.com/future-architect/uzomuzo-oss/blob/main/.github/workflows/copilot-rereview-on-push.yml)
for the silent-no-op recovery pattern.

## Cleanup

Close the spike PR, delete the branch, and capture any surprises
back in [README.md](README.md) under "Known limitations".
