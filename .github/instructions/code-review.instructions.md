---
applyTo: "**"
excludeAgent: "cloud-agent"
---

# Code review instructions

Copilot code review only reads the first 4,000 characters of this
file. The cloud-agent rules live in
[`pr-babysit.instructions.md`](pr-babysit.instructions.md).

## Knowledge cutoff

Treat anything unfamiliar as **new, not wrong**. Do not flag:

- Bun/TypeScript/Zod/MCP SDK versions newer than your cutoff.
- macOS FFI in `src/keychain.ts` and `src/touchid.ts`. The
  `Bun.dlopen` + `objc_msgSend` and inline-Swift fallback are
  intentional; see `CLAUDE.md`.
- macOS-only assumptions (this server only runs on macOS).

## Comment format

Use this exact format:

```
<emoji> **<severity>:** <description>
```

| Severity | Emoji | Use for |
|---|---|---|
| CRITICAL | 🔴 | Logic error, secret leak, security, data loss |
| MODERATE | 🟡 | Real reliability bug with bounded blast radius |
| NIT | 🟢 | Maintainability, naming, light refactor |

One concern per comment. Suggest a concrete change when possible.

## Focus

Optimize for the things this codebase cares about:

- **Secret-leak defense.** Any new path that could let a
  `kind="secret"` value reach stdout, stderr, logs, error messages,
  MCP tool output, or thrown exceptions. The `scrub()` floor is
  4 chars — flag anything that bypasses it. In `run_with_secrets`,
  error messages must be built from key *names* and exception types
  only.
- **Two-kinds invariant.** `Result<{kind: "plain"; value: string}>`
  for `get_plain` is the compile-time enforcement; `list_envs`,
  `find_envs`, the catalog resource, and `keychain://env/{name}`
  reads must never include values.
- **Logging.** All logging must be `console.error`. `console.log`
  corrupts the stdio JSON-RPC stream.
- **Atomic index writes.** New persisted state must round-trip
  through `saveIndex`'s temp+fsync+rename path and be zod-validated
  by `IndexSchema` on read.
- **`normalizeName` at every entry point** for any tool that takes
  an env name.
- **`outputSchema` shape.** Flat `z.object` only (not
  ZodDiscriminatedUnion); variant-specific fields optional.
- **FFI async patterns.** Avoid `bun:ffi` for async callbacks.
  `JSCallback` does not preserve scope when invoked from a non-JS
  thread; shell out to `swift -` instead.

## Do NOT comment on

- Stylistic preferences without correctness impact.
- Hypothetical edge cases ("while unlikely", "could potentially").
- Hardcoded values appearing once. No "extract to constant" for
  one-offs.
- Discrepancies between PR description and code.
- Test coverage of unchanged code.
- Comments that restate what the code already does.
- Suggestions that contradict patterns established in this codebase.
- Future dates, version numbers, model names (unreliable due to
  cutoff).

## Severity calibration

The babysitter cap (`MAX_COPILOT_REVIEWS=5` lifetime requests per
PR) means each review pass matters. Miscalibration wastes those.

Increase severity for: secret-leak risk, data-integrity bugs, logic
errors in always-run paths, race conditions.

Decrease severity for: suggestions that contradict repo patterns,
hedged language ("consider", "may be worth"), flags on lines the
PR did not intentionally change, duplicated style flags across many
files.

For duplicated root issues, post once and note "applies to N other
call sites".
