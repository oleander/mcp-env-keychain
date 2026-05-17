import { beforeEach, describe, expect, test } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { buildServer } from "../src/server.ts";
import { setupTestEnv } from "./helpers.ts";

async function makeClient(): Promise<Client> {
  const server = await buildServer();
  const [ct, st] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test", version: "0.0.0" });
  await server.connect(st);
  await client.connect(ct);
  return client;
}

describe("mcp-env-keychain prompts", () => {
  beforeEach(() => {
    setupTestEnv();
  });

  test("prompts/list returns both shipped prompts", async () => {
    const client = await makeClient();
    const { prompts } = await client.listPrompts();
    const names = prompts.map((p) => p.name).sort();
    expect(names).toContain("import-env-file");
    expect(names).toContain("audit-stale");
  });

  test("import-env-file prompt expands the path into a workflow message", async () => {
    const client = await makeClient();
    const res = await client.getPrompt({
      name: "import-env-file",
      arguments: { path: "/tmp/example.env" },
    });
    expect(res.messages.length).toBeGreaterThan(0);
    const first = res.messages[0]!;
    expect(first.role).toBe("user");
    expect(first.content.type).toBe("text");
    if (first.content.type === "text") {
      expect(first.content.text).toContain("/tmp/example.env");
      expect(first.content.text).toContain("save_env");
      // Defense in depth: the prompt must never instruct the agent to echo values.
      expect(first.content.text).toContain("only names");
    }
  });

  test("audit-stale prompt threads the cutoff into the workflow message", async () => {
    const client = await makeClient();
    const res = await client.getPrompt({
      name: "audit-stale",
      arguments: { days: "30" },
    });
    const first = res.messages[0]!;
    if (first.content.type === "text") {
      expect(first.content.text).toContain("30 days");
      expect(first.content.text).toContain("list_envs");
      // Should explicitly tell the agent NOT to fetch values.
      expect(first.content.text.toLowerCase()).toContain("not call");
    }
  });

  test("audit-stale defaults to 90 days when the argument is missing or unparseable", async () => {
    const client = await makeClient();
    const res = await client.getPrompt({
      name: "audit-stale",
      arguments: { days: "not-a-number" },
    });
    const first = res.messages[0]!;
    if (first.content.type === "text") {
      expect(first.content.text).toContain("90 days");
    }
  });
});
