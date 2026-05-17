# PR State Schema

The babysitter stores per-PR state in two places, both queryable via
`gh`:

1. A single hidden controller comment per PR, with a JSON marker that
   the controller PATCHes in place.
2. HEAD-scoped suppression markers as separate hidden comments, used
   to dedupe parallel events and signal handoff with a local
   babysitter or human.

There is no Copilot Memory dependency. Memory is for repository
learnings, not a deterministic queryable lock.

## Controller comment

One PR comment, authored by the workflow, whose body starts with the
marker tag. The controller updates this comment in place via PATCH on
every successful run.

```
<!-- copilot-babysit-state:v1 -->
```json
{
  "schemaVersion": 1,
  "controllerVersion": "0.1.0",
  "headSha": "abc123def456...",
  "lastEvent": "synchronize",
  "lastEventAt": "2026-05-17T14:30:00Z",
  "lastAction": "request_copilot_review",
  "lastActionAt": "2026-05-17T14:30:05Z",
  "cooldownUntil": "2026-05-17T15:00:05Z",
  "iteration": {
    "headSha": "abc123def456...",
    "copilotIteration": 1,
    "reviewRequestCount": 1,
    "fixRequestCount": 0,
    "exhausted": false,
    "exhaustedReason": null,
    "thresholdSeverity": 2
  },
  "session": {
    "totalCopilotIterations": 1,
    "totalReviewRequests": 1,
    "totalFixRequests": 0
  },
  "pendingRunId": null,
  "pausedBy": null,
  "humanEscalation": null,
  "triage": {
    "byThread": {
      "PRRT_kwDOxxxx": {
        "headSha": "abc123def456...",
        "category": "Correctness",
        "severity": 4,
        "validConcern": "Yes",
        "recommendation": "Address",
        "shouldTriggerFixLoop": true,
        "rationale": "...",
        "decidedAt": "2026-05-17T14:30:04Z"
      }
    }
  }
}
```
<!-- /copilot-babysit-state -->
```

The opening tag, fenced JSON, and closing tag are mandatory; the
shell guard parses by:

1. Locating the comment by author and the literal opening tag.
2. Extracting the JSON body between the fences with `jq`-friendly
   delimiters.
3. Validating it against
   [`schema-state.json`](schema-state.json).
4. PATCHing the comment with the new JSON, preserving identity.

The wrapping markdown is human-readable in the GitHub UI; the JSON
inside the fenced block is machine-readable.

## Field semantics

- `schemaVersion` — bump this when the schema changes; the shell
  guard refuses to write if `schemaVersion` is unknown.
- `controllerVersion` — informational, taken from
  `controllerVersion.txt` in this directory.
- `headSha` — the PR HEAD when the controller last acted.
- `iteration` — HEAD-scoped counters. **Reset whenever
  `iteration.headSha` does not match the live PR `headRefOid`**, with
  the exception of `/copilot retry` which resets these values without
  changing `headSha`.
- `iteration.copilotIteration` — number of completed Copilot review
  cycles for this HEAD. Hard cap: 3.
- `iteration.thresholdSeverity` — minimum severity (per the triage
  schema) at which a Copilot comment is allowed to trigger another
  fix loop. Iteration 1 → 2, iteration 2 → 3, iteration 3+ → 4.
- `session` — totals across the lifetime of this PR. Never reset.
  Used for analytics and rate limiting cross-HEAD spam.
- `cooldownUntil` — RFC3339 timestamp. The controller refuses to post
  a new Copilot prompt or review request before this time, regardless
  of model recommendation.
- `pendingRunId` — workflow run ID currently driving this PR; cleared
  by the same run on success or by the next workflow that observes
  the run as `completed`.
- `pausedBy` — non-null if `copilot:paused` is set by the operator.
- `humanEscalation` — set when the model returns
  `recommendation: "Discuss with team"` or low confidence. Cleared
  manually with `/copilot resume`.
- `triage.byThread` — the most recent triage decision for each
  unresolved thread, keyed by GraphQL thread node ID. Persisted so
  the same comment is not re-litigated every workflow run. Entries
  are dropped when the thread becomes resolved or its `headSha`
  field no longer matches `iteration.headSha`.

## HEAD-scoped suppression markers

These are separate one-line PR comments authored by the workflow.
They are not the controller comment; they exist solely to dedupe and
hand off.

| Marker | Purpose | TTL |
|--------|---------|-----|
| `<!-- copilot-fix-trigger:<HEAD_SHA>:<reviewCommentId> -->` | One per `(HEAD, reviewCommentId)` pair. The auto-responder will not re-tag a Copilot comment that already has a marker. The marker is appended to the bottom of the `@copilot apply changes...` reply itself, so it lives in the thread it scopes. | Implicit (HEAD-scoped). |
| `<!-- copilot-review-requested:<HEAD_SHA> -->` | Used only when the workflow proactively re-requests a Copilot review (cron stuck-detector). | 30m cooldown. |
| `<!-- copilot-local-active:<HEAD_SHA> -->` | A local babysitter or human is actively driving; workflow yields while marker `updated_at` is fresh. | 30m, refreshed by PATCH heartbeat. |
| `<!-- copilot-local-converged:<HEAD_SHA> -->` | This HEAD was driven to convergence locally; cron must not re-trigger fixes. | Permanent (HEAD-scoped). |

`updated_at` (not `created_at`) is what the TTL check uses, so the
local skill must PATCH the marker to heartbeat. Stale markers are
ignored by cron.

When the PR HEAD advances, all old-HEAD markers become irrelevant
because they are keyed by SHA. The cron job does not bother garbage
collecting them; they remain visible as historical breadcrumbs.

## Reset rules

- `headSha` change: reset `iteration.*` to a fresh struct keyed to
  the new HEAD. Drop `triage.byThread` entries whose
  `headSha` does not match the new HEAD. Clear `cooldownUntil`. Do
  not reset `session.*`.
- `/copilot retry`: clear `cooldownUntil`. Do not reset
  `iteration.copilotIteration` (the 3-cycle cap is intentionally
  sticky). Reset `iteration.thresholdSeverity` to the rule for the
  current iteration.
- `/copilot reset-state`: maintainer-only escape hatch. Replace the
  whole controller comment with a fresh struct. Logs the prior state
  to a step summary so it is recoverable.

## Failure semantics

- If the controller comment exists but does not parse, the workflow
  posts a `copilot:needs-human` label and emits a step-summary
  warning. It does **not** overwrite the broken comment; that is a
  destructive operation a human must opt into.
- If reading PR comments fails (rate limit, transient API error), the
  controller treats automation triggers as fail-closed: do not post
  a new Copilot request. Manual operator labels are fail-open: a
  maintainer adding `copilot:monitor` should not be silently dropped
  on a transient API error.
- If the model decision conflicts with deterministic facts (e.g.
  recommends `enable_auto_merge` while `iteration.exhausted` is
  true), the shell guard refuses the action and labels the PR
  `copilot:needs-human`.
