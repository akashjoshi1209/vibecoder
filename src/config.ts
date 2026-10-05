// Config resolution. Any user can customize vibecoder without touching the
// installed package: settings in ~/.vibecoder/config.json are deep-merged over
// the built-in defaults (the package's config.json). Point VIBECODER_CONFIG at
// a file to take full ownership (that file is used exactly as-is, no merge).
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { RootConfig } from "./llm/client";
import { resolvePackageFile } from "./paths";

export interface ConfigPaths {
  /** Built-in defaults shipped with the package (null if not found). */
  builtin: string | null;
  /** The file whose contents represent the live config. */
  effectiveFile: string;
  /** The user-owned config file, or null when VIBECODER_CONFIG takes over. */
  userFile: string | null;
  /** True when the live config is built-in defaults merged with a user file. */
  merged: boolean;
}

export const FALLBACK_CONFIG: RootConfig = {
  provider: "groq",
  model: "qwen/qwen3.8-27b",
  providers: {
    groq: {
      type: "openai-compatible",
      baseURL: "https://api.groq.com/openai/v1",
      apiKeyEnv: "GROQ_API_KEY",
      timeoutMs: 240000,
      timeoutIdleMs: 120000,
      models: ["qwen/qwen3.8-27b", "openai/gpt-oss-120b", "openai/gpt-oss-20b"],
    },
    nvidia: {
      type: "openai-compatible",
      baseURL: "https://api.nvidia.com/v1",
      apiKeyEnv: "NVIDIA_API_KEY",
      timeoutMs: 240000,
      timeoutIdleMs: 120000,
      models: ["nvidia/nemotron-3-ultra-550b-a55b"],
    },
    ollama: {
      type: "openai-compatible",
      baseURL: "http://127.0.0.1:11434/v1",
      apiKeyEnv: "",
      timeoutMs: 240000,
      timeoutIdleMs: 120000,
      models: ["qwen2.5:1.5b", "llama3.1"],
    },
  },
  permissions: {
    destructive: "allow",
    network: "allow",
    filesystem: "full",
  },
  /** Optional per-session cost cap in USD. When set, the agent stops after the
   *  cumulative estimated cost exceeds this value. Default: undefined (no cap). */
  maxCostUsd: undefined,
};

export function userConfigFile(): string {
  const sessionDir = process.env.VIBECODER_SESSION_DIR;
  if (sessionDir) return join(sessionDir, "config.json");
  return join(homedir(), ".vibecoder", "config.json");
}

export function configPaths(): ConfigPaths {
  const envConfig = process.env.VIBECODER_CONFIG;
  if (envConfig) {
    return { builtin: null, effectiveFile: envConfig, userFile: null, merged: false };
  }
  const builtin = resolvePackageFile("config.json");
  const userFile = userConfigFile();
  if (existsSync(userFile)) {
    return { builtin, effectiveFile: userFile, userFile, merged: true };
  }
  return { builtin, effectiveFile: builtin ?? userFile, userFile, merged: false };
}

export function isPlainObject(v: unknown): v is Record<string, unknown> {
  if (typeof v !== "object" || v === null || Array.isArray(v)) return false;
  const proto = Object.getPrototypeOf(v);
  return proto === Object.prototype || proto === null;
}

/** Validate a config object. Returns an array of human-readable error messages
 *  (empty when valid). Checks only structural rules that would cause runtime
 *  crashes if violated. */
export function validateConfig(cfg: unknown): string[] {
  const errors: string[] = [];
  if (!isPlainObject(cfg)) {
    errors.push("config must be a JSON object (top-level {})");
    return errors;
  }
  const o = cfg as Record<string, unknown>;
  if (typeof o.provider !== "string" || !o.provider) {
    errors.push("config.provider must be a non-empty string (e.g. \"groq\", \"ollama\")");
  }
  if (typeof o.model !== "string" || !o.model) {
    errors.push("config.model must be a non-empty string");
  }
  if (!isPlainObject(o.providers)) {
    errors.push("config.providers must be an object mapping provider names to config");
  } else {
    const providers = o.providers as Record<string, unknown>;
    for (const name of Object.keys(providers)) {
      const p = providers[name];
      if (!isPlainObject(p)) {
        errors.push(`providers."${name}" must be an object`);
        continue;
      }
      const pc = p as Record<string, unknown>;
      if (typeof pc.type !== "string" || !pc.type) {
        errors.push(`providers."${name}".type must be a non-empty string (e.g. "openai-compatible" or "anthropic")`);
      }
      if (typeof pc.baseURL !== "string" || !pc.baseURL) {
        errors.push(`providers."${name}".baseURL must be a non-empty string`);
      }
      if (typeof pc.apiKeyEnv !== "string") {
        errors.push(`providers."${name}".apiKeyEnv must be a string (can be empty for local providers like ollama)`);
      }
      // Bind to a local so the array check narrows for the next line; testing
      // pc.models directly left it as `unknown` and the guard never applied.
      const models: unknown = pc.models;
      if (!Array.isArray(models) || !models.length) {
        errors.push(`providers."${name}".models must be a non-empty array of model IDs`);
      } else if (!models.every((m: unknown) => typeof m === "string")) {
        errors.push(`providers."${name}".models must all be strings`);
      }
    }
  }
  if (o.routing !== undefined) {
    if (!isPlainObject(o.routing)) {
      errors.push("config.routing must be an object");
    } else {
      const r = o.routing as Record<string, unknown>;
      if (typeof r.strategy !== "string" || !["keyword", "hybrid"].includes(r.strategy as string)) {
        errors.push(`config.routing.strategy must be "keyword" or "hybrid"`);
      }
      for (const key of ["chatProvider", "chatModel", "heavyProvider", "heavyModel"] as const) {
        if (r[key] !== undefined && (typeof r[key] !== "string" || !r[key])) {
          errors.push(`config.routing.${key} must be a non-empty string when set`);
        }
      }
    }
  }
  if (o.temperature !== undefined && (typeof o.temperature !== "number" || !isFinite(o.temperature) || o.temperature < 0 || o.temperature > 2)) {
    errors.push("config.temperature must be a number between 0 and 2");
  }
  if (o.maxInputTokens !== undefined && (typeof o.maxInputTokens !== "number" || !isFinite(o.maxInputTokens) || o.maxInputTokens < 1)) {
    errors.push("config.maxInputTokens must be a positive number");
  }
  if (o.maxInputTokensPerMinute !== undefined && (typeof o.maxInputTokensPerMinute !== "number" || !isFinite(o.maxInputTokensPerMinute) || o.maxInputTokensPerMinute < 1)) {
    errors.push("config.maxInputTokensPerMinute must be a positive number");
  }
  if (o.maxCostUsd !== undefined && (typeof o.maxCostUsd !== "number" || !isFinite(o.maxCostUsd) || o.maxCostUsd < 0)) {
    errors.push("config.maxCostUsd must be a non-negative number (e.g. 5 for a $5 cap)");
  }
  if (o.permissions !== undefined) {
    if (!isPlainObject(o.permissions)) {
      errors.push("config.permissions must be an object");
    } else {
      const p = o.permissions as Record<string, unknown>;
      if (p.destructive !== undefined && !["allow", "ask", "deny"].includes(p.destructive as string)) {
        errors.push('config.permissions.destructive must be "allow", "ask", or "deny"');
      }
      if (p.network !== undefined && !["allow", "deny"].includes(p.network as string)) {
        errors.push('config.permissions.network must be "allow" or "deny"');
      }
      if (p.filesystem !== undefined && !["workspace", "full"].includes(p.filesystem as string)) {
        errors.push('config.permissions.filesystem must be "workspace" or "full"');
      }
    }
  }
  return errors;
}

/** Recursive merge: scalars and arrays are replaced; objects merge key-wise. */
export function deepMerge<T>(base: T, override: unknown): T {
  if (override === undefined) return base;
  if (!isPlainObject(base) || !isPlainObject(override)) return override as T;
  const out: Record<string, unknown> = { ...base };
  for (const key of Object.keys(override)) {
    const v = override[key];
    if (v === undefined) continue;
    if (v === null) {
      delete out[key]; // null override deletes the key
      continue;
    }
    out[key] = deepMerge((base as Record<string, unknown>)[key], v);
  }
  return out as T;
}

export function loadJsonFile<T = unknown>(file: string): T {
  return JSON.parse(readFileSync(file, "utf8")) as T;
}

/**
 * Load the live (merged) config. Pass an explicit `path` to load an exact file
 * with no merging (used by tests and VIBECODER_CONFIG handling).
 */
export async function loadConfig(path?: string): Promise<RootConfig> {
  if (path) return loadJsonFile<RootConfig>(path);
  if (process.env.VIBECODER_CONFIG) return loadJsonFile<RootConfig>(process.env.VIBECODER_CONFIG);
  const { builtin, effectiveFile, merged } = configPaths();
  const base = builtin ? loadJsonFile<RootConfig>(builtin) : FALLBACK_CONFIG;
  if (merged) {
    const raw = loadJsonFile<Partial<RootConfig>>(effectiveFile);
    const mergedCfg = deepMerge(base, raw);
    const errors = validateConfig(mergedCfg);
    if (errors.length) {
      const userFile = configPaths().userFile;
      const where = userFile ? ` in ${userFile}` : "";
      throw new Error(
        `config.json has problems that would crash vibecoder:${where}\n  ${errors.join("\n  ")}\n  Fix the file above and restart.`,
      );
    }
    return mergedCfg;
  }
  return base;
}

export async function loadConfigInfo(): Promise<{ config: RootConfig; paths: ConfigPaths }> {
  const paths = configPaths();
  const config = await loadConfig();
  return { config, paths };
}

/** Write (or rewrite) the user config file, creating ~/.vibecoder. */
export function writeUserConfig(config: RootConfig): string {
  const file = userConfigFile();
  mkdirSync(join(homedir(), ".vibecoder"), { recursive: true });
  writeFileSync(file, JSON.stringify(config, null, 2) + "\n", "utf8");
  return file;
}