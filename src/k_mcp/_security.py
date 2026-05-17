"""macOS Touch ID UI gate via LocalAuthentication framework.

This is a *UI gate*, not a Keychain ACL: it prompts the user for Touch ID
(or Face ID, depending on the device) and returns whether authentication
succeeded. The actual Keychain items remain stored without biometric ACL —
this gate protects the server's code path, not the secret bytes at rest.

Why this design: setting a real biometric ACL on Keychain items
(``kSecAttrAccessControl`` with ``kSecAccessControlBiometryCurrentSet``)
requires the calling process to be code-signed with entitlements that the
``uv``-installed Python interpreter does not have. Without a signed wrapper
binary, the UI gate is the strongest Touch ID integration available.
"""
from __future__ import annotations

from typing import Any

from LocalAuthentication import (
    LAContext,
    LAPolicyDeviceOwnerAuthenticationWithBiometrics,
)


class TouchIDNotAvailable(RuntimeError):
    """Raised when the device has no Touch ID/Face ID configured."""


class TouchIDAuthFailed(RuntimeError):
    """Raised when the user cancels or fails the biometric prompt."""


def biometrics_available() -> bool:
    """Return True if the device can evaluate a biometrics policy right now."""
    ctx = LAContext.alloc().init()
    can, _ = ctx.canEvaluatePolicy_error_(
        LAPolicyDeviceOwnerAuthenticationWithBiometrics, None
    )
    return bool(can)


def authenticate(reason: str) -> None:
    """Prompt the user for Touch ID. Returns on success; raises on failure.

    The ``reason`` string is shown in the system prompt: "k-mcp is trying to
    {reason}". Keep it short and human.
    """
    if not biometrics_available():
        raise TouchIDNotAvailable(
            "Touch ID is not available or not configured on this device."
        )
    ctx = LAContext.alloc().init()
    ok, err = ctx.evaluatePolicy_localizedReason_error_(
        LAPolicyDeviceOwnerAuthenticationWithBiometrics, reason, None
    )
    if not ok:
        msg = err.localizedDescription() if err is not None else "unknown"
        raise TouchIDAuthFailed(f"Touch ID authentication failed: {msg}")
