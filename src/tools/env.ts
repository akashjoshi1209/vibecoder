import { registerTool, type ToolContext } from "./registry";
import { join as pathJoin, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { spawn } from "node:child_process";

const _repoRoot = (() => {
  try {
    const file = fileURLToPath(import.meta.url);
    let dir = dirname(file);
    for (let i = 0; i < 10; i++) {
      if (existsSync(pathJoin(dir, "package.json")) || existsSync(pathJoin(dir, ".git"))) {
        return dir;
      }
      dir = dirname(dir);
    }
    return pathJoin(process.cwd(), "..", "..");
  } catch {
    return pathJoin(process.cwd(), "..", "..");
  }
})();

const ENV_FILE = (() => {
  const override = process.env.VIBECODER_ENV_FILE;
  if (override) return override;
  return pathJoin(_repoRoot, ".env");
})();

async function readEnv(): Promise<Record<string, string>> {
  try {
    const text = await readFile(ENV_FILE, "utf8");
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
  await writeFile(ENV_FILE, lines + "\n");
}

function mask(v: string): string {
  if (!v) return "(not set)";
  if (v.length <= 4) return "****";
  return v.slice(0, 2) + "****" + (v.length > 6 ? v.slice(-2) : "");
}

async function whichBin(name: string): Promise<boolean> {
  try {
    const child = spawn("which", [name], {
      stdio: ["ignore", "pipe", "pipe"],
      detached: true,
    });
    let stdout = "";
    let stderr = "";
    const p = new Promise<void>((resolve) => {
      child.stdout?.on("data", (d: Buffer) => (stdout += d.toString()));
      child.stderr?.on("data", (d: Buffer) => (stderr += d.toString()));
      child.on("close", () => resolve());
    });
    await p;
    return child.exitCode === 0 && stdout.trim().length > 0;
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
    const present = val.length > 0;
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
    return keys.map((k) => `  ${k}: ${mask(env[k])}`).join("\n");
  },
});

registerTool({
  definition: {
    type: "function",
    function: {
      name: "env_check",
      description:
        "Check whether a list of required environment variables are set in .env. Returns a report: which are set (masked), which are missing, and a pass/fail verdict. Use before a task that depends on specific keys.",
      parameters: {
        type: "object",
        properties: {
          keys: { type: "array", items: { type: "string" }, description: "List of env var names to check (required)" },
        },
        required: ["keys"],
      },
    },
  },
  async run(args: Record<string, unknown>, ctx: ToolContext): Promise<string> {
    const keys = (args.keys as string[] | undefined)?.filter((k) => typeof k === "string" && k.trim()) ?? [];
    if (!keys.length) return "ERROR: keys list is required and must be non-empty";
    const env = await readEnv();
    const missing: string[] = [];
    const present: string[] = [];
    for (const k of keys) {
      const v = env[k.trim()] ?? "";
      if (v) present.push(k.trim()); else missing.push(k.trim());
    }
    const lines: string[] = [];
    lines.push(`env_check: ${present.length}/${keys.length} set`);
    if (present.length) {
      lines.push("set:");
      for (const k of present) lines.push(`  ${k}: ${mask(env[k])}`);
    }
    if (missing.length) {
      lines.push("missing:");
      for (const k of missing) lines.push(`  ${k}: (not set)`);
    }
    if (missing.length) lines.push("\nVERDICT: FAIL — the following are missing and must be set before proceeding: " + missing.join(", "));
    else lines.push("\nVERDICT: PASS — all required keys are set");
    return lines.join("\n");
  },
});

registerTool({
  definition: {
    type: "function",
    function: {
      name: "env_require",
      description:
        "Require that a single environment variable is set in .env. Fails loudly with an actionable message if it is missing. Use at the start of a task that cannot proceed without a specific key (e.g. an API key).",
      parameters: {
        type: "object",
        properties: {
          key: { type: "string", description: "Environment variable name that must be set (required)" },
        },
        required: ["key"],
      },
    },
  },
  async run(args: Record<string, unknown>, ctx: ToolContext): Promise<string> {
    const key = String(args.key ?? "").trim();
    if (!key) return "ERROR: key is required";
    const env = await readEnv();
    const v = env[key] ?? "";
    if (!v) return `FAIL: ${key} is not set in .env. Set it with env_set("${key}", "<value>") then re-run.`;
    return `OK: ${key} is set (masked: ${mask(v)})`;
  },
});
