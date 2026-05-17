import {
  keychain,
  loadIndex,
  looksSecret,
  normalizeName,
  now,
  saveIndex,
  scrub,
} from "./keychain.ts";
import { ensureUnlocked, TouchIDAuthFailed, TouchIDNotAvailable } from "./touchid.ts";
import type {
  Catalog,
  DeleteEnvResult,
  Entry,
  FindEnvsResult,
  GetPlainResult,
  ListEnvsResult,
  RunResult,
  SaveEnvArgs,
  SaveEnvResult,
} from "./types.ts";

export async function catalogPayload(): Promise<Catalog> {
  const index = await loadIndex();
  const entries = Object.entries(index.entries)
    .map(([name, e]) => ({ name, ...e }))
    .sort((a, b) => a.name.localeCompare(b.name));
  return { count: entries.length, entries };
}

export async function catalogNamesPayload(): Promise<string[]> {
  const index = await loadIndex();
  // Object.keys is already unique — no Set wrap needed.
  return Object.keys(index.entries).sort((a, b) => a.localeCompare(b));
}

export async function saveEnv(args: SaveEnvArgs): Promise<SaveEnvResult> {
  const name = normalizeName(args.name);
  if (!name) return { ok: false, error: "name is required" };

  if (args.kind === "plain" && looksSecret(name)) {
    return {
      ok: false,
      error:
        `Refusing to save '${name}' as kind='plain' because the name ` +
        "looks like a secret. Re-call with kind='secret' (recommended), " +
        "or rename it if it really is non-sensitive.",
    };
  }

  await keychain().setPassword(name, args.value);

  const index = await loadIndex();
  const existing = index.entries[name];
  const ts = now();
  const entry: Entry = {
    kind: args.kind,
    created_at: existing?.created_at ?? ts,
    updated_at: ts,
  };
  index.entries[name] = entry;
  await saveIndex(index);

  return { ok: true, name, kind: args.kind };
}

export async function listEnvs(): Promise<ListEnvsResult> {
  return await catalogPayload();
}

export async function findEnvs(pattern: string): Promise<FindEnvsResult> {
  const pat = pattern.trim().toLowerCase();
  const index = await loadIndex();
  const matches = Object.entries(index.entries)
    .filter(([n]) => n.toLowerCase().includes(pat))
    .map(([name, e]) => ({ name, ...e }))
    .sort((a, b) => a.name.localeCompare(b.name));
  return { pattern, count: matches.length, entries: matches };
}

export async function getPlain(rawName: string): Promise<GetPlainResult> {
  const name = normalizeName(rawName);
  if (!name) return { ok: false, error: "name is required" };
  const index = await loadIndex();
  const entry = index.entries[name];
  if (!entry) return { ok: false, error: `no env named '${name}'` };
  if (entry.kind !== "plain") {
    return {
      ok: false,
      error:
        `'${name}' is stored as kind='${entry.kind}'. Plain ` +
        "retrieval is refused for secrets. Use run_with_secrets to " +
        "use this value inside a command.",
    };
  }
  const value = await keychain().getPassword(name);
  if (value === null) {
    return {
      ok: false,
      error: `index has '${name}' but Keychain does not (out of sync)`,
    };
  }
  return { ok: true, name, kind: "plain", value };
}

export async function deleteEnv(rawName: string): Promise<DeleteEnvResult> {
  const name = normalizeName(rawName);
  if (!name) return { ok: false, error: "name is required" };
  const index = await loadIndex();
  if (!(name in index.entries)) {
    return { ok: false, error: `no env named '${name}'` };
  }
  // Best-effort delete from keychain; index is authoritative on existence.
  try {
    await keychain().deletePassword(name);
  } catch {
    // already gone from Keychain — still drop the index entry
  }
  delete index.entries[name];
  await saveIndex(index);
  return { ok: true, name };
}

// Dedupe while preserving order.
function dedupe<T>(xs: T[]): T[] {
  const seen = new Set<T>();
  const out: T[] = [];
  for (const x of xs) {
    if (!seen.has(x)) {
      seen.add(x);
      out.push(x);
    }
  }
  return out;
}

export async function runWithSecrets(args: {
  command: string;
  env_keys: string[];
  cwd?: string;
  timeout?: number;
}): Promise<RunResult> {
  const command = args.command;
  const timeout = args.timeout ?? 60;

  if (!command?.trim()) {
    return { ok: false, error: "command is required" };
  }

  // Normalize + dedupe each requested key so " FOO " and "FOO" resolve the same.
  const keys = dedupe((args.env_keys ?? []).map(normalizeName).filter((k) => k.length > 0));
  const index = await loadIndex();
  const unknown = keys.filter((k) => !(k in index.entries));
  if (unknown.length > 0) {
    return {
      ok: false,
      error:
        `unknown env keys: [${unknown.map((k) => `'${k}'`).join(", ")}]. ` +
        "Use list_envs to see what's stored.",
    };
  }

  // Gate Touch ID BEFORE touching Keychain for any secret-kind key.
  const secretKeys = keys.filter((k) => index.entries[k]?.kind === "secret");
  if (secretKeys.length > 0) {
    try {
      await ensureUnlocked(secretKeys);
    } catch (e) {
      if (e instanceof TouchIDNotAvailable) {
        return { ok: false, error: `Touch ID required but unavailable: ${e.message}` };
      }
      if (e instanceof TouchIDAuthFailed) {
        return { ok: false, error: `Touch ID required: ${e.message}` };
      }
      return { ok: false, error: "Touch ID required (unexpected failure)" };
    }
  }

  const injected: Record<string, string> = {};
  const secretsOnly: Record<string, string> = {};
  const missing: string[] = [];
  for (const k of keys) {
    const v = await keychain().getPassword(k);
    if (v === null) {
      missing.push(k);
      continue;
    }
    injected[k] = v;
    if (index.entries[k]?.kind === "secret") secretsOnly[k] = v;
  }
  if (missing.length > 0) {
    return {
      ok: false,
      error:
        `keys in index but missing from Keychain (out of sync): ` +
        `[${missing.map((k) => `'${k}'`).join(", ")}]`,
    };
  }

  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (v !== undefined) env[k] = v;
  }
  for (const [k, v] of Object.entries(injected)) env[k] = v;

  let proc: ReturnType<typeof Bun.spawn>;
  try {
    proc = Bun.spawn(["bash", "-lc", command], {
      env,
      stdout: "pipe",
      stderr: "pipe",
      stdin: "ignore",
      ...(args.cwd !== undefined ? { cwd: args.cwd } : {}),
    });
  } catch (e) {
    // Spawn errors describe the failure (e.g. ENOENT for a bad cwd) and never
    // contain env values.
    const msg = e instanceof Error ? e.message : String(e);
    return {
      ok: false,
      error: `failed to spawn subprocess: ${msg}`,
      injected_keys: keys,
    };
  }

  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    proc.kill();
  }, timeout * 1000);

  let stdoutText = "";
  let stderrText = "";
  let exitCode = -1;
  try {
    const stdoutStream = proc.stdout as ReadableStream<Uint8Array>;
    const stderrStream = proc.stderr as ReadableStream<Uint8Array>;
    const [stdout, stderr, exited] = await Promise.all([
      new Response(stdoutStream).text(),
      new Response(stderrStream).text(),
      proc.exited,
    ]);
    stdoutText = stdout;
    stderrText = stderr;
    exitCode = exited;
  } finally {
    clearTimeout(timer);
  }

  if (timedOut) {
    return {
      ok: false,
      error: `command exceeded timeout of ${timeout}s`,
      injected_keys: keys,
    };
  }

  return {
    ok: true,
    exit_code: exitCode,
    stdout: scrub(stdoutText, secretsOnly),
    stderr: scrub(stderrText, secretsOnly),
    injected_keys: keys,
  };
}
