"""Tests for the Touch ID gate behavior — without ever actually prompting.

Mocks ``_security.authenticate`` to count calls and simulate success/failure.
Verifies:
  - plain-only run_with_secrets does NOT call authenticate
  - secret-touching run_with_secrets calls authenticate exactly once per session
  - on failure, run_with_secrets returns a clean error and the secret never reaches the env
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

_tmp = Path(tempfile.mkdtemp(prefix="k-mcp-touchid-"))
import k_mcp.server as srv  # noqa: E402
from k_mcp import _security as _sec  # noqa: E402

srv.INDEX_PATH = _tmp / "index.json"


def expect(cond: bool, msg: str) -> None:
    if not cond:
        print(f"FAIL: {msg}", file=sys.stderr)
        sys.exit(1)
    print(f"  ok: {msg}")


# Counter + controllable success/failure
class FakeAuth:
    def __init__(self) -> None:
        self.calls: list[str] = []
        self.should_succeed = True
        self.failure_kind: type | None = None

    def __call__(self, reason: str) -> None:
        self.calls.append(reason)
        if self.should_succeed:
            return
        kind = self.failure_kind or _sec.TouchIDAuthFailed
        raise kind("simulated")


fake = FakeAuth()
_sec.authenticate = fake  # type: ignore[assignment]


def reset_session() -> None:
    """Reset session-unlocked flag + auth call counter between scenarios."""
    srv._session_unlocked = False
    fake.calls.clear()
    fake.should_succeed = True
    fake.failure_kind = None


# Seed the keychain with one plain and one secret
srv.save_env("PLAIN_URL", "https://x.test", "plain")
srv.save_env("SECRET_KEY", "live_dont_leak_zzzz1111", "secret")

print("== plain-only run does NOT prompt ==")
reset_session()
r = srv.run_with_secrets('echo "$PLAIN_URL"', ["PLAIN_URL"])
expect(r["ok"], "plain-only run succeeded")
expect(len(fake.calls) == 0, f"no auth prompt for plain-only run (calls={fake.calls})")
expect(srv._session_unlocked is False, "session stays locked after plain-only run")

print("== secret-touching run prompts exactly once ==")
reset_session()
r = srv.run_with_secrets('echo "$SECRET_KEY"', ["SECRET_KEY"])
expect(r["ok"], "secret run succeeded after auth")
expect(len(fake.calls) == 1, f"auth prompted once (calls={fake.calls})")
expect(srv._session_unlocked is True, "session is now unlocked")
expect("[REDACTED:SECRET_KEY]" in r["stdout"], "scrubbing still works post-auth")

print("== second secret-touching run in same session is gate-free ==")
r = srv.run_with_secrets('echo "$SECRET_KEY"', ["SECRET_KEY"])
expect(r["ok"], "second run succeeded")
expect(len(fake.calls) == 1, f"NO second prompt (still {len(fake.calls)} call)")

print("== auth failure returns clean error, no secret leaks ==")
reset_session()
fake.should_succeed = False
fake.failure_kind = _sec.TouchIDAuthFailed
r = srv.run_with_secrets('echo "$SECRET_KEY"', ["SECRET_KEY"])
expect(not r["ok"], "auth failure surfaces as not-ok")
expect("Touch ID required" in r["error"], f"error mentions Touch ID (got: {r['error']!r})")
expect("live_dont_leak_zzzz1111" not in str(r), "secret value absent from refused response")

print("== auth unavailable returns clean error ==")
reset_session()
fake.should_succeed = False
fake.failure_kind = _sec.TouchIDNotAvailable
r = srv.run_with_secrets('echo "$SECRET_KEY"', ["SECRET_KEY"])
expect(not r["ok"], "unavailable surfaces as not-ok")
expect("unavailable" in r["error"].lower(), "error mentions unavailable")

print("== mixed run: plain + secret triggers ONE prompt ==")
reset_session()
r = srv.run_with_secrets(
    'echo "$PLAIN_URL"; echo "$SECRET_KEY"',
    ["PLAIN_URL", "SECRET_KEY"],
)
expect(r["ok"], "mixed run succeeded")
expect(len(fake.calls) == 1, "one prompt for the mixed run")
expect("https://x.test" in r["stdout"], "plain value flowed through")
expect("[REDACTED:SECRET_KEY]" in r["stdout"], "secret scrubbed")

print("\nTOUCH ID GATE TESTS PASSED")
