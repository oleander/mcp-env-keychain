#!/usr/bin/env bun
// Live verification: hits the real macOS Keychain. Cleans up after itself.
// Uses uniquely-named entries (k_mcp_live_verify_*) so it can't trample real data.
import {
  saveEnv,
  listEnvs,
  getPlain,
  deleteEnv,
  runWithSecrets,
} from "../src/tools.ts";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setIndexPath } from "../src/keychain.ts";

const TMP = mkdtempSync(join(tmpdir(), "k-mcp-live-"));
setIndexPath(join(TMP, "index.json"));

const PLAIN_NAME = "k_mcp_live_verify_url";
const PLAIN_VALUE = "https://live-test-" + Date.now() + ".example.com";

let failed = 0;
function check(name, cond) {
  if (cond) console.log(`  ok: ${name}`);
  else {
    console.error(`FAIL: ${name}`);
    failed++;
  }
}

try {
  console.log("== save_env (plain) — real Keychain ==");
  const s = await saveEnv({ name: PLAIN_NAME, value: PLAIN_VALUE, kind: "plain" });
  check("save_env returns ok", s.ok === true);

  console.log("== list_envs sees the entry ==");
  const l = await listEnvs();
  const found = l.entries.find((e) => e.name === PLAIN_NAME);
  check("entry shows in list_envs", found !== undefined && found.kind === "plain");
  check("list_envs returns no value field", found !== undefined && !("value" in found));

  console.log("== get_plain returns the real value ==");
  const g = await getPlain(PLAIN_NAME);
  check("get_plain ok", g.ok === true);
  check("get_plain value round-trip", g.ok === true && g.value === PLAIN_VALUE);

  console.log("== run_with_secrets (plain only, no Touch ID prompt) ==");
  const r = await runWithSecrets({
    command: 'echo "URL=$' + PLAIN_NAME + '"',
    env_keys: [PLAIN_NAME],
  });
  check("run_with_secrets ok", r.ok === true);
  check("plain value injected into subprocess env", r.ok && r.stdout.includes(PLAIN_VALUE));
} finally {
  console.log("== cleanup ==");
  const d = await deleteEnv(PLAIN_NAME);
  check("delete_env ok", d.ok === true);
}

if (failed > 0) {
  console.error(`\n${failed} live check(s) FAILED`);
  process.exit(1);
}
console.log("\nALL LIVE CHECKS PASSED");
