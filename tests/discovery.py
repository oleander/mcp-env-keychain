"""Tests for discovery-at-handshake: dynamic instructions + catalog resource.

Two layers verified:
  1. _build_instructions() includes a catalog snapshot of the current index.
  2. The keychain://catalog resource is registered, listed, and readable
     via the MCP protocol — and never returns values.
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

_tmp = Path(tempfile.mkdtemp(prefix="k-mcp-discovery-"))
import k_mcp.server as srv  # noqa: E402

srv.INDEX_PATH = _tmp / "index.json"
srv._session_unlocked = True

from fastmcp import Client  # noqa: E402


def expect(cond: bool, msg: str) -> None:
    if not cond:
        print(f"FAIL: {msg}", file=sys.stderr)
        sys.exit(1)
    print(f"  ok: {msg}")


# --- Layer 1: _build_instructions() function-level ---

print("== instructions when index is empty ==")
inst = srv._build_instructions()
expect("no envs stored yet" in inst, "empty-index instructions say 'no envs stored yet'")
expect("keychain://catalog" in inst, "instructions point to the resource")

print("== instructions reflect current index when populated ==")
srv.save_env("DEMO_URL", "https://demo.test", "plain")
srv.save_env("DEMO_SECRET", "live_dont_leak_qqq", "secret")

inst = srv._build_instructions()
expect("DEMO_URL" in inst, "instructions list DEMO_URL")
expect("kind=plain" in inst, "instructions include kind=plain")
expect("DEMO_SECRET" in inst, "instructions list DEMO_SECRET")
expect("kind=secret" in inst, "instructions include kind=secret")
expect("live_dont_leak_qqq" not in inst, "secret VALUE absent from instructions")


# --- Layer 2: protocol-exposed resource ---


def _unwrap_resource_content(read_result) -> dict:
    """Pull the JSON dict out of a CallResource response."""
    # FastMCP returns ReadResourceResult with .contents = list of TextResourceContents
    if hasattr(read_result, "contents"):
        contents = read_result.contents
    else:
        contents = read_result
    for c in contents:
        text = getattr(c, "text", None)
        if text:
            return json.loads(text)
    raise AssertionError(f"no text content in {read_result!r}")


async def proto_test() -> None:
    async with Client(srv.mcp) as client:
        print("== resources/list includes keychain://catalog ==")
        resources = await client.list_resources()
        uris = [str(r.uri) for r in resources]
        expect("keychain://catalog" in uris, f"catalog resource registered (got {uris})")

        cat = next(r for r in resources if str(r.uri) == "keychain://catalog")
        expect(cat.name == "Stored envs catalog", "resource has friendly name")
        expect("Never includes values" in (cat.description or ""), "description warns about no values")

        print("== read keychain://catalog returns current state ==")
        result = await client.read_resource("keychain://catalog")
        data = _unwrap_resource_content(result)
        names = {e["name"] for e in data["entries"]}
        expect({"DEMO_URL", "DEMO_SECRET"}.issubset(names), f"catalog lists both demo entries (got {names})")
        expect(data["count"] == 2, f"count matches (got {data['count']})")

        # Every entry has metadata; no values
        for e in data["entries"]:
            expect("kind" in e, f"entry {e['name']} has kind")
            expect("value" not in e, f"entry {e['name']} has NO value field")

        # Strongest: the secret value string is absent from the entire payload
        raw = json.dumps(data)
        expect("live_dont_leak_qqq" not in raw, "secret value absent from full catalog payload")

        print("== catalog refreshes after save_env mid-session ==")
        srv.save_env("DEMO_URL_2", "https://demo2.test", "plain")
        result2 = await client.read_resource("keychain://catalog")
        data2 = _unwrap_resource_content(result2)
        names2 = {e["name"] for e in data2["entries"]}
        expect("DEMO_URL_2" in names2, "fresh save reflected on next read")
        expect(data2["count"] == 3, "count updated")

        print("== catalog refreshes after delete_env mid-session ==")
        srv.delete_env("DEMO_URL_2")
        result3 = await client.read_resource("keychain://catalog")
        data3 = _unwrap_resource_content(result3)
        names3 = {e["name"] for e in data3["entries"]}
        expect("DEMO_URL_2" not in names3, "delete reflected on next read")
        expect(data3["count"] == 2, "count back to 2")


asyncio.run(proto_test())

# Clean up
srv.delete_env("DEMO_URL")
srv.delete_env("DEMO_SECRET")

print("\nDISCOVERY TESTS PASSED")
