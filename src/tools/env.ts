import { registerTool, type ToolContext } from "./registry";
import { join as pathJoin, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { readFile, writeFile, rename } from "node:fs/promises";
import { existsSync, realpathSync } from "node:fs";
import { spawn } from "node:child_process";
import { registerTool as _registerTool } from "./registry";

/** Plan mode is a read-only investigation phase. env_set writes to disk, so it
 *  has to be refused there — it previously had no planPhase check at all and
 *  happily wrote during plan mode. */
function envPlanBlocked(ctx: { planPhase?: boolean }): string | null {
  return ctx.planPhase
    ? "BLOCKED IN PLAN MODE (read-only): env_set is disabled while investigating. Record the intended environment change in your PLAN instead; the human approves before anything is written."
    : null;
}

/**
 * Locate the project root that owns `.env`.
 *
 * This walks up from *this module's* file looking for a project marker, which
 * is wrong in two ways that bit us during testing:
 *
 *  1. The walk is unbounded across the filesystem, so a symlinked or junctioned
 *     parent (e.g. a `node_modules` junction pointing at another checkout)
 *     can redirect it to a *different* repository's root. A write meant for a
 *     sandbox then landed on the real `.env`.
 *  2. It resolves relative to the installed module, not the session. In a
 *     globally-linked install the package lives somewhere unrelated to the
 *     project the user is working on.
 *
 * Preference order is now: explicit override, then the session cwd, and only
 * then the module location. The module walk also refuses to cross a symlink and
 * stops at the filesystem root.
 */
const _repoRoot = (() => {
  const from = (start: string): string | null => {
    try {
      let dir = resolve(start);
      for (let i = 0; i < 10; i++) {
        if (existsSync(pathJoin(dir, "package.json")) || existsSync(pathJoin(dir, ".git"))) {
          return dir;
        }
        const parent = dirname(dir);
        if (parent === dir) return null;
        // Do not climb through a link: that is how the walk escaped a sandbox.
        try {
          if (realpathSync.native(dir) !== resolve(dir)) return null;
        } catch {
          return null;
        }
        dir = parent;
      }
      return null;
    } catch {
      return null;
    }
  };
  // A session-scoped install (VIBECODER_SESSION_DIR) or a cwd that is itself a
  // project wins, so a linked global install still edits the right .env.
  return from(process.cwd()) ?? from(dirname(fileURLToPath(import.meta.url))) ?? process.cwd();
})();

/** Path to the .env this tool reads and writes. Evaluated per call rather than
 *  cached at import time so VIBECODER_ENV_FILE stays overridable (tests, and
 *  any caller that relocates the file after startup). */
export function envPath(): string {
  const override = process.env.VIBECODER_ENV_FILE;
  if (override) return override;
  return pathJoin(_repoRoot, ".env");
}

/** Parse dotenv text. Tolerates CRLF (Windows-authored files, which previously
 *  made every key read back as "not set" because the value kept its `\r`) and
 *  strips surrounding quotes so masking does not expose the quote character. */
export function parseEnv(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const m = line.match(/^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
    if (!m) continue;
    let value = m[2].trim();
    if (value.length > 1 && value.startsWith('"') && value.endsWith('"')) {
      // Double-quoted values may carry JSON-style escapes, which is what
      // formatEnv writes. Unescape them so a value round-trips unchanged.
      try {
        value = JSON.parse(value) as string;
      } catch {
        value = value.slice(1, -1);
      }
    } else if (value.length > 1 && value.startsWith("'") && value.endsWith("'")) {
      // Single quotes are literal in dotenv: no escape processing.
      value = value.slice(1, -1);
    }
    out[m[1]] = value;
  }
  return out;
}

/** Serialise back to dotenv, quoting values that need it. */
export function formatEnv(dict: Record<string, string>): string {
  // Only quote when the value actually needs it. Quoting everything would
  // still round-trip through parseEnv, but it makes the file hostile to
  // anything else that reads it (docker-compose, CI runners, other tools).
  const needsQuote = (v: string) => v === "" || /[\s"'#$`\\]/.test(v);
  return (
    Object.entries(dict)
      .map(([k, v]) => `${k}=${needsQuote(v) ? JSON.stringify(v) : v}`)
      .join("\n") + "\n"
  );
}

async function readEnv(): Promise<Record<string, string>> {
  try {
    return parseEnv(await readFile(envPath(), "utf8"));
  } catch {
    return {};
  }
}

/**
 * Merge `updates` into the existing .env.
 *
 * This used to serialise only the keys the caller had in hand, so any key that
 * failed to parse was silently dropped on write — a partial read destroyed
 * unrelated secrets. Now it re-reads, merges, and writes atomically.
 */
async function mergeEnv(updates: Record<string, string>): Promise<void> {
  const file = envPath();
  const current = await readEnv();
  const merged = { ...current, ...updates };
  const tmp = file + ".tmp";
  await writeFile(tmp, formatEnv(merged), "utf8");
  await rename(tmp, file);
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
    const blocked = envPlanBlocked(ctx);
    if (blocked) return blocked;
    const key = String(args.key ?? "").trim();
    const value = String(args.value ?? "");
    if (!key) return "ERROR: key is required";
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) {
      return `ERROR: "${key}" is not a valid environment variable name (letters, digits and underscore only; cannot start with a digit)`;
    }
    if (/[\r\n]/.test(value)) return "ERROR: value cannot contain newlines";
    await mergeEnv({ [key]: value });
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
