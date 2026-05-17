#!/usr/bin/env bash
# Run per-thread Copilot-comment triage through GitHub Models, persist
# the result keyed by (threadId, headSha) into the controller state,
# and emit a summary on stdout.
#
# Usage:
#   triage.sh <pr_number> <context.json> <state.json> [out_state_file]
#
# Reads `context.json` produced by gather.sh, looks at unresolved
# Copilot threads on the current HEAD, calls the model with the
# triage prompt, validates against schema-triage.json, and writes the
# updated state to `out_state_file` (defaults to a temp file printed
# on stdout).

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib.sh
source "$SCRIPT_DIR/lib.sh"

require_env GITHUB_TOKEN GITHUB_REPOSITORY

# shellcheck disable=SC2034  # accepted for parity with gather.sh / act.sh callers
PR="${1:?usage: triage.sh <pr> <context.json> <state.json> [out_state]}"
CONTEXT="${2:?missing context.json}"
STATE="${3:?missing state.json}"
OUT_STATE="${4:-$(mktemp)}"

PROMPT_FILE="$BABYSIT_DIR/prompt-triage.md"
SCHEMA_FILE="$BABYSIT_DIR/schema-triage.json"
MODEL="${BABYSIT_MODEL:-openai/gpt-4o-mini}"

cp "$STATE" "$OUT_STATE"

threshold="$(jq -r '.iteration.thresholdSeverity' "$STATE")"
head_sha="$(jq -r '.headSha' "$CONTEXT")"

# Pull only Copilot-authored unresolved threads on current HEAD.
copilot_threads="$(jq '
  .threads.sample
  | map(select(.hasCopilot == true and .isResolved == false and .isOutdated == false))
' "$CONTEXT")"

count="$(jq 'length' <<<"$copilot_threads")"
if [ "$count" = "0" ]; then
  log "no Copilot comments to triage"
  jq -n '{
    decisions: [],
    summary: {
      totalThreads: 0,
      byRecommendation: { "Address": 0, "Ignore": 0, "Defer": 0, "Discuss with team": 0 },
      rootIssues: []
    }
  }'
  printf '%s\n' "$OUT_STATE" >&2
  exit 0
fi

# Compose the user payload — short, minimal threading context.
user_payload="$(jq -n \
  --argjson threshold "$threshold" \
  --argjson threads "$copilot_threads" '
  {
    iterationThreshold: $threshold,
    threads: $threads
  }
' | jq -Rs .)"

system_msg="$(jq -Rs . < "$PROMPT_FILE")"

body="$(jq -n \
  --arg model "$MODEL" \
  --argjson system_msg "$system_msg" \
  --argjson user_msg "$user_payload" '
  {
    model: $model,
    temperature: 0.1,
    response_format: { type: "json_object" },
    messages: [
      { role: "system", content: $system_msg },
      { role: "user",   content: $user_msg }
    ]
  }
')"

resp_raw="$(mktemp)"
trap 'rm -f "$resp_raw"' EXIT

http_status=$(curl --silent --show-error \
  --output "$resp_raw" \
  --write-out '%{http_code}' \
  --request POST \
  --url 'https://models.github.ai/inference/chat/completions' \
  --header "Authorization: Bearer $GITHUB_TOKEN" \
  --header "Accept: application/vnd.github+json" \
  --header "X-GitHub-Api-Version: 2022-11-28" \
  --header "Content-Type: application/json" \
  --data-binary "$body" || echo "000")

if [ "$http_status" != "200" ]; then
  warn "GitHub Models triage call failed: HTTP $http_status"
  warn "$(head -c 600 "$resp_raw")"
  jq -n '{
    decisions: [],
    summary: {
      totalThreads: 0,
      byRecommendation: { "Address": 0, "Ignore": 0, "Defer": 0, "Discuss with team": 0 },
      rootIssues: []
    }
  }'
  printf '%s\n' "$OUT_STATE" >&2
  exit 0
fi

content="$(jq -r '.choices[0].message.content // ""' "$resp_raw")"
stripped="$(printf '%s' "$content" \
  | sed -E 's/^[[:space:]]*```(json)?[[:space:]]*//; s/[[:space:]]*```[[:space:]]*$//')"

if ! printf '%s' "$stripped" | jq -e . >/dev/null 2>&1; then
  warn "triage model output was not JSON"
  jq -n '{
    decisions: [],
    summary: {
      totalThreads: 0,
      byRecommendation: { "Address": 0, "Ignore": 0, "Defer": 0, "Discuss with team": 0 },
      rootIssues: []
    }
  }'
  printf '%s\n' "$OUT_STATE" >&2
  exit 0
fi

triage_file="$(mktemp)"
printf '%s' "$stripped" > "$triage_file"

# Schema validation
if command -v ajv >/dev/null 2>&1; then
  if ! ajv validate -s "$SCHEMA_FILE" -d "$triage_file" --strict=false >/dev/null 2>&1; then
    warn "triage JSON failed ajv validation; ignoring"
    jq -n '{
      decisions: [],
      summary: {
        totalThreads: 0,
        byRecommendation: { "Address": 0, "Ignore": 0, "Defer": 0, "Discuss with team": 0 },
        rootIssues: []
      }
    }'
    rm -f "$triage_file"
    printf '%s\n' "$OUT_STATE" >&2
    exit 0
  fi
fi

# Persist decisions into state.triage.byThread keyed by threadId.
now="$(now_iso)"
jq --slurpfile dec "$triage_file" --arg sha "$head_sha" --arg now "$now" '
  .triage = (.triage // { byThread: {} })
  | .triage.byThread = (
      (.triage.byThread // {})
      | with_entries(select(.value.headSha == $sha))
    )
  | reduce ($dec[0].decisions // [])[] as $d (
      .;
      .triage.byThread[$d.threadId] = {
        headSha: $sha,
        category: $d.category,
        severity: $d.severity,
        validConcern: $d.validConcern,
        recommendation: $d.recommendation,
        shouldTriggerFixLoop: $d.shouldTriggerFixLoop,
        rationale: ($d.rationale // null),
        duplicateGroup: ($d.duplicateGroup // null),
        decidedAt: $now
      }
    )
' "$OUT_STATE" > "${OUT_STATE}.tmp" && mv "${OUT_STATE}.tmp" "$OUT_STATE"

cat "$triage_file"
rm -f "$triage_file"

# The path to the updated state goes to stderr so callers can read
# stdout for the triage JSON.
printf '%s\n' "$OUT_STATE" >&2
