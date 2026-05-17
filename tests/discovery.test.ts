import { describe, expect, test, beforeEach } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { buildServer, buildInstructions } from "../src/server.ts";
import { saveEnv } from "../src/tools.ts";
import { setupTestEnv } from "./helpers.ts";

describe("k-mcp discovery surfaces", () => {
  beforeEach(() => {
    setupTestEnv();
  });

  test("instructions include the catalog snapshot at handshake (no values)", async () => {
    const PLAIN_VALUE = "https://distinctive-url-marker-2026.example.com";
    const SECRET_VALUE = "sk_distinctive_secret_marker_12345abcdef";
    await saveEnv({ name: "BACKEND_URL", value: PLAIN_VALUE, kind: "plain" });
    await saveEnv({ name: "STRIPE_API_KEY", value: SECRET_VALUE, kind: "secret" });
    const text = await buildInstructions();
    expect(text).toContain("Catalog at handshake:");
    expect(text).toContain("BACKEND_URL (kind=plain)");
    expect(text).toContain("STRIPE_API_KEY (kind=secret)");
    expect(text).not.toContain(PLAIN_VALUE);
    expect(text).not.toContain(SECRET_VALUE);
  });

  test("instructions handle empty catalog cleanly", async () => {
    const text = await buildInstructions();
    expect(text).toContain("(no envs stored yet)");
  });

  test("keychain://catalog resource reflects live state on every read", async () => {
    const server = await buildServer();
    const [ct, st] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "test", version: "0.0.0" });
    await server.connect(st);
    await client.connect(ct);

    const empty = await client.readResource({ uri: "keychain://catalog" });
    const emptyFirst = empty.contents[0];
    if (emptyFirst === undefined || !("text" in emptyFirst) || typeof emptyFirst.text !== "string") {
      throw new Error("empty catalog read returned no text content");
    }
    const emptyPayload = JSON.parse(emptyFirst.text) as { count: number; entries: unknown[] };
    expect(emptyPayload.count).toBe(0);
    expect(emptyPayload.entries).toEqual([]);

    await saveEnv({ name: "NEW_URL", value: "u", kind: "plain" });

    const filled = await client.readResource({ uri: "keychain://catalog" });
    const filledFirst = filled.contents[0];
    if (filledFirst === undefined || !("text" in filledFirst) || typeof filledFirst.text !== "string") {
      throw new Error("filled catalog read returned no text content");
    }
    const filledPayload = JSON.parse(filledFirst.text) as {
      count: number;
      entries: Array<{ name: string; kind: string }>;
    };
    expect(filledPayload.count).toBe(1);
    expect(filledPayload.entries[0]?.name).toBe("NEW_URL");
    expect(filledPayload.entries[0]?.kind).toBe("plain");
  });
});
