import { McpServer, ResourceTemplate } from "@modelcontextprotocol/sdk/server/mcp.js";
import * as z from "zod/v4";
import pkg from "../package.json" with { type: "json" };
import { loadIndex } from "./keychain.ts";
import { auditStalePrompt, importEnvFilePrompt } from "./prompts.ts";
import {
  catalogNamesPayload,
  deleteEnv,
  findEnvs,
  getEnvMetadata,
  getPlain,
  listEnvs,
  runWithSecrets,
  saveEnv,
  setElicitFn,
  setOnIndexChange,
} from "./tools.ts";
import {
  DeleteEnvOutput,
  FindEnvsOutput,
  GetPlainOutput,
  KindSchema,
  ListEnvsOutput,
  RunWithSecretsOutput,
  SaveEnvOutput,
} from "./types.ts";

const BASE_INSTRUCTIONS = [
  "Stores env values (URLs, API keys, tokens) in the macOS Keychain.",
  "- Plain values (kind='plain') are retrievable via get_plain.",
  "- Secret values (kind='secret') can ONLY be used via run_with_secrets,",
  "  which injects them into a subprocess env without exposing them in tool",
  "  output. Never request, print, or paraphrase secret values directly.",
  "- First time per session that run_with_secrets is asked to inject a",
  "  secret-kind value, the user is prompted for Touch ID. Subsequent",
  "  calls in the same session are gate-free.",
  "- Live resources:",
  "    `keychain://env-names`      — flat sorted list of names (legacy alias).",
  "    `keychain://env/{name}`     — per-env metadata (kind + timestamps, no value).",
  "  Clients can also enumerate via the resource template's list callback.",
].join("\n");

export async function buildInstructions(): Promise<string> {
  try {
    const index = await loadIndex();
    const entries = Object.entries(index.entries);

    // Bucket by kind, sort each by updated_at desc (most-recent first).
    const byKind: { plain: string[]; secret: string[] } = { plain: [], secret: [] };
    const sorted = entries.sort(([, a], [, b]) => b.updated_at.localeCompare(a.updated_at));
    for (const [name, entry] of sorted) {
      byKind[entry.kind].push(name);
    }

    // JSON-array form: machine-parseable, bucketed by kind, ordered by recency.
    // No truncation — full catalog is emitted on every handshake.
    const secretsLine = `Secrets (most recent first): ${JSON.stringify(byKind.secret)}`;
    const plainLine = `Plain (most recent first): ${JSON.stringify(byKind.plain)}`;
    return `${BASE_INSTRUCTIONS}\n\n${secretsLine}\n${plainLine}`;
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

  // Wire the index-change notifier so clients refresh their resource list
  // after save_env / delete_env. `sendResourceListChanged` is async, so we
  // attach a .catch to the returned promise — a sync try/catch would only
  // catch synchronous throws and leak transport-failure rejections.
  setOnIndexChange(() => {
    void Promise.resolve(server.sendResourceListChanged()).catch((e) => {
      // Server not yet connected to a transport, or transport disconnected
      // mid-call — fire-and-forget, surface to stderr only.
      console.error("mcp-env-keychain: sendResourceListChanged failed:", e);
    });
  });

  // Wire the elicitation seam to the underlying server's elicitInput. Tools
  // that call the seam get a real client interaction when the client supports
  // elicitation; the call rejects when it doesn't, and tools fall back to the
  // legacy refuse path.
  setElicitFn((params) => server.server.elicitInput(params));

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
      outputSchema: SaveEnvOutput,
      annotations: {
        idempotentHint: true,
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
      outputSchema: ListEnvsOutput,
      annotations: {
        readOnlyHint: true,
        idempotentHint: true,
      },
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
      outputSchema: FindEnvsOutput,
      annotations: {
        readOnlyHint: true,
        idempotentHint: true,
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
      outputSchema: GetPlainOutput,
      annotations: {
        readOnlyHint: true,
        idempotentHint: true,
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
      outputSchema: DeleteEnvOutput,
      annotations: {
        destructiveHint: true,
        idempotentHint: true,
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
      outputSchema: RunWithSecretsOutput,
      annotations: {
        openWorldHint: true,
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

  // ---- Resources ----
  //
  // Two surfaces over the same data:
  //   1) keychain://env/{name}   — parameterized template, returns metadata.
  //      The `list` callback enumerates the full catalog so clients can
  //      browse without a tool call. `complete.name` autocompletes from the
  //      current index.
  //   2) keychain://env-names    — legacy alias from v0.2.x, flat name array.

  server.registerResource(
    "keychain-env",
    new ResourceTemplate("keychain://env/{name}", {
      list: async () => {
        const names = await catalogNamesPayload();
        return {
          resources: names.map((name) => ({
            uri: `keychain://env/${encodeURIComponent(name)}`,
            name,
            mimeType: "application/json",
          })),
        };
      },
      complete: {
        name: async (value) => {
          const names = await catalogNamesPayload();
          const v = value.toLowerCase();
          return names.filter((n) => n.toLowerCase().startsWith(v));
        },
      },
    }),
    {
      title: "Stored env metadata",
      description:
        "Per-env metadata (name, kind, created_at, updated_at). Values are NEVER returned.",
      mimeType: "application/json",
    },
    async (uri, variables) => {
      const raw = variables.name;
      const name = Array.isArray(raw) ? (raw[0] ?? "") : (raw ?? "");
      // Defensive decode: percent-decode the template variable when possible,
      // but fall back to the raw value rather than failing the request when
      // the URI contains malformed escapes like `keychain://env/100%_SAFE`.
      let lookup = name;
      try {
        lookup = decodeURIComponent(name);
      } catch {
        // Malformed percent-encoding — use the literal segment so the lookup
        // returns a normal `ok: false` instead of a transport-level error.
      }
      const result = await getEnvMetadata(lookup);
      return {
        contents: [
          {
            uri: uri.href,
            mimeType: "application/json",
            text: JSON.stringify(result),
          },
        ],
      };
    },
  );

  server.registerResource(
    "keychain-env-names",
    "keychain://env-names",
    {
      title: "Stored env names (legacy alias)",
      description:
        "Live sorted unique array of stored env names only. " +
        "No values, kinds, or timestamps. Prefer the `keychain://env/{name}` template for richer access.",
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

  // ---- Prompts ----
  server.registerPrompt(
    importEnvFilePrompt.name,
    importEnvFilePrompt.config,
    importEnvFilePrompt.handler,
  );
  server.registerPrompt(auditStalePrompt.name, auditStalePrompt.config, auditStalePrompt.handler);

  return server;
}
