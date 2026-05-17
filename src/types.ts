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
export type RunErr = Err & { injected_keys?: string[] };
export type RunResult = RunOk | RunErr;

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
