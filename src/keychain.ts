import { dlopen, FFIType, type Pointer, ptr, read, toArrayBuffer } from "bun:ffi";
import { randomBytes } from "node:crypto";
import {
  closeSync,
  copyFileSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  renameSync,
  unlinkSync,
} from "node:fs";
import { dirname } from "node:path";
import { resolveIndexPath, SECRET_HINT_TOKENS, SERVICE } from "./constants.ts";
import { type Index, IndexSchema } from "./types.ts";

export interface KeychainBackend {
  getPassword(name: string): Promise<string | null>;
  setPassword(name: string, value: string): Promise<void>;
  deletePassword(name: string): Promise<void>;
}

// Default backend: Security.framework via bun:ffi.
//
// We use the legacy SecKeychainItem* API (deprecated since 10.10 but still
// functional on every shipping macOS) rather than the modern SecItem* API
// because the legacy calls take simple C-string + length args, while SecItem*
// requires constructing a CFDictionary of CFString/CFData values per call.
// Upgrade path if Apple ever ships the deprecation: bind SecItem{Add,Copy,
// Update,Delete} + CFDictionaryCreate + CFStringCreateWithBytes + CFDataCreate
// and the kSec* constants via dlsym (same pattern as _NSConcreteStackBlock).
//
// Why this matters over the `security` CLI: the CLI requires the secret value
// as an argv element (`security add-generic-password -w VALUE`), so a `ps`
// snapshot during the call can observe it. The framework path passes the
// value as a pointer to a per-process buffer, so it's never on any other
// process's view.

const SEC_LIB = "/System/Library/Frameworks/Security.framework/Security";
const CF_LIB = "/System/Library/Frameworks/CoreFoundation.framework/CoreFoundation";

const errSecSuccess = 0;
const errSecItemNotFound = -25300;
const errSecDuplicateItem = -25299;

const sec = dlopen(SEC_LIB, {
  SecKeychainAddGenericPassword: {
    args: [
      FFIType.ptr,
      FFIType.u32,
      FFIType.ptr,
      FFIType.u32,
      FFIType.ptr,
      FFIType.u32,
      FFIType.ptr,
      FFIType.ptr,
    ],
    returns: FFIType.i32,
  },
  SecKeychainFindGenericPassword: {
    args: [
      FFIType.ptr,
      FFIType.u32,
      FFIType.ptr,
      FFIType.u32,
      FFIType.ptr,
      FFIType.ptr,
      FFIType.ptr,
      FFIType.ptr,
    ],
    returns: FFIType.i32,
  },
  SecKeychainItemModifyAttributesAndData: {
    args: [FFIType.ptr, FFIType.ptr, FFIType.u32, FFIType.ptr],
    returns: FFIType.i32,
  },
  SecKeychainItemDelete: {
    args: [FFIType.ptr],
    returns: FFIType.i32,
  },
  SecKeychainItemFreeContent: {
    args: [FFIType.ptr, FFIType.ptr],
    returns: FFIType.i32,
  },
});

const cf = dlopen(CF_LIB, {
  CFRelease: { args: [FFIType.ptr], returns: FFIType.void },
});

// Allocate an 8-byte slot to receive a pointer-sized out-parameter. The FFI
// callee writes into it; `readPtr` extracts a Pointer-usable handle.
// Bun's `read.ptr` returns `number` in its typings but the runtime value
// must be passed back into FFI ptr args, hence the cast.
function allocPtrSlot(): { buf: ArrayBuffer; addr: Pointer } {
  const buf = new ArrayBuffer(8);
  return { buf, addr: ptr(buf) };
}

function readPtr(slot: { addr: Pointer }): Pointer {
  return read.ptr(slot.addr, 0) as unknown as Pointer;
}

class SecurityFrameworkBackend implements KeychainBackend {
  async getPassword(name: string): Promise<string | null> {
    const service = Buffer.from(SERVICE);
    const account = Buffer.from(name);
    const passLenBuf = new ArrayBuffer(4);
    const passLenPtr = ptr(passLenBuf);
    const passData = allocPtrSlot();
    const itemRef = allocPtrSlot();

    const r = sec.symbols.SecKeychainFindGenericPassword(
      null,
      service.length,
      service,
      account.length,
      account,
      passLenPtr,
      passData.addr,
      itemRef.addr,
    );

    if (r === errSecItemNotFound) return null;
    if (r !== errSecSuccess) {
      throw new Error(`SecKeychainFindGenericPassword failed (OSStatus ${r})`);
    }

    const passLen = new DataView(passLenBuf).getUint32(0, true);
    const passDataPtr = readPtr(passData);
    const itemRefPtr = readPtr(itemRef);
    let value: string;
    try {
      const ab = toArrayBuffer(passDataPtr, 0, passLen);
      value = new TextDecoder().decode(ab);
    } finally {
      sec.symbols.SecKeychainItemFreeContent(null, passDataPtr);
      if (Number(itemRefPtr) !== 0) cf.symbols.CFRelease(itemRefPtr);
    }
    return value;
  }

  async setPassword(name: string, value: string): Promise<void> {
    const service = Buffer.from(SERVICE);
    const account = Buffer.from(name);
    const password = Buffer.from(value);

    let r = sec.symbols.SecKeychainAddGenericPassword(
      null,
      service.length,
      service,
      account.length,
      account,
      password.length,
      password,
      null,
    );

    if (r === errSecDuplicateItem) {
      // Item exists — find its ref, then modify the data field.
      const itemRef = allocPtrSlot();
      r = sec.symbols.SecKeychainFindGenericPassword(
        null,
        service.length,
        service,
        account.length,
        account,
        null,
        null,
        itemRef.addr,
      );
      if (r !== errSecSuccess) {
        throw new Error(`SecKeychainFindGenericPassword during upsert failed (OSStatus ${r})`);
      }
      const itemRefPtr = readPtr(itemRef);
      try {
        r = sec.symbols.SecKeychainItemModifyAttributesAndData(
          itemRefPtr,
          null,
          password.length,
          password,
        );
      } finally {
        if (Number(itemRefPtr) !== 0) cf.symbols.CFRelease(itemRefPtr);
      }
      if (r !== errSecSuccess) {
        throw new Error(`SecKeychainItemModifyAttributesAndData failed (OSStatus ${r})`);
      }
    } else if (r !== errSecSuccess) {
      // NEVER include `value` here — the err message must not leak it.
      throw new Error(`SecKeychainAddGenericPassword failed (OSStatus ${r})`);
    }
  }

  async deletePassword(name: string): Promise<void> {
    const service = Buffer.from(SERVICE);
    const account = Buffer.from(name);
    const itemRef = allocPtrSlot();

    let r = sec.symbols.SecKeychainFindGenericPassword(
      null,
      service.length,
      service,
      account.length,
      account,
      null,
      null,
      itemRef.addr,
    );
    if (r === errSecItemNotFound) return;
    if (r !== errSecSuccess) {
      throw new Error(`SecKeychainFindGenericPassword during delete failed (OSStatus ${r})`);
    }
    const itemRefPtr = readPtr(itemRef);
    try {
      r = sec.symbols.SecKeychainItemDelete(itemRefPtr);
    } finally {
      if (Number(itemRefPtr) !== 0) cf.symbols.CFRelease(itemRefPtr);
    }
    if (r !== errSecSuccess && r !== errSecItemNotFound) {
      throw new Error(`SecKeychainItemDelete failed (OSStatus ${r})`);
    }
  }
}

let backend: KeychainBackend = new SecurityFrameworkBackend();
export function setKeychainBackend(b: KeychainBackend): void {
  backend = b;
}
export function keychain(): KeychainBackend {
  return backend;
}

// Index file I/O.

let indexPathOverride: string | null = null;
export function setIndexPath(p: string | null): void {
  indexPathOverride = p;
}
function indexPath(): string {
  return indexPathOverride ?? resolveIndexPath();
}

export async function loadIndex(): Promise<Index> {
  const path = indexPath();
  mkdirSync(dirname(path), { recursive: true });
  if (!existsSync(path)) return { entries: {} };

  let parsed: unknown;
  try {
    parsed = await Bun.file(path).json();
  } catch (e) {
    return backupAndReset(path, "not valid JSON", e);
  }

  const result = IndexSchema.safeParse(parsed);
  if (!result.success) {
    return backupAndReset(path, "schema validation failed", result.error);
  }
  return result.data;
}

function backupAndReset(path: string, reason: string, err: unknown): Index {
  const ts = new Date().toISOString().replace(/[:.]/g, "-");
  const backup = `${path}.corrupt.${ts}`;
  try {
    copyFileSync(path, backup);
    console.error(
      `mcp-env-keychain: index ${reason} at ${path}; backed up to ${backup}. ` +
        `Starting with empty index. Cause: ${err instanceof Error ? err.message : String(err)}`,
    );
  } catch (copyErr) {
    console.error(
      `mcp-env-keychain: index ${reason} at ${path} and backup also failed (${copyErr instanceof Error ? copyErr.message : String(copyErr)}). ` +
        `Starting with empty index.`,
    );
  }
  return { entries: {} };
}

export async function saveIndex(index: Index): Promise<void> {
  const path = indexPath();
  mkdirSync(dirname(path), { recursive: true });
  // Stable serialization: sort entry keys so on-disk format matches Python's `sort_keys=True`.
  const sorted: Index = { entries: {} };
  for (const key of Object.keys(index.entries).sort()) {
    const entry = index.entries[key];
    if (entry !== undefined) sorted.entries[key] = entry;
  }
  const payload = JSON.stringify(sorted, null, 2);

  // Atomic write: write to a sibling temp file, fsync, then rename. Temp and
  // target live in the same directory so rename is atomic on POSIX. fsync
  // before rename means a crash mid-write can never produce a partial final
  // file (we'd just leave an orphan .tmp that the next load ignores).
  const tmp = `${path}.tmp.${process.pid}.${randomBytes(4).toString("hex")}`;
  try {
    await Bun.write(tmp, payload);
    const fd = openSync(tmp, "r+");
    try {
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    renameSync(tmp, path);
  } catch (e) {
    try {
      if (existsSync(tmp)) unlinkSync(tmp);
    } catch {
      // ignore — the orphan is harmless, it's not the final path
    }
    throw e;
  }
}

// Pure helpers — ported 1:1 from server.py.

// Single source of normalization. Every tool that takes an env name routes
// through this so " FOO " and "FOO" are the same lookup.
export function normalizeName(s: string): string {
  return s.trim();
}

export function looksSecret(name: string): boolean {
  const up = name.toUpperCase();
  return SECRET_HINT_TOKENS.some((tok) => up.includes(tok));
}

export function scrub(text: string, secrets: Record<string, string>): string {
  let out = text;
  for (const [name, value] of Object.entries(secrets)) {
    if (value.length >= 4) {
      out = out.split(value).join(`[REDACTED:${name}]`);
    }
  }
  return out;
}

// Python: datetime.now(timezone.utc).isoformat(timespec="seconds")
// produces: "2026-05-17T07:30:00+00:00"
export function now(): string {
  const d = new Date();
  const iso = d.toISOString(); // "2026-05-17T07:30:00.123Z"
  const noMillis = iso.replace(/\.\d{3}Z$/, ""); // "2026-05-17T07:30:00"
  return `${noMillis}+00:00`;
}
