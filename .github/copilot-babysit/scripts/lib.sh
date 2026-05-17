#!/usr/bin/env bash
# Shared helpers for the Copilot babysitter workflow.
#
# Sourced by the controller scripts. Requires `gh`, `jq`, and a
# coreutils `date` (Linux runners ship GNU date; the workflow runs on
# `ubuntu-latest`).
#
# All logging goes to stderr so callers can capture stdout for data.

set -euo pipefail

# shellcheck disable=SC2034
BABYSIT_VERSION_FILE="${GITHUB_WORKSPACE:-$(pwd)}/.github/copilot-babysit/controllerVersion.txt"
BABYSIT_DIR="${GITHUB_WORKSPACE:-$(pwd)}/.github/copilot-babysit"

STATE_OPEN_TAG='<!-- copilot-babysit-state:v1 -->'
STATE_CLOSE_TAG='<!-- /copilot-babysit-state -->'
# shellcheck disable=SC2034
STATE_AUTHOR_HINT="github-actions[bot]"

# Logging helpers (stderr only).
log()   { printf '%s\n' "$*" >&2; }
warn()  { printf '::warning::%s\n' "$*" >&2; }
error() { printf '::error::%s\n' "$*" >&2; exit 1; }

# Pretty step-summary entry.
summary() {
  if [ -n "${GITHUB_STEP_SUMMARY:-}" ]; then
    printf '%s\n' "$*" >> "$GITHUB_STEP_SUMMARY"
  fi
}

require_env() {
  local name
  for name in "$@"; do
    if [ -z "${!name:-}" ]; then
      error "missing required env: $name"
    fi
  done
}

# Read the controller version once.
controller_version() {
  if [ -r "$BABYSIT_VERSION_FILE" ]; then
    head -c 64 "$BABYSIT_VERSION_FILE" | tr -d '[:space:]'
  else
    echo "unknown"
  fi
}

# RFC3339 UTC timestamp for state writes.
now_iso() { date -u +%Y-%m-%dT%H:%M:%SZ; }

# `date` arithmetic that works on both GNU and BSD without -d on BSD.
# Argument: minutes to add (may be negative).
iso_offset_minutes() {
  local minutes="$1"
  if date -u -d "+${minutes} minutes" +%Y-%m-%dT%H:%M:%SZ >/dev/null 2>&1; then
    date -u -d "+${minutes} minutes" +%Y-%m-%dT%H:%M:%SZ
  else
    # BSD fallback (macOS) — only used for local testing.
    date -u -v"+${minutes}M" +%Y-%m-%dT%H:%M:%SZ
  fi
}

# Compute lexicographically comparable ISO timestamp for a cooldown
# window in minutes ago. Used by markers with TTL semantics.
iso_minutes_ago() {
  local minutes="$1"
  iso_offset_minutes "-${minutes}"
}

# Check whether an RFC3339 timestamp is in the future. Lex compare.
# Usage: is_future_iso "$cooldown_iso"
is_future_iso() {
  local target="$1"
  local now
  now="$(now_iso)"
  [ "$target" \> "$now" ]
}

# --- PR data ----------------------------------------------------------

pr_view_json() {
  local pr="$1"
  gh api "repos/${GITHUB_REPOSITORY:?}/pulls/${pr}"
}

pr_review_threads() {
  local pr="$1"
  gh api graphql -f query='
    query($owner:String!,$repo:String!,$n:Int!) {
      repository(owner:$owner,name:$repo) {
        pullRequest(number:$n) {
          headRefOid
          reviewThreads(first:100) {
            nodes {
              id
              isResolved
              isOutdated
              path
              line
              comments(first:20) {
                nodes {
                  databaseId
                  author { login }
                  path
                  body
                  createdAt
                }
              }
            }
          }
        }
      }
    }' -f owner="${GITHUB_REPOSITORY%%/*}" \
       -f repo="${GITHUB_REPOSITORY##*/}" \
       -F n="$pr"
}

# Fetch all PR-level (issue) comments in one paginated array.
pr_issue_comments() {
  local pr="$1"
  gh api --paginate "repos/${GITHUB_REPOSITORY:?}/issues/${pr}/comments"
}

# --- Controller state comment ----------------------------------------
#
# Format: a single PR comment whose body is
#
#     <STATE_OPEN_TAG>
#     ```json
#     {...}
#     ```
#     <STATE_CLOSE_TAG>
#     <markdown summary>
#
# The shell guard locates the comment by matching the literal
# STATE_OPEN_TAG inside .body and authored by the workflow.

state_find_comment_id() {
  local pr="$1"
  pr_issue_comments "$pr" | jq -s -r --arg tag "$STATE_OPEN_TAG" '
    add // []
    | [.[] | select(.body != null and (.body | contains($tag)))]
    | last
    | (.id // empty)
  '
}

state_extract_json() {
  # Reads a comment body from stdin and emits the JSON between the
  # ```json fences and STATE_CLOSE_TAG.
  awk '
    BEGIN { in_block = 0 }
    /^```json$/ && !in_block { in_block = 1; next }
    /^```$/ && in_block { in_block = 0; next }
    in_block { print }
  '
}

# Validate the state JSON against the schema. Requires `ajv` only if
# present; falls back to a basic jq sanity check otherwise.
state_validate_json_file() {
  local file="$1"
  local schema="$BABYSIT_DIR/schema-state.json"
  if command -v ajv >/dev/null 2>&1; then
    if ! ajv validate -s "$schema" -d "$file" --strict=false >/dev/null 2>&1; then
      warn "state JSON failed ajv validation"
      return 1
    fi
    return 0
  fi
  # Fallback: jq must parse, top-level must be object with required keys.
  if ! jq -e '.schemaVersion == 1 and (.iteration | type == "object")' "$file" >/dev/null 2>&1; then
    return 1
  fi
  return 0
}

state_default_json() {
  local head_sha="$1"
  local now
  now="$(now_iso)"
  jq -n \
    --arg cv "$(controller_version)" \
    --arg sha "$head_sha" \
    --arg now "$now" '
    {
      schemaVersion: 1,
      controllerVersion: $cv,
      headSha: $sha,
      lastEvent: null,
      lastEventAt: null,
      lastAction: null,
      lastActionAt: null,
      cooldownUntil: null,
      iteration: {
        headSha: $sha,
        copilotIteration: 0,
        reviewRequestCount: 0,
        fixRequestCount: 0,
        exhausted: false,
        exhaustedReason: null,
        thresholdSeverity: 2
      },
      session: {
        totalCopilotIterations: 0,
        totalReviewRequests: 0,
        totalFixRequests: 0
      },
      pendingRunId: null,
      pausedBy: null,
      humanEscalation: null,
      triage: { byThread: {} }
    }
  '
}

# Threshold severity for an iteration index. Iteration 1 → 2,
# iteration 2 → 3, iteration 3+ → 4.
state_threshold_for_iteration() {
  local n="$1"
  if [ "$n" -le 1 ]; then echo 2
  elif [ "$n" -eq 2 ]; then echo 3
  else echo 4
  fi
}

# Reset HEAD-scoped fields when the live HEAD diverges from the
# stored HEAD. Reads JSON from stdin, writes JSON to stdout.
state_reset_for_head() {
  local new_head="$1"
  jq --arg sha "$new_head" '
    if .iteration.headSha != $sha then
      .headSha = $sha
      | .iteration = {
          headSha: $sha,
          copilotIteration: 0,
          reviewRequestCount: 0,
          fixRequestCount: 0,
          exhausted: false,
          exhaustedReason: null,
          thresholdSeverity: 2
        }
      | .cooldownUntil = null
      | .triage = (
          (.triage // { byThread: {} })
          | .byThread = (
              (.byThread // {})
              | with_entries(select(.value.headSha == $sha))
            )
        )
    else
      .
    end
  '
}

# Render the state comment body from a JSON file.
state_render_body() {
  local json_file="$1"
  local cv
  cv="$(controller_version)"
  local headline
  headline="$(jq -r '
    "Babysitter v" + (.controllerVersion // "unknown")
    + " · iter " + ((.iteration.copilotIteration|tostring))
    + "/" + (if .iteration.exhausted then "exhausted" else "3" end)
    + " · sev≥" + (.iteration.thresholdSeverity|tostring)
    + " · last: " + (.lastAction // "none")
    + (if .cooldownUntil then " · cooldown until " + .cooldownUntil else "" end)
  ' "$json_file")"
  cat <<EOF
$STATE_OPEN_TAG

**$headline**

\`\`\`json
$(jq -S '.' "$json_file")
\`\`\`

$STATE_CLOSE_TAG

_This comment is owned by the Copilot babysitter workflow. Use
\`/copilot reset-state\` to reset it._
_Controller v$cv._
EOF
}

state_load() {
  # Loads the current state for a PR, reseting HEAD-scoped fields when
  # the HEAD has changed. Prints JSON to stdout.
  local pr="$1"
  local head_sha="$2"
  local cid
  cid="$(state_find_comment_id "$pr" || true)"
  if [ -z "$cid" ]; then
    state_default_json "$head_sha"
    return 0
  fi
  local body_file json_file
  body_file="$(mktemp)"
  json_file="$(mktemp)"
  if ! gh api "repos/${GITHUB_REPOSITORY}/issues/comments/${cid}" \
        --jq '.body' > "$body_file"; then
    warn "failed to fetch state comment $cid; falling back to default"
    state_default_json "$head_sha"
    rm -f "$body_file" "$json_file"
    return 0
  fi
  if ! state_extract_json < "$body_file" > "$json_file"; then
    warn "state comment $cid did not contain a fenced JSON block"
    state_default_json "$head_sha"
    rm -f "$body_file" "$json_file"
    return 0
  fi
  if ! state_validate_json_file "$json_file"; then
    warn "state comment $cid failed schema validation; refusing to parse"
    summary "::warning:: state comment validation failed; left untouched"
    # Surface raw body to summary for human inspection.
    if [ -n "${GITHUB_STEP_SUMMARY:-}" ]; then
      {
        echo "<details><summary>Broken state comment</summary>"
        echo
        echo '```'
        head -c 8000 "$body_file" || true
        echo '```'
        echo "</details>"
      } >> "$GITHUB_STEP_SUMMARY"
    fi
    state_default_json "$head_sha"
    rm -f "$body_file" "$json_file"
    return 0
  fi
  state_reset_for_head "$head_sha" < "$json_file"
  rm -f "$body_file" "$json_file"
}

# Save the state JSON. Writes a new comment if none exists, PATCHes
# the existing one otherwise.
state_save() {
  local pr="$1"
  local json_file="$2"
  local body_file
  body_file="$(mktemp)"
  state_render_body "$json_file" > "$body_file"
  local cid
  cid="$(state_find_comment_id "$pr" || true)"
  if [ -z "$cid" ]; then
    log "state_save: creating new state comment for PR #$pr"
    gh pr comment "$pr" --repo "$GITHUB_REPOSITORY" --body-file "$body_file" >/dev/null
  else
    log "state_save: PATCHing state comment $cid for PR #$pr"
    gh api --method PATCH \
      "repos/${GITHUB_REPOSITORY}/issues/comments/${cid}" \
      --field "body=@${body_file}" >/dev/null
  fi
  rm -f "$body_file"
}

# --- HEAD-scoped suppression markers ---------------------------------

marker_review_requested() { printf '<!-- copilot-review-requested:%s -->' "$1"; }
marker_local_active()     { printf '<!-- copilot-local-active:%s -->' "$1"; }
marker_local_converged()  { printf '<!-- copilot-local-converged:%s -->' "$1"; }

# Per-comment fix-trigger marker: scoped to (HEAD_SHA, reviewCommentId).
# Embedded in the body of the `@copilot apply changes...` thread reply
# so the auto-responder can detect and dedupe by reading the thread.
marker_fix_trigger() {
  printf '<!-- copilot-fix-trigger:%s:%s -->' "$1" "$2"
}

# Returns 0 if a marker is present; 1 otherwise.
# Args: pr, marker text, max-age-minutes (0 = no TTL check).
marker_present_recent() {
  local pr="$1" marker="$2" ttl_min="${3:-0}"
  local cutoff
  if [ "$ttl_min" -gt 0 ]; then
    cutoff="$(iso_minutes_ago "$ttl_min")"
  else
    cutoff="1970-01-01T00:00:00Z"
  fi
  pr_issue_comments "$pr" | jq -s -r \
    --arg m "$marker" \
    --arg cutoff "$cutoff" '
    add // []
    | any(.[];
        .body != null
        and (.body | startswith($m))
        and (.updated_at >= $cutoff))
  ' | grep -q '^true$'
}

# Post a marker as a one-line PR comment.
marker_post() {
  local pr="$1" marker="$2" note="${3:-}"
  local body
  if [ -n "$note" ]; then
    body=$(printf '%s\n\n%s\n' "$marker" "$note")
  else
    body="$marker"
  fi
  gh pr comment "$pr" --repo "$GITHUB_REPOSITORY" --body "$body" >/dev/null
}

# Check the local-active marker. Returns 0 (yield) if a fresh marker
# is present.
should_yield_to_local() {
  local pr="$1" head_sha="$2"
  if marker_present_recent "$pr" "$(marker_local_converged "$head_sha")" 0; then
    return 0
  fi
  if marker_present_recent "$pr" "$(marker_local_active "$head_sha")" 30; then
    return 0
  fi
  return 1
}
