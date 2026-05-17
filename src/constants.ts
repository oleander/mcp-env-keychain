import { homedir } from "node:os";
import { join } from "node:path";

export const SERVICE = "mcp-env";

export const SECRET_HINT_TOKENS = [
  "KEY",
  "SECRET",
  "TOKEN",
  "PASS",
  "PWD",
  "CRED",
  "AUTH",
] as const;

// Minimum length for a kind="secret" value. Matches the floor in `scrub()`
// (src/keychain.ts) — values shorter than this would echo back unredacted from
// run_with_secrets's captured output, so we refuse them at write time.
export const MIN_SECRET_LEN = 4;

export const DEFAULT_INDEX_PATH = join(homedir(), ".config", "mcp-keychain", "index.json");

export function resolveIndexPath(): string {
  const override = process.env.K_MCP_INDEX_PATH;
  return override && override.length > 0 ? override : DEFAULT_INDEX_PATH;
}
