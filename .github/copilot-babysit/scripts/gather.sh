#!/usr/bin/env bash
# Gather a compact PR state document for the GitHub Models decision
# step. Reads from `gh` (REST + GraphQL) and emits a single JSON
# object on stdout.
#
# Usage:   gather.sh <pr_number>
# Output:  one JSON object — see schema-context.json.
#
# Designed to be deterministic and short: the model receives only the
# facts it needs to choose an action.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib.sh
source "$SCRIPT_DIR/lib.sh"

require_env GITHUB_REPOSITORY

PR="${1:?usage: gather.sh <pr_number>}"

pr_json="$(pr_view_json "$PR")"
head_sha="$(jq -r '.head.sha' <<<"$pr_json")"
labels_json="$(jq '[.labels[].name]' <<<"$pr_json")"
is_draft="$(jq -r '.draft // false' <<<"$pr_json")"
mergeable="$(jq -r '.mergeable_state // "unknown"' <<<"$pr_json")"
title="$(jq -r '.title // ""' <<<"$pr_json")"
base_ref="$(jq -r '.base.ref' <<<"$pr_json")"
head_ref="$(jq -r '.head.ref' <<<"$pr_json")"

# Threads (GraphQL is canonical; REST comments can lag).
threads_json="$(pr_review_threads "$PR")"
threads="$(jq '
  .data.repository.pullRequest.reviewThreads.nodes
  | map({
      id,
      isResolved,
      isOutdated,
      path,
      line,
      author: (.comments.nodes[0].author.login // null),
      bodyHead: (.comments.nodes[0].body // "" | .[0:600]),
      commentCount: (.comments.nodes | length),
      hasCopilot: any(.comments.nodes[]?; .author.login == "copilot-pull-request-reviewer" or .author.login == "copilot-pull-request-reviewer[bot]" or .author.login == "Copilot")
    })
' <<<"$threads_json")"

unresolved="$(jq '
  map(select(.isResolved == false))
' <<<"$threads")"

unresolved_current="$(jq '
  map(select(.isOutdated == false))
' <<<"$unresolved")"

unresolved_outdated="$(jq '
  map(select(.isOutdated == true))
' <<<"$unresolved")"

# Check runs on the current HEAD.
checks_json="$(gh api \
  "repos/${GITHUB_REPOSITORY}/commits/${head_sha}/check-runs?per_page=100" \
  --paginate || echo '{"check_runs":[]}')"
checks="$(jq '
  [.check_runs[]? | {
    name,
    status,
    conclusion,
    started_at,
    completed_at
  }]
' <<<"$checks_json")"

required_failed="$(jq '
  [.[] | select(.conclusion == "failure" or .conclusion == "timed_out")]
  | length
' <<<"$checks")"

required_running="$(jq '
  [.[] | select(.status == "in_progress" or .status == "queued")]
  | length
' <<<"$checks")"

# Latest Copilot review on this HEAD, if any.
copilot_reviews="$(gh api --paginate \
  "repos/${GITHUB_REPOSITORY}/pulls/${PR}/reviews" || echo '[]')"
copilot_latest="$(jq -s '
  add // []
  | [.[] | select(.user.login == "copilot-pull-request-reviewer[bot]" or .user.login == "Copilot")]
  | sort_by(.submitted_at)
  | last // null
' <<<"$copilot_reviews")"

copilot_state="pending"
copilot_summary=""
if [ "$(jq -r 'if . == null then "" else (.commit_id // "") end' <<<"$copilot_latest")" = "$head_sha" ]; then
  copilot_summary="$(jq -r '.body // ""' <<<"$copilot_latest")"
  if printf '%s' "$copilot_summary" | grep -qiE 'generated no( new)? comments'; then
    copilot_state="clean"
  else
    copilot_state="dirty"
  fi
fi

# Copilot pending dynamic check.
copilot_check_pending="$(jq '
  any(.[]?;
    (.name | test("Copilot"; "i"))
    and (.status == "in_progress" or .status == "queued")
  )
' <<<"$checks")"

# Auto-bot comment summary on this HEAD only (used for triage feeder).
copilot_open_comments="$(jq '
  map(select(
    .isResolved == false
    and .isOutdated == false
    and .hasCopilot == true
  ))
' <<<"$threads")"

# Repo policy snippet — is auto-merge available?
repo_meta="$(gh api "repos/${GITHUB_REPOSITORY}" --jq '
  { allow_squash_merge, allow_merge_commit, allow_rebase_merge }
' || echo '{}')"

# Hidden marker presence.
marker_review="$(marker_review_requested "$head_sha")"
marker_fix="$(marker_fix_requested "$head_sha")"
review_request_marker_present=false
fix_request_marker_present=false
local_active_marker_present=false
local_converged_marker_present=false

if marker_present_recent "$PR" "$marker_review" 30; then
  review_request_marker_present=true
fi
if marker_present_recent "$PR" "$marker_fix" 0; then
  fix_request_marker_present=true
fi
if marker_present_recent "$PR" "$(marker_local_active "$head_sha")" 30; then
  local_active_marker_present=true
fi
if marker_present_recent "$PR" "$(marker_local_converged "$head_sha")" 0; then
  local_converged_marker_present=true
fi

# Compose the document.
jq -n \
  --argjson labels "$labels_json" \
  --argjson threads "$threads" \
  --argjson unresolved_current "$unresolved_current" \
  --argjson unresolved_outdated "$unresolved_outdated" \
  --argjson checks "$checks" \
  --arg required_failed "$required_failed" \
  --arg required_running "$required_running" \
  --arg copilot_state "$copilot_state" \
  --arg copilot_summary "$copilot_summary" \
  --argjson copilot_check_pending "$copilot_check_pending" \
  --argjson copilot_open_comments "$copilot_open_comments" \
  --argjson repo_meta "$repo_meta" \
  --arg pr "$PR" \
  --arg head_sha "$head_sha" \
  --arg base_ref "$base_ref" \
  --arg head_ref "$head_ref" \
  --arg title "$title" \
  --arg is_draft "$is_draft" \
  --arg mergeable "$mergeable" \
  --argjson review_request_marker_present "$review_request_marker_present" \
  --argjson fix_request_marker_present "$fix_request_marker_present" \
  --argjson local_active_marker_present "$local_active_marker_present" \
  --argjson local_converged_marker_present "$local_converged_marker_present" \
  --arg now "$(now_iso)" '
  {
    pr: ($pr | tonumber),
    title: $title,
    headSha: $head_sha,
    baseRef: $base_ref,
    headRef: $head_ref,
    isDraft: ($is_draft == "true"),
    mergeStateStatus: $mergeable,
    labels: $labels,
    repo: $repo_meta,
    threads: {
      total: ($threads | length),
      unresolvedCurrent: ($unresolved_current | length),
      unresolvedOutdated: ($unresolved_outdated | length),
      copilotOpenOnHead: ($copilot_open_comments | length),
      sample: ($unresolved_current[0:25])
    },
    checks: {
      total: ($checks | length),
      failed: ($required_failed | tonumber),
      running: ($required_running | tonumber),
      runs: ($checks[0:25])
    },
    copilot: {
      latestReviewState: $copilot_state,
      latestReviewSummary: ($copilot_summary | .[0:400]),
      copilotCheckPending: $copilot_check_pending
    },
    markers: {
      reviewRequestPresent: $review_request_marker_present,
      fixRequestPresent: $fix_request_marker_present,
      localActivePresent: $local_active_marker_present,
      localConvergedPresent: $local_converged_marker_present
    },
    now: $now
  }
'
