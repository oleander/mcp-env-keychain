import { beforeEach, describe, expect, test } from "bun:test";
import { existsSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { loadIndex } from "../src/keychain.ts";
import { deleteEnv, findEnvs, getPlain, listEnvs, runWithSecrets, saveEnv } from "../src/tools.ts";
import { setupTestEnv } from "./helpers.ts";

describe("mcp-env-keychain tools (smoke)", () => {
  beforeEach(() => {
    setupTestEnv();
  });

  test("save_env (plain URL) succeeds", async () => {
    const r = await saveEnv({
      name: "BACKEND_URL",
      value: "https://api.example.com",
      kind: "plain",
    });
    expect(r.ok).toBe(true);
  });

  test("save_env refuses plain save of secret-named key", async () => {
    const r = await saveEnv({ name: "STRIPE_API_KEY", value: "should_not_save", kind: "plain" });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain("looks like a secret");
  });

  test("save_env stores a secret", async () => {
    const r = await saveEnv({
      name: "STRIPE_API_KEY",
      value: "sk_live_thisisverysecret_abc123",
      kind: "secret",
    });
    expect(r.ok).toBe(true);
  });

  test("list_envs returns both entries with no values", async () => {
    await saveEnv({ name: "BACKEND_URL", value: "https://api.example.com", kind: "plain" });
    await saveEnv({ name: "STRIPE_API_KEY", value: "sk_live_x", kind: "secret" });
    const r = await listEnvs();
    expect(r.count).toBe(2);
    const names = r.entries.map((e) => e.name).sort();
    expect(names).toEqual(["BACKEND_URL", "STRIPE_API_KEY"]);
    for (const e of r.entries) {
      expect("value" in e).toBe(false);
    }
  });

  test("find_envs does case-insensitive substring match", async () => {
    await saveEnv({ name: "STRIPE_API_KEY", value: "sk_x", kind: "secret" });
    await saveEnv({ name: "BACKEND_URL", value: "u", kind: "plain" });
    const r = await findEnvs("stripe");
    expect(r.count).toBe(1);
    expect(r.entries[0]?.name).toBe("STRIPE_API_KEY");
    expect("value" in (r.entries[0] ?? {})).toBe(false);
  });

  test("get_plain retrieves a plain value", async () => {
    await saveEnv({ name: "BACKEND_URL", value: "https://api.example.com", kind: "plain" });
    const r = await getPlain("BACKEND_URL");
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value).toBe("https://api.example.com");
  });

  test("get_plain refuses to return a secret", async () => {
    await saveEnv({ name: "STRIPE_API_KEY", value: "sk_x", kind: "secret" });
    const r = await getPlain("STRIPE_API_KEY");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain("Plain retrieval is refused");
  });

  test("get_plain gives clean error for missing env", async () => {
    const r = await getPlain("DOES_NOT_EXIST");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain("no env named");
  });

  test("run_with_secrets rejects unknown keys", async () => {
    const r = await runWithSecrets({ command: "echo hi", env_keys: ["NOT_REAL"] });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain("unknown env keys");
  });

  test("run_with_secrets injects values and scrubs the secret from stdout", async () => {
    await saveEnv({ name: "BACKEND_URL", value: "https://api.example.com", kind: "plain" });
    await saveEnv({
      name: "STRIPE_API_KEY",
      value: "sk_live_thisisverysecret_abc123",
      kind: "secret",
    });
    const r = await runWithSecrets({
      command: 'echo "URL=$BACKEND_URL"; echo "OOPS=$STRIPE_API_KEY"',
      env_keys: ["BACKEND_URL", "STRIPE_API_KEY"],
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.exit_code).toBe(0);
    expect(r.stdout).toContain("https://api.example.com");
    expect(r.stdout).not.toContain("sk_live_thisisverysecret_abc123");
    expect(r.stdout).toContain("[REDACTED:STRIPE_API_KEY]");
    expect(r.injected_keys).toEqual(["BACKEND_URL", "STRIPE_API_KEY"]);
  });

  test("run_with_secrets reports timeout as a clean error", async () => {
    const r = await runWithSecrets({ command: "sleep 5", env_keys: [], timeout: 1 });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain("timeout");
  });

  test("run_with_secrets returns non-zero exit codes via exit_code, not error", async () => {
    const r = await runWithSecrets({ command: "exit 7", env_keys: [] });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.exit_code).toBe(7);
  });

  test("delete_env removes both Keychain value and index entry", async () => {
    await saveEnv({ name: "BACKEND_URL", value: "u", kind: "plain" });
    await saveEnv({ name: "STRIPE_API_KEY", value: "sk_x", kind: "secret" });
    expect((await deleteEnv("BACKEND_URL")).ok).toBe(true);
    expect((await deleteEnv("STRIPE_API_KEY")).ok).toBe(true);
    expect((await listEnvs()).count).toBe(0);
  });
});

describe("index reliability (B2, B3, B4)", () => {
  beforeEach(() => {
    setupTestEnv();
  });

  // B2: normalizeName at every entry point
  test("untrimmed names are normalized symmetrically across all tools", async () => {
    const saved = await saveEnv({ name: "  PADDED_URL  ", value: "u", kind: "plain" });
    expect(saved.ok).toBe(true);
    if (saved.ok) expect(saved.name).toBe("PADDED_URL");

    // Lookup with different whitespace — should still find it.
    const found = await getPlain(" PADDED_URL\t");
    expect(found.ok).toBe(true);
    if (found.ok) expect(found.value).toBe("u");

    // Delete with surrounding whitespace.
    const deleted = await deleteEnv("PADDED_URL ");
    expect(deleted.ok).toBe(true);
  });

  test("run_with_secrets normalizes each env_keys entry", async () => {
    await saveEnv({ name: "BACKEND_URL", value: "https://x.com", kind: "plain" });
    const r = await runWithSecrets({
      command: "echo $BACKEND_URL",
      env_keys: ["  BACKEND_URL\t"],
    });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.stdout).toContain("https://x.com");
      expect(r.injected_keys).toEqual(["BACKEND_URL"]);
    }
  });

  // B4: corrupt index recovery
  test("loadIndex backs up a corrupt file and starts with an empty index", async () => {
    const { indexFile, dir } = setupTestEnv();
    // Plant a corrupt index that's valid JSON but fails the IndexSchema.
    writeFileSync(indexFile, JSON.stringify({ entries: "not-an-object" }));

    const loaded = await loadIndex();
    expect(loaded.entries).toEqual({});

    const siblings = readdirSync(dir);
    const backup = siblings.find((f) => f.startsWith("index.json.corrupt."));
    expect(backup).toBeDefined();
    expect(existsSync(join(dir, backup!))).toBe(true);
  });

  test("loadIndex backs up an unparseable JSON file too", async () => {
    const { indexFile, dir } = setupTestEnv();
    writeFileSync(indexFile, "not valid json {{{");

    const loaded = await loadIndex();
    expect(loaded.entries).toEqual({});

    const siblings = readdirSync(dir);
    expect(siblings.some((f) => f.startsWith("index.json.corrupt."))).toBe(true);
  });

  // B7: preserved timeout output
  test("run_with_secrets timeout preserves any captured stdout/stderr", async () => {
    const r = await runWithSecrets({
      command: 'echo "first line"; echo "second line" >&2; sleep 5',
      env_keys: [],
      timeout: 1,
    });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error).toContain("timeout");
      // The kill happens after the early echoes drained.
      expect(r.stdout).toContain("first line");
      expect(r.stderr).toContain("second line");
    }
  });
});
