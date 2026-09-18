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
  provider: "ollama",
  model: "qwen2.5:1.5b",
  providers: {
    ollama: {
      type: "openai-compatible",
      baseURL: "http://127.0.0.1:11434/v1",
      apiKeyEnv: "",
      timeoutMs: 240000,
      timeoutIdleMs: 120000,
      models: ["qwen2.5:1.5b", "llama3.1"],
    },
  },
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
    const user = loadJsonFile<Partial<RootConfig>>(effectiveFile);
    return deepMerge(base, user);
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