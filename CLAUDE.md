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

If a name *looks* secret (contains KEY/TOKEN/SECRET/PASS/PWD/CRED/AUTH — see `SECRET_HINT_TOKENS` in `src/constants.ts`) but the caller asks for `kind="plain"`, `save_env` asks the user via the MCP elicitation channel ("save as 'secret' instead?"). If the client supports elicitation, the user resolves the conflict explicitly. If the client doesn't (or the user cancels), `save_env` falls back to refusing outright. Either way, a `get_plain` of a secret-named entry can't leak it. See `resolveKindOnConflict` in `src/tools.ts` and `setElicitFn` for the test seam.

The TS type system pins this: `Result<{kind: "plain"; value: string}>` for `get_plain` means it's a compile error to construct a success return that isn't kind-plain.

### Name normalization

Every tool that takes an env name routes through `normalizeName(s) = s.trim()` (`src/keychain.ts`). Saving `" FOO "` and looking up `"FOO\t"` resolve to the same entry. Tools: `save_env`, `get_plain`, `delete_env`, `run_with_secrets` (per env_key), and `find_envs` (pattern).

### Storage layout

- **Values** live in the macOS Keychain (v2 layout, `INDEX_VERSION = 2`):
  - `serviceName` = the env var name (e.g. `STRIPE_API_KEY`). This is what Keychain Access shows in the **Name** column.
  - `accountName` = `OWNER` (`"mcp-env"`, in `src/constants.ts`). Uniform across all our entries — lets users see at a glance which Keychain rows belong to mcp-env, and lets us reliably filter our entries among potential collisions.
  - `kSecAttrDescription` = `"plain"` or `"secret"`. Set via a follow-up `SecKeychainItemModifyAttributesAndData` with a single-attribute `SecKeychainAttributeList`. Shows in the **Kind** column in Keychain Access. (The value itself is still encrypted at rest — no Keychain item class exposes raw cleartext.)
- **Legacy v1 layout** (Python predecessor, pre-`INDEX_VERSION` files): single shared `serviceName="mcp-env"` with the env name in `accountName`. On startup, `loadIndex` runs a one-shot migration if `index.version !== INDEX_VERSION`. `migrateLegacyEntry` reads each legacy row, re-writes it under v2, deletes the legacy row, and stamps `version: 2` once all succeed. Partial failure withholds the version stamp so the next startup retries. Idempotent: re-migration is a no-op because v2-only entries have no legacy row to find.
- **Metadata** (name → kind, created_at, updated_at; plus top-level `version`) lives in `~/.config/mcp-keychain/index.json`. The two can fall out of sync (the code handles "in index, missing from Keychain" explicitly).
- **Writes are atomic.** `saveIndex` writes to a sibling `index.json.tmp.<pid>.<rand>`, `fsync`s, then `rename`s. A crash mid-write leaves an orphan temp (which the loader ignores) and never a partial final file.
- **Reads are validated.** `loadIndex` zod-parses the file against `IndexSchema`. A corrupt or hand-edited file is backed up to `index.json.corrupt.<ts>` (logged to stderr) and we start with an empty index — better than bricking the server on one bad entry.
- `K_MCP_INDEX_PATH` env var overrides the index location — used by tests to point at a tempdir.

### Discovery surfaces (LLM-facing)

Five complementary mechanisms expose what's stored — none of them return values:

1. **`instructions` at handshake** — `buildInstructions()` (`src/server.ts`) reads the index at startup and emits two labeled JSON arrays into the MCP `initialize` response:
   ```
   Secrets (most recent first): ["STRIPE_API_KEY", …]
   Plain (most recent first):   ["BACKEND_URL",   …]
   ```
   Bucketed by kind, sorted by `updated_at` desc, full catalog (no count cap). Machine-parseable in one shot.
2. **`keychain://env/{name}` resource template** (`src/server.ts`) — RFC 6570 URI template. Reading any concrete URI returns `{ ok, metadata: { name, kind, created_at, updated_at } }` (no value). The `list` callback enumerates one resource per stored env, so clients can browse without a tool call. The `complete.name` callback offers prefix autocomplete from the current index.
3. **`keychain://env-names` static resource** — legacy alias kept for backward-compatibility with v0.2.x clients. Same flat JSON name array as before.
4. **`notifications/resources/list_changed`** — fired after every successful `save_env` / `delete_env` via the `setOnIndexChange` seam in `tools.ts` (wired to `server.sendResourceListChanged()` from `server.ts`). Clients refresh their resource list immediately.
5. **Per-tool `outputSchema` + `annotations`** on every `registerTool` call. `outputSchema` is a flat `z.object` so the SDK's `normalizeObjectSchema` can wrap it (it doesn't accept discriminated unions at the top level — keep this in mind if extending). Annotations: `readOnlyHint`, `destructiveHint`, `idempotentHint`, `openWorldHint`.

Prompts: `src/prompts.ts` ships `import-env-file` and `audit-stale`. Each is a user-invokable template that emits a single user-role workflow message; the agent drives the actual tool calls.

The `tests/discovery.test.ts`, `tests/prompts.test.ts`, `tests/elicitation.test.ts`, and `tests/protocol.test.ts` files pin these contracts.

### Secret-leak defenses (defense-in-depth)

Three independent layers prevent a secret value from reaching the chat:
1. **API shape** — `list_envs`, `find_envs`, `get_plain` (for secret-kind), and the catalog resource simply don't return values. Enforced at compile time by `Result<{kind: "plain"; value: string}>`.
2. **Output scrubbing** — `scrub()` in `src/keychain.ts` replaces any literal secret value of length ≥ 4 in `run_with_secrets`'s captured stdout/stderr with `[REDACTED:NAME]`. Catches accidents like `echo $STRIPE_KEY`. Length floor avoids pathological replacement from 1-char secrets. The scrub also applies to stdout/stderr preserved alongside a timeout error.
3. **Error sanitization** — error messages in `run_with_secrets` are constructed from key *names* and exception types only, never from values.

### Touch ID gate (`src/touchid.ts`)

- **Availability check** uses `Bun.dlopen` + `objc_msgSend` to call `LAContext.canEvaluatePolicy:error:` synchronously (no callback needed, fast).
- **The actual biometric prompt** runs via `Bun.spawn(["swift", "-"], { stdin: <inline Swift source> })`. We tried doing the whole thing in `bun:ffi`, but Bun 1.3.x's `JSCallback` invokes the wrapped JS function in a context where **no identifiers** (not lexical closures, not module-level consts, not even values written to `globalThis` from the main thread) are visible. That makes the async `evaluatePolicy:reply:` block-callback pattern unworkable. The Swift fallback is reliable, has ~1-2s cold start (Swift JIT compilation), and the inline source is small (~20 lines).
- **`swift` precheck** — before the spawn, `Bun.which("swift")` is checked (cached per process). If absent, we throw `TouchIDNotAvailable` with a helpful message pointing at `xcode-select --install`. The check survives the call so cold paths through fallback environments produce a real error instead of an opaque `ENOENT`.
- This is a **UI gate**, not a Keychain ACL: it prompts the user for Touch ID and returns whether authentication succeeded. The actual Keychain items remain stored without biometric ACL.
- `ensureUnlocked()` prompts **once per server-process lifetime**, only when `run_with_secrets` is asked to inject at least one `kind="secret"` value. Plain-only invocations never prompt. Tests inject a no-op auth function via `setAuth()`.

### Keychain access

`src/keychain.ts` calls `SecKeychainAddGenericPassword` / `Find` / `ModifyAttributesAndData` / `Delete` from `Security.framework` via `bun:ffi`. The value moves as a pointer-to-process-buffer, never as an argv element — so a `ps` snapshot can't observe it.

**Setting the description attribute** uses an inline-built `SecKeychainAttributeList`. `buildDescriptionAttrList(kind)` allocates two `ArrayBuffer`s (`SecKeychainAttribute` = `{tag: u32; length: u32; data: void*}` → 16 bytes; `SecKeychainAttributeList` = `{count: u32; attr: SecKeychainAttribute*}` → 16 bytes incl. alignment) and packs `kSecDescriptionItemAttr` (`'desc'` = `0x64657363`) plus a pointer to the kind string bytes. The returned `keepAlive` struct must be referenced from the caller until the FFI call returns so GC can't reclaim the backing memory mid-call.

The legacy `SecKeychain*` API is officially deprecated in favor of the modern `SecItem*` family (`SecItemAdd` / `SecItemCopyMatching` / `SecItemUpdate` / `SecItemDelete`). We use the legacy calls because they take plain C-string + length args; `SecItem*` requires constructing a `CFDictionary` of `CFString`/`CFData` values per call, which is significantly more FFI plumbing. Both work on every shipping macOS; if Apple ever ships the deprecation, the migration is mechanical.

## File layout

```
src/
  index.ts        — entrypoint: builds server, connects StdioServerTransport, SIGINT handler
  server.ts       — registerTool / registerResource / registerPrompt wiring; buildInstructions();
                    JSON-import of package.json for serverInfo.version (no runtime FS read)
  tools.ts        — the 6 tool implementations + getEnvMetadata (resource read); setOnIndexChange
                    + setElicitFn test seams; normalizeName at every entry point
  prompts.ts      — import-env-file, audit-stale prompt definitions
  keychain.ts     — Security.framework FFI backend; atomic saveIndex (temp+fsync+rename);
                    zod-validated loadIndex with corrupt-file backup; scrub/looksSecret/normalizeName/now
  touchid.ts      — bun:ffi LocalAuthentication gate; Bun.which("swift") precheck;
                    session-scoped; setAuth() test seam
  types.ts        — Kind, Entry, Index, Result discriminated unions; zod input + output schemas;
                    IndexSchema for persisted index validation
  constants.ts    — OWNER (v2 accountName tag), LEGACY_SERVICE, INDEX_VERSION,
                    SECRET_HINT_TOKENS, INDEX_PATH resolution
tests/
  helpers.ts          — setupTestEnv, installAuthCounter, installFailingAuth, installElicitStub
  smoke.test.ts       — every tool through its direct function entry; bug-fix coverage
                        (normalizeName symmetry, corrupt index recovery, preserved timeout output)
  protocol.test.ts    — client ↔ server over InMemoryTransport; secret-absence audit
  discovery.test.ts   — instructions JSON format; outputSchema + annotations on tools/list;
                        ResourceTemplate list + read; alias backward compat; list_changed seam
  prompts.test.ts     — prompts/list + getPrompt for both shipped prompts
  elicitation.test.ts — save_env conflict elicitation: accept/decline/cancel/missing-capability
  touchid.test.ts     — gate fires once per session; failure path
  migration.test.ts   — legacy→v2 layout migration via a dual-layout mock backend;
                        idempotency, partial-failure retry, version stamp
```

## When modifying

- New tools that return entry data must follow the no-values-ever rule for the catalog/listing surfaces — only `get_plain` returns values, and only for `kind="plain"`. The `Result<{kind: "plain"; value: string}>` literal type is your enforcement.
- If you add anything that prints, logs, or includes user-controlled strings in errors inside `run_with_secrets`, pass it through `scrub()` or construct it from key names only.
- All logging MUST be `console.error` only. `console.log` corrupts the stdio JSON-RPC stream.
- `objc_msgSend` requires a separate `dlopen` declaration per signature in Bun — see the pattern at the top of `src/touchid.ts`.
- Avoid `bun:ffi` for async callback patterns (Apple blocks, libdispatch reply blocks, etc.). Bun's `JSCallback` does not preserve scope when invoked from a non-JS thread. Prefer shelling out to a small Swift program via `swift -`.
- **Version source of truth.** `serverInfo.version` is sourced from `package.json` via a static JSON import (`import pkg from "../package.json" with { type: "json" };` in `src/server.ts`). Bun statically embeds the JSON into compiled binaries at bundle time — no `--compile-autoload-package-json` flag needed. Do not duplicate the version literal elsewhere.
- **outputSchema constraints.** The SDK's `normalizeObjectSchema` only accepts ZodObject (or a raw `{key: schema}` shape it can wrap into z.object), not ZodDiscriminatedUnion. When adding new tools, model the result as a flat `z.object({...})` with optional variant-specific fields. The TS-level `Result<T>` invariant is preserved in `src/types.ts`; the runtime JSON-schema is laxer.
- **Elicitation fallback contract.** Anything that calls `setElicitFn` via `mcpServer.server.elicitInput(...)` must handle the throw path: clients without the `elicitation` capability return a rejection. Tools must degrade gracefully (e.g. `resolveKindOnConflict` returns `null` on throw, which the caller treats as "refuse" — the legacy v0.2.x behavior).
