import { dlopen, FFIType, suffix } from "bun:ffi";

export class TouchIDNotAvailable extends Error {}
export class TouchIDAuthFailed extends Error {}

// ---- Synchronous availability check via FFI (no callback) ----
//
// We use bun:ffi for the synchronous `canEvaluatePolicy:error:` check because
// it's cheap and reliable. The async `evaluatePolicy:localizedReason:reply:`
// path requires an Apple block, which means a JSCallback invoked from the
// libdispatch thread. In Bun 1.3.x that callback context resolves NO
// non-globalThis identifiers — even writes to globalThis from the main
// thread don't appear there (separate realm). So we run the actual prompt
// via a Swift one-liner piped to `swift -` instead.

const OBJC_LIB = `libobjc.A.${suffix}`;
const objcCore = dlopen(OBJC_LIB, {
  objc_getClass: { args: [FFIType.cstring], returns: FFIType.ptr },
  sel_registerName: { args: [FFIType.cstring], returns: FFIType.ptr },
});
const msgSend0 = dlopen(OBJC_LIB, {
  objc_msgSend: { args: [FFIType.ptr, FFIType.ptr], returns: FFIType.ptr },
}).symbols.objc_msgSend;
const msgSendI64PtrRetBool = dlopen(OBJC_LIB, {
  objc_msgSend: {
    args: [FFIType.ptr, FFIType.ptr, FFIType.i64, FFIType.ptr],
    returns: FFIType.bool,
  },
}).symbols.objc_msgSend;

const libSystem = dlopen(`libSystem.B.${suffix}`, {
  dlopen: { args: [FFIType.cstring, FFIType.i32], returns: FFIType.ptr },
});
// Load LocalAuthentication so objc_getClass("LAContext") resolves.
const RTLD_NOW = 2;
{
  const h = libSystem.symbols.dlopen(
    Buffer.from("/System/Library/Frameworks/LocalAuthentication.framework/LocalAuthentication\0"),
    RTLD_NOW,
  );
  if (h === null || Number(h) === 0) {
    throw new Error("Touch ID: failed to dlopen LocalAuthentication.framework");
  }
}

const LA_POLICY_DEVICE_OWNER_AUTH_WITH_BIOMETRICS = 1n;

export function biometricsAvailable(): boolean {
  try {
    const LAContext = objcCore.symbols.objc_getClass(Buffer.from("LAContext\0"));
    if (LAContext === null || Number(LAContext) === 0) return false;
    const allocSel = objcCore.symbols.sel_registerName(Buffer.from("alloc\0"));
    const initSel = objcCore.symbols.sel_registerName(Buffer.from("init\0"));
    const canEvalSel = objcCore.symbols.sel_registerName(Buffer.from("canEvaluatePolicy:error:\0"));
    const allocated = msgSend0(LAContext, allocSel);
    const ctx = msgSend0(allocated, initSel);
    if (ctx === null || Number(ctx) === 0) return false;
    return Boolean(
      msgSendI64PtrRetBool(ctx, canEvalSel, LA_POLICY_DEVICE_OWNER_AUTH_WITH_BIOMETRICS, null),
    );
  } catch {
    return false;
  }
}

// ---- Async authenticate() via `swift -` ----

const SWIFT_SCRIPT = `
import Foundation
import LocalAuthentication

let reason = CommandLine.arguments.dropFirst().joined(separator: " ")
let ctx = LAContext()
var err: NSError?
guard ctx.canEvaluatePolicy(.deviceOwnerAuthenticationWithBiometrics, error: &err) else {
    FileHandle.standardError.write(("UNAVAILABLE:" + (err?.localizedDescription ?? "unknown")).data(using: .utf8)!)
    exit(2)
}
let sem = DispatchSemaphore(value: 0)
var ok = false
var msg = ""
ctx.evaluatePolicy(.deviceOwnerAuthenticationWithBiometrics, localizedReason: reason) { success, error in
    ok = success
    if let e = error { msg = e.localizedDescription }
    sem.signal()
}
sem.wait()
if !ok {
    FileHandle.standardError.write(("FAILED:" + msg).data(using: .utf8)!)
    exit(1)
}
exit(0)
`;

// Cached availability check — `Bun.which` is cheap but no need to repeat.
let swiftPathCache: string | null | undefined;
function findSwift(): string | null {
  if (swiftPathCache === undefined) swiftPathCache = Bun.which("swift");
  return swiftPathCache;
}

async function swiftAuthenticate(reason: string): Promise<void> {
  if (findSwift() === null) {
    throw new TouchIDNotAvailable(
      "Touch ID requires the Swift toolchain (used to drive LAContext from a clean realm). " +
        "Install Xcode Command Line Tools and retry:\n  xcode-select --install",
    );
  }
  // swift - reads source from stdin and JIT-compiles. Cold start ~1-2s.
  const proc = Bun.spawn(["swift", "-", reason], {
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
  });
  proc.stdin.write(SWIFT_SCRIPT);
  await proc.stdin.end();

  const [stderr, exit] = await Promise.all([
    new Response(proc.stderr as ReadableStream<Uint8Array>).text(),
    proc.exited,
  ]);

  if (exit === 0) return;
  if (exit === 2) {
    const m = stderr.replace(/^UNAVAILABLE:/, "");
    throw new TouchIDNotAvailable(`Touch ID is not available: ${m || "unknown"}`);
  }
  const m = stderr.replace(/^FAILED:/, "");
  throw new TouchIDAuthFailed(`Touch ID authentication failed: ${m || "user cancelled or failed"}`);
}

// ---- Session gate ----

let sessionUnlocked = false;
type AuthFn = (reason: string) => Promise<void>;
let authFn: AuthFn = swiftAuthenticate;

export function setAuth(fn: AuthFn): void {
  authFn = fn;
}

export function resetSession(): void {
  sessionUnlocked = false;
}

export async function authenticate(reason: string): Promise<void> {
  await authFn(reason);
}

export async function ensureUnlocked(secretNames: string[]): Promise<void> {
  if (sessionUnlocked) return;
  const plural = secretNames.length === 1 ? "" : "s";
  const reason = `unlock ${secretNames.length} mcp-env-keychain secret${plural} for this session`;
  await authFn(reason);
  sessionUnlocked = true;
}
