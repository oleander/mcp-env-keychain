import { type ChildProcess, spawn } from "node:child_process";

// Subprocess execution engine for run_with_secrets.
//
// Never sees secret values: receives the already-merged env from the caller
// and returns raw stdout/stderr. Scrubbing happens in the caller because the
// per-key label is only known there.
//
// Edge cases this module owns:
//   1. Process-group lifetime. `detached: true` puts the child in its own
//      process group so a backgrounded grandchild (`(sleep &)`) can't outlive
//      the timeout — we kill the whole group via process.kill(-pid, sig).
//   2. Graceful termination. On timeout we send SIGTERM to the group and give
//      it `graceMs` to clean up before escalating to SIGKILL. With pgrp-kill
//      this works even for `bash -lc 'sleep 30'`, because SIGTERM reaches
//      `sleep` directly.
//   3. Output cap. We cap each stream at maxBytesPerStream and KEEP DRAINING
//      after the cap so the kernel pipe buffer doesn't fill and block the
//      child from exiting (which would freeze our timeout escalation).
//   4. Spawn classification. ENOENT / ENOTDIR / EACCES / EPERM are all
//      pre-fetch errors today; we classify them and produce LLM-actionable
//      messages instead of a single opaque "failed to spawn subprocess".

export type SpawnFailureKind =
  | "cwd_missing"
  | "cwd_not_dir"
  | "cwd_no_access"
  | "shell_missing"
  | "generic";

export type ExecResult =
  | {
      kind: "exited";
      exitCode: number;
      stdout: string;
      stderr: string;
      truncatedStdout: boolean;
      truncatedStderr: boolean;
    }
  | {
      kind: "timeout";
      stdout: string;
      stderr: string;
      truncatedStdout: boolean;
      truncatedStderr: boolean;
      signal: "SIGTERM" | "SIGKILL";
    }
  | {
      kind: "spawn_failed";
      error: string;
      classification: SpawnFailureKind;
    };

export type ExecInput = {
  command: string;
  env: Record<string, string>;
  cwd?: string;
  timeoutMs: number;
  maxBytesPerStream?: number;
  graceMs?: number;
};

const DEFAULT_MAX_BYTES = 1 << 20; // 1 MiB
const DEFAULT_GRACE_MS = 2000;

function killTree(pid: number, sig: "SIGTERM" | "SIGKILL"): void {
  try {
    // Negative PID targets the process group. With detached:true the child
    // is its own pgrp leader (pgrp == pid), so this reaps every descendant
    // that hasn't escaped via setsid of its own.
    process.kill(-pid, sig);
  } catch {
    // ESRCH (no such group) is benign — they're already gone.
  }
}

function classifySpawnError(
  err: NodeJS.ErrnoException,
  cwd: string | undefined,
): { kind: SpawnFailureKind; cwd?: string } {
  const code = err.code;
  if (code === "ENOTDIR" && cwd !== undefined) return { kind: "cwd_not_dir", cwd };
  if ((code === "EACCES" || code === "EPERM") && cwd !== undefined)
    return { kind: "cwd_no_access", cwd };
  if (code === "ENOENT") {
    if (cwd !== undefined) return { kind: "cwd_missing", cwd };
    return { kind: "shell_missing" };
  }
  return { kind: "generic" };
}

function spawnErrorMessage(
  f: { kind: SpawnFailureKind; cwd?: string },
  rawMessage: string,
): string {
  switch (f.kind) {
    case "cwd_missing":
      return `cwd does not exist: '${f.cwd}'. Pass an absolute path that exists, or omit cwd.`;
    case "cwd_not_dir":
      return `cwd is not a directory: '${f.cwd}'.`;
    case "cwd_no_access":
      return `cwd not accessible (permission denied): '${f.cwd}'.`;
    case "shell_missing":
      return "bash not found at /bin/bash; check the shell installation.";
    case "generic":
      return `failed to spawn subprocess: ${rawMessage}`;
  }
}

// Reads from a Node Readable up to `cap` bytes, then keeps consuming chunks
// (discarding them) so the producer doesn't block on pipe back-pressure.
function captureCapped(
  stream: NodeJS.ReadableStream,
  cap: number,
): Promise<{ text: string; truncated: boolean }> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    let truncated = false;
    stream.on("data", (chunk: Buffer | string) => {
      const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      if (truncated) return;
      if (total + buf.byteLength <= cap) {
        chunks.push(buf);
        total += buf.byteLength;
      } else {
        const remain = cap - total;
        if (remain > 0) chunks.push(buf.subarray(0, remain));
        total = cap;
        truncated = true;
      }
    });
    stream.on("end", () => {
      resolve({ text: Buffer.concat(chunks).toString("utf8"), truncated });
    });
    stream.on("error", (e) => reject(e));
  });
}

export async function execCommand(input: ExecInput): Promise<ExecResult> {
  const cap = input.maxBytesPerStream ?? DEFAULT_MAX_BYTES;
  const graceMs = input.graceMs ?? DEFAULT_GRACE_MS;

  let child: ChildProcess;
  try {
    child = spawn("bash", ["-lc", input.command], {
      env: input.env,
      stdio: ["ignore", "pipe", "pipe"],
      detached: true,
      ...(input.cwd !== undefined ? { cwd: input.cwd } : {}),
    });
  } catch (e) {
    // node:child_process can throw synchronously for some early failures
    // (mostly arg validation). Most real spawn failures — ENOENT for cwd,
    // EACCES, ENOTDIR — arrive via the asynchronous 'error' event instead.
    const err = e as NodeJS.ErrnoException;
    const cls = classifySpawnError(err, input.cwd);
    return {
      kind: "spawn_failed",
      error: spawnErrorMessage(cls, err.message ?? String(e)),
      classification: cls.kind,
    };
  }

  // Wait for spawn-or-error before we start reading pipes. node:child_process
  // emits 'spawn' once the child is live or 'error' if it never came up.
  const ready = await new Promise<{ ok: true } | { ok: false; err: NodeJS.ErrnoException }>(
    (resolve) => {
      child.once("spawn", () => resolve({ ok: true }));
      child.once("error", (e) => resolve({ ok: false, err: e as NodeJS.ErrnoException }));
    },
  );
  if (!ready.ok) {
    const cls = classifySpawnError(ready.err, input.cwd);
    return {
      kind: "spawn_failed",
      error: spawnErrorMessage(cls, ready.err.message ?? String(ready.err)),
      classification: cls.kind,
    };
  }

  // Defensive null check. With stdio:["ignore","pipe","pipe"] these are
  // guaranteed, but TS doesn't know that.
  if (!child.stdout || !child.stderr || child.pid === undefined) {
    return {
      kind: "spawn_failed",
      error: "failed to spawn subprocess: no stdio available",
      classification: "generic",
    };
  }
  const pid = child.pid;

  let timedOut = false;
  let killSignal: "SIGTERM" | "SIGKILL" = "SIGTERM";

  const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
    child.once("exit", (code, signal) => resolve({ code, signal }));
  });

  const timer = setTimeout(async () => {
    timedOut = true;
    killTree(pid, "SIGTERM");
    const settled = await Promise.race([
      exited.then(() => "exited" as const),
      new Promise<"grace">((r) => setTimeout(() => r("grace"), graceMs)),
    ]);
    if (settled === "grace") {
      killSignal = "SIGKILL";
      killTree(pid, "SIGKILL");
    }
  }, input.timeoutMs);

  let stdout: { text: string; truncated: boolean };
  let stderr: { text: string; truncated: boolean };
  try {
    [stdout, stderr] = await Promise.all([
      captureCapped(child.stdout, cap),
      captureCapped(child.stderr, cap),
    ]);
    await exited;
  } finally {
    clearTimeout(timer);
  }

  if (timedOut) {
    return {
      kind: "timeout",
      stdout: stdout.text,
      stderr: stderr.text,
      truncatedStdout: stdout.truncated,
      truncatedStderr: stderr.truncated,
      signal: killSignal,
    };
  }

  const { code, signal } = await exited;
  return {
    kind: "exited",
    // When killed by an external signal we still report an exit code; node
    // gives null in that case, so synthesise the POSIX convention 128 + sig.
    exitCode: code ?? (signal ? 128 + (signalToNumber(signal) ?? 0) : -1),
    stdout: stdout.text,
    stderr: stderr.text,
    truncatedStdout: stdout.truncated,
    truncatedStderr: stderr.truncated,
  };
}

function signalToNumber(sig: NodeJS.Signals): number | null {
  // Just the ones bash subprocesses tend to hit; null fallback is fine.
  const table: Partial<Record<NodeJS.Signals, number>> = {
    SIGHUP: 1,
    SIGINT: 2,
    SIGQUIT: 3,
    SIGTERM: 15,
    SIGKILL: 9,
  };
  return table[sig] ?? null;
}
