# Babysitter spike — verification runbook

The plan calls for a small spike on a real PR to confirm which
review-request paths actually wake Copilot with the
`GITHUB_TOKEN` available in workflows. This file is the manual
runbook to follow once the workflow files are dropped in.

## Prerequisites

- The four workflow files described in
  [`README.md`](README.md) are present in
  [`/.github/workflows/`](../workflows/).
- The bootstrap workflow has run once successfully (creates
  the `copilot:*` labels).
- This repository has Copilot Pro/Pro+/Business/Enterprise so
  Copilot review is even available; see
  https://docs.github.com/en/copilot/concepts/agents/cloud-agent/access-management.

## Spike 1 — slash command happy path

1. Create a throwaway branch: `git checkout -b babysit-spike-1` and
   commit a deliberate small change (e.g. add a TODO comment to
   `src/types.ts`). Push and open a PR.
2. Comment `/copilot babysit` on the PR.
3. **Expect:**
   - The `copilot:monitor` label appears within ~30s.
   - No state comment is posted yet (no Copilot review on HEAD).
4. Comment `/copilot pause`.
5. **Expect:** `copilot:paused` label appears.
6. Comment `/copilot resume`. The label disappears.
7. Comment `/copilot stop`. `copilot:monitor` is removed,
   `copilot:paused` is added.

If steps 3–7 work, the slash-command workflow is correctly wired.

## Spike 2 — Copilot review request

Re-enable monitoring on the spike PR (`/copilot babysit`) and
request a Copilot review through one of the paths below. Each
should be tried separately, on a fresh PR, to identify which one
actually wakes Copilot under your token policy.

| Path | Command | Notes |
|------|---------|-------|
| A | UI: `Reviewers → Request review → Copilot` | Establishes a baseline; confirms Copilot is reachable for this org/repo. |
| B | `gh pr edit <PR> --add-reviewer copilot` | Same effect as A, scriptable. |
| C | GraphQL `requestReviews` with `botIds: [BOT_kgDOCnlnWA]` via `GITHUB_TOKEN` | Per the `future-architect/uzomuzo-oss` writeup, this can silently no-op under `GITHUB_TOKEN`. Confirm whether your repo is affected. |
| D | GraphQL `requestReviews` via a maintainer PAT (e.g. `secrets.GH_ACTIONS_TOKEN`) | Use only if C silently no-ops. |
| E | `gh extension install ChrisCarini/gh-copilot-review` then `gh copilot-review <PR>` | Wraps A/B; useful if you keep the extension on the runner image. |

Record which paths produce a Copilot review with all of these:

- A `Running Copilot Code Review` dynamic check appears.
- A `pull_request_review.submitted` event from
  `copilot-pull-request-reviewer[bot]` (or `Copilot`) lands.
- One or more `pull_request_review_comment.created` events fire
  for each inline comment.

Document the winner in
[`README.md`](README.md) and update
`scripts/respond.sh` if a different fallback order is needed.

## Spike 3 — Auto-respond fast path

With monitoring enabled and Copilot leaving at least one review
comment on the PR:

1. Confirm the workflow run from
   `pull_request_review_comment.created` fires.
2. **Expect:** the workflow posts an `@copilot apply changes
   based on [this feedback](URL)` thread reply on each unresolved
   Copilot comment, and the body of that reply ends with the
   marker:

   ```
   <!-- copilot-fix-trigger:<HEAD>:<commentDatabaseId> -->
   ```

3. Re-trigger the workflow (e.g. comment `/copilot retry`). The
   workflow should detect the existing markers and post **zero**
   new replies for the same `(HEAD, commentId)` pairs.
4. Push a new commit to the PR. The workflow runs again, the
   `iteration` counter resets in the state comment, and any new
   Copilot review comments on the new HEAD get tagged.
5. After the third Copilot review iteration on the same HEAD, the
   workflow stops tagging and adds `copilot:loop-exhausted`.

## Spike 4 — Copilot resolves the thread

The cloud-agent instructions tell Copilot to reply + resolve the
thread after applying a fix. Confirm:

1. After the auto-respond reply lands, Copilot opens a new PR /
   pushes commits to address the comment.
2. Copilot posts an in-thread reply with the fix description and
   commit SHA.
3. The thread is marked `isResolved: true` in:

   ```bash
   gh api graphql -f query='
   query($o:String!,$r:String!,$n:Int!){
     repository(owner:$o,name:$r){
       pullRequest(number:$n){
         reviewThreads(first:100){
           nodes { id isResolved isOutdated comments(first:1){nodes{author{login}}} }
         }
       }
     }
   }' -f o=oleander -f r=mcp-env-keychain -F n=<PR>
   ```

If Copilot does not resolve the thread automatically despite the
instructions, refine
[`pr-babysit.instructions.md`](../instructions/pr-babysit.instructions.md)
based on the observed behavior — the auto-tag flow assumes Copilot
honors the resolve step.

## Spike 5 — Auto-merge gates

With the PR clean (no unresolved threads, CI green, no Copilot
pending), confirm the babysitter does NOT auto-merge. The current
implementation does not call `gh pr merge --auto` from the
auto-responder by design — operators enable auto-merge themselves
once Copilot has converged. Document any change to that policy
before adding it back.

## Cleanup

Once the spike PR has driven the system through the four scenarios
above, close it, delete the branch, and remove the spike-induced
labels. Capture any surprises in
[`README.md`](README.md) under "Known limitations" and adjust
budgets/cooldowns in `lib.sh` if needed.
