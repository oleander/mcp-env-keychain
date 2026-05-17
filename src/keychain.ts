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
import {
  INDEX_VERSION,
  LEGACY_SERVICE,
  OWNER,
  resolveIndexPath,
  SECRET_HINT_TOKENS,
} from "./constants.ts";
import { type Index, IndexSchema, type Kind } from "./types.ts";

export interface KeychainBackend {
  getPassword(name: string): Promise<string | null>;
  setPassword(name: string, value: string, kind: Kind): Promise<void>;
  deletePassword(name: string): Promise<void>;
  // Migrate one entry from the legacy layout (service="mcp-env", account=name)
  // to the v2 layout (service=name, account="mcp-env") and set the description
  // attribute from `kind`. Returns true if a legacy entry was found and moved,
  // false if no legacy entry exists (already on v2 or never written).
  migrateLegacyEntry(name: string, kind: Kind): Promise<boolean>;
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

// SecKeychainAttribute tag for kSecDescriptionItemAttr = 'desc'.
// FourCharCode: bytes 'd','e','s','c' packed as a uint32 in native byte order.
const K_SEC_DESCRIPTION_ITEM_ATTR = 0x64657363;

// Build a SecKeychainAttributeList containing a single attribute for the
// item's description, holding the bytes of `kind` ("plain" or "secret").
// The returned `addr` is what's passed as the second arg to
// SecKeychainItemModifyAttributesAndData. `keepAlive` must be retained by
// the caller until the FFI call returns — releasing it earlier could let
// GC reclaim the backing memory the framework is reading from.
function buildDescriptionAttrList(kind: Kind): {
  addr: Pointer;
  keepAlive: { dataBuf: Buffer; attrBuf: ArrayBuffer; listBuf: ArrayBuffer };
} {
  const dataBuf = Buffer.from(kind);

  // SecKeychainAttribute: { tag: u32; length: u32; data: void* }  → 16 bytes
  const attrBuf = new ArrayBuffer(16);
  const attrView = new DataView(attrBuf);
  attrView.setUint32(0, K_SEC_DESCRIPTION_ITEM_ATTR, true);
  attrView.setUint32(4, dataBuf.length, true);
  attrView.setBigUint64(8, BigInt(ptr(dataBuf)), true);

  // SecKeychainAttributeList: { count: u32; attr: SecKeychainAttribute* }
  // 4-byte count + 4-byte padding (pointer must be 8-byte aligned) + 8-byte ptr = 16 bytes
  const listBuf = new ArrayBuffer(16);
  const listView = new DataView(listBuf);
  listView.setUint32(0, 1, true);
  listView.setBigUint64(8, BigInt(ptr(attrBuf)), true);

  return { addr: ptr(listBuf), keepAlive: { dataBuf, attrBuf, listBuf } };
}

// Perform a SecKeychainFindGenericPassword + (optional) read.
// Returns null if not found, throws on any other error.
function findPassword(
  service: Buffer,
  account: Buffer,
  wantValue: boolean,
): { value: string | null; itemRefPtr: Pointer | null } | null {
  const passLenBuf = new ArrayBuffer(4);
  const passLenPtr = wantValue ? ptr(passLenBuf) : null;
  const passData = wantValue ? allocPtrSlot() : null;
  const itemRef = allocPtrSlot();

  const r = sec.symbols.SecKeychainFindGenericPassword(
    null,
    service.length,
    service,
    account.length,
    account,
    passLenPtr,
    passData?.addr ?? null,
    itemRef.addr,
  );

  if (r === errSecItemNotFound) return null;
  if (r !== errSecSuccess) {
    throw new Error(`SecKeychainFindGenericPassword failed (OSStatus ${r})`);
  }

  const itemRefPtr = readPtr(itemRef);

  if (!wantValue || !passData) {
    return { value: null, itemRefPtr };
  }

  const passLen = new DataView(passLenBuf).getUint32(0, true);
  const passDataPtr = readPtr(passData);
  let value: string;
  try {
    const ab = toArrayBuffer(passDataPtr, 0, passLen);
    value = new TextDecoder().decode(ab);
  } finally {
    sec.symbols.SecKeychainItemFreeContent(null, passDataPtr);
  }
  return { value, itemRefPtr };
}

function modifyDescription(itemRefPtr: Pointer, kind: Kind, password: Buffer | null): void {
  const attrList = buildDescriptionAttrList(kind);
  const r = sec.symbols.SecKeychainItemModifyAttributesAndData(
    itemRefPtr,
    attrList.addr,
    password?.length ?? 0,
    password,
  );
  // `attrList.keepAlive` referenced here so GC can't reclaim its buffers
  // until the FFI call returns.
  void attrList.keepAlive;
  if (r !== errSecSuccess) {
    throw new Error(`SecKeychainItemModifyAttributesAndData failed (OSStatus ${r})`);
  }
}

function deleteItem(itemRefPtr: Pointer): void {
  const r = sec.symbols.SecKeychainItemDelete(itemRefPtr);
  if (r !== errSecSuccess && r !== errSecItemNotFound) {
    throw new Error(`SecKeychainItemDelete failed (OSStatus ${r})`);
  }
}

class SecurityFrameworkBackend implements KeychainBackend {
  async getPassword(name: string): Promise<string | null> {
    const service = Buffer.from(name);
    const account = Buffer.from(OWNER);
    const found = findPassword(service, account, true);
    if (!found) return null;
    try {
      return found.value;
    } finally {
      if (found.itemRefPtr && Number(found.itemRefPtr) !== 0) {
        cf.symbols.CFRelease(found.itemRefPtr);
      }
    }
  }

  async setPassword(name: string, value: string, kind: Kind): Promise<void> {
    const service = Buffer.from(name);
    const account = Buffer.from(OWNER);
    const password = Buffer.from(value);
    const itemRef = allocPtrSlot();

    const r = sec.symbols.SecKeychainAddGenericPassword(
      null,
      service.length,
      service,
      account.length,
      account,
      password.length,
      password,
      itemRef.addr,
    );

    if (r === errSecDuplicateItem) {
      // Existing entry — look up its ref, then update both value and description.
      const found = findPassword(service, account, false);
      if (!found || !found.itemRefPtr) {
        throw new Error("SecKeychainFindGenericPassword during upsert returned no itemRef");
      }
      try {
        modifyDescription(found.itemRefPtr, kind, password);
      } finally {
        if (Number(found.itemRefPtr) !== 0) cf.symbols.CFRelease(found.itemRefPtr);
      }
      return;
    }
    if (r !== errSecSuccess) {
      // NEVER include `value` here — the err message must not leak it.
      throw new Error(`SecKeychainAddGenericPassword failed (OSStatus ${r})`);
    }

    // Fresh insert — set the description attribute on the just-added item
    // (passing null/0 for password to leave value untouched).
    const itemRefPtr = readPtr(itemRef);
    if (Number(itemRefPtr) === 0) return; // best-effort: value is saved
    try {
      modifyDescription(itemRefPtr, kind, null);
    } finally {
      cf.symbols.CFRelease(itemRefPtr);
    }
  }

  async deletePassword(name: string): Promise<void> {
    const service = Buffer.from(name);
    const account = Buffer.from(OWNER);
    const found = findPassword(service, account, false);
    if (!found || !found.itemRefPtr) return;
    try {
      deleteItem(found.itemRefPtr);
    } finally {
      if (Number(found.itemRefPtr) !== 0) cf.symbols.CFRelease(found.itemRefPtr);
    }
  }

  async migrateLegacyEntry(name: string, kind: Kind): Promise<boolean> {
    const legacyService = Buffer.from(LEGACY_SERVICE);
    const legacyAccount = Buffer.from(name);
    const legacy = findPassword(legacyService, legacyAccount, true);
    if (!legacy) return false;

    try {
      if (legacy.value === null) {
        throw new Error("legacy entry returned no value during migration");
      }
      // Write under v2 layout first, then delete the legacy entry. If the
      // write fails we leave the legacy entry intact so no value is lost.
      await this.setPassword(name, legacy.value, kind);
      if (legacy.itemRefPtr && Number(legacy.itemRefPtr) !== 0) {
        deleteItem(legacy.itemRefPtr);
      }
      return true;
    } finally {
      if (legacy.itemRefPtr && Number(legacy.itemRefPtr) !== 0) {
        cf.symbols.CFRelease(legacy.itemRefPtr);
      }
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
  if (!existsSync(path)) return { version: INDEX_VERSION, entries: {} };

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

  const index = result.data;
  if (index.version !== INDEX_VERSION) {
    await runMigration(index);
  }
  return index;
}

// One-shot migration from the legacy layout (single shared service name) to
// the v2 layout (per-entry service name + description attribute). Runs once,
// stamps `version: INDEX_VERSION` into index.json on full success, then
// becomes a no-op. If any entry fails, the version stamp is withheld so the
// next startup retries — successful entries are idempotent on re-run because
// migrateLegacyEntry returns false when no legacy item exists.
async function runMigration(index: Index): Promise<void> {
  let allOk = true;
  for (const [name, entry] of Object.entries(index.entries)) {
    try {
      await backend.migrateLegacyEntry(name, entry.kind);
    } catch (e) {
      allOk = false;
      console.error(
        `mcp-env-keychain: failed to migrate '${name}' to v2 layout: ` +
          `${e instanceof Error ? e.message : String(e)}. Will retry on next startup.`,
      );
    }
  }
  if (allOk) {
    index.version = INDEX_VERSION;
    await saveIndex(index);
  }
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
  const sorted: Index = { version: index.version, entries: {} };
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
