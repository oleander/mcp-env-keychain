# mcp-env-keychain

MCP server for macOS that stores environment-variable values in the Keychain and lets an LLM use them safely. Values never leak into chat transcripts.

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

- `save_env(name, value, kind)`  
  Store/update an entry. Refuses `kind="plain"` when the name looks secret (e.g. contains `KEY`, `TOKEN`, `SECRET`, `PASS`, etc).
- `list_envs()`  
  Lists names, kinds, and timestamps only (never values).
- `find_envs(pattern)`  
  Case-insensitive name search, metadata only.
- `get_plain(name)`  
  Returns value only for entries stored as `kind="plain"`.
- `delete_env(name)`  
  Removes entry from index + Keychain.
- `run_with_secrets(command, env_keys, cwd?, timeout?)`  
  Runs a shell command with selected values injected as env vars.

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

Pushing a tag like `v0.2.1` triggers the `Release` GitHub Actions workflow, which verifies the package, builds a precompiled macOS binary, uploads `mcp-env-keychain-macos-<arch>.tar.gz` to the GitHub release, and publishes `@oleander/mcp-env-keychain` to GitHub Packages. Manual release runs from `main` bump `package.json` (`patch`, `minor`, or `major`), commit the version bump, and create the matching GitHub release tag.

## Troubleshooting

- **No Touch ID prompt appears:** Touch ID is requested only when `run_with_secrets` injects at least one `secret` key. Plain-only runs do not prompt.
- **Prompt appears only once:** This is expected; unlock is cached for the server process/session lifetime.
- **`bun: command not found`:** install Bun and ensure it is on `PATH`.
- **GitHub Packages install returns 401/403:** run `gh auth status` and confirm the active token has `read:packages` or `write:packages`, then run `npm config set //npm.pkg.github.com/:_authToken "$(gh auth token)"`.
- **`get_plain` refuses a key:** the entry was saved as `secret`; use `run_with_secrets`.
- **Index path in tests/automation:** set `K_MCP_INDEX_PATH` to point at a custom index file.
