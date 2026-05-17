#!/usr/bin/env bash
# Post one `@copilot apply changes based on [link]` reply per
# unresolved Copilot review comment on the current PR HEAD, then
# update the controller state.
#
# Usage:
#   respond.sh <pr_number>
#
# Required env:
#   GITHUB_REPOSITORY  e.g. "owner/repo"
#   GITHUB_TOKEN       PAT or GITHUB_TOKEN with contents:read,
#                      pull-requests:write, issues:write
#   BABYSIT_TRIAGE     optional, "on" enables GitHub Models triage
#                      filter (default: off)
#   BABYSIT_MAX_PER_RUN  optional, hard cap on comments tagged in a
#                        single workflow run (default: 10)
#
# Exits 0 on success, 1 on hard failure (state save errors, etc.).

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib.sh
source "$SCRIPT_DIR/lib.sh"

require_env GITHUB_REPOSITORY GITHUB_TOKEN

PR="${1:?usage: respond.sh <pr_number>}"
TRIAGE_MODE="${BABYSIT_TRIAGE:-off}"
MAX_PER_RUN="${BABYSIT_MAX_PER_RUN:-10}"
COPILOT_BOT_LOGINS=(
  "copilot-pull-request-reviewer"
  "copilot-pull-request-reviewer[bot]"
  "Copilot"
)

# --- Preconditions ----------------------------------------------------

pr_json="$(pr_view_json "$PR")"
head_sha="$(jq -r '.head.sha' <<<"$pr_json")"
labels="$(jq -r '[.labels[].name] | join(",")' <<<"$pr_json")"

if ! grep -q 'copilot:monitor' <<<"$labels"; then
  log "PR #$PR is not labeled copilot:monitor; nothing to do"
  summary "Babysitter skipped PR #$PR (no \`copilot:monitor\` label)."
  exit 0
fi
if grep -q 'copilot:paused' <<<"$labels"; then
  log "PR #$PR is paused; nothing to do"
  summary "Babysitter skipped PR #$PR (paused)."
  exit 0
fi

# Yield to a local skill that is actively driving this HEAD.
if should_yield_to_local "$PR" "$head_sha"; then
  log "yielding to local skill on HEAD $head_sha"
  summary "Babysitter yielded to local skill on HEAD \`$head_sha\`."
  exit 0
fi

# --- Load durable state ----------------------------------------------

state_file="$(mktemp)"
trap 'rm -f "$state_file"' EXIT
state_load "$PR" "$head_sha" > "$state_file"

iteration_count="$(jq -r '.iteration.copilotIteration' "$state_file")"
iteration_exhausted="$(jq -r '.iteration.exhausted' "$state_file")"
threshold_severity="$(jq -r '.iteration.thresholdSeverity' "$state_file")"

if [ "$iteration_exhausted" = "true" ] || [ "$iteration_count" -ge 3 ]; then
  log "iteration cap reached for HEAD $head_sha; not posting more triggers"
  gh pr edit "$PR" --repo "$GITHUB_REPOSITORY" --add-label copilot:loop-exhausted >/dev/null 2>&1 || true
  jq --arg now "$(now_iso)" '.lastAction = "loop_exhausted_skip" | .lastActionAt = $now' \
    "$state_file" > "${state_file}.tmp" && mv "${state_file}.tmp" "$state_file"
  state_save "$PR" "$state_file"
  summary "Babysitter PR #$PR: iteration cap (3) reached for HEAD \`$head_sha\`; auto-responder is dormant until next push."
  exit 0
fi

# --- Fetch unresolved Copilot review threads on current HEAD ---------

threads_raw="$(pr_review_threads "$PR")"

# Build a flat list of (threadId, commentDatabaseId, html_url, body,
# author, isResolved, isOutdated). We anchor on the FIRST comment of
# each thread because that is the actual "review comment" that
# gh API returns html_url for; and we need its databaseId to build
# the discussion URL fragment.
threads_json="$(jq '
  [.data.repository.pullRequest.reviewThreads.nodes[]
    | select(.isResolved == false and .isOutdated == false)
    | . as $t
    | ($t.comments.nodes[0]) as $c
    | select($c != null and $c.author.login != null)
    | {
        threadId: $t.id,
        path: ($t.path // null),
        line: ($t.line // null),
        commentDatabaseId: $c.databaseId,
        author: $c.author.login,
        bodyHead: ($c.body // "" | .[0:500])
      }
  ]
' <<<"$threads_raw")"

# Filter to Copilot bot threads only.
copilot_threads="$(jq --argjson logins "$(printf '%s' "${COPILOT_BOT_LOGINS[*]}" | jq -Rsc 'split(" ")')" '
  map(select(.author as $a | $logins | index($a)))
' <<<"$threads_json")"

unresolved_count="$(jq 'length' <<<"$copilot_threads")"
log "PR #$PR has $unresolved_count unresolved Copilot thread(s) on HEAD $head_sha"

if [ "$unresolved_count" = "0" ]; then
  jq --arg now "$(now_iso)" '
    .lastAction = "noop_no_copilot_comments" | .lastActionAt = $now
  ' "$state_file" > "${state_file}.tmp" && mv "${state_file}.tmp" "$state_file"
  gh pr edit "$PR" --repo "$GITHUB_REPOSITORY" \
    --remove-label copilot:feedback >/dev/null 2>&1 || true
  state_save "$PR" "$state_file"
  exit 0
fi

# --- Detect already-tagged comments ----------------------------------
#
# Each thread reply we post embeds a marker:
#   <!-- copilot-fix-trigger:<HEAD>:<commentDatabaseId> -->
# We detect existing markers by scanning the *issue* comments of the
# PR (those are PR-level comments authored by `gh pr comment`) AND
# the thread comments themselves. The simplest source of truth is
# the bodies of all PR-level review comments authored by us.

review_comments_json="$(gh api --paginate \
  "repos/${GITHUB_REPOSITORY}/pulls/${PR}/comments" || echo '[]')"

# `review_comments_json` is a stream of pages from --paginate; jq -s
# concatenates.
existing_markers="$(jq -s -r '
  add // []
  | map(.body // "")
  | map(capture("<!-- copilot-fix-trigger:(?<head>[a-f0-9]+):(?<cid>[0-9]+) -->"; "g"))
  | flatten
  | map(.cid)
' <<<"$review_comments_json" 2>/dev/null || echo '[]')"

if ! [[ "$existing_markers" =~ ^\[ ]]; then
  existing_markers="[]"
fi

# Also scan PR issue comments (in case the marker ever lands there).
issue_comments_json="$(pr_issue_comments "$PR" || echo '[]')"
existing_markers_issue="$(jq -s -r '
  add // []
  | map(.body // "")
  | map(capture("<!-- copilot-fix-trigger:(?<head>[a-f0-9]+):(?<cid>[0-9]+) -->"; "g"))
  | flatten
  | map(.cid)
' <<<"$issue_comments_json" 2>/dev/null || echo '[]')"

if ! [[ "$existing_markers_issue" =~ ^\[ ]]; then
  existing_markers_issue="[]"
fi

merged_markers="$(jq -n \
  --argjson a "$existing_markers" \
  --argjson b "$existing_markers_issue" \
  '($a + $b) | unique')"

untagged="$(jq --argjson tagged "$merged_markers" '
  map(select(.commentDatabaseId | tostring | (in($tagged | map(. as $x | {key: ($x | tostring), value: true}) | from_entries)) | not))
' <<<"$copilot_threads")"

untagged_count="$(jq 'length' <<<"$untagged")"
log "PR #$PR has $untagged_count untagged Copilot comment(s) on HEAD $head_sha"

if [ "$untagged_count" = "0" ]; then
  jq --arg now "$(now_iso)" '
    .lastAction = "noop_already_tagged" | .lastActionAt = $now
  ' "$state_file" > "${state_file}.tmp" && mv "${state_file}.tmp" "$state_file"
  state_save "$PR" "$state_file"
  exit 0
fi

# --- Optional triage (off by default) --------------------------------

if [ "$TRIAGE_MODE" = "on" ]; then
  log "triage: BABYSIT_TRIAGE=on; running optional GitHub Models triage"
  context_file="$(mktemp)"
  bash "$SCRIPT_DIR/gather.sh" "$PR" > "$context_file"
  triage_state="$(mktemp)"
  bash "$SCRIPT_DIR/triage.sh" "$PR" "$context_file" "$state_file" "$triage_state" \
    > /dev/null 2>&1 || warn "triage step failed; continuing without filtering"
  if [ -s "$triage_state" ]; then
    cp "$triage_state" "$state_file"
  fi
  rm -f "$context_file" "$triage_state"
  # Filter untagged threads: drop those with `shouldTriggerFixLoop=false`.
  untagged="$(jq --slurpfile state "$state_file" '
    map(. as $thread
      | $state[0].triage.byThread[$thread.threadId] as $t
      | if $t == null then
          . + { _shouldTrigger: true, _triageReason: "no triage decision; defaulting to trigger" }
        elif ($t.shouldTriggerFixLoop == true) then
          . + { _shouldTrigger: true, _triageReason: ("triage: " + $t.recommendation + ", sev " + ($t.severity|tostring)) }
        else
          . + { _shouldTrigger: false, _triageReason: ("triage skipped: " + $t.recommendation + ", sev " + ($t.severity|tostring)) }
        end)
  ' <<<"$untagged")"
fi

# --- Tag Copilot for each untagged comment ---------------------------

# Bound how many we tag in a single workflow run; the next event
# resumes from updated state.
to_tag="$(jq --arg max "$MAX_PER_RUN" '
  [.[] | select(._shouldTrigger != false)] | .[0:($max|tonumber)]
' <<<"$untagged")"

to_tag_count="$(jq 'length' <<<"$to_tag")"
log "PR #$PR will tag $to_tag_count Copilot comment(s) this run"

if [ "$to_tag_count" = "0" ]; then
  # All untagged comments were filtered out by triage. Reply to each
  # filtered thread with the deferral note + per-comment marker.
  for tid in $(jq -r '.[].threadId' <<<"$untagged"); do
    cid="$(jq -r --arg id "$tid" '.[] | select(.threadId == $id) | .commentDatabaseId' <<<"$untagged")"
    reason="$(jq -r --arg id "$tid" '.[] | select(.threadId == $id) | (._triageReason // "filtered")' <<<"$untagged")"
    reply_body="$(printf 'Babysitter (iter %s, threshold sev≥%s): not tagging Copilot for this comment because %s. Resolve or reopen manually if you want it addressed.\n\n%s\n' \
      "$iteration_count" "$threshold_severity" "$reason" "$(marker_fix_trigger "$head_sha" "$cid")")"
    log "posting deferral reply for thread $tid (comment $cid)"
    gh api graphql \
      -f query='mutation($t:ID!,$b:String!){addPullRequestReviewThreadReply(input:{pullRequestReviewThreadId:$t,body:$b}){comment{id}}}' \
      -f t="$tid" -f b="$reply_body" >/dev/null \
      || warn "failed to post deferral reply for thread $tid"
  done
fi

posted=0
for tid in $(jq -r '.[].threadId' <<<"$to_tag"); do
  cid="$(jq -r --arg id "$tid" '.[] | select(.threadId == $id) | .commentDatabaseId' <<<"$to_tag")"
  if [ -z "$cid" ] || [ "$cid" = "null" ]; then
    warn "thread $tid has no comment database id; skipping"
    continue
  fi
  link="https://github.com/${GITHUB_REPOSITORY}/pull/${PR}#discussion_r${cid}"
  marker="$(marker_fix_trigger "$head_sha" "$cid")"
  reply_body="$(printf '@copilot apply changes based on [this feedback](%s).\n\nResolve this thread once the fix is committed (see `.github/instructions/pr-babysit.instructions.md`). Babysitter iter %s, threshold sev≥%s.\n\n%s\n' \
    "$link" "$iteration_count" "$threshold_severity" "$marker")"

  log "tagging Copilot for thread $tid (comment $cid)"
  if gh api graphql \
       -f query='mutation($t:ID!,$b:String!){addPullRequestReviewThreadReply(input:{pullRequestReviewThreadId:$t,body:$b}){comment{id}}}' \
       -f t="$tid" -f b="$reply_body" >/dev/null; then
    posted=$((posted + 1))
  else
    warn "failed to post @copilot reply for thread $tid"
  fi
done

log "posted $posted reply/replies"

# --- Bump iteration counter (once per Copilot review pass) -----------
#
# We treat "we just tagged at least one new comment for this HEAD"
# as the start of a new iteration. The iteration represents a
# Copilot review/fix cycle, so we increment the counter once per
# call regardless of how many comments we tagged.

if [ "$posted" -gt 0 ]; then
  jq --arg now "$(now_iso)" '
    .iteration.copilotIteration = (.iteration.copilotIteration + 1)
    | .iteration.thresholdSeverity = (
        if .iteration.copilotIteration <= 1 then 2
        elif .iteration.copilotIteration == 2 then 3
        else 4 end)
    | .iteration.exhausted = (.iteration.copilotIteration >= 3)
    | .iteration.exhaustedReason = (
        if .iteration.copilotIteration >= 3
        then "copilot iteration cap reached"
        else null end)
    | .iteration.fixRequestCount = (.iteration.fixRequestCount + 1)
    | .session.totalCopilotIterations = (.session.totalCopilotIterations + 1)
    | .session.totalFixRequests = (.session.totalFixRequests + 1)
    | .lastAction = "tag_copilot"
    | .lastActionAt = $now
  ' "$state_file" > "${state_file}.tmp" && mv "${state_file}.tmp" "$state_file"

  gh pr edit "$PR" --repo "$GITHUB_REPOSITORY" \
    --add-label copilot:feedback \
    --remove-label copilot:clean \
    --remove-label copilot:review-pending >/dev/null 2>&1 || true
fi

state_save "$PR" "$state_file"

summary "### Babysitter PR #$PR"
summary ""
summary "- HEAD: \`$head_sha\`"
summary "- Iteration: $(jq -r '.iteration.copilotIteration' "$state_file") / 3"
summary "- Severity threshold: $(jq -r '.iteration.thresholdSeverity' "$state_file")"
summary "- Tagged: $posted Copilot comment(s) this run"
summary "- Untagged remaining: $((to_tag_count - posted))"
