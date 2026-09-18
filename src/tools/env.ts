import { registerTool, type ToolContext } from "./registry";
import { join as pathJoin } from "node:path";

/**
 * Read and write environment variables to the project's gitignored `.env` file.
 * Useful on phones where editing .env by hand is clunky. Values are masked in
 * output; binary names are checked with `which`.
 *
 * `env_get(key)` — read a value (masked display).
 * `env_set(key, value)` — write/update a key in .env (creates the file if needed).
 * `env_list()` — list keys (values shown as [set]/[not set]).
 */

const ENV_FILE = (() => {
  const override = process.env.VIBECODER_ENV_FILE;
  if (override) return override;
  const repoRoot = pathJoin(import.meta.dir, "..", "..");
  return pathJoin(repoRoot, ".env");
})();

async function readEnv(): Promise<Record<string, string>> {
  try {
    const text = await Bun.file(ENV_FILE).text();
    const out: Record<string, string> = {};
    for (const line of text.split("\n")) {
      const m = line.match(/^([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
      if (m) out[m[1]] = m[2];
    }
    return out;
  } catch {
    return {};
  }
}

async function writeEnv(dict: Record<string, string>): Promise<void> {
  const lines = Object.entries(dict)
    .filter(([, v]) => true)
    .map(([k, v]) => `${k}=${v}`)
    .join("\n");
  await Bun.write(ENV_FILE, lines + "\n");
}

function mask(v: string): string {
  if (!v) return "(not set)";
  if (v.length <= 4) return "****";
  return v.slice(0, 2) + "****" + (v.length > 6 ? v.slice(-2) : "");
}

async function whichBin(name: string): Promise<boolean> {
    try {
    const proc = Bun.spawn({
      cmd: ["which", name],
      stdout: "pipe",
      stderr: "pipe",
      detached: true,
    });
    const [out, exitCode] = await Promise.all([
      new Response(proc.stdout).text(),
      proc.exited,
    ]);
    return exitCode === 0 && out.trim().length > 0;
  } catch {
    return false;
  }
}

registerTool({
  definition: {
    type: "function",
    function: {
      name: "env_get",
      description:
        "Read an environment variable from the project's gitignored .env file. Values are masked in the output for safety. Returns the key, whether it is set, and a masked value.",
      parameters: {
        type: "object",
        properties: {
          key: { type: "string", description: "Environment variable name to read (required)" },
        },
        required: ["key"],
      },
    },
  },
  async run(args: Record<string, unknown>, ctx: ToolContext): Promise<string> {
    const key = String(args.key ?? "").trim();
    if (!key) return "ERROR: key is required";
    const env = await readEnv();
    const val = env[key] ?? "";
    const present = await whichBin(key.toLowerCase()) || val.length > 0;
    return `${key}: ${present ? "set" : "not set"}\n  value: ${mask(val)}`;
  },
});

registerTool({
  definition: {
    type: "function",
    function: {
      name: "env_set",
      description:
        "Set or update an environment variable in the project's gitignored .env file. The value is stored (not shown back for safety). Use env_get to confirm.",
      parameters: {
        type: "object",
        properties: {
          key: { type: "string", description: "Environment variable name (required)" },
          value: { type: "string", description: "Value to store (required; kept private — not echoed back)" },
        },
        required: ["key", "value"],
      },
    },
  },
  async run(args: Record<string, unknown>, ctx: ToolContext): Promise<string> {
    const key = String(args.key ?? "").trim();
    const value = String(args.value ?? "");
    if (!key) return "ERROR: key is required";
    const env = await readEnv();
    env[key] = value;
    await writeEnv(env);
    return `Set ${key} in .env (value stored, not echoed for safety). Run env_get("${key}") to confirm.`;
  },
});

registerTool({
  definition: {
    type: "function",
    function: {
      name: "env_list",
      description:
        "List environment variables from the project's .env file. Shows which keys are set (values masked). Useful for checking whether API keys are configured before running tasks.",
      parameters: { type: "object", properties: {} },
    },
  },
  async run(_args: Record<string, unknown>, ctx: ToolContext): Promise<string> {
    const env = await readEnv();
    const keys = Object.keys(env).sort();
    if (!keys.length) return "(no .env file or no variables set)";
    const binMap: Record<string, boolean> = {};
    for (const k of keys) binMap[k] = await whichBin(k.toLowerCase());
    return keys.map((k) => `  ${k}: ${mask(env[k])}${binMap[k] ? "  [bin found]" : ""}`).join("\n");
  },
});
