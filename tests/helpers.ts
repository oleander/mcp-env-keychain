import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  ElicitRequestFormParams,
  ElicitResult,
} from "@modelcontextprotocol/sdk/types.js";
import type { KeychainBackend } from "../src/keychain.ts";
import {
  setKeychainBackend,
  setIndexPath,
} from "../src/keychain.ts";
import { setAuth, resetSession } from "../src/touchid.ts";
import { setElicitFn, setOnIndexChange } from "../src/tools.ts";

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

export function setupTestEnv(): { indexFile: string; dir: string } {
  const dir = mkdtempSync(join(tmpdir(), "mcp-env-keychain-test-"));
  const indexFile = join(dir, "index.json");
  setIndexPath(indexFile);
  setKeychainBackend(makeMemoryKeychain());
  let authCalls = 0;
  setAuth(async () => {
    authCalls += 1;
  });
  resetSession();
  // Clear cross-test state on the discoverability seams so a prior test's
  // stubs never leak.
  setElicitFn(null);
  setOnIndexChange(null);
  return { indexFile, dir };
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

// Wires a stub elicitation function. The supplied responder receives the
// elicitInput params and decides what to return — tests can model accept,
// decline, cancel, or "client lacks capability" (throw).
export function installElicitStub(
  responder: (params: ElicitRequestFormParams) => Promise<ElicitResult> | ElicitResult,
): { calls: () => number; lastParams: () => ElicitRequestFormParams | null } {
  let n = 0;
  let last: ElicitRequestFormParams | null = null;
  setElicitFn(async (params) => {
    n += 1;
    last = params;
    return await responder(params);
  });
  return {
    calls: () => n,
    lastParams: () => last,
  };
}

// Wires a stub sendResourceListChanged notifier and returns a call counter.
export function installListChangedCounter(): { calls: () => number; reset: () => void } {
  let n = 0;
  setOnIndexChange(() => {
    n += 1;
  });
  return {
    calls: () => n,
    reset: () => {
      n = 0;
    },
  };
}
