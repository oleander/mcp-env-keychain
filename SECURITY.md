# Security Policy

This MCP server stores secrets in the macOS Keychain on behalf of an LLM client.
Vulnerability reports — especially anything that could leak a secret value into
a tool response, transcript, or log — are taken seriously.

## Reporting a vulnerability

Please **do not** open a public issue or PR for a suspected vulnerability.

Use GitHub's private vulnerability reporting:
<https://github.com/oleander/mcp-env-keychain/security/advisories/new>

Helpful to include:

- A description of the issue and its impact
- Minimal steps to reproduce
- Affected version (`mcp-env-keychain` git SHA or release tag)
- Whether the issue affects stored values, the Touch ID gate, or
  the `run_with_secrets` subprocess boundary

You should expect an acknowledgement within a few days. Public disclosure
will be coordinated through a security advisory.

## Threat model

This server is designed to run as a **local stdio process** spawned by an
MCP client (Claude Code, etc.) on the user's own machine. It accesses the
user's macOS login Keychain via the user's session. It is **not** intended
to be exposed over a network or run as a multi-user daemon.

**In scope**

- Secret values reaching the chat transcript via any tool response,
  resource, server `instructions`, log line, or error message
- Bypasses of the Touch ID session gate for `run_with_secrets`
- Argument-vector / `/proc` exposure of secret values during subprocess
  invocation
- Persistence of secrets outside the Keychain (filesystem, env vars
  written to disk, swap, etc.)
- Privilege escalation through `run_with_secrets` command construction

**Out of scope**

- An attacker who already controls the user's macOS account or shell
  session — that attacker can read the Keychain directly
- Issues in upstream dependencies (Bun, `@modelcontextprotocol/sdk`,
  zod, macOS itself) — please report those to the respective projects
- Denial of service of the local stdio process

## Supported versions

Only the latest published release on GitHub Packages is supported. If you
are on an older version, please update before reporting.
