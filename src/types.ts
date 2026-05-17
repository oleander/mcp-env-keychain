import * as z from "zod/v4";

export const KindSchema = z.enum(["plain", "secret"]);
export type Kind = z.infer<typeof KindSchema>;

export type Entry = {
  kind: Kind;
  created_at: string;
  updated_at: string;
};

export type Index = {
  entries: Record<string, Entry>;
};

export type Ok<T> = { ok: true } & T;
export type Err = { ok: false; error: string };
export type Result<T> = Ok<T> | Err;

export type CatalogEntry = Entry & { name: string };
export type Catalog = { count: number; entries: CatalogEntry[] };

export type SaveEnvResult = Result<{ name: string; kind: Kind }>;
export type ListEnvsResult = Catalog;
export type FindEnvsResult = { pattern: string; count: number; entries: CatalogEntry[] };
export type GetPlainResult = Result<{ name: string; kind: "plain"; value: string }>;
export type DeleteEnvResult = Result<{ name: string }>;

export type EnvMetadata = { name: string; kind: Kind; created_at: string; updated_at: string };

export type RunOk = Ok<{
  exit_code: number;
  stdout: string;
  stderr: string;
  injected_keys: string[];
}>;
// RunErr can carry partial output on timeout — what the subprocess printed
// before being killed is exactly what the user needs to debug.
export type RunErr = Err & {
  injected_keys?: string[];
  stdout?: string;
  stderr?: string;
};
export type RunResult = RunOk | RunErr;

// ---- Output schemas (zod) ----
//
// MCP requires structuredContent to be a JSON-schema "object" at the top
// level, so each output schema is a flat z.object. Variant-specific fields
// are optional and discriminated at runtime by `ok`. The richer Result<T>
// invariant lives in the TS types above — readers should treat the runtime
// payload as `Result<...>` and not rely on JSON-schema discriminators.

const CatalogEntrySchema = z.object({
  name: z.string(),
  kind: KindSchema,
  created_at: z.string(),
  updated_at: z.string(),
});

export const SaveEnvOutput = z.object({
  ok: z.boolean(),
  name: z.string().optional(),
  kind: KindSchema.optional(),
  error: z.string().optional(),
});

export const ListEnvsOutput = z.object({
  count: z.number().int().nonnegative(),
  entries: z.array(CatalogEntrySchema),
});

export const FindEnvsOutput = z.object({
  pattern: z.string(),
  count: z.number().int().nonnegative(),
  entries: z.array(CatalogEntrySchema),
});

export const GetPlainOutput = z.object({
  ok: z.boolean(),
  name: z.string().optional(),
  kind: z.literal("plain").optional(),
  value: z.string().optional(),
  error: z.string().optional(),
});

export const DeleteEnvOutput = z.object({
  ok: z.boolean(),
  name: z.string().optional(),
  error: z.string().optional(),
});

export const RunWithSecretsOutput = z.object({
  ok: z.boolean(),
  exit_code: z.number().int().optional(),
  stdout: z.string().optional(),
  stderr: z.string().optional(),
  injected_keys: z.array(z.string()).optional(),
  error: z.string().optional(),
});

// ---- Persisted index schema ----
//
// Validated on every loadIndex. A corrupt file is backed up and we start
// fresh — bricking the server on a hand-edit isn't worth it.
const EntrySchema = z.object({
  kind: KindSchema,
  created_at: z.string(),
  updated_at: z.string(),
});

export const IndexSchema = z.object({
  entries: z.record(z.string(), EntrySchema),
});

export const SaveEnvInput = z.object({
  name: z.string(),
  value: z.string(),
  kind: KindSchema,
});

export const FindEnvsInput = z.object({ pattern: z.string() });

export const GetPlainInput = z.object({ name: z.string() });

export const DeleteEnvInput = z.object({ name: z.string() });

export const RunWithSecretsInput = z.object({
  command: z.string(),
  env_keys: z.array(z.string()),
  cwd: z.string().optional(),
  timeout: z.number().int().positive().default(60),
});

export const ListEnvsInput = z.object({});

export type SaveEnvArgs = z.infer<typeof SaveEnvInput>;
export type FindEnvsArgs = z.infer<typeof FindEnvsInput>;
export type GetPlainArgs = z.infer<typeof GetPlainInput>;
export type DeleteEnvArgs = z.infer<typeof DeleteEnvInput>;
export type RunWithSecretsArgs = z.infer<typeof RunWithSecretsInput>;
