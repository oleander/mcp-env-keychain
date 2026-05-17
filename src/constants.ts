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

export const DEFAULT_INDEX_PATH = join(
  homedir(),
  ".config",
  "mcp-keychain",
  "index.json",
);

export function resolveIndexPath(): string {
  const override = process.env.K_MCP_INDEX_PATH;
  return override && override.length > 0 ? override : DEFAULT_INDEX_PATH;
}
