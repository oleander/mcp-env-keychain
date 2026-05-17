import { beforeEach, describe, expect, test } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { buildInstructions, buildServer } from "../src/server.ts";
import { saveEnv } from "../src/tools.ts";
import { setupTestEnv } from "./helpers.ts";

describe("mcp-env-keychain discovery surfaces", () => {
  beforeEach(() => {
    setupTestEnv();
  });

  test("instructions include the catalog snapshot at handshake (no values)", async () => {
    const PLAIN_VALUE = "https://distinctive-url-marker-2026.example.com";
    const SECRET_VALUE = "sk_distinctive_secret_marker_12345abcdef";
    await saveEnv({ name: "BACKEND_URL", value: PLAIN_VALUE, kind: "plain" });
    await saveEnv({ name: "STRIPE_API_KEY", value: SECRET_VALUE, kind: "secret" });
    const text = await buildInstructions();
    expect(text).toContain("Env names at handshake:");
    expect(text).toContain("BACKEND_URL");
    expect(text).toContain("STRIPE_API_KEY");
    expect(text).not.toContain(PLAIN_VALUE);
    expect(text).not.toContain(SECRET_VALUE);
  });

  test("instructions handle empty catalog cleanly", async () => {
    const text = await buildInstructions();
    expect(text).toContain("(no envs stored yet)");
  });

  test("keychain://env-names resource reflects live state on every read", async () => {
    const server = await buildServer();
    const [ct, st] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "test", version: "0.0.0" });
    await server.connect(st);
    await client.connect(ct);

    const empty = await client.readResource({ uri: "keychain://env-names" });
    const emptyFirst = empty.contents[0];
    if (
      emptyFirst === undefined ||
      !("text" in emptyFirst) ||
      typeof emptyFirst.text !== "string"
    ) {
      throw new Error("empty catalog read returned no text content");
    }
    const emptyPayload = JSON.parse(emptyFirst.text) as string[];
    expect(emptyPayload).toEqual([]);

    await saveEnv({ name: "NEW_URL", value: "u", kind: "plain" });

    const filled = await client.readResource({ uri: "keychain://env-names" });
    const filledFirst = filled.contents[0];
    if (
      filledFirst === undefined ||
      !("text" in filledFirst) ||
      typeof filledFirst.text !== "string"
    ) {
      throw new Error("filled catalog read returned no text content");
    }
    const filledPayload = JSON.parse(filledFirst.text) as string[];
    expect(filledPayload).toEqual(["NEW_URL"]);
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
