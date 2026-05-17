"""LIVE end-to-end test against the real installed binary and real macOS Keychain.

Drives the same command Claude Code spawns, calls every tool over real stdio
JSON-RPC, and writes/reads/deletes test entries in the actual Keychain.

Test entries used (deleted at end, even on failure):
  - k_mcp_smoke_url     (plain)
  - k_mcp_smoke_secret  (secret)
"""
from __future__ import annotations

import json
import subprocess
import sys
import time

CMD = [
    "/opt/homebrew/bin/uv", "run",
    "--project", "/Users/linus/Code/k-mcp", "k-mcp",
]
PLAIN_NAME = "k_mcp_smoke_url"
PLAIN_VALUE = "https://example.test/k-mcp-smoke"
SECRET_NAME = "k_mcp_smoke_secret"
SECRET_VALUE = f"k_mcp_smoke_value_{int(time.time())}_donotleak"


def jsonrpc(method, params=None, id_=None):
    msg = {"jsonrpc": "2.0", "method": method}
    if params is not None:
        msg["params"] = params
    if id_ is not None:
        msg["id"] = id_
    return json.dumps(msg) + "\n"


class Server:
    def __init__(self):
        self.proc = subprocess.Popen(
            CMD, stdin=subprocess.PIPE, stdout=subprocess.PIPE,
            stderr=subprocess.PIPE, text=True, bufsize=1,
        )
        self._id = 0

    def close(self):
        try:
            self.proc.stdin.close()
            self.proc.wait(timeout=5)
        except Exception:
            self.proc.kill()

    def _send(self, method, params=None, expect_response=True):
        if expect_response:
            self._id += 1
            payload = jsonrpc(method, params, id_=self._id)
        else:
            payload = jsonrpc(method, params)
        self.proc.stdin.write(payload)
        self.proc.stdin.flush()
        if not expect_response:
            return None
        want = self._id
        while True:
            line = self.proc.stdout.readline()
            if not line:
                err = self.proc.stderr.read()
                raise RuntimeError(f"server closed stdout. stderr:\n{err}")
            try:
                obj = json.loads(line)
            except json.JSONDecodeError:
                continue
            if obj.get("id") == want:
                return obj

    def initialize(self):
        r = self._send("initialize", {
            "protocolVersion": "2024-11-05",
            "capabilities": {},
            "clientInfo": {"name": "live-test", "version": "0.0.1"},
        })
        if "result" not in r:
            raise RuntimeError(f"init failed: {r}")
        self._send("notifications/initialized", {}, expect_response=False)

    def call(self, tool, args):
        r = self._send("tools/call", {"name": tool, "arguments": args})
        if "error" in r:
            return {"_protocol_error": r["error"]}
        # FastMCP returns structured content in result.structuredContent.
        sc = r["result"].get("structuredContent")
        if sc is not None:
            return sc
        # Fallback: parse text content
        for c in r["result"].get("content", []):
            if c.get("type") == "text":
                try:
                    return json.loads(c["text"])
                except json.JSONDecodeError:
                    return {"_text": c["text"]}
        return r["result"]


def expect(cond, msg):
    if not cond:
        print(f"FAIL: {msg}", file=sys.stderr)
        sys.exit(1)
    print(f"  ok: {msg}")


def main():
    print(f"Test secret value (should NEVER appear after this line): {SECRET_VALUE}")
    print("Note: scanning for this exact string in tool output below.\n")

    srv = Server()
    cleanup_done = False

    def cleanup():
        nonlocal cleanup_done
        if cleanup_done:
            return
        cleanup_done = True
        print("\n== cleanup ==")
        for name in (PLAIN_NAME, SECRET_NAME):
            r = srv.call("delete_env", {"name": name})
            print(f"  deleted {name}: ok={r.get('ok')}")
        srv.close()

    try:
        print("== initialize ==")
        srv.initialize()
        expect(True, "MCP handshake complete")

        # Pre-clean in case a prior aborted run left state
        srv.call("delete_env", {"name": PLAIN_NAME})
        srv.call("delete_env", {"name": SECRET_NAME})

        print("\n== save_env (plain) → real Keychain ==")
        r = srv.call("save_env", {
            "name": PLAIN_NAME, "value": PLAIN_VALUE, "kind": "plain",
        })
        expect(r.get("ok") is True, f"plain save ok (got {r})")

        print("== save_env (secret) → real Keychain ==")
        r = srv.call("save_env", {
            "name": SECRET_NAME, "value": SECRET_VALUE, "kind": "secret",
        })
        expect(r.get("ok") is True, f"secret save ok (got {r})")

        print("== list_envs ==")
        r = srv.call("list_envs", {})
        names = {e["name"] for e in r["entries"]}
        expect({PLAIN_NAME, SECRET_NAME}.issubset(names), "both test entries listed")
        expect(SECRET_VALUE not in json.dumps(r), "secret value absent from list_envs payload")

        print("== find_envs ==")
        r = srv.call("find_envs", {"pattern": "smoke"})
        match_names = {e["name"] for e in r["entries"]}
        expect({PLAIN_NAME, SECRET_NAME}.issubset(match_names), "find_envs matched both")
        expect(SECRET_VALUE not in json.dumps(r), "secret value absent from find_envs payload")

        print("== get_plain (plain) — should return URL ==")
        r = srv.call("get_plain", {"name": PLAIN_NAME})
        expect(r.get("ok") and r.get("value") == PLAIN_VALUE, "plain retrieved correctly")

        print("== get_plain (secret) — should refuse ==")
        r = srv.call("get_plain", {"name": SECRET_NAME})
        expect(not r.get("ok") and "refused" in r.get("error", ""), "get_plain refused secret")
        expect(SECRET_VALUE not in json.dumps(r), "secret value absent from refused-get payload")

        print("== run_with_secrets — echo + scrubbing ==")
        r = srv.call("run_with_secrets", {
            "command": f'echo "URL=$' + PLAIN_NAME + '"; '
                       f'echo "SHOULD_BE_REDACTED=$' + SECRET_NAME + '"',
            "env_keys": [PLAIN_NAME, SECRET_NAME],
        })
        expect(r.get("ok") is True, f"command succeeded (got {r.get('error')})")
        expect(PLAIN_VALUE in r["stdout"], "plain URL flows through to stdout")
        expect(SECRET_VALUE not in r["stdout"], "secret value NOT in stdout (real binary, real Keychain)")
        expect(f"[REDACTED:{SECRET_NAME}]" in r["stdout"], "secret was replaced with REDACTED marker")
        expect(SECRET_VALUE not in json.dumps(r), "secret value absent from ENTIRE run_with_secrets payload")

        print("== full-payload secret leak check across all replies ==")
        # Sanity: nothing we've returned contains the live secret value.
        # (The Python-side `SECRET_VALUE` is in this script's memory but we've never
        # passed it into a print/log after the initial banner.)
        print("  (verified per-call above)")

    finally:
        cleanup()

    print("\nLIVE TEST PASSED")


if __name__ == "__main__":
    main()
