import { beforeEach, describe, expect, test } from "bun:test";
import { runWithSecrets, saveEnv } from "../src/tools.ts";
import { installAuthCounter, installFailingAuth, setupTestEnv } from "./helpers.ts";

describe("Touch ID gate", () => {
  beforeEach(() => {
    setupTestEnv();
  });

  test("auth is invoked exactly once per session even when many secrets are used", async () => {
    const counter = installAuthCounter();
    await saveEnv({ name: "STRIPE_API_KEY", value: "sk_x", kind: "secret" });
    await saveEnv({ name: "GITHUB_TOKEN", value: "ghp_y", kind: "secret" });
    await saveEnv({ name: "API_URL", value: "https://example.com", kind: "plain" });

    expect(counter.calls()).toBe(0);

    const r1 = await runWithSecrets({
      command: "echo hi",
      env_keys: ["STRIPE_API_KEY"],
    });
    expect(r1.ok).toBe(true);
    expect(counter.calls()).toBe(1);

    const r2 = await runWithSecrets({
      command: "echo hi",
      env_keys: ["STRIPE_API_KEY", "GITHUB_TOKEN"],
    });
    expect(r2.ok).toBe(true);
    expect(counter.calls()).toBe(1);

    const r3 = await runWithSecrets({ command: "echo hi", env_keys: ["API_URL"] });
    expect(r3.ok).toBe(true);
    expect(counter.calls()).toBe(1);
  });

  test("auth is NOT invoked when only plain values are injected", async () => {
    const counter = installAuthCounter();
    await saveEnv({ name: "API_URL", value: "https://example.com", kind: "plain" });
    const r = await runWithSecrets({ command: "echo hi", env_keys: ["API_URL"] });
    expect(r.ok).toBe(true);
    expect(counter.calls()).toBe(0);
  });

  test("auth failure surfaces as a clean tool error (no secret leakage)", async () => {
    await saveEnv({ name: "STRIPE_API_KEY", value: "sk_x", kind: "secret" });
    installFailingAuth("user cancelled biometric prompt");
    const r = await runWithSecrets({ command: "echo hi", env_keys: ["STRIPE_API_KEY"] });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error).toContain("Touch ID required");
      expect(r.error).toContain("user cancelled");
    }
  });
});
