import type { GetPromptResult } from "@modelcontextprotocol/sdk/types.js";
import * as z from "zod/v4";

// Prompts are user-invokable templates. They surface as / commands in clients
// like Claude Code, distinct from tools (LLM-invoked). Each prompt returns a
// single user-role message that briefs the agent on the workflow; the agent
// then drives the actual tool calls (save_env, list_envs, …).

export const importEnvFilePrompt = {
  name: "import-env-file",
  config: {
    title: "Import .env file",
    description:
      "Bulk-import env vars from a .env file. Walks the agent through " +
      "filtering placeholders, classifying secret vs plain, and saving each.",
    argsSchema: {
      path: z.string().describe("Absolute or working-directory-relative path to a .env file."),
    },
  },
  handler: ({ path }: { path: string }): GetPromptResult => ({
    messages: [
      {
        role: "user",
        content: {
          type: "text",
          text:
            `Import env vars from \`${path}\` into mcp-env-keychain.\n\n` +
            `Steps:\n` +
            `1. Read \`${path}\` and parse \`KEY=VALUE\` lines (ignore blanks, comments starting with #).\n` +
            `2. Drop entries whose value is empty, a placeholder ` +
            `(\`changeme\`, \`xxx\`, \`your-...\`, \`<...>\`, \`$HOME\`, \`${"${...}"}\`, \`%(...)s\`, etc.), ` +
            `or otherwise clearly templated.\n` +
            `3. Classify each remaining var:\n` +
            `   - \`secret\` if the name contains KEY/TOKEN/SECRET/PASS/PWD/CRED/AUTH, ` +
            `or the value looks like a credential (long hex, JWT-shaped, sk_*, ghp_*, etc.).\n` +
            `   - \`plain\` for URLs, hostnames, usernames, ports, region codes, feature flags.\n` +
            `4. Call \`save_env({name, value, kind})\` for each. If a name looks ` +
            `like a secret but you passed \`kind='plain'\`, the save will be ` +
            `refused — re-call with \`kind='secret'\` (or rename the var).\n` +
            `5. Report a final summary: imported (count), skipped (count + reasons), failed (count + reasons).\n\n` +
            `Do not echo any value into the chat — only names.`,
        },
      },
    ],
  }),
} as const;

export const auditStalePrompt = {
  name: "audit-stale",
  config: {
    title: "Audit stale credentials",
    description:
      "List entries whose updated_at is older than N days, so you can rotate or delete them.",
    argsSchema: {
      days: z
        .string()
        .describe(
          "Entries older than this many days are reported. Prompt args are strings; " +
            "parse to an integer. Default to 90 if omitted or unparseable.",
        ),
    },
  },
  handler: ({ days }: { days: string }): GetPromptResult => {
    const parsed = Number.parseInt(days, 10);
    const cutoffDays = Number.isFinite(parsed) && parsed > 0 ? parsed : 90;
    return {
      messages: [
        {
          role: "user",
          content: {
            type: "text",
            text:
              `Audit mcp-env-keychain entries older than ${cutoffDays} days.\n\n` +
              `Steps:\n` +
              `1. Call \`list_envs\` to get all entries with their kinds and timestamps.\n` +
              `2. Compute the cutoff: now - ${cutoffDays} days.\n` +
              `3. Filter to entries where \`updated_at < cutoff\`.\n` +
              `4. Report a table sorted by age desc: name, kind, age in days. ` +
              `Group by kind so secrets are visible at the top — those are the credential-rotation candidates.\n` +
              `5. Do NOT call \`get_plain\` or \`run_with_secrets\` — only metadata is needed here.\n\n` +
              `If nothing is stale, say so.`,
          },
        },
      ],
    };
  },
} as const;
