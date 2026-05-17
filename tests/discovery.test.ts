import { beforeEach, describe, expect, test } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { buildInstructions, buildServer } from "../src/server.ts";
import { deleteEnv, saveEnv, setOnIndexChange } from "../src/tools.ts";
import { setupTestEnv } from "./helpers.ts";

async function makeClient(): Promise<Client> {
  const server = await buildServer();
  const [ct, st] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test", version: "0.0.0" });
  await server.connect(st);
  await client.connect(ct);
  return client;
}

describe("mcp-env-keychain discovery surfaces", () => {
  beforeEach(() => {
    setupTestEnv();
    // Clear any index-change subscriber lingering from another test.
    setOnIndexChange(null);
  });

  test("instructions emit JSON arrays bucketed by kind, no values", async () => {
    const PLAIN_VALUE = "https://distinctive-url-marker-2026.example.com";
    const SECRET_VALUE = "sk_distinctive_secret_marker_12345abcdef";
    await saveEnv({ name: "BACKEND_URL", value: PLAIN_VALUE, kind: "plain" });
    await saveEnv({ name: "STRIPE_API_KEY", value: SECRET_VALUE, kind: "secret" });
    const text = await buildInstructions();
    expect(text).toContain("Secrets (most recent first):");
    expect(text).toContain("Plain (most recent first):");
    expect(text).toContain('"STRIPE_API_KEY"');
    expect(text).toContain('"BACKEND_URL"');
    expect(text).not.toContain(PLAIN_VALUE);
    expect(text).not.toContain(SECRET_VALUE);
  });

  test("instructions handle empty catalog with empty arrays", async () => {
    const text = await buildInstructions();
    expect(text).toContain("Secrets (most recent first): []");
    expect(text).toContain("Plain (most recent first): []");
  });

  test("instructions sort each kind by updated_at desc (most recent first)", async () => {
    await saveEnv({ name: "OLDER_URL", value: "u1", kind: "plain" });
    // Force a clock tick so updated_at differs (ISO seconds precision).
    await new Promise((r) => setTimeout(r, 1100));
    await saveEnv({ name: "NEWER_URL", value: "u2", kind: "plain" });
    const text = await buildInstructions();
    const match = text.match(/Plain \(most recent first\): (\[.*\])/);
    if (match === null || match[1] === undefined) {
      throw new Error("expected plain bucket line in instructions");
    }
    const parsed = JSON.parse(match[1]) as string[];
    expect(parsed[0]).toBe("NEWER_URL");
    expect(parsed[1]).toBe("OLDER_URL");
  });

  test("keychain://env-names alias still returns the flat name array", async () => {
    const client = await makeClient();
    const empty = await client.readResource({ uri: "keychain://env-names" });
    const emptyFirst = empty.contents[0];
    if (
      emptyFirst === undefined ||
      !("text" in emptyFirst) ||
      typeof emptyFirst.text !== "string"
    ) {
      throw new Error("empty alias read returned no text content");
    }
    expect(JSON.parse(emptyFirst.text)).toEqual([]);

    await saveEnv({ name: "NEW_URL", value: "u", kind: "plain" });

    const filled = await client.readResource({ uri: "keychain://env-names" });
    const filledFirst = filled.contents[0];
    if (
      filledFirst === undefined ||
      !("text" in filledFirst) ||
      typeof filledFirst.text !== "string"
    ) {
      throw new Error("filled alias read returned no text content");
    }
    expect(JSON.parse(filledFirst.text)).toEqual(["NEW_URL"]);
  });

  test("ResourceTemplate list enumerates one resource per stored env", async () => {
    await saveEnv({ name: "BACKEND_URL", value: "u", kind: "plain" });
    await saveEnv({ name: "STRIPE_API_KEY", value: "sk_x", kind: "secret" });

    const client = await makeClient();
    const { resources } = await client.listResources();
    const uris = resources.map((r) => r.uri).sort();

    // Two env-template resources + the legacy alias.
    expect(uris).toContain("keychain://env/BACKEND_URL");
    expect(uris).toContain("keychain://env/STRIPE_API_KEY");
    expect(uris).toContain("keychain://env-names");
  });

  test("keychain://env/{name} returns metadata only, never the value", async () => {
    const SECRET = "sk_distinctive_secret_in_template_read_test_abcdef";
    await saveEnv({ name: "STRIPE_API_KEY", value: SECRET, kind: "secret" });

    const client = await makeClient();
    const res = await client.readResource({ uri: "keychain://env/STRIPE_API_KEY" });
    const first = res.contents[0];
    if (first === undefined || !("text" in first) || typeof first.text !== "string") {
      throw new Error("template read returned no text content");
    }
    const parsed = JSON.parse(first.text) as {
      ok: boolean;
      metadata?: { name: string; kind: string };
    };
    expect(parsed.ok).toBe(true);
    expect(parsed.metadata?.name).toBe("STRIPE_API_KEY");
    expect(parsed.metadata?.kind).toBe("secret");
    // Defense in depth: the literal value must not appear anywhere in the response.
    expect(JSON.stringify(res)).not.toContain(SECRET);
  });

  test("keychain://env/{name} returns ok=false for unknown names", async () => {
    const client = await makeClient();
    const res = await client.readResource({ uri: "keychain://env/DOES_NOT_EXIST" });
    const first = res.contents[0];
    if (first === undefined || !("text" in first) || typeof first.text !== "string") {
      throw new Error("template read returned no text content");
    }
    const parsed = JSON.parse(first.text) as { ok: boolean; error?: string };
    expect(parsed.ok).toBe(false);
    expect(parsed.error).toContain("no env named");
  });

  test("save_env and delete_env each notify the index-change seam", async () => {
    let n = 0;
    setOnIndexChange(() => {
      n += 1;
    });

    await saveEnv({ name: "BACKEND_URL", value: "u", kind: "plain" });
    expect(n).toBe(1);

    await saveEnv({ name: "OTHER_URL", value: "u2", kind: "plain" });
    expect(n).toBe(2);

    await deleteEnv("BACKEND_URL");
    expect(n).toBe(3);
  });

  test("tools/list advertises outputSchema and annotations on every tool", async () => {
    const server = await buildServer();
    const [ct, st] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "test", version: "0.0.0" });
    await server.connect(st);
    await client.connect(ct);

    const { tools } = await client.listTools();
    const byName = new Map(tools.map((t) => [t.name, t]));

    for (const t of tools) {
      expect(t.outputSchema).toBeDefined();
    }

    expect(byName.get("list_envs")?.annotations?.readOnlyHint).toBe(true);
    expect(byName.get("list_envs")?.annotations?.idempotentHint).toBe(true);
    expect(byName.get("find_envs")?.annotations?.readOnlyHint).toBe(true);
    expect(byName.get("get_plain")?.annotations?.readOnlyHint).toBe(true);
    expect(byName.get("save_env")?.annotations?.idempotentHint).toBe(true);
    expect(byName.get("delete_env")?.annotations?.destructiveHint).toBe(true);
    expect(byName.get("delete_env")?.annotations?.idempotentHint).toBe(true);
    expect(byName.get("run_with_secrets")?.annotations?.openWorldHint).toBe(true);
  });
});
