import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ElicitRequestFormParams, ElicitResult } from "@modelcontextprotocol/sdk/types.js";
import type { KeychainBackend } from "../src/keychain.ts";
import { setIndexPath, setKeychainBackend } from "../src/keychain.ts";
import { setElicitFn } from "../src/tools.ts";
import { resetSession, setAuth } from "../src/touchid.ts";

export function makeMemoryKeychain(): KeychainBackend {
  const store = new Map<string, string>();
  return {
    async getPassword(name) {
      return store.get(name) ?? null;
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
  setAuth(async () => {});
  resetSession();
  // Clear any elicitation stub from a prior test.
  setElicitFn(null);
  return { indexFile, dir };
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
