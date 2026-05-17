# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

`k-mcp` is a macOS-only MCP server (FastMCP, stdio transport) that stores env-var values in the macOS Keychain and lets an LLM use them — without ever returning secret values to the chat transcript. Installed binary is `k-mcp` (see `[project.scripts]`); registered for Claude Code via `claude mcp add -s user k-mcp`.

## Commands

```bash
# Install / sync deps (Python >=3.11, uv-managed)
uv sync

# Run the server directly (what Claude Code spawns)
uv run k-mcp

# Run a single test file (tests are standalone scripts, no pytest)
uv run python tests/smoke.py            # in-memory keyring + tempdir index
uv run python tests/protocol.py         # exercises tools via FastMCP Client
uv run python tests/discovery.py        # instructions snapshot + catalog resource
uv run python tests/touchid_gate.py     # Touch ID gate, with auth() mocked
uv run python tests/stdio_handshake.py  # spawns the real binary, drives stdio JSON-RPC
uv run python tests/live.py             # LIVE — hits the real Keychain (uses k_mcp_smoke_* entries, cleans up)
```

Tests print `ok:` / `FAIL:` lines and `sys.exit(1)` on failure. No test runner — `live.py` and `stdio_handshake.py` shell out to `/opt/homebrew/bin/uv run --project /Users/linus/Code/k-mcp k-mcp`, so those paths are baked in.

## Architecture

### The two-kinds model (the core invariant)

Every stored entry has a `kind`:
- **`plain`** — URLs, hostnames, usernames. Retrievable verbatim via `get_plain`.
- **`secret`** — API keys, tokens. **Never** returned by any tool. The *only* way to use a secret is `run_with_secrets`, which injects values into a `bash -lc` subprocess's environment.

If a name *looks* secret (contains KEY/TOKEN/SECRET/PASS/PWD/CRED/AUTH — see `SECRET_HINT_TOKENS`) but the caller asks for `kind="plain"`, `save_env` refuses. This prevents a later `get_plain` from leaking it. See `_looks_secret` in `src/k_mcp/server.py`.

### Storage layout

- **Values** live in the macOS Keychain under service name `mcp-env` (constant `SERVICE`).
- **Metadata** (name → kind, created_at, updated_at) lives in `~/.config/mcp-keychain/index.json`. The two can fall out of sync (the code handles "in index, missing from Keychain" explicitly).
- `K_MCP_INDEX_PATH` env var overrides the index location — used by tests to point at a tempdir without touching real state.

### Discovery surfaces (LLM-facing)

Two complementary mechanisms expose what's stored, both metadata-only:
1. **`instructions` at server construction** — `_build_instructions()` reads the index at startup and embeds a catalog snapshot directly into the MCP `initialize` response. Static for the session.
2. **`keychain://catalog` resource** — re-reads the index on every `resources/read` call, so it reflects live state after any `save_env`/`delete_env` mid-session.

Both surfaces include name + kind + timestamps; never values. The `stdio_handshake.py` and `discovery.py` tests pin this contract.

### Secret-leak defenses (defense-in-depth)

Three independent layers prevent a secret value from reaching the chat:
1. **API shape** — `list_envs`, `find_envs`, `get_plain` (for secret-kind), and the catalog resource simply don't return values.
2. **Output scrubbing** — `_scrub()` replaces any literal secret value of length ≥ 4 in `run_with_secrets`'s captured stdout/stderr with `[REDACTED:NAME]`. Catches accidents like `echo $STRIPE_KEY`. Length floor avoids pathological replacement from 1-char secrets.
3. **Error sanitization** — error messages in `run_with_secrets` are constructed from key *names* and exception types only, never from values.

### Touch ID gate (`_security.py`)

- Uses `LocalAuthentication.LAContext` via PyObjC. This is a **UI gate**, not a Keychain ACL — biometric ACLs (`kSecAttrAccessControl` + `kSecAccessControlBiometryCurrentSet`) require a code-signed wrapper with entitlements, which the `uv`-installed Python interpreter doesn't have. Don't try to "upgrade" this to a real ACL without solving the codesigning problem first.
- `_ensure_unlocked()` prompts **once per server-process lifetime**, only when `run_with_secrets` is asked to inject at least one `kind="secret"` value. Plain-only invocations never prompt. The `_session_unlocked` module-global tracks this; tests set it to `True` directly to bypass.

## Testing notes

- All tests except `live.py` install an in-memory `KeyringBackend` *before* `import k_mcp.server`, then override `srv.INDEX_PATH` and `srv._session_unlocked = True`. This pattern lets you exercise every code path without touching the real Keychain or biometric subsystem.
- `touchid_gate.py` reassigns `_sec.authenticate` to a `FakeAuth` callable to count prompts and simulate failures — the gate is intentionally easy to swap.
- `live.py` is the only test that hits the real Keychain. It uses dedicated `k_mcp_smoke_*` entry names and runs cleanup in a `finally` even on failure. The test prints its randomized secret value once at the top, then asserts the exact string never appears in any subsequent tool reply.

## When modifying

- New tools that return entry data must follow the no-values-ever rule for the catalog/listing surfaces — only `get_plain` returns values, and only for `kind="plain"`.
- If you add anything that prints, logs, or includes user-controlled strings in errors inside `run_with_secrets`, pass it through `_scrub()` or construct it from key names only.
- `keyring.set_password` is synchronous and blocks on the actual Keychain; the in-memory backend in tests is the right escape hatch — don't add async/threading around it.
