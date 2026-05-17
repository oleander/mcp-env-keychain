import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import * as z from "zod/v4";
import pkg from "../package.json" with { type: "json" };
import { loadIndex } from "./keychain.ts";
import {
  catalogNamesPayload,
  deleteEnv,
  findEnvs,
  getPlain,
  listEnvs,
  runWithSecrets,
  saveEnv,
} from "./tools.ts";
import { KindSchema } from "./types.ts";

const BASE_INSTRUCTIONS = [
  "Stores env values (URLs, API keys, tokens) in the macOS Keychain.",
  "- Plain values (kind='plain') are retrievable via get_plain.",
  "- Secret values (kind='secret') can ONLY be used via run_with_secrets,",
  "  which injects them into a subprocess env without exposing them in tool",
  "  output. Never request, print, or paraphrase secret values directly.",
  "- First time per session that run_with_secrets is asked to inject a",
  "  secret-kind value, the user is prompted for Touch ID. Subsequent",
  "  calls in the same session are gate-free.",
  "- A live resource with stored env names is available at",
  "  `keychain://env-names` — read it for fresh state without calling a tool.",
].join("\n");

export async function buildInstructions(): Promise<string> {
  try {
    const index = await loadIndex();
    const entries = Object.entries(index.entries).sort(([a], [b]) => a.localeCompare(b));
    if (entries.length === 0) {
      return `${BASE_INSTRUCTIONS}\n\nEnv names at handshake: (no envs stored yet)`;
    }
    const lines = ["", "", "Env names at handshake:"];
    for (const [name] of entries) {
      lines.push(`  - ${name}`);
    }
    return BASE_INSTRUCTIONS + lines.join("\n");
  } catch {
    return BASE_INSTRUCTIONS;
  }
}

function toolText<T>(payload: T): {
  content: Array<{ type: "text"; text: string }>;
  structuredContent: T extends object ? T : { value: T };
  isError?: boolean;
} {
  const text = JSON.stringify(payload);
  const structured = (
    typeof payload === "object" && payload !== null ? payload : { value: payload }
  ) as T extends object ? T : { value: T };
  // isError on the MCP envelope means "tool itself failed" (think: exception).
  // Our Result<T>.ok=false cases are validation/expected outcomes — we surface
  // them via structuredContent.ok=false but DON'T set isError, so clients
  // (and the LLM) see a clean tool-call return.
  return { content: [{ type: "text", text }], structuredContent: structured };
}

export async function buildServer(): Promise<McpServer> {
  const instructions = await buildInstructions();
  const server = new McpServer(
    { name: "mcp-env-keychain", version: pkg.version },
    { instructions },
  );

  server.registerTool(
    "save_env",
    {
      description:
        "Store an env value in the macOS Keychain. " +
        "kind='plain' for non-sensitive (URLs, usernames), 'secret' for credentials. " +
        "If the name looks like a secret (KEY/TOKEN/SECRET/PASS/etc.) but kind='plain', the save is refused.",
      inputSchema: {
        name: z.string(),
        value: z.string(),
        kind: KindSchema,
      },
    },
    async (args) => toolText(await saveEnv(args)),
  );

  server.registerTool(
    "list_envs",
    {
      description:
        "List all stored env names with their kind and timestamps. Values are NEVER returned by this tool.",
      inputSchema: {},
    },
    async () => toolText(await listEnvs()),
  );

  server.registerTool(
    "find_envs",
    {
      description:
        "Search stored env names by case-insensitive substring. Returns matching names with their kind. Values are NEVER returned.",
      inputSchema: {
        pattern: z.string(),
      },
    },
    async ({ pattern }) => toolText(await findEnvs(pattern)),
  );

  server.registerTool(
    "get_plain",
    {
      description:
        "Retrieve a plain (non-secret) env value. Refuses entries stored with kind='secret' — for those, use run_with_secrets.",
      inputSchema: {
        name: z.string(),
      },
    },
    async ({ name }) => toolText(await getPlain(name)),
  );

  server.registerTool(
    "delete_env",
    {
      description: "Remove an env from both Keychain and the index.",
      inputSchema: {
        name: z.string(),
      },
    },
    async ({ name }) => toolText(await deleteEnv(name)),
  );

  server.registerTool(
    "run_with_secrets",
    {
      description:
        "Run a shell command with named Keychain values injected as env vars. " +
        "The ONLY way to use secret-kind values. Secret values are placed in the subprocess env but NEVER appear in this tool's return value. " +
        "Captured stdout/stderr are scrubbed of any literal secret values as defense-in-depth.",
      inputSchema: {
        command: z.string(),
        env_keys: z.array(z.string()),
        cwd: z.string().optional(),
        timeout: z.number().int().positive().optional(),
      },
    },
    async (args) =>
      toolText(
        await runWithSecrets({
          command: args.command,
          env_keys: args.env_keys,
          ...(args.cwd !== undefined ? { cwd: args.cwd } : {}),
          ...(args.timeout !== undefined ? { timeout: args.timeout } : {}),
        }),
      ),
  );

  server.registerResource(
    "keychain-env-names",
    "keychain://env-names",
    {
      title: "Stored env names",
      description:
        "Live sorted unique array of stored env names only. " +
        "No values, kinds, or timestamps. Reflects current state on every read.",
      mimeType: "application/json",
    },
    async (uri) => ({
      contents: [
        {
          uri: uri.href,
          mimeType: "application/json",
          text: JSON.stringify(await catalogNamesPayload()),
        },
      ],
    }),
  );

  return server;
}
