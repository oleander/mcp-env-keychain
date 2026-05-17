---
applyTo: "**"
excludeAgent: "cloud-agent"
---

# Code review instructions

These rules apply to GitHub Copilot when it is reviewing pull requests
on this repository. The cloud-agent rules live in
[`pr-babysit.instructions.md`](pr-babysit.instructions.md).

## Knowledge cutoff

Your training data has a cutoff. Treat anything you do not recognize
as **new, not wrong**. Do not flag any of these as bugs:

- Bun, TypeScript, Zod, MCP SDK versions newer than your training
  cutoff.
- macOS-specific FFI patterns in `src/keychain.ts` and
  `src/touchid.ts`. The `Bun.dlopen` + `objc_msgSend` approach is
  intentional; see the root [`CLAUDE.md`](../../CLAUDE.md) for why.
- Inline Swift via `Bun.spawn(["swift", "-"], ...)` for Touch ID. We
  tried `bun:ffi` for the async block-callback pattern and it does
  not work with Bun 1.3.x `JSCallback`. The Swift fallback is
  intentional.
- GitHub Actions runner names (e.g. `macos-latest`).

## Comment format

Every review comment uses this format:

```
<emoji> **<severity>:** <description>
```

| Severity | Emoji | When to use |
|----------|-------|-------------|
| CRITICAL | 🔴 | Logic error, security issue, secret leak, data loss |
| MODERATE | 🟡 | Real correctness or reliability issue with bounded blast radius |
| NIT | 🟢 | Maintainability, naming, light refactor |

Examples:

- 🔴 **CRITICAL:** `run_with_secrets` returns the value of
  `STRIPE_API_KEY` in stdout without going through `scrub()` —
  violates the no-secret-values invariant.
- 🟡 **MODERATE:** This loops over each item and issues a separate
  query — N+1 problem. Use a single batch query.
- 🟢 **NIT:** This nested `if/elif/else` is hard to follow. Consider
  early returns.

## What to focus on

Optimize for catching the things this codebase cares about:

- **Secret-leak defense.** Anything that could cause a `kind="secret"`
  value to flow into stdout, stderr, error messages, logs, MCP tool
  output, or a thrown exception body. The `scrub()` floor is
  4 characters — flag any new path that bypasses it. Error messages
  inside `run_with_secrets` must be constructed from key names and
  exception types only.
- **The two-kinds invariant.** `Result<{kind: "plain"; value:
  string}>` for `get_plain` is the compile-time enforcement;
  `list_envs`, `find_envs`, the catalog resource template, and the
  `keychain://env/{name}` reads must never include values.
- **Logging discipline.** All logging must be `console.error`.
  `console.log` corrupts the stdio JSON-RPC stream. Flag any new
  `console.log`.
- **Atomic index writes.** New persisted state must round-trip
  through `saveIndex`'s temp+fsync+rename path and be zod-validated
  by `IndexSchema` on read.
- **`normalizeName` at every entry point.** New tools that take an
  env name must trim through `normalizeName`.
- **`outputSchema` shape.** Tool output schemas must be flat
  `z.object` (not ZodDiscriminatedUnion). Variant-specific fields
  should be optional.
- **macOS-only assumptions.** This server only runs on macOS. Do not
  flag the lack of Linux/Windows support.
- **FFI async patterns.** Avoid `bun:ffi` for async callbacks (Apple
  blocks, libdispatch reply blocks). Bun's `JSCallback` does not
  preserve scope when invoked from a non-JS thread.

## Do NOT comment on

- **Stylistic preferences without correctness impact.** Naming
  variations, prefer-const-over-let when both are correct, single vs
  double quotes when the project mixes them.
- **Hypothetical edge cases.** If you would write "while unlikely,"
  "could potentially," or "edge case where," skip it. Only flag
  issues that realistically occur in practice.
- **Hardcoded values or magic numbers** when they appear once. Do not
  suggest extracting constants for one-off literals.
- **Discrepancies between PR description and code.** Focus on the
  code; description drift is the author's job.
- **Test coverage of unchanged code.** Only flag missing tests for
  behavior the PR is adding or changing.
- **Comments that restate what the code already does.**
- **Suggestions that contradict patterns established in this
  codebase.** If `src/tools.ts` uses one approach throughout, do not
  suggest a different style for the new addition.
- **Future dates, version numbers, model names.** Your knowledge
  cutoff makes these unreliable.

## Severity calibration

Adjust severity by the rules below. The babysitter workflow uses
severity to decide whether a comment triggers another fix loop, so
miscalibration directly causes wasted review cycles.

Increase severity for:

- A path that could cause a secret value to reach stdout, logs, or a
  thrown error.
- Logic errors, race conditions, unhandled exceptions in code paths
  that run on every request.
- Unhandled edge cases that affect data integrity (corrupting
  `index.json`, returning stale catalog data, etc.).

Decrease severity for:

- Suggestions that contradict the codebase's established patterns.
- Comments restating what the code already does.
- Flags on lines that the PR did not intentionally change.
- Hedged language like "consider," "may be worth," or "might want
  to."
- Duplicated style flags across many files where one rationale
  applies.

## Output discipline

- One concern per comment. Do not bundle multiple unrelated issues.
- Reference the file and line you are flagging. Use suggested-change
  blocks when the fix is concrete and short.
- Repeat the same root-cause comment at most once per group; for
  duplicates, note "applies to N other call sites" rather than
  re-litigating each instance.
