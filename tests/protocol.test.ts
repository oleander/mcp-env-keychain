import { describe, expect, test, beforeEach } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { buildServer } from "../src/server.ts";
import { setupTestEnv } from "./helpers.ts";

async function makeClient(): Promise<Client> {
  const server = await buildServer();
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "mcp-env-keychain-test", version: "0.0.0" });
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  return client;
}

function unwrap(result: unknown): unknown {
  const r = result as {
    structuredContent?: unknown;
    content?: Array<{ type?: string; text?: string }>;
  };
  if (r.structuredContent !== undefined) return r.structuredContent;
  const first = r.content?.[0];
  if (first && first.type === "text" && typeof first.text === "string") {
    return JSON.parse(first.text);
  }
  return null;
}

describe("mcp-env-keychain tools (MCP protocol)", () => {
  beforeEach(() => {
    setupTestEnv();
  });

  test("all 6 tools are registered", async () => {
    const client = await makeClient();
    const { tools } = await client.listTools();
    const names = tools.map((t) => t.name).sort();
    expect(names).toEqual([
      "delete_env",
      "find_envs",
      "get_plain",
      "list_envs",
      "run_with_secrets",
      "save_env",
    ]);
    for (const t of tools) {
      expect(t.inputSchema).toBeDefined();
    }
  });

  test("save_env returns ok over protocol", async () => {
    const client = await makeClient();
    const r = unwrap(
      await client.callTool({
        name: "save_env",
        arguments: { name: "BACKEND_URL", value: "https://api.example.com", kind: "plain" },
      }),
    ) as { ok: boolean };
    expect(r.ok).toBe(true);
  });

  test("list_envs returns count, no values, over protocol", async () => {
    const client = await makeClient();
    await client.callTool({
      name: "save_env",
      arguments: { name: "BACKEND_URL", value: "https://api.example.com", kind: "plain" },
    });
    await client.callTool({
      name: "save_env",
      arguments: { name: "STRIPE_API_KEY", value: "sk_live_proto_x", kind: "secret" },
    });
    const r = unwrap(await client.callTool({ name: "list_envs", arguments: {} })) as {
      count: number;
      entries: Array<Record<string, unknown>>;
    };
    expect(r.count).toBe(2);
    for (const e of r.entries) expect("value" in e).toBe(false);
  });

  test("secret values NEVER appear in any part of the protocol-level response", async () => {
    const client = await makeClient();
    const SECRET = "sk_live_protoverysecret_xyz789";
    await client.callTool({
      name: "save_env",
      arguments: { name: "STRIPE_API_KEY", value: SECRET, kind: "secret" },
    });
    const full = await client.callTool({
      name: "run_with_secrets",
      arguments: { command: 'echo "$STRIPE_API_KEY"', env_keys: ["STRIPE_API_KEY"] },
    });
    const serialised = JSON.stringify(full);
    expect(serialised).not.toContain(SECRET);
  });

  test("scrubbing places [REDACTED:NAME] in stdout over protocol", async () => {
    const client = await makeClient();
    await client.callTool({
      name: "save_env",
      arguments: { name: "BACKEND_URL", value: "https://api.example.com", kind: "plain" },
    });
    await client.callTool({
      name: "save_env",
      arguments: { name: "STRIPE_API_KEY", value: "sk_live_proto_abcdef", kind: "secret" },
    });
    const r = unwrap(
      await client.callTool({
        name: "run_with_secrets",
        arguments: {
          command: 'echo "URL=$BACKEND_URL"; echo "OOPS=$STRIPE_API_KEY"',
          env_keys: ["BACKEND_URL", "STRIPE_API_KEY"],
        },
      }),
    ) as { ok: true; stdout: string };
    expect(r.ok).toBe(true);
    expect(r.stdout).toContain("https://api.example.com");
    expect(r.stdout).not.toContain("sk_live_proto_abcdef");
    expect(r.stdout).toContain("[REDACTED:STRIPE_API_KEY]");
  });

  test("get_plain refuses secret over protocol", async () => {
    const client = await makeClient();
    await client.callTool({
      name: "save_env",
      arguments: { name: "STRIPE_API_KEY", value: "sk_x", kind: "secret" },
    });
    const r = unwrap(
      await client.callTool({ name: "get_plain", arguments: { name: "STRIPE_API_KEY" } }),
    ) as { ok: boolean; error?: string };
    expect(r.ok).toBe(false);
    expect(r.error).toContain("refused");
  });

  test("delete_env returns ok over protocol", async () => {
    const client = await makeClient();
    await client.callTool({
      name: "save_env",
      arguments: { name: "BACKEND_URL", value: "u", kind: "plain" },
    });
    const r = unwrap(
      await client.callTool({ name: "delete_env", arguments: { name: "BACKEND_URL" } }),
    ) as { ok: boolean };
    expect(r.ok).toBe(true);
  });
});
