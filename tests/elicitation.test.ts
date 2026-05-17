import { describe, expect, test, beforeEach } from "bun:test";
import { saveEnv } from "../src/tools.ts";
import { installElicitStub, setupTestEnv } from "./helpers.ts";

describe("save_env elicitation on looks-secret/plain conflict", () => {
  beforeEach(() => {
    setupTestEnv();
  });

  test("fall back to refusal when no elicitation seam is wired (legacy clients)", async () => {
    // No installElicitStub call — elicitFn is null.
    const r = await saveEnv({
      name: "STRIPE_API_KEY",
      value: "should_not_save",
      kind: "plain",
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain("looks like a secret");
  });

  test("fall back to refusal when the elicitation stub throws (client lacks capability)", async () => {
    installElicitStub(() => {
      throw new Error("client does not support elicitation");
    });
    const r = await saveEnv({
      name: "STRIPE_API_KEY",
      value: "should_not_save",
      kind: "plain",
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain("looks like a secret");
  });

  test("accept + saveAsSecret=true upgrades the save to kind='secret'", async () => {
    const stub = installElicitStub(async () => ({
      action: "accept",
      content: { saveAsSecret: true },
    }));
    const r = await saveEnv({
      name: "STRIPE_API_KEY",
      value: "sk_via_elicit_promotion",
      kind: "plain",
    });
    expect(stub.calls()).toBe(1);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.kind).toBe("secret");
  });

  test("accept + saveAsSecret=false persists with the original kind=plain", async () => {
    installElicitStub(async () => ({
      action: "accept",
      content: { saveAsSecret: false },
    }));
    const r = await saveEnv({
      name: "STRIPE_API_KEY",
      value: "actually_a_url_named_funny",
      kind: "plain",
    });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.kind).toBe("plain");
  });

  test("decline persists with kind=plain (the originally requested kind)", async () => {
    installElicitStub(async () => ({ action: "decline" }));
    const r = await saveEnv({
      name: "MY_KEY_PREFIX",
      value: "this is fine as plain",
      kind: "plain",
    });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.kind).toBe("plain");
  });

  test("cancel falls back to refusal", async () => {
    installElicitStub(async () => ({ action: "cancel" }));
    const r = await saveEnv({
      name: "STRIPE_API_KEY",
      value: "should_not_save",
      kind: "plain",
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain("looks like a secret");
  });

  test("elicitation is not triggered when name+kind don't conflict", async () => {
    const stub = installElicitStub(async () => ({ action: "accept" }));
    const r1 = await saveEnv({ name: "BACKEND_URL", value: "u", kind: "plain" });
    const r2 = await saveEnv({ name: "STRIPE_API_KEY", value: "sk_x", kind: "secret" });
    expect(stub.calls()).toBe(0);
    expect(r1.ok).toBe(true);
    expect(r2.ok).toBe(true);
  });

  test("elicit message references the env name without revealing the value", async () => {
    const VALUE = "sk_distinctive_value_should_never_appear_in_prompt_xyz";
    const stub = installElicitStub(async () => ({ action: "decline" }));
    await saveEnv({ name: "STRIPE_API_KEY", value: VALUE, kind: "plain" });
    const params = stub.lastParams();
    expect(params).not.toBeNull();
    expect(params!.message).toContain("STRIPE_API_KEY");
    expect(params!.message).not.toContain(VALUE);
  });
});
