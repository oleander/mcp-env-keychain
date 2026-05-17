# Repository custom instructions

This is `mcp-env-keychain`, a macOS-only MCP server (TypeScript on
Bun, stdio transport) that stores env-var values in the macOS
Keychain and exposes them to LLMs without ever returning secret
values to the chat transcript. The full architecture lives in
[`CLAUDE.md`](../CLAUDE.md).

Copilot code review only reads the first 4,000 characters of this
file. The cloud-agent-only details live in
[`.github/instructions/pr-babysit.instructions.md`](instructions/pr-babysit.instructions.md);
the code-review-only nuance lives in
[`.github/instructions/code-review.instructions.md`](instructions/code-review.instructions.md).

## Build, test, type-check

```bash
bun install --frozen-lockfile
bun test
bunx tsc --noEmit
```

CI runs the same commands on macOS in
[`.github/workflows/ci.yml`](workflows/ci.yml). The FFI in
`src/keychain.ts` and `src/touchid.ts` links against macOS
frameworks — do not propose Linux-only patterns.

## Hard invariants

- **Never return secret values.** `list_envs`, `find_envs`, the
  catalog resource, and `get_plain` for `kind="secret"` must not
  include values. The only path that uses secret values is
  `run_with_secrets`, which injects them into a subprocess env and
  scrubs stdout/stderr through `scrub()`. Errors inside
  `run_with_secrets` must be built from key names and exception
  types only.
- **All logging is `console.error`.** `console.log` corrupts the
  stdio JSON-RPC stream.
- **Avoid `bun:ffi` for async callbacks.** `JSCallback` does not
  preserve scope when invoked from a non-JS thread. Shell out to
  `swift -` as `src/touchid.ts` does.
- **`outputSchema` is flat `z.object`** (not ZodDiscriminatedUnion).
  Variant-specific fields are optional.
- **Version lives in `package.json`** and is imported via static
  JSON import in `src/server.ts`. Do not duplicate it.
- **`normalizeName` at every entry point** that takes an env name.
- **Persisted state goes through `saveIndex`** (atomic
  temp+fsync+rename) and is zod-validated by `IndexSchema` on read.

## Pull request and merge etiquette

The full babysitter ruleset is in
[`.github/instructions/pr-babysit.instructions.md`](instructions/pr-babysit.instructions.md).
Short list:

- **Never force-push.** Merge the base branch in to update.
- **Never merge while Copilot review is pending** for the current
  HEAD. A queued `Running Copilot Code Review` check or unfinished
  review blocks merge.
- **Convert PR back to draft before pushing review-fix commits.**
  Mark ready again only after fast CI is green and unresolved
  threads are zero.
- **Batch accepted review fixes into one commit and one push** per
  Copilot iteration. Avoid multiple pushes per round.
- **Stage only named files or hunks.** No `git add .` / `git add -A`.
- **Pass PR bodies via `--body-file`.** Backticks in shell
  substitution corrupt the text.
- **Resolve every review thread** after fixes are pushed or replies
  posted.
- **Do not manually post `@copilot review`.** It is not a documented
  trigger. The
  [`Copilot Request Review`](workflows/copilot-request-review.yml)
  workflow handles review requests on push, capped at 5 lifetime
  requests per PR. If you need a manual review, add the
  `copilot:force-review` label.

## When responding to `@copilot apply changes based on [link]`

If the babysitter (or a maintainer) tags you to fix a specific
review thread:

1. Read every comment in the linked thread.
2. Apply the smallest viable fix. Stage only the changed files.
3. Run `bun test` and `bunx tsc --noEmit`.
4. Reply in the linked thread with the fix description and commit
   SHA (do not write "Fixed." with no detail).
5. Resolve the thread.
6. One commit per prompt; one push per iteration.

If the comment is obsolete or invalid, reply explaining why and
resolve the thread without changing code.
