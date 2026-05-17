# mcp-env-keychain

MCP server for macOS that stores environment-variable values in the Keychain and lets an LLM use them safely. `secret` values are not returned by tools or tool responses; `plain` values may be returned to the client/chat transcript by design.

## Security model

Each stored entry has a `kind`:

- `plain`: non-sensitive values (URLs, usernames). Can be read with `get_plain`.
- `secret`: sensitive values (API keys/tokens). **Cannot** be read back by any tool.

Secrets are only usable via `run_with_secrets`, which injects them into a subprocess environment. Output is scrubbed to redact accidental secret echoes.

## Prerequisites

- macOS (uses Security.framework + Touch ID flow)
- [Bun](https://bun.sh) `>= 1.3.0` (required even when launching with `npx`, because the `k-mcp` bin runs on Bun)
- npm authentication for GitHub Packages when installing from `npm.pkg.github.com`

## Run from GitHub Packages

```bash
npm config set @oleander:registry https://npm.pkg.github.com
npm config set //npm.pkg.github.com/:_authToken "$(gh auth token)"
```

Then launch the server:

```bash
bunx --package @oleander/mcp-env-keychain@latest mcp-env-keychain
# or
npx --yes --package=@oleander/mcp-env-keychain@latest mcp-env-keychain
```

The auth command assumes you are logged into the GitHub CLI with a token that has package access. To check, run `gh auth status`. `npx` is supported as a package launcher, but it still needs `bun` on `PATH` because this MCP server uses Bun-specific APIs. The package also keeps `k-mcp` as a shorter binary alias.

To check the published version, use `npm view @oleander/mcp-env-keychain@latest version --registry=https://npm.pkg.github.com`, not `npx`.

Do not include `run` in these commands. `npx run @oleander/mcp-env-keychain@latest` and `bunx run @oleander/mcp-env-keychain@latest` try to execute a different `run` command/package instead of the MCP server binary.

## Develop locally

```bash
git clone https://github.com/oleander/mcp-env-keychain.git
cd mcp-env-keychain
bun install
bun run start
```

## Register with MCP clients

### Claude Code

```bash
claude mcp add -s user k-mcp -- bunx --package @oleander/mcp-env-keychain k-mcp
```

### Cursor (`~/.cursor/mcp.json`)

```json
{
  "mcpServers": {
    "k-mcp": {
      "command": "npx",
      "args": ["--yes", "--package=@oleander/mcp-env-keychain", "k-mcp"]
    }
  }
}
```

## Core tools

All tools advertise an `outputSchema` and behavior annotations (`readOnlyHint`, `destructiveHint`, `idempotentHint`, `openWorldHint`) so MCP clients can render confirmations and rich types.

- `save_env(name, value, kind)` — `idempotentHint`  
  Store/update an entry. If the name looks like a secret (KEY/TOKEN/SECRET/PASS/PWD/CRED/AUTH) but `kind="plain"`, the save is refused — re-call with `kind="secret"` or rename the variable.
- `list_envs()` — `readOnlyHint`, `idempotentHint`  
  Lists names, kinds, and timestamps only (never values).
- `get_plain(name)` — `readOnlyHint`, `idempotentHint`  
  Returns value only for entries stored as `kind="plain"`.
- `delete_env(name)` — `destructiveHint`, `idempotentHint`  
  Removes entry from index + Keychain.
- `run_with_secrets(command, env_keys, cwd?, timeout?)` — `openWorldHint`  
  Runs a shell command with selected values injected as env vars. On timeout, the partial stdout/stderr captured before the kill is returned alongside the error so you can debug what the subprocess actually did.

## Resources

- `keychain://env/{name}` — per-env metadata (`{ name, kind, created_at, updated_at }`). The server's `list` callback enumerates one resource per stored env, and `complete.name` autocompletes from the current index. Values are **never** returned.
- The server emits `notifications/resources/list_changed` after every successful `save_env` / `delete_env`, so clients refresh immediately.

## Prompts

User-invokable templates (surface as `/commands` in clients that support prompts):

- `/import-env-file` — bulk-import vars from a `.env` file. Walks the agent through filtering placeholders, classifying secret vs plain, and saving each.
- `/audit-stale` — list entries whose `updated_at` is older than N days (defaults to 90). Useful for credential rotation.

## Quickstart examples

```json
{"name":"save_env","arguments":{"name":"BACKEND_URL","value":"https://api.example.com","kind":"plain"}}
{"name":"save_env","arguments":{"name":"STRIPE_API_KEY","value":"sk_live_...","kind":"secret"}}
{"name":"get_plain","arguments":{"name":"BACKEND_URL"}}
{"name":"run_with_secrets","arguments":{"command":"echo $BACKEND_URL && curl -H \"Authorization: Bearer $STRIPE_API_KEY\" https://api.stripe.com/v1/charges","env_keys":["BACKEND_URL","STRIPE_API_KEY"]}}
```

## Commands

From `package.json`:

```bash
bun run start      # run server
bun test           # test suite
bun run typecheck  # tsc --noEmit
bun run compile    # compile to dist/mcp-env-keychain
```

## Releases

Releases are automatic: every PR merged into `main` triggers the `Auto release on PR merge` workflow, which dispatches the `Release` workflow with a `patch` bump. The release workflow bumps `package.json`, commits the bump to `main`, pushes the matching `vX.Y.Z` tag, builds the precompiled macOS binary, creates a GitHub Release with auto-generated notes from the merged PRs, and publishes `@oleander/mcp-env-keychain` to GitHub Packages.

For a minor or major bump, run the `Release` workflow manually from the Actions tab and pick the bump level. Pushing a `v*` tag directly also still works.

## Troubleshooting

- **No Touch ID prompt appears:** Touch ID is requested only when `run_with_secrets` injects at least one `secret` key. Plain-only runs do not prompt.
- **Prompt appears only once:** This is expected; unlock is cached for the server process/session lifetime.
- **`bun: command not found`:** install Bun and ensure it is on `PATH`.
- **GitHub Packages install returns 401/403:** run `gh auth status` and confirm the active token has `read:packages` or `write:packages`, then run `npm config set //npm.pkg.github.com/:_authToken "$(gh auth token)"`.
- **`get_plain` refuses a key:** the entry was saved as `secret`; use `run_with_secrets`.
- **Index path in tests/automation:** set `K_MCP_INDEX_PATH` to point at a custom index file.
