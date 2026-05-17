import { afterEach, describe, expect, test } from "bun:test";
import { execSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execCommand } from "../src/exec.ts";

// These tests exercise the spawn engine directly. No keychain involvement —
// they can run in any POSIX environment with bash, sleep, ps, head, yes.

describe("execCommand basic lifecycle", () => {
  test("returns exited with raw stdout/stderr and exit code", async () => {
    const r = await execCommand({
      command: "echo out; echo err >&2; exit 7",
      env: process.env as Record<string, string>,
      timeoutMs: 5000,
    });
    expect(r.kind).toBe("exited");
    if (r.kind !== "exited") return;
    expect(r.exitCode).toBe(7);
    expect(r.stdout).toBe("out\n");
    expect(r.stderr).toBe("err\n");
    expect(r.truncatedStdout).toBe(false);
    expect(r.truncatedStderr).toBe(false);
  });
});

describe("execCommand output cap", () => {
  test("stdout cap hit, truncated flag set, child still exits cleanly", async () => {
    const r = await execCommand({
      command: "yes hello | head -c $((2 * 1024 * 1024))",
      env: process.env as Record<string, string>,
      timeoutMs: 5000,
      maxBytesPerStream: 1024,
    });
    expect(r.kind).toBe("exited");
    if (r.kind !== "exited") return;
    expect(r.stdout.length).toBe(1024);
    expect(r.truncatedStdout).toBe(true);
  });

  test("stderr cap drains without hanging the producer", async () => {
    const r = await execCommand({
      command: "(yes bad | head -c $((2 * 1024 * 1024))) >&2",
      env: process.env as Record<string, string>,
      timeoutMs: 5000,
      maxBytesPerStream: 1024,
    });
    expect(r.kind).toBe("exited");
    if (r.kind !== "exited") return;
    expect(r.stderr.length).toBe(1024);
    expect(r.truncatedStderr).toBe(true);
  });
});

describe("execCommand timeout escalation", () => {
  test("graceful SIGTERM wins when child handles it", async () => {
    const r = await execCommand({
      command: 'trap "echo bye; exit 0" TERM; sleep 30 & wait',
      env: process.env as Record<string, string>,
      timeoutMs: 300,
      graceMs: 2000,
    });
    expect(r.kind).toBe("timeout");
    if (r.kind !== "timeout") return;
    expect(r.signal).toBe("SIGTERM");
    expect(r.stdout).toContain("bye");
  });

  test("SIGKILL escalation when child ignores SIGTERM", async () => {
    const t0 = Date.now();
    const r = await execCommand({
      command: 'trap "" TERM; sleep 30',
      env: process.env as Record<string, string>,
      timeoutMs: 200,
      graceMs: 300,
    });
    const dur = Date.now() - t0;
    expect(r.kind).toBe("timeout");
    if (r.kind !== "timeout") return;
    expect(r.signal).toBe("SIGKILL");
    // Should escape within roughly timeout + grace + a small overhead.
    expect(dur).toBeLessThan(2000);
  });

  test("orphan grandchild is killed via process-group", async () => {
    const pidFile = join(tmpdir(), `exec-orphan-${process.pid}-${Date.now()}`);
    if (existsSync(pidFile)) unlinkSync(pidFile);
    const r = await execCommand({
      command: `(sleep 30 & echo $! > ${pidFile}); echo started; sleep 30`,
      env: process.env as Record<string, string>,
      timeoutMs: 400,
      graceMs: 500,
    });
    expect(r.kind).toBe("timeout");
    // Give init a moment to reap the grandchild.
    await new Promise((resolve) => setTimeout(resolve, 500));
    expect(existsSync(pidFile)).toBe(true);
    const orphanPid = Number.parseInt(readFileSync(pidFile, "utf8").trim(), 10);
    unlinkSync(pidFile);

    // The grandchild should be either gone (ESRCH) or a zombie. Both indicate
    // our SIGTERM reached it via the process group. A still-Running state
    // means the orphan escaped the kill.
    let state: string;
    try {
      state = execSync(`ps -o state= -p ${orphanPid}`, { stdio: ["ignore", "pipe", "ignore"] })
        .toString()
        .trim();
    } catch {
      // ps exits non-zero when the pid is unknown — that's the cleanest dead.
      state = "";
    }
    // Z = zombie (dead, awaiting reap); "" = already reaped.
    expect(["", "Z"]).toContain(state[0] ?? "");
  });
});

describe("execCommand spawn classification", () => {
  let tempDir: string | null = null;
  afterEach(() => {
    if (tempDir) {
      try {
        chmodSync(tempDir, 0o700);
        rmSync(tempDir, { recursive: true });
      } catch {}
      tempDir = null;
    }
  });

  test("classifies missing cwd", async () => {
    const r = await execCommand({
      command: "echo hi",
      env: process.env as Record<string, string>,
      cwd: `/definitely/not/here/${Math.random()}`,
      timeoutMs: 5000,
    });
    expect(r.kind).toBe("spawn_failed");
    if (r.kind !== "spawn_failed") return;
    expect(r.classification).toBe("cwd_missing");
    expect(r.error).toContain("cwd does not exist");
  });

  test("classifies cwd that is a file, not a directory", async () => {
    tempDir = mkdtempSync(join(tmpdir(), "exec-cwdfile-"));
    const file = join(tempDir, "not-a-dir");
    writeFileSync(file, "x");
    const r = await execCommand({
      command: "echo hi",
      env: process.env as Record<string, string>,
      cwd: file,
      timeoutMs: 5000,
    });
    expect(r.kind).toBe("spawn_failed");
    if (r.kind !== "spawn_failed") return;
    expect(r.classification).toBe("cwd_not_dir");
  });

  test("classifies cwd without execute permission", async () => {
    // Root bypasses mode bits, so skip this case for the root test runner.
    if (typeof process.getuid === "function" && process.getuid() === 0) return;
    tempDir = mkdtempSync(join(tmpdir(), "exec-noaccess-"));
    chmodSync(tempDir, 0o000);
    const r = await execCommand({
      command: "echo hi",
      env: process.env as Record<string, string>,
      cwd: tempDir,
      timeoutMs: 5000,
    });
    expect(r.kind).toBe("spawn_failed");
    if (r.kind !== "spawn_failed") return;
    expect(r.classification).toBe("cwd_no_access");
  });
});
