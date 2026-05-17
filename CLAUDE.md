# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

`mcp-env-keychain` is a macOS-only MCP server (TypeScript on Bun, stdio transport) that stores env-var values in the macOS Keychain and lets an LLM use them — without ever returning secret values to the chat transcript. Run with `bun run src/index.ts`. Registered for Claude Code via `claude mcp add -s user k-mcp -- bunx --package @oleander/mcp-env-keychain k-mcp`.

## Commands

```bash
bun install           # install deps (Bun >= 1.3)
bun run src/index.ts  # run the server (what Claude Code spawns)
bun test              # run the full test suite (bun:test)
bunx tsc --noEmit     # type check (strict mode, exactOptionalPropertyTypes)
```

## Architecture

### The two-kinds model (the core invariant)

Every stored entry has a `kind`:
- **`plain`** — URLs, hostnames, usernames. Retrievable verbatim via `get_plain`.
- **`secret`** — API keys, tokens. **Never** returned by any tool. The *only* way to use a secret is `run_with_secrets`, which injects values into a `bash -lc` subprocess's environment.

If a name *looks* secret (contains KEY/TOKEN/SECRET/PASS/PWD/CRED/AUTH — see `SECRET_HINT_TOKENS` in `src/constants.ts`) but the caller asks for `kind="plain"`, `save_env` refuses. This prevents a later `get_plain` from leaking it. See `looksSecret` in `src/keychain.ts`.

The TS type system pins this: `Result<{kind: "plain"; value: string}>` for `get_plain` means it's a compile error to construct a success return that isn't kind-plain.

### Storage layout

- **Values** live in the macOS Keychain under service name `mcp-env` (constant `SERVICE` in `src/constants.ts`). On-disk format is identical to the Python version this replaces, so existing entries continue to work.
- **Metadata** (name → kind, created_at, updated_at) lives in `~/.config/mcp-keychain/index.json`. The two can fall out of sync (the code handles "in index, missing from Keychain" explicitly).
- `K_MCP_INDEX_PATH` env var overrides the index location — used by tests to point at a tempdir.

### Discovery surfaces (LLM-facing)

Two complementary mechanisms expose what's stored:
1. **`instructions` at server construction** — `buildInstructions()` reads the index at startup and embeds a name snapshot directly into the MCP `initialize` response. Static for the session.
2. **`keychain://env-names` resource** — re-reads the index on every `resources/read` call and returns a sorted, unique JSON array of env names only.

Neither surface returns values. The `tests/discovery.test.ts` and `tests/protocol.test.ts` files pin this contract.

### Secret-leak defenses (defense-in-depth)

Three independent layers prevent a secret value from reaching the chat:
1. **API shape** — `list_envs`, `find_envs`, `get_plain` (for secret-kind), and the catalog resource simply don't return values. Enforced at compile time by `Result<{kind: "plain"; value: string}>`.
2. **Output scrubbing** — `scrub()` in `src/keychain.ts` replaces any literal secret value of length ≥ 4 in `run_with_secrets`'s captured stdout/stderr with `[REDACTED:NAME]`. Catches accidents like `echo $STRIPE_KEY`. Length floor avoids pathological replacement from 1-char secrets.
3. **Error sanitization** — error messages in `run_with_secrets` are constructed from key *names* and exception types only, never from values.

### Touch ID gate (`src/touchid.ts`)

- **Availability check** uses `Bun.dlopen` + `objc_msgSend` to call `LAContext.canEvaluatePolicy:error:` synchronously (no callback needed, fast).
- **The actual biometric prompt** runs via `Bun.spawn(["swift", "-"], { stdin: <inline Swift source> })`. We tried doing the whole thing in `bun:ffi`, but Bun 1.3.x's `JSCallback` invokes the wrapped JS function in a context where **no identifiers** (not lexical closures, not module-level consts, not even values written to `globalThis` from the main thread) are visible. That makes the async `evaluatePolicy:reply:` block-callback pattern unworkable. The Swift fallback is reliable, has ~1-2s cold start (Swift JIT compilation), and the inline source is small (~20 lines).
- This is a **UI gate**, not a Keychain ACL: it prompts the user for Touch ID and returns whether authentication succeeded. The actual Keychain items remain stored without biometric ACL.
- `ensureUnlocked()` prompts **once per server-process lifetime**, only when `run_with_secrets` is asked to inject at least one `kind="secret"` value. Plain-only invocations never prompt. Tests inject a no-op auth function via `setAuth()`.

### Keychain access

`src/keychain.ts` calls `SecKeychainAddGenericPassword` / `Find` / `ModifyAttributesAndData` / `Delete` from `Security.framework` via `bun:ffi`. The value moves as a pointer-to-process-buffer, never as an argv element — so a `ps` snapshot can't observe it. Format-compat with the Python predecessor (PyObjC `keyring`) is verified: framework-written entries are readable by the `security` CLI and vice versa.

The legacy `SecKeychain*` API is officially deprecated in favor of the modern `SecItem*` family (`SecItemAdd` / `SecItemCopyMatching` / `SecItemUpdate` / `SecItemDelete`). We use the legacy calls because they take plain C-string + length args; `SecItem*` requires constructing a `CFDictionary` of `CFString`/`CFData` values per call, which is significantly more FFI plumbing. Both work on every shipping macOS; if Apple ever ships the deprecation, the migration is mechanical.

## File layout

```
src/
  index.ts        — entrypoint: builds server, connects StdioServerTransport, SIGINT handler
  server.ts       — registerTool / registerResource wiring; buildInstructions()
  tools.ts        — the 6 tool implementations as pure async functions
  keychain.ts     — Security.framework FFI backend, index.json I/O, scrub/looksSecret/now, backend injection seam
  touchid.ts      — bun:ffi LocalAuthentication gate, session-scoped, setAuth() test seam
  types.ts        — Kind, Entry, Index, Result discriminated unions; zod schemas
  constants.ts    — SERVICE, SECRET_HINT_TOKENS, INDEX_PATH resolution
tests/
  helpers.ts          — setupTestEnv() — in-memory keychain + tempdir index + no-op auth
  smoke.test.ts       — every tool through its direct function entry
  protocol.test.ts    — client ↔ server over InMemoryTransport; secret-absence audit
  discovery.test.ts   — instructions + keychain://env-names
  touchid.test.ts     — gate fires once per session; failure path
```

## When modifying

- New tools that return entry data must follow the no-values-ever rule for the catalog/listing surfaces — only `get_plain` returns values, and only for `kind="plain"`. The `Result<{kind: "plain"; value: string}>` literal type is your enforcement.
- If you add anything that prints, logs, or includes user-controlled strings in errors inside `run_with_secrets`, pass it through `scrub()` or construct it from key names only.
- All logging MUST be `console.error` only. `console.log` corrupts the stdio JSON-RPC stream.
- `objc_msgSend` requires a separate `dlopen` declaration per signature in Bun — see the pattern at the top of `src/touchid.ts`.
- Avoid `bun:ffi` for async callback patterns (Apple blocks, libdispatch reply blocks, etc.). Bun's `JSCallback` does not preserve scope when invoked from a non-JS thread. Prefer shelling out to a small Swift program via `swift -`.
