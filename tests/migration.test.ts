import { beforeEach, describe, expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { type KeychainBackend, loadIndex, setKeychainBackend } from "../src/keychain.ts";
import type { Kind } from "../src/types.ts";
import { setupTestEnv } from "./helpers.ts";

// Dual-layout in-memory keychain: models both the legacy (service="mcp-env",
// account=name) and v2 (service=name, account="mcp-env") layouts so the
// migration code can be tested end-to-end without the FFI.
function makeDualLayoutKeychain(): {
  backend: KeychainBackend;
  seedLegacy: (name: string, value: string) => void;
  hasLegacy: (name: string) => boolean;
  hasV2: (name: string) => boolean;
  v2Value: (name: string) => string | null;
  v2Description: (name: string) => Kind | null;
} {
  const LEGACY = "mcp-env";
  const OWNER = "mcp-env";

  // Composite key: `${service}\x1f${account}` → value
  const values = new Map<string, string>();
  // Track kSecAttrDescription per v2 entry.
  const descriptions = new Map<string, Kind>();

  const legacyKey = (name: string) => `${LEGACY}\x1f${name}`;
  const v2Key = (name: string) => `${name}\x1f${OWNER}`;

  const backend: KeychainBackend = {
    async getPassword(name) {
      return values.get(v2Key(name)) ?? null;
    },
    async setPassword(name, value, kind) {
      values.set(v2Key(name), value);
      descriptions.set(name, kind);
    },
    async deletePassword(name) {
      values.delete(v2Key(name));
      descriptions.delete(name);
    },
    async migrateLegacyEntry(name, kind) {
      const k = legacyKey(name);
      const v = values.get(k);
      if (v === undefined) return false;
      values.set(v2Key(name), v);
      descriptions.set(name, kind);
      values.delete(k);
      return true;
    },
  };

  return {
    backend,
    seedLegacy: (name, value) => values.set(legacyKey(name), value),
    hasLegacy: (name) => values.has(legacyKey(name)),
    hasV2: (name) => values.has(v2Key(name)),
    v2Value: (name) => values.get(v2Key(name)) ?? null,
    v2Description: (name) => descriptions.get(name) ?? null,
  };
}

describe("legacy → v2 keychain layout migration", () => {
  let indexFile: string;
  let mock: ReturnType<typeof makeDualLayoutKeychain>;

  beforeEach(() => {
    ({ indexFile } = setupTestEnv());
    mock = makeDualLayoutKeychain();
    setKeychainBackend(mock.backend);
  });

  test("migrates entries from legacy layout to v2 and stamps version", async () => {
    // Plant legacy keychain rows for two entries.
    mock.seedLegacy("BACKEND_URL", "https://api.example.com");
    mock.seedLegacy("STRIPE_API_KEY", "sk_live_redacted_abc");
    // Plant an index file in the v1 shape (no `version` field).
    writeFileSync(
      indexFile,
      JSON.stringify({
        entries: {
          BACKEND_URL: {
            kind: "plain",
            created_at: "2026-05-01T00:00:00+00:00",
            updated_at: "2026-05-01T00:00:00+00:00",
          },
          STRIPE_API_KEY: {
            kind: "secret",
            created_at: "2026-05-01T00:00:00+00:00",
            updated_at: "2026-05-01T00:00:00+00:00",
          },
        },
      }),
    );

    const index = await loadIndex();

    expect(index.version).toBe(2);
    expect(mock.hasLegacy("BACKEND_URL")).toBe(false);
    expect(mock.hasLegacy("STRIPE_API_KEY")).toBe(false);
    expect(mock.v2Value("BACKEND_URL")).toBe("https://api.example.com");
    expect(mock.v2Value("STRIPE_API_KEY")).toBe("sk_live_redacted_abc");
    expect(mock.v2Description("BACKEND_URL")).toBe("plain");
    expect(mock.v2Description("STRIPE_API_KEY")).toBe("secret");

    // Persisted: re-reading the file shows the version field is now stamped.
    const onDisk = JSON.parse(await Bun.file(indexFile).text());
    expect(onDisk.version).toBe(2);
  });

  test("second load is a no-op (already at v2)", async () => {
    mock.seedLegacy("FOO", "bar");
    writeFileSync(
      indexFile,
      JSON.stringify({
        entries: {
          FOO: {
            kind: "plain",
            created_at: "2026-05-01T00:00:00+00:00",
            updated_at: "2026-05-01T00:00:00+00:00",
          },
        },
      }),
    );

    await loadIndex();
    expect(mock.hasV2("FOO")).toBe(true);

    // Manually overwrite the v2 value to detect spurious re-migration.
    await mock.backend.setPassword("FOO", "tampered", "plain");

    const second = await loadIndex();
    expect(second.version).toBe(2);
    expect(mock.v2Value("FOO")).toBe("tampered");
  });

  test("a fresh server (no existing index file) starts at v2", async () => {
    const index = await loadIndex();
    expect(index.version).toBe(2);
    expect(Object.keys(index.entries)).toEqual([]);
  });

  test("index entry with no matching legacy row migrates cleanly (no-op for that name)", async () => {
    mock.seedLegacy("FOO", "value");
    // BAR has an index entry but no legacy keychain row — migrateLegacyEntry
    // returns false; this still counts as a clean run.
    writeFileSync(
      indexFile,
      JSON.stringify({
        entries: {
          FOO: {
            kind: "plain",
            created_at: "2026-05-01T00:00:00+00:00",
            updated_at: "2026-05-01T00:00:00+00:00",
          },
          BAR: {
            kind: "secret",
            created_at: "2026-05-01T00:00:00+00:00",
            updated_at: "2026-05-01T00:00:00+00:00",
          },
        },
      }),
    );

    const index = await loadIndex();
    expect(index.version).toBe(2);
    expect(mock.hasLegacy("FOO")).toBe(false);
    expect(mock.v2Value("FOO")).toBe("value");
    expect(mock.hasV2("BAR")).toBe(false); // never had a legacy row
  });

  test("entry whose migrate throws leaves version unstamped so retry is possible", async () => {
    const throwingBackend: KeychainBackend = {
      ...mock.backend,
      async migrateLegacyEntry(name) {
        if (name === "BOOM") throw new Error("synthetic failure");
        return false;
      },
    };
    setKeychainBackend(throwingBackend);
    writeFileSync(
      indexFile,
      JSON.stringify({
        entries: {
          BOOM: {
            kind: "secret",
            created_at: "2026-05-01T00:00:00+00:00",
            updated_at: "2026-05-01T00:00:00+00:00",
          },
        },
      }),
    );

    const index = await loadIndex();
    expect(index.version).toBeUndefined();
    const onDisk = JSON.parse(await Bun.file(indexFile).text());
    expect(onDisk.version).toBeUndefined();
  });
});
