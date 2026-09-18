import { describe, expect, test, afterEach, beforeEach } from "bun:test";
import { deepMerge, isPlainObject, loadConfig, configPaths, FALLBACK_CONFIG } from "./config";
import { writeFileSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "vc-config-test-"));
});

afterEach(() => {
  if (dir) rmSync(dir, { recursive: true, force: true });
  delete process.env.VIBECODER_CONFIG;
  delete process.env.VIBECODER_SESSION_DIR;
});

describe("deepMerge", () => {
  test("nested objects merge recursively", () => {
    const merged = deepMerge<Record<string, unknown>>({ a: { b: 1, c: 2 } }, { a: { c: 3, d: 4 } });
    expect(merged.a).toEqual({ b: 1, c: 3, d: 4 });
  });

  test("user (override) arrays replace builtin arrays", () => {
    const merged = deepMerge({ tools: { allow: ["a"] } }, { tools: { allow: ["b", "c"] } } as Record<string, unknown>);
    expect(merged.tools.allow).toEqual(["b", "c"]);
  });

  test("null override values delete keys", () => {
    const merged = deepMerge({ a: { b: 1, c: 2 } }, { a: { b: null } } as Record<string, unknown>);
    expect(merged.a.b).toBeUndefined();
    expect(merged.a.c).toBe(2);
  });

  test("does not mutate either input", () => {
    const base = { a: { b: 1 } };
    const over = { a: { c: 2 } };
    deepMerge(base, over);
    expect(base).toEqual({ a: { b: 1 } });
    expect(over).toEqual({ a: { c: 2 } });
  });
});

describe("isPlainObject", () => {
  test("classifies plain objects and non-objects", () => {
    expect(isPlainObject({})).toBe(true);
    expect(isPlainObject([])).toBe(false);
    expect(isPlainObject(null)).toBe(false);
    expect(isPlainObject("x")).toBe(false);
    expect(isPlainObject(new Date())).toBe(false);
  });
});

describe("loadConfig", () => {
  test("uses builtin defaults when no user file exists", async () => {
    process.env.VIBECODER_SESSION_DIR = dir;
    const cfg = await loadConfig();
    expect(cfg.provider).toBe(FALLBACK_CONFIG.provider);
    expect(cfg.model).toBe(FALLBACK_CONFIG.model);
  });

  test("VIBECODER_CONFIG is a full takeover, not a merge", async () => {
    const custom = join(dir, "custom.json");
    writeFileSync(custom, JSON.stringify({ provider: "groq", model: "llama-x" }));
    process.env.VIBECODER_CONFIG = custom;
    const info = configPaths();
    expect(info.effectiveFile).toBe(custom);
    expect(info.merged).toBe(false);
    const cfg = await loadConfig();
    expect(cfg.provider).toBe("groq");
    expect(cfg.model).toBe("llama-x");
  });

  test("reads a config file directly", async () => {
    const custom = join(dir, "direct.json");
    writeFileSync(custom, JSON.stringify({ provider: "openai", model: "gpt-x" }));
    const cfg = await loadConfig(custom);
    expect(cfg.provider).toBe("openai");
    expect(cfg.model).toBe("gpt-x");
  });

  test("user file deep-merges over builtin defaults through the live load path", async () => {
    process.env.VIBECODER_SESSION_DIR = dir;
    writeFileSync(join(dir, "config.json"), JSON.stringify({ model: "merged-model" }));
    const info = configPaths();
    expect(info.merged).toBe(true);
    const cfg = await loadConfig();
    expect(cfg.model).toBe("merged-model");
    expect(cfg.provider).toBe(FALLBACK_CONFIG.provider);
  });

  test("missing user file is tolerated and reported as not merged", async () => {
    process.env.VIBECODER_SESSION_DIR = dir;
    const info = configPaths();
    expect(info.merged).toBe(false);
    expect(info.userFile).toBe(join(dir, "config.json"));
    const cfg = await loadConfig();
    expect(cfg.provider).toBe(FALLBACK_CONFIG.provider);
  });
});