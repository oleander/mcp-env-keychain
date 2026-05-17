import { homedir } from "node:os";
import { join } from "node:path";

// Owner tag written into the Keychain item's `accountName` field for every
// entry we create. The `serviceName` field holds the env var name, so each
// entry shows distinctly in Keychain Access (Name column) and our entries
// are identifiable among others by the uniform Account column value.
export const OWNER = "mcp-env";

// Legacy layout used SERVICE as the keychain `serviceName` and the env name
// as `accountName`. Migration reads from the legacy layout on startup.
export const LEGACY_SERVICE = "mcp-env";

// Current on-disk index format version. Bumped when the layout changes.
export const INDEX_VERSION = 2;

export const SECRET_HINT_TOKENS = [
  "KEY",
  "SECRET",
  "TOKEN",
  "PASS",
  "PWD",
  "CRED",
  "AUTH",
] as const;

export const DEFAULT_INDEX_PATH = join(homedir(), ".config", "mcp-keychain", "index.json");

export function resolveIndexPath(): string {
  const override = process.env.K_MCP_INDEX_PATH;
  return override && override.length > 0 ? override : DEFAULT_INDEX_PATH;
}
