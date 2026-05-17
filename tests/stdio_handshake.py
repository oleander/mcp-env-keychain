"""Spawn the EXACT command Claude Code spawns and drive it over stdio.

Sends MCP initialize + tools/list + resources/list, parses the JSON-RPC replies,
asserts that all tools and the catalog resource are exposed, and that the
dynamic instructions text includes the seeded catalog. Closes the last
verification gap: the deployment story works through the real stdio transport,
not just in-memory.
"""
from __future__ import annotations

import json
import os
import subprocess
import sys
import tempfile
from pathlib import Path

# Seed a test index pointed-to by K_MCP_INDEX_PATH so the spawned binary
# rebuilds instructions from this content.
_tmp = Path(tempfile.mkdtemp(prefix="k-mcp-stdio-"))
_index = _tmp / "index.json"
_index.write_text(json.dumps({
    "entries": {
        "STDIO_TEST_URL": {
            "kind": "plain",
            "created_at": "2026-01-01T00:00:00+00:00",
            "updated_at": "2026-01-01T00:00:00+00:00",
        },
        "STDIO_TEST_SECRET": {
            "kind": "secret",
            "created_at": "2026-01-01T00:00:00+00:00",
            "updated_at": "2026-01-01T00:00:00+00:00",
        },
    }
}))

CMD = [
    "/opt/homebrew/bin/uv",
    "run",
    "--project",
    "/Users/linus/Code/k-mcp",
    "k-mcp",
]
ENV = {**os.environ, "K_MCP_INDEX_PATH": str(_index)}


def jsonrpc(method: str, params: dict | None = None, id_: int | None = None) -> str:
    msg = {"jsonrpc": "2.0", "method": method}
    if params is not None:
        msg["params"] = params
    if id_ is not None:
        msg["id"] = id_
    return json.dumps(msg) + "\n"


def read_response(proc: subprocess.Popen, want_id: int) -> dict:
    """Read newline-delimited JSON until we see the response for ``want_id``."""
    while True:
        line = proc.stdout.readline()
        if not line:
            stderr = proc.stderr.read()
            print(f"FAIL: server closed stdout. stderr:\n{stderr}", file=sys.stderr)
            sys.exit(1)
        try:
            obj = json.loads(line)
        except json.JSONDecodeError:
            continue  # ignore non-JSON banner output
        if obj.get("id") == want_id:
            return obj


def expect(cond: bool, msg: str) -> None:
    if not cond:
        print(f"FAIL: {msg}", file=sys.stderr)
        sys.exit(1)
    print(f"  ok: {msg}")


def main() -> None:
    proc = subprocess.Popen(
        CMD,
        stdin=subprocess.PIPE,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
        bufsize=1,
        env=ENV,
    )

    try:
        # MCP initialize
        proc.stdin.write(jsonrpc("initialize", {
            "protocolVersion": "2024-11-05",
            "capabilities": {},
            "clientInfo": {"name": "stdio-test", "version": "0.0.1"},
        }, id_=1))
        proc.stdin.flush()

        init_resp = read_response(proc, want_id=1)
        expect("result" in init_resp, "initialize returned a result")
        server_name = init_resp["result"]["serverInfo"]["name"]
        expect(server_name == "k-mcp", f"server identifies as 'k-mcp' (got '{server_name}')")

        # Dynamic instructions: the seeded index must be reflected in the
        # initialize response text that the host hands to the LLM.
        instr = init_resp["result"].get("instructions", "") or ""
        expect("Catalog at handshake" in instr, "instructions include catalog section header")
        expect("STDIO_TEST_URL" in instr, "instructions include seeded plain entry name")
        expect("STDIO_TEST_SECRET" in instr, "instructions include seeded secret entry name")
        expect("kind=plain" in instr and "kind=secret" in instr, "instructions tag entries with kind")
        expect("keychain://catalog" in instr, "instructions point to the live resource")

        # initialized notification
        proc.stdin.write(jsonrpc("notifications/initialized", {}))
        proc.stdin.flush()

        # tools/list
        proc.stdin.write(jsonrpc("tools/list", {}, id_=2))
        proc.stdin.flush()

        tools_resp = read_response(proc, want_id=2)
        tools = tools_resp["result"]["tools"]
        names = sorted(t["name"] for t in tools)
        expected = ["delete_env", "find_envs", "get_plain", "list_envs", "run_with_secrets", "save_env"]
        expect(names == expected, f"6 tools listed: {names}")

        # Every tool has a non-empty input schema
        for t in tools:
            expect(
                "inputSchema" in t and "properties" in t["inputSchema"],
                f"{t['name']} has inputSchema with properties",
            )

        # run_with_secrets schema check — the param names matter for Claude
        rws = next(t for t in tools if t["name"] == "run_with_secrets")
        props = set(rws["inputSchema"].get("properties", {}).keys())
        expect(
            {"command", "env_keys"}.issubset(props),
            f"run_with_secrets exposes command + env_keys params (got {sorted(props)})",
        )

        # resources/list — catalog resource must be advertised
        proc.stdin.write(jsonrpc("resources/list", {}, id_=3))
        proc.stdin.flush()
        res_resp = read_response(proc, want_id=3)
        resources = res_resp["result"]["resources"]
        uris = [r["uri"] for r in resources]
        expect("keychain://catalog" in uris, f"catalog resource listed (got {uris})")

        # resources/read — catalog content must reflect seeded index
        proc.stdin.write(jsonrpc("resources/read", {"uri": "keychain://catalog"}, id_=4))
        proc.stdin.flush()
        read_resp = read_response(proc, want_id=4)
        contents = read_resp["result"]["contents"]
        text = next(c["text"] for c in contents if "text" in c)
        data = json.loads(text)
        names = {e["name"] for e in data["entries"]}
        expect({"STDIO_TEST_URL", "STDIO_TEST_SECRET"}.issubset(names),
               f"catalog contents include seeded entries (got {names})")
        expect(all("value" not in e for e in data["entries"]),
               "catalog entries carry no 'value' field")

        print("\nSTDIO HANDSHAKE PASSED")
    finally:
        proc.stdin.close()
        try:
            proc.wait(timeout=5)
        except subprocess.TimeoutExpired:
            proc.kill()


if __name__ == "__main__":
    main()
