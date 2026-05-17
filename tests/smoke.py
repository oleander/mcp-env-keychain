"""End-to-end smoke test for k-mcp.

Uses an in-memory keyring backend so we don't touch the real macOS Keychain
during testing. Redirects the index file to a tempdir so we don't pollute
``~/.config/mcp-keychain/``. Exercises every tool through its real entry point.
"""
from __future__ import annotations

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

# Redirect index to a tempdir BEFORE importing the server module
_tmp = Path(tempfile.mkdtemp(prefix="k-mcp-test-"))
import k_mcp.server as srv  # noqa: E402

srv.INDEX_PATH = _tmp / "index.json"
srv._session_unlocked = True  # bypass Touch ID for non-interactive tests


def expect(cond: bool, msg: str) -> None:
    if not cond:
        print(f"FAIL: {msg}", file=sys.stderr)
        sys.exit(1)
    print(f"  ok: {msg}")


print("== save_env (plain URL) ==")
r = srv.save_env("BACKEND_URL", "https://api.example.com", "plain")
expect(r["ok"], "saves plain URL")

print("== save_env (secret-named with kind=plain → refused) ==")
r = srv.save_env("STRIPE_API_KEY", "should_not_save", "plain")
expect(not r["ok"] and "looks like a secret" in r["error"], "refuses plain save of secret-named key")

print("== save_env (secret) ==")
r = srv.save_env("STRIPE_API_KEY", "sk_live_thisisverysecret_abc123", "secret")
expect(r["ok"], "saves secret")

print("== list_envs ==")
r = srv.list_envs()
expect(r["count"] == 2, "lists 2 entries")
names = [e["name"] for e in r["entries"]]
expect("BACKEND_URL" in names and "STRIPE_API_KEY" in names, "list contains both")
expect(all("value" not in e for e in r["entries"]), "list_envs returns no values")

print("== find_envs ==")
r = srv.find_envs("stripe")
expect(r["count"] == 1 and r["entries"][0]["name"] == "STRIPE_API_KEY", "case-insensitive substring match")
expect("value" not in r["entries"][0], "find_envs returns no values")

print("== get_plain (plain → OK) ==")
r = srv.get_plain("BACKEND_URL")
expect(r["ok"] and r["value"] == "https://api.example.com", "retrieves plain value")

print("== get_plain (secret → refused) ==")
r = srv.get_plain("STRIPE_API_KEY")
expect(not r["ok"] and "Plain retrieval is refused" in r["error"], "refuses to plain-get a secret")

print("== get_plain (missing → error) ==")
r = srv.get_plain("DOES_NOT_EXIST")
expect(not r["ok"] and "no env named" in r["error"], "missing env gives clean error")

print("== run_with_secrets (unknown key → refused) ==")
r = srv.run_with_secrets("echo hi", ["NOT_REAL"])
expect(not r["ok"] and "unknown env keys" in r["error"], "rejects unknown key")

print("== run_with_secrets (happy path, output scrubbing) ==")
r = srv.run_with_secrets(
    'echo "URL=$BACKEND_URL"; echo "OOPS=$STRIPE_API_KEY"',
    ["BACKEND_URL", "STRIPE_API_KEY"],
)
expect(r["ok"], "runs successfully")
expect(r["exit_code"] == 0, "exit code is 0")
expect("https://api.example.com" in r["stdout"], "plain value passes through to stdout")
expect("sk_live_thisisverysecret_abc123" not in r["stdout"], "SECRET VALUE NEVER appears in stdout")
expect("[REDACTED:STRIPE_API_KEY]" in r["stdout"], "secret was scrubbed with marker")
expect(r["injected_keys"] == ["BACKEND_URL", "STRIPE_API_KEY"], "injected_keys reflects what was used")

print("== run_with_secrets (timeout) ==")
r = srv.run_with_secrets("sleep 5", [], timeout=1)
expect(not r["ok"] and "timeout" in r["error"], "timeout returns error")

print("== run_with_secrets (non-zero exit) ==")
r = srv.run_with_secrets("exit 7", [])
expect(r["ok"] and r["exit_code"] == 7, "non-zero exit returned as exit_code, not as error")

print("== delete_env ==")
r = srv.delete_env("BACKEND_URL")
expect(r["ok"], "deletes plain")
r = srv.delete_env("STRIPE_API_KEY")
expect(r["ok"], "deletes secret")
r = srv.list_envs()
expect(r["count"] == 0, "index empty after both deletes")

print("\nALL CHECKS PASSED")
