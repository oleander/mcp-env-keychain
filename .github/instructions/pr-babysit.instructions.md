---
applyTo: "**"
excludeAgent: "code-review"
---

# Cloud-agent rules: PR lifecycle and merge gates

These rules apply to GitHub Copilot when it is acting as a cloud agent
on this repository. Copilot code review uses
[`code-review.instructions.md`](code-review.instructions.md) instead.

## Auto-tag fix protocol

When you receive a comment that begins with `@copilot apply changes
based on [this feedback](URL)`, treat it as an auto-generated fix
request from the babysitter. The URL points to a specific review
thread on this PR. Follow this protocol:

1. **Open the linked review thread** and read every comment in it.
2. **Apply the smallest viable fix** that resolves the concern.
   Stage only the files you actually changed; do not run `git add .`.
3. **Run the safeguards** before committing: `bun install --frozen-lockfile`,
   `bun test`, `bunx tsc --noEmit`. They must all pass.
4. **Reply in the linked thread** with a short, specific message
   that names the fix and the commit SHA, e.g. "Fixed in
   `abc1234` by tightening the type signature." Do not write
   "Fixed." with no detail.
5. **Resolve the review thread** after the reply lands. The
   babysitter relies on this to know the comment is closed; an
   unresolved thread blocks merge in this repo's ruleset.
6. **One commit per babysitter prompt.** Push once. Do not amend
   or rebase the prompt's commit into other commits.

If the comment is already obsolete (the diff has changed under it,
the issue is invalid, or the suggestion contradicts a documented
repo pattern), **reply explaining why and resolve the thread**
without changing code. Do not silently leave it unresolved.

## Hard rules

- **Never force-push.** Always merge the base branch in to update.
- **Never merge while Copilot review is pending** for the current
  head commit. A queued `Running Copilot Code Review` dynamic check
  or an unfinished Copilot review pass blocks merge.
- **Convert the PR back to draft before pushing review-fix commits.**
  Keep it draft while batching fixes and waiting for fast CI. Mark
  ready again only after CI is green and unresolved threads are zero.
- **Batch accepted review fixes into one commit and one push** per
  Copilot iteration. Multiple pushes burn CI minutes and trigger
  redundant Copilot waves.
- **Stage only named files or hunks.** Do not run `git add .` or
  `git add -A`.
- **Pass PR bodies and long review replies via files**
  (`--body-file`, temp markdown, quoted heredocs). Shell command
  substitution in backticks corrupts the text.
- **Verify branch context before every edit/commit/push** with
  `git status --short --branch`.
- **Do not manually request bot reviews.** Auto-bot reviewers
  (Copilot, Codex, etc.) review on push automatically. Do not post
  `@copilot review` or `@codex review` unless explicitly asked.
- **Resolve every review thread** after fixes are pushed or replies
  posted. An open thread blocks merge in many rulesets.

## Copilot review iteration policy

Cap at three iterations per HEAD. The babysitter workflow tracks the
counter in a hidden state comment keyed by `headSha`.

| Iteration | Address with code/doc changes | Resolve without addressing |
|-----------|------------------------------|---------------------------|
| 1 | Address valid high, medium, and low | Only invalid/out-of-scope/already-fixed |
| 2 | Address valid high and medium | Reply-resolve low with the iteration note |
| 3+ | Address valid high | Reply-resolve medium and low with the iteration note |

When resolving without addressing, reply in-thread first stating which
iteration this is and why the issue is being deferred. Example reply:

> Copilot iteration 2: resolving without code changes because this is
> low-priority feedback and the PR is now only accepting medium/high
> fixes.

After the third completed Copilot pass, do not wait for or solicit
more Copilot feedback to clear medium/low suggestions. Address valid
high-severity findings only and reply-resolve the rest.

## State-gathering recipe (run first, in parallel)

Pull everything needed to decide what to do, in one parallel batch.

```bash
gh pr view <N> --repo <owner>/<repo> --json number,title,state,isDraft,mergeable,mergeStateStatus,reviewDecision,headRefName,baseRefName,headRefOid,url,labels,statusCheckRollup,autoMergeRequest
gh api /repos/<owner>/<repo>/pulls/<N>/comments --paginate
gh pr view <N> --repo <owner>/<repo> --json reviews,comments
gh run list --repo <owner>/<repo> --branch <headRefName> --limit 15 --json databaseId,name,displayTitle,status,conclusion,event,headSha,createdAt
gh pr view <N> --repo <owner>/<repo> --json files
git fetch origin --prune && git status --short --branch
```

Use GraphQL `reviewThreads` (not raw `/pulls/<N>/comments`) as the
canonical list of unresolved threads. Each thread has `id`,
`isResolved`, and `isOutdated`.

```bash
gh api graphql -f query='
query($owner: String!, $repo: String!, $n: Int!) {
  repository(owner: $owner, name: $repo) {
    pullRequest(number: $n) {
      headRefOid
      reviewThreads(first: 100) {
        nodes { id isResolved isOutdated
          comments(first: 20) { nodes { databaseId author { login } path body } } }
      }
    }
  }
}' -f owner=<owner> -f repo=<repo> -F n=<N>
```

## Triage threads against the current tree (before coding)

On long-lived PRs, many current (non-outdated) bot threads describe
bugs already fixed in later commits. Before implementing:

1. Read the referenced file at `headRefOid`.
2. Classify each thread: **already fixed** → reply citing the fix +
   resolve; **comment-only** → update the stale comment in the same
   batch commit; **real gap** → code change.
3. Do not re-implement validation or tests Copilot asked for if they
   already exist; reply and resolve instead.

Comment-only fixes (misleading test comments, wrong type in a field
doc) are valid in the single review-fix commit and often clear several
threads at once.

## CI failure triage

A failing required check is one of three things. Figure out which
before pushing:

1. **Caused by this PR.** Failed test paths overlap changed files; the
   failure did not appear on `main`'s latest run. → Fix in this PR.
2. **Flake.** Same test passed recently on the same SHA, or the
   failure mode is timeout/network on an unrelated test. → Re-run
   once with `gh run rerun <runId> --failed`; if still red, escalate.
3. **Pre-existing failure on `main`.** The same workflow is red on
   `main`. → Surface to the user; do not block this PR on it.

## Branch update and conflict handling

- `mergeStateStatus: BEHIND` → use the Update branch button or
  `gh api -X PUT /repos/{o}/{r}/pulls/<N>/update-branch`.
- `mergeStateStatus: DIRTY` or `CONFLICTING` → the Update branch
  button is disabled. `git fetch origin && git merge origin/<base>`
  locally, resolve conflicts, push.
- For `go.mod` conflicts when merging the base, keep both sides' new
  direct `require` entries, then `go mod tidy`. The mcp-env-keychain
  repo is TypeScript so this rarely applies, but the equivalent for
  `package.json` / `bun.lock` is to keep both new dependencies and
  re-run `bun install`.

## Worktrees

If the PR branch lives in a git worktree, commit and push from that
worktree path. `git checkout <branch>` fails with `already used by
worktree at ...`; use the printed worktree directory.

## Auto-merge

- Use auto-merge when the repo allows it: `gh pr merge --auto
  --squash` (or the repo's preferred merge type). Check
  `gh api /repos/{o}/{r} --jq '{squash, merge, rebase}'` first.
- GitHub auto-disables auto-merge when a ready PR is converted back
  to draft. Re-arm it after re-marking ready.

## Lifecycle

Run this in order:

1. Open or confirm draft.
2. Update branch from base; re-run if base moves later.
3. Wait for fast CI.
4. Fix CI failures, push.
5. Check unresolved threads before marking ready.
6. Mark ready for review.
7. Before any review-fix push, convert the PR back to draft.
8. Collect every unresolved thread and apply the iteration policy.
9. Apply accepted fixes in one batch (one commit, one push).
10. Reply to every addressed and rejected thread, then resolve it.
11. Wait for fast CI on the fix push.
12. Mark ready again.
13. Loop steps 7-12 only within the 3-iteration cap.
14. Wait for the post-`ready_for_review` full pipeline (draft-era runs
    keep some required jobs `SKIPPED`).
15. Confirm Copilot is not pending for the current head commit.
16. Final update-branch if behind.
17. Enable auto-merge.

## Useful gh commands

```bash
gh pr view <N> --json state,isDraft,mergeable,mergeStateStatus,statusCheckRollup,reviewDecision,headRefName,baseRefName
gh pr checks <N>
gh pr ready <N>            # leave draft
gh pr ready <N> --undo     # convert back to draft
gh api -X PUT /repos/{owner}/{repo}/pulls/<N>/update-branch
gh api /repos/{owner}/{repo}/rules/branches/<base>
gh pr review <N> --comment --body-file reply.md
gh pr merge <N> --auto --squash
gh run list --branch <branch> --limit 10
```

For thread reply + resolve from the CLI, use GraphQL. REST does not
expose resolve, and reply-via-REST is brittle:

```bash
gh api graphql \
  -f query='mutation($thread: ID!, $body: String!) {
    addPullRequestReviewThreadReply(input: {pullRequestReviewThreadId: $thread, body: $body}) {
      comment { id }
    }
  }' -f thread=PRRT_kwDOxxx -f body='Fixed in <sha>: ...'

gh api graphql \
  -f query='mutation($id: ID!) {
    resolveReviewThread(input: {threadId: $id}) { thread { isResolved } }
  }' -f id=PRRT_kwDOxxx
```

When bulk-resolving outdated threads, always post a short reply first
saying the thread is outdated, then resolve it. Resolve-only without a
reply leaves no audit trail.

## Repository-specific commands

This is a Bun + TypeScript repo:

```bash
bun install --frozen-lockfile
bun test
bunx tsc --noEmit
```

CI runs the same commands on macOS in
[`/.github/workflows/ci.yml`](../workflows/ci.yml). FFI in
`src/keychain.ts` and `src/touchid.ts` is macOS-only; do not propose
Linux-only patterns.

The two-kinds invariant (`plain` vs `secret`) and the
no-secret-values-in-output contract are non-negotiable. See the root
[`CLAUDE.md`](../../CLAUDE.md) for the full architecture.

## Red flags — STOP

- About to `gh pr merge` and have not checked `gh run list` for
  Copilot dynamic runs.
- About to push a review fix and the PR is marked ready (convert to
  draft first).
- About to `git push --force` without an explicit user request.
- `gh pr view` shows `mergeStateStatus: BEHIND` and you are about to
  merge.
- A required check is `SKIPPED` (not failed, not passed) while ready;
  this is a ruleset/job mismatch, not a passing state.
- All CI green, no unresolved threads visible to you, but
  `mergeStateStatus: BLOCKED`. Re-query `reviewThreads` filtered to
  `isResolved: false` and confirm Copilot is not still `in_progress`
  on `headRefOid`.
- Auto-merge silently disables when a PR is converted back to draft;
  re-arm after re-marking ready.
