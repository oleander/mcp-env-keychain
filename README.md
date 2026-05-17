# mcp-env-keychain

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![GitHub Packages](https://img.shields.io/badge/GitHub%20Packages-%40oleander%2Fmcp--env--keychain-blue)](https://github.com/oleander/mcp-env-keychain/pkgs/npm/mcp-env-keychain)

An MCP server for macOS that stores environment-variable values in the system Keychain and lets an LLM **use** them in shell commands without their values ever entering the chat transcript. Entries are split into two kinds: `plain` values (URLs, hostnames) that can be read back, and `secret` values (API keys, tokens) that can only be injected into a subprocess via `run_with_secrets` — gated by Touch ID and scrubbed from captured output.

## Use cases

- Run a `curl` against a paid API in a Claude Code session without pasting the bearer token into chat.
- Let an agent inspect, list, or search what env vars are available without ever exposing their values.
- Use `BACKEND_URL`-style plain values directly in chat output while keeping `STRIPE_API_KEY`-style secrets locked behind Touch ID.
- Replace ad-hoc `.env` files in agent workflows with a Keychain-backed store; lifetime auth is one biometric prompt per server process.

## Prerequisites

- macOS (uses `Security.framework` and `LocalAuthentication.framework`).
- [Bun](https://bun.sh) `>= 1.3.0` — required at runtime even when launched with `npx`, because the `k-mcp` bin runs on Bun.
- An authenticated [`gh`](https://cli.github.com) CLI for installing from GitHub Packages.

## Installation

### Authenticate with GitHub Packages

```bash
npm config set @oleander:registry https://npm.pkg.github.com
npm config set //npm.pkg.github.com/:_authToken "$(gh auth token)"
```

The token needs `read:packages`. Run `gh auth status` to confirm.

### Run the server

```bash
bunx --package @oleander/mcp-env-keychain@latest mcp-env-keychain
# or
npx --yes --package=@oleander/mcp-env-keychain@latest mcp-env-keychain
```

The package also installs `k-mcp` as a shorter binary alias. To check the published version, use `npm view @oleander/mcp-env-keychain@latest version --registry=https://npm.pkg.github.com`.

Do not include `run` in these commands — `npx run @oleander/mcp-env-keychain` and `bunx run @oleander/mcp-env-keychain` try to execute a different `run` command instead of this server.

## Configure your MCP client

### Claude Code

```bash
claude mcp add -s user k-mcp -- bunx --package @oleander/mcp-env-keychain k-mcp
```

### Claude Desktop (`~/Library/Application Support/Claude/claude_desktop_config.json`)

```json
{
  "mcpServers": {
    "k-mcp": {
      "command": "bunx",
      "args": ["--package", "@oleander/mcp-env-keychain", "k-mcp"]
    }
  }
}
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

## Security model

Every entry has a `kind`:

- `plain` — non-sensitive values (URLs, hostnames, usernames). Retrievable via `get_plain`.
- `secret` — credentials (API keys, tokens). **Never** returned by any tool or resource. The only way to use a secret is `run_with_secrets`, which injects it into a subprocess `env` for one command.

Three independent layers prevent a secret value from reaching the chat transcript:

1. **API shape.** `list_envs`, `find_envs`, `get_plain` (for `kind="secret"`), and the `keychain://env-names` resource do not return values. The TypeScript type system pins `get_plain`'s success return to `kind="plain"` at compile time.
2. **Output scrubbing.** Stdout and stderr captured by `run_with_secrets` are post-processed: any literal secret value of length ≥ 4 is replaced with `[REDACTED:NAME]`. This catches accidents like `echo $STRIPE_KEY`.
3. **Error sanitization.** Errors from `run_with_secrets` are constructed from key names and exception types only — never from values.

**Touch ID gate.** `run_with_secrets` prompts for Touch ID **once per server process**, only when at least one `kind="secret"` value is injected. Plain-only invocations never prompt. Subsequent secret-using calls in the same session are gate-free.

**Auto-refusal on save.** `save_env` refuses `kind="plain"` when the name matches the secret-hint pattern (`KEY`, `TOKEN`, `SECRET`, `PASS`, `PWD`, `CRED`, `AUTH`). This prevents a later `get_plain` from leaking a value that was misclassified at save time.

See [SECURITY.md](SECURITY.md) for the full threat model and reporting policy.

## Tools

| Tool | Returns values? | Description |
|---|---|---|
| `save_env(name, value, kind)` | no | Store/update a `plain` or `secret` entry. Refuses `kind="plain"` for secret-looking names. |
| `list_envs()` | no | All entries with name, kind, `created_at`, `updated_at`. Values never included. |
| `find_envs(pattern)` | no | Case-insensitive substring search over names. Metadata only. |
| `get_plain(name)` | yes (plain only) | Returns the value; refuses if the entry is `kind="secret"`. |
| `delete_env(name)` | no | Remove from both index and Keychain. |
| `run_with_secrets(command, env_keys, cwd?, timeout?)` | yes (scrubbed stdout/stderr) | Run a shell command with selected values injected as env vars; output has literal secret values redacted. `timeout` is in seconds, default 60. |

## Resources

| Resource | URI | MIME | Description |
|---|---|---|---|
| Stored env names | `keychain://env-names` | `application/json` | Sorted unique array of stored env names. Re-read on every access. No values, kinds, or timestamps. Counterpart to `list_envs` for clients that prefer resource subscriptions over tool calls. |

The server also embeds a name snapshot in its MCP `initialize` instructions, so the LLM sees what's stored at handshake without an extra round-trip.

## Quickstart examples

Store a plain value:

```json
{"name":"save_env","arguments":{"name":"BACKEND_URL","value":"https://api.example.com","kind":"plain"}}
```

Store a secret (refused if you mistakenly pass `kind="plain"`):

```json
{"name":"save_env","arguments":{"name":"STRIPE_API_KEY","value":"sk_live_...","kind":"secret"}}
```

Read a plain value back:

```json
{"name":"get_plain","arguments":{"name":"BACKEND_URL"}}
```

Use a secret in a command (Touch ID prompts on first use of the session; `sk_live_...` is replaced with `[REDACTED:STRIPE_API_KEY]` in the returned stdout):

```json
{"name":"run_with_secrets","arguments":{"command":"curl -H \"Authorization: Bearer $STRIPE_API_KEY\" $BACKEND_URL/v1/charges","env_keys":["BACKEND_URL","STRIPE_API_KEY"]}}
```

## Develop locally

```bash
git clone https://github.com/oleander/mcp-env-keychain.git
cd mcp-env-keychain
bun install
bun run start
```

## Commands

```bash
bun run start      # run server
bun test           # test suite
bun run typecheck  # tsc --noEmit
bun run lint       # biome check
bun run compile    # compile to dist/mcp-env-keychain
```

## Releases

Pushing a tag like `v0.2.1` triggers the `Release` GitHub Actions workflow, which verifies the package, builds a precompiled macOS binary, uploads `mcp-env-keychain-macos-<arch>.tar.gz` to the GitHub release, and publishes `@oleander/mcp-env-keychain` to GitHub Packages. Manual release runs from `main` bump `package.json` (`patch`, `minor`, or `major`), commit the version bump, and create the matching GitHub release tag.

## Troubleshooting

- **No Touch ID prompt appears.** Touch ID is requested only when `run_with_secrets` injects at least one `secret` key. Plain-only runs do not prompt.
- **Prompt appears only once.** Expected; unlock is cached for the server process/session lifetime.
- **`bun: command not found`.** Install Bun and ensure it is on `PATH`.
- **GitHub Packages install returns 401/403.** Run `gh auth status` and confirm the active token has `read:packages` or `write:packages`, then run `npm config set //npm.pkg.github.com/:_authToken "$(gh auth token)"`.
- **`get_plain` refuses a key.** The entry was saved as `secret`; use `run_with_secrets`.
- **Index path in tests/automation.** Set `K_MCP_INDEX_PATH` to point at a custom index file.

## License

MIT — see [LICENSE](LICENSE).
