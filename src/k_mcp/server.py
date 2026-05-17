"""macOS Keychain MCP server for env secrets.

Two kinds of values:
- ``plain``   — URLs, hostnames, usernames. Retrievable via ``get_plain``.
- ``secret``  — API keys, tokens, passwords. Only usable via ``run_with_secrets``,
  which injects them into a subprocess environment but never returns the values
  themselves to the MCP transcript.
"""
from __future__ import annotations

import json
import os
import subprocess
from datetime import datetime, timezone
from pathlib import Path
from typing import Literal

import keyring
import keyring.errors
from fastmcp import FastMCP

from . import _security as _sec

SERVICE = "mcp-env"
# Index path can be overridden via env var (used by tests to point at a tempdir).
INDEX_PATH = Path(
    os.environ.get("K_MCP_INDEX_PATH")
    or (Path.home() / ".config" / "mcp-keychain" / "index.json")
)
SECRET_HINT_TOKENS = ("KEY", "SECRET", "TOKEN", "PASS", "PWD", "CRED", "AUTH")

# Session-scoped Touch ID gate. Once True, no further biometric prompts this
# session. Tests can set this to True directly to bypass the prompt.
_session_unlocked: bool = False

Kind = Literal["plain", "secret"]


def _load_index() -> dict:
    INDEX_PATH.parent.mkdir(parents=True, exist_ok=True)
    if not INDEX_PATH.exists():
        return {"entries": {}}
    return json.loads(INDEX_PATH.read_text())


_BASE_INSTRUCTIONS = (
    "Stores env values (URLs, API keys, tokens) in the macOS Keychain.\n"
    "- Plain values (kind='plain') are retrievable via get_plain.\n"
    "- Secret values (kind='secret') can ONLY be used via run_with_secrets,\n"
    "  which injects them into a subprocess env without exposing them in tool\n"
    "  output. Never request, print, or paraphrase secret values directly.\n"
    "- First time per session that run_with_secrets is asked to inject a\n"
    "  secret-kind value, the user is prompted for Touch ID. Subsequent\n"
    "  calls in the same session are gate-free.\n"
    "- A live catalog of stored envs is available as an MCP resource at\n"
    "  `keychain://catalog` — read it for fresh state without calling a tool."
)


def _build_instructions() -> str:
    """Compose server instructions including a snapshot of the catalog.

    This snapshot is the catalog at SERVER STARTUP. For live data within a
    session, read the ``keychain://catalog`` resource.
    """
    try:
        index = _load_index()
    except Exception:
        return _BASE_INSTRUCTIONS
    entries = sorted(index.get("entries", {}).items())
    if not entries:
        return _BASE_INSTRUCTIONS + "\n\nCatalog at handshake: (no envs stored yet)"
    lines = ["\n\nCatalog at handshake:"]
    for name, entry in entries:
        kind = entry.get("kind", "?")
        lines.append(f"  - {name} (kind={kind})")
    return _BASE_INSTRUCTIONS + "\n".join(lines)


mcp = FastMCP("k-mcp", instructions=_build_instructions())


def _ensure_unlocked(secret_names: list[str]) -> None:
    """Prompt Touch ID once per session before serving secret-kind values.

    Raises the underlying TouchID* exceptions on failure; callers translate
    them into tool-level error responses.
    """
    global _session_unlocked
    if _session_unlocked:
        return
    reason = (
        f"unlock {len(secret_names)} k-mcp "
        f"secret{'s' if len(secret_names) != 1 else ''} for this session"
    )
    _sec.authenticate(reason)
    _session_unlocked = True


def _save_index(index: dict) -> None:
    INDEX_PATH.parent.mkdir(parents=True, exist_ok=True)
    INDEX_PATH.write_text(json.dumps(index, indent=2, sort_keys=True))


def _now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def _looks_secret(name: str) -> bool:
    up = name.upper()
    return any(token in up for token in SECRET_HINT_TOKENS)


def _scrub(text: str, secrets: dict[str, str]) -> str:
    """Replace any literal secret values found in ``text`` with a marker.

    Defense-in-depth against ``echo $KEY``-style accidents. Only scrubs values
    of length >= 4 to avoid pathological false-positive replacements (a 1-char
    secret would match almost any output).
    """
    for name, value in secrets.items():
        if len(value) >= 4:
            text = text.replace(value, f"[REDACTED:{name}]")
    return text


def _catalog_payload() -> dict:
    """Build the catalog dict — names, kinds, timestamps. No values, ever."""
    index = _load_index()
    return {
        "count": len(index["entries"]),
        "entries": sorted(
            ({"name": n, **e} for n, e in index["entries"].items()),
            key=lambda x: x["name"],
        ),
    }


@mcp.resource(
    "keychain://catalog",
    name="Stored envs catalog",
    description=(
        "Live list of all stored env names, their kind (plain or secret), "
        "and creation/update timestamps. Never includes values. Reflects "
        "current state on every read."
    ),
    mime_type="application/json",
)
def keychain_catalog() -> dict:
    return _catalog_payload()


@mcp.tool
def save_env(name: str, value: str, kind: Kind) -> dict:
    """Store an env value in the macOS Keychain.

    Args:
        name: env var name (e.g. "STRIPE_API_KEY", "BACKEND_URL").
        value: the value to store.
        kind: "plain" for non-sensitive values (URLs, usernames), "secret" for
            credentials. The kind decides how the value can be retrieved later.

    If the name looks like a secret (contains KEY/TOKEN/SECRET/PASS/etc.) but
    kind="plain", the save is refused. This prevents the value from later being
    retrievable as plain text. Re-call with kind="secret".
    """
    name = (name or "").strip()
    if not name:
        return {"ok": False, "error": "name is required"}

    if kind == "plain" and _looks_secret(name):
        return {
            "ok": False,
            "error": (
                f"Refusing to save '{name}' as kind='plain' because the name "
                "looks like a secret. Re-call with kind='secret' (recommended), "
                "or rename it if it really is non-sensitive."
            ),
        }

    keyring.set_password(SERVICE, name, value)

    index = _load_index()
    entry = index["entries"].get(name, {})
    entry["kind"] = kind
    entry["updated_at"] = _now()
    entry.setdefault("created_at", entry["updated_at"])
    index["entries"][name] = entry
    _save_index(index)

    return {"ok": True, "name": name, "kind": kind}


@mcp.tool
def list_envs() -> dict:
    """List all stored env names with their kind and timestamps.

    Values are NEVER returned by this tool. This is the discovery surface:
    safe to call freely to see what's available.
    """
    index = _load_index()
    entries = sorted(
        ({"name": n, **e} for n, e in index["entries"].items()),
        key=lambda x: x["name"],
    )
    return {"count": len(entries), "entries": entries}


@mcp.tool
def find_envs(pattern: str) -> dict:
    """Search stored env names by case-insensitive substring.

    Returns matching names with their kind. Values are NEVER returned.
    """
    pat = (pattern or "").lower()
    index = _load_index()
    matches = sorted(
        (
            {"name": n, **e}
            for n, e in index["entries"].items()
            if pat in n.lower()
        ),
        key=lambda x: x["name"],
    )
    return {"pattern": pattern, "count": len(matches), "entries": matches}


@mcp.tool
def get_plain(name: str) -> dict:
    """Retrieve a plain (non-secret) env value.

    Refuses entries stored with kind='secret' — for those, use run_with_secrets.
    """
    index = _load_index()
    entry = index["entries"].get(name)
    if entry is None:
        return {"ok": False, "error": f"no env named '{name}'"}
    if entry.get("kind") != "plain":
        return {
            "ok": False,
            "error": (
                f"'{name}' is stored as kind='{entry.get('kind')}'. Plain "
                "retrieval is refused for secrets. Use run_with_secrets to "
                "use this value inside a command."
            ),
        }

    value = keyring.get_password(SERVICE, name)
    if value is None:
        return {
            "ok": False,
            "error": f"index has '{name}' but Keychain does not (out of sync)",
        }
    return {"ok": True, "name": name, "kind": "plain", "value": value}


@mcp.tool
def delete_env(name: str) -> dict:
    """Remove an env from both Keychain and the index."""
    index = _load_index()
    if name not in index["entries"]:
        return {"ok": False, "error": f"no env named '{name}'"}

    try:
        keyring.delete_password(SERVICE, name)
    except keyring.errors.PasswordDeleteError:
        pass  # already gone from Keychain; still drop the index entry

    del index["entries"][name]
    _save_index(index)
    return {"ok": True, "name": name}


@mcp.tool
def run_with_secrets(
    command: str,
    env_keys: list[str],
    cwd: str | None = None,
    timeout: int = 60,
) -> dict:
    """Run a shell command with named Keychain values injected as env vars.

    This is the ONLY way to use secret-kind values. Secret values are placed in
    the subprocess environment but MUST NEVER appear in this tool's return value
    — not in stdout passthrough, not in stderr, not in error messages.

    Args:
        command: shell command (executed via ``bash -lc``). Can reference any
            injected key as ``$KEY_NAME`` or ``${KEY_NAME}``.
        env_keys: env names to inject. Each must exist in the index. Both
            plain and secret kinds are allowed (plain values get the same
            treatment so callers don't have to care).
        cwd: working directory for the subprocess. Defaults to the server's cwd.
        timeout: max seconds the command may run. Defaults to 60.

    Returns:
        ``{"ok": bool, "exit_code": int, "stdout": str, "stderr": str,
           "injected_keys": [...]}``
        On error: ``{"ok": False, "error": str}`` with NO secret value text
        anywhere in the error.

    Example:
        run_with_secrets(
            command='curl -sS -H "Authorization: Bearer $STRIPE_KEY" '
                    'https://api.stripe.com/v1/charges?limit=1',
            env_keys=["STRIPE_KEY"],
        )

    The returned stdout/stderr are scrubbed of any literal secret values as
    defense-in-depth: even if a command accidentally echoes ``$STRIPE_KEY``,
    the chat transcript only sees ``[REDACTED:STRIPE_KEY]``.
    """
    if not command or not command.strip():
        return {"ok": False, "error": "command is required"}

    keys = list(dict.fromkeys(env_keys or []))  # dedupe, preserve order

    index = _load_index()
    unknown = [k for k in keys if k not in index["entries"]]
    if unknown:
        return {
            "ok": False,
            "error": (
                f"unknown env keys: {unknown}. Use list_envs to see what's "
                "stored."
            ),
        }

    # Gate Touch ID BEFORE we touch Keychain for any secret-kind key.
    secret_keys = [k for k in keys if index["entries"][k].get("kind") == "secret"]
    if secret_keys:
        try:
            _ensure_unlocked(secret_keys)
        except _sec.TouchIDNotAvailable as e:
            return {"ok": False, "error": f"Touch ID required but unavailable: {e}"}
        except _sec.TouchIDAuthFailed as e:
            return {"ok": False, "error": f"Touch ID required: {e}"}

    injected: dict[str, str] = {}
    secrets_only: dict[str, str] = {}  # subset of injected to scrub from output
    missing: list[str] = []
    for k in keys:
        v = keyring.get_password(SERVICE, k)
        if v is None:
            missing.append(k)
            continue
        injected[k] = v
        if index["entries"][k].get("kind") == "secret":
            secrets_only[k] = v
    if missing:
        return {
            "ok": False,
            "error": (
                f"keys in index but missing from Keychain (out of sync): "
                f"{missing}"
            ),
        }

    env = {**os.environ, **injected}

    try:
        result = subprocess.run(
            ["bash", "-lc", command],
            env=env,
            capture_output=True,
            text=True,
            timeout=timeout,
            cwd=cwd,
        )
    except subprocess.TimeoutExpired:
        return {
            "ok": False,
            "error": f"command exceeded timeout of {timeout}s",
            "injected_keys": keys,
        }
    except OSError as exc:
        # OSError messages come from Python's syscall wrapper — they describe
        # the failure (e.g. "No such file or directory" for a bad cwd) and
        # never contain env values.
        return {
            "ok": False,
            "error": f"failed to spawn subprocess: {exc.strerror or exc}",
            "injected_keys": keys,
        }

    return {
        "ok": True,
        "exit_code": result.returncode,
        "stdout": _scrub(result.stdout, secrets_only),
        "stderr": _scrub(result.stderr, secrets_only),
        "injected_keys": keys,
    }


def main() -> None:
    mcp.run()


if __name__ == "__main__":
    main()
