"""Spawn the EXACT command Claude Code spawns and drive it over stdio.

Sends MCP initialize + tools/list, parses the JSON-RPC replies, asserts that
all 6 tools are exposed with input schemas. Closes the last verification gap:
the deployment story works through the real stdio transport, not just in-memory.
"""
from __future__ import annotations

import json
import subprocess
import sys


CMD = [
    "/opt/homebrew/bin/uv",
    "run",
    "--project",
    "/Users/linus/Code/k-mcp",
    "k-mcp",
]


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

        print("\nSTDIO HANDSHAKE PASSED")
    finally:
        proc.stdin.close()
        try:
            proc.wait(timeout=5)
        except subprocess.TimeoutExpired:
            proc.kill()


if __name__ == "__main__":
    main()
