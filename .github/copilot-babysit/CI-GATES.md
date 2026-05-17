# CI gating decision

The plan considered adding a `review:clear` label gate on slow CI
jobs so that pushes still receiving review feedback would not burn
slow runner minutes. After auditing this repository's CI surface,
**no slow-CI gating is added**.

## Audit

The only CI workflow is
[`/.github/workflows/ci.yml`](../workflows/ci.yml). It runs:

| Step | Approximate cost |
|------|------------------|
| `actions/checkout@v4` | seconds |
| `oven-sh/setup-bun@v2` | seconds (cached) |
| `actions/cache@v4` for `~/.bun/install/cache` | seconds |
| `bun install --frozen-lockfile` | seconds |
| `bun test` | sub-minute on this codebase |
| `bunx tsc --noEmit` | sub-minute on this codebase |

`bun test` and `bunx tsc --noEmit` are the entire pipeline; both are
fast enough that pushing a noisy review-fix iteration costs at most
one or two macOS runner minutes per push. There are no unit-vs-
integration splits, no e2e jobs, and no draft-gated jobs that should
defer until review feedback is clear.

## Decision

- **Do not** add `if: contains(github.event.pull_request.labels.*.name, 'review:clear')`
  conditions to the CI jobs.
- **Do not** add a separate slow-CI workflow as a placeholder; that
  would invert the cost calculation by adding workflow scheduler
  overhead for jobs that do not exist yet.
- **Revisit** this decision if any of the following change:
  - A long-running job (real-device tests, package publish dry-runs,
    integration with a live macOS Keychain harness, signed binary
    builds) lands in CI.
  - The babysitter starts producing more than ~5 review-fix
    iterations per PR on average. `MAX_COPILOT_REVIEWS` (default
    5) should bound this; if the cap is raised, slow-CI gating
    becomes relevant again.

## What bounds CI churn instead

The babysitter's `MAX_COPILOT_REVIEWS` cap (5 lifetime Copilot
requests per PR) bounds the worst-case CI cost: a PR cannot trigger
more than ~5 review-fix cycles before the workflow parks it in
draft. Each cycle is at most one push, so CI runs at most 5x for
review-driven churn before an operator must intervene.
