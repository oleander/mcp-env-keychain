# Repository custom instructions

This is `mcp-env-keychain`, a macOS-only MCP server (TypeScript on Bun, stdio
transport) that stores env-var values in the macOS Keychain and exposes them
to LLMs without ever returning secret values to the chat transcript. See
[`CLAUDE.md`](../CLAUDE.md) for architecture, the two-kinds invariant, and
the secret-leak defenses.

## Build, test, type-check

Run all of these locally and in CI before considering a change complete:

```bash
bun install
bun test
bunx tsc --noEmit
```

CI runs the same commands on macOS via
[`/.github/workflows/ci.yml`](workflows/ci.yml). Do not propose Linux-only
patterns; the FFI calls in `src/keychain.ts` and `src/touchid.ts` link
against macOS frameworks (`Security.framework`, `LocalAuthentication`).

## Hard repository invariants

These are non-negotiable. A change that violates any of them is wrong.

- **Never return secret values.** `list_envs`, `find_envs`, the catalog
  resource, and `get_plain` for `kind="secret"` must not include values.
  The only path that uses secret values is `run_with_secrets`, which
  injects them into a subprocess env and scrubs stdout/stderr through
  `scrub()`. Construct error messages in `run_with_secrets` from key
  names and exception types only.
- **All logging is `console.error`.** `console.log` corrupts the stdio
  JSON-RPC stream.
- **Avoid `bun:ffi` for async callbacks.** Bun 1.3.x `JSCallback` does
  not preserve scope when invoked from a non-JS thread. Shell out to
  `swift -` instead, the way `src/touchid.ts` already does.
- **`outputSchema` must be a flat `z.object`.** The SDK's
  `normalizeObjectSchema` does not accept ZodDiscriminatedUnion at the
  top level.
- **Version is sourced from `package.json`** via static JSON import in
  `src/server.ts`. Do not duplicate the version literal anywhere else.
- **`normalizeName` at every entry point.** New tools that take an env
  name must trim through `normalizeName`. New persisted state must be
  zod-validated by `IndexSchema` and written via the atomic
  `saveIndex` path.

## Auto-tag fix protocol (read this if you are responding to `@copilot apply changes based on [link]`)

The babysitter workflow posts a single `@copilot apply changes
based on [this feedback](URL)` reply on each unresolved Copilot
review comment. When you act on one of those prompts:

1. Open the linked thread, read every comment.
2. Apply the smallest viable fix; stage only changed files.
3. Run `bun test` and `bunx tsc --noEmit` before committing.
4. Reply in the linked thread with the fix description and commit
   SHA. Do not write "Fixed." with no detail.
5. Resolve the thread after the reply lands. This is how the
   babysitter knows the comment is closed.
6. One commit per prompt; one push per Copilot iteration.

If the comment is obsolete or invalid, reply explaining why and
resolve the thread without changing code. Do not silently leave it
unresolved.

## Pull request and merge etiquette

The full babysitter ruleset lives in
[`.github/instructions/pr-babysit.instructions.md`](instructions/pr-babysit.instructions.md).
The short list:

- **Never force-push.** Merge the base branch in to update.
- **Never merge while Copilot is pending.** A `Running Copilot Code
  Review` dynamic check or an unfinished Copilot review pass on the
  current head commit blocks merge.
- **Convert the PR back to draft before pushing review-fix commits.**
  Mark ready again only after fast CI is green and unresolved threads
  are zero.
- **Batch accepted review fixes into one commit and one push.** One
  Copilot iteration per push. Multiple pushes burn CI minutes and
  trigger redundant Copilot waves.
- **Stage only named files or hunks.** No `git add .` / `git add -A`.
- **Pass PR bodies via `--body-file`.** Shell command substitution in
  backticks corrupts the text.
- **Resolve every review thread** after fixes are pushed or replies
  posted. An open thread blocks merge in many rulesets.
- **Do not manually request bot reviews.** Auto-bot reviewers run on
  push automatically; manual asks duplicate work.
- **Use auto-merge when allowed.** Re-arm it after any draft round-trip
  because GitHub auto-disables it when a ready PR converts back to
  draft.

## Copilot review iteration policy

Cap at three iterations per HEAD. The babysitter workflow tracks the
counter in a hidden state comment.

| Iteration | Address with code/doc changes | Resolve without addressing |
|-----------|------------------------------|---------------------------|
| 1 | High, medium, and low | Only invalid/out-of-scope/already-fixed |
| 2 | High and medium | Low |
| 3+ | High | Medium and low |

When resolving without addressing, reply in-thread first stating which
iteration this is and why the issue is being deferred. After the third
completed Copilot pass, address valid high-severity findings only and
reply-resolve the rest with the iteration note.

## Branch and worktree hygiene

- **Verify branch context before every edit/commit/push** with
  `git status --short --branch`. Long PR sessions switch branches; drift
  is common.
- **If the PR branch lives in a git worktree**, commit and push from
  that worktree path (`git checkout <branch>` fails with `already used
  by worktree at ...`). Use the printed worktree directory.
- **Update branch from base** before judging CI or merging. `BEHIND` →
  use the Update branch button or `gh api -X PUT
  /repos/{o}/{r}/pulls/<N>/update-branch`. `DIRTY`/`CONFLICTING` → fetch
  and merge the base locally; the Update branch button is disabled in
  that state.
