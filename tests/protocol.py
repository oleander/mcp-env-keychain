"""Protocol-level test: invokes every tool through FastMCP's MCP transport.

This proves the @mcp.tool decorators registered correctly, the JSON Schemas
generate, and the tool layer is reachable via the MCP protocol — not just
that the underlying Python functions work.
"""
from __future__ import annotations

import asyncio
import json
import sys
import tempfile
from pathlib import Path

import keyring
from keyring.backend import KeyringBackend


class _MemKeyring(KeyringBackend):
    priority = 1

    def __init__(self) -> None:
        self._store: dict[tuple[str, str], str] = {}

    def get_password(self, service, username):
        return self._store.get((service, username))

    def set_password(self, service, username, password):
        self._store[(service, username)] = password

    def delete_password(self, service, username):
        if (service, username) not in self._store:
            import keyring.errors
            raise keyring.errors.PasswordDeleteError(username)
        del self._store[(service, username)]


keyring.set_keyring(_MemKeyring())

_tmp = Path(tempfile.mkdtemp(prefix="k-mcp-proto-"))
import k_mcp.server as srv  # noqa: E402
srv.INDEX_PATH = _tmp / "index.json"
srv._session_unlocked = True  # bypass Touch ID for non-interactive tests

from fastmcp import Client  # noqa: E402


def expect(cond: bool, msg: str) -> None:
    if not cond:
        print(f"FAIL: {msg}", file=sys.stderr)
        sys.exit(1)
    print(f"  ok: {msg}")


def _unwrap(result):
    """FastMCP CallToolResult → the dict our tool returned.

    The structured content is in .data (preferred) or parsed from .content[0].text.
    """
    if getattr(result, "data", None) is not None:
        return result.data
    text = result.content[0].text
    return json.loads(text)


async def main() -> None:
    async with Client(srv.mcp) as client:
        print("== list_tools (protocol) ==")
        tools = await client.list_tools()
        names = sorted(t.name for t in tools)
        expected = ["delete_env", "find_envs", "get_plain", "list_envs", "run_with_secrets", "save_env"]
        expect(names == expected, f"all 6 tools registered: got {names}")

        for t in tools:
            expect(t.inputSchema is not None, f"{t.name} has an inputSchema")

        print("== save_env via protocol ==")
        r = _unwrap(await client.call_tool("save_env", {
            "name": "BACKEND_URL", "value": "https://api.example.com", "kind": "plain",
        }))
        expect(r["ok"] is True, "save_env returns ok")

        r = _unwrap(await client.call_tool("save_env", {
            "name": "STRIPE_API_KEY", "value": "sk_live_protoverysecret_xyz789", "kind": "secret",
        }))
        expect(r["ok"] is True, "save_env (secret) returns ok")

        print("== list_envs via protocol ==")
        r = _unwrap(await client.call_tool("list_envs", {}))
        expect(r["count"] == 2, "list_envs reports 2 entries")
        expect(all("value" not in e for e in r["entries"]), "no values in list_envs over protocol")

        print("== run_with_secrets via protocol (scrubbing) ==")
        r = _unwrap(await client.call_tool("run_with_secrets", {
            "command": 'echo "URL=$BACKEND_URL"; echo "OOPS=$STRIPE_API_KEY"',
            "env_keys": ["BACKEND_URL", "STRIPE_API_KEY"],
        }))
        expect(r["ok"] is True, "run_with_secrets ok over protocol")
        expect("https://api.example.com" in r["stdout"], "plain URL flows through")
        expect("sk_live_protoverysecret_xyz789" not in r["stdout"], "secret NEVER appears in stdout over protocol")
        expect("[REDACTED:STRIPE_API_KEY]" in r["stdout"], "secret redacted with marker over protocol")

        # Even the full CallToolResult serialization should not contain the secret
        full = await client.call_tool("run_with_secrets", {
            "command": 'echo "$STRIPE_API_KEY"',
            "env_keys": ["STRIPE_API_KEY"],
        })
        full_str = json.dumps({
            "data": full.data,
            "content": [c.text for c in full.content if hasattr(c, "text")],
        })
        expect("sk_live_protoverysecret_xyz789" not in full_str,
               "secret value absent from ENTIRE protocol-level response payload")

        print("== get_plain refuses secret via protocol ==")
        r = _unwrap(await client.call_tool("get_plain", {"name": "STRIPE_API_KEY"}))
        expect(r["ok"] is False and "refused" in r["error"], "get_plain refuses secret over protocol")

        print("== delete_env via protocol ==")
        r = _unwrap(await client.call_tool("delete_env", {"name": "BACKEND_URL"}))
        expect(r["ok"] is True, "delete_env ok")
        r = _unwrap(await client.call_tool("delete_env", {"name": "STRIPE_API_KEY"}))
        expect(r["ok"] is True, "delete_env (secret) ok")

    print("\nPROTOCOL CHECKS PASSED")


if __name__ == "__main__":
    asyncio.run(main())
