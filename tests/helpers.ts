import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { KeychainBackend } from "../src/keychain.ts";
import {
  setKeychainBackend,
  setIndexPath,
} from "../src/keychain.ts";
import { setAuth, resetSession } from "../src/touchid.ts";

export function makeMemoryKeychain(): KeychainBackend {
  const store = new Map<string, string>();
  return {
    async getPassword(name) {
      return store.has(name) ? store.get(name)! : null;
    },
    async setPassword(name, value) {
      store.set(name, value);
    },
    async deletePassword(name) {
      store.delete(name);
    },
  };
}

export function setupTestEnv(): { indexFile: string } {
  const dir = mkdtempSync(join(tmpdir(), "mcp-env-keychain-test-"));
  const indexFile = join(dir, "index.json");
  setIndexPath(indexFile);
  setKeychainBackend(makeMemoryKeychain());
  let authCalls = 0;
  setAuth(async () => {
    authCalls += 1;
  });
  resetSession();
  return { indexFile };
}

export function installAuthCounter(): { calls: () => number; reset: () => void } {
  let n = 0;
  setAuth(async () => {
    n += 1;
  });
  resetSession();
  return {
    calls: () => n,
    reset: () => {
      n = 0;
      resetSession();
    },
  };
}

export function installFailingAuth(message = "user cancelled"): void {
  setAuth(async () => {
    const { TouchIDAuthFailed } = await import("../src/touchid.ts");
    throw new TouchIDAuthFailed(message);
  });
  resetSession();
}
