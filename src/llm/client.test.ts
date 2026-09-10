import { describe, expect, test } from "bun:test";
import { createProvider, type RootConfig } from "./client";

function config(overrides?: { provider?: string; openai?: string[]; anthropic?: string[]; ollama?: string[] }): RootConfig {
  return {
    provider: overrides?.provider ?? "groq",
    model: "qwen/qwen3.8-27b",
    providers: {
      groq: {
        type: "openai-compatible",
        baseURL: "https://api.groq.com/openai/v1",
        apiKeyEnv: "GROQ_API_KEY",
        models: ["qwen/qwen3.8-27b", "openai/gpt-oss-120b"],
      },
      ollama: {
        type: "openai-compatible",
        baseURL: "http://localhost:11434/v1",
        apiKeyEnv: "",
        models: overrides?.ollama ?? ["qwen2.5:1.5b", "llama3.1"],
      },
      openai: {
        type: "openai-compatible",
        baseURL: "https://api.openai.com/v1",
        apiKeyEnv: "OPENAI_API_KEY",
        models: overrides?.openai ?? ["gpt-4o", "gpt-4o-mini"],
      },
      anthropic: {
        type: "anthropic",
        baseURL: "https://api.anthropic.com/v1",
        apiKeyEnv: "ANTHROPIC_API_KEY",
        models: overrides?.anthropic ?? ["claude-sonnet-4-5", "claude-3-5-haiku-latest"],
      },
    },
  };
}

describe("createProvider", () => {
  test("default provider returns the configured model", () => {
    const cfg = config();
    const { model, name } = createProvider(cfg);
    expect(name).toBe("groq");
    expect(model).toBe("qwen/qwen3.8-27b");
  });

  test("switching provider picks its first model by default", () => {
    const cfg = config();
    const { model, name } = createProvider(cfg, "openai");
    expect(name).toBe("openai");
    expect(model).toBe("gpt-4o");
  });

  test("switching to anthropic picks its first model", () => {
    const cfg = config();
    const { model, name } = createProvider(cfg, "anthropic");
    expect(name).toBe("anthropic");
    expect(model).toBe("claude-sonnet-4-5");
  });

  test("switching to ollama picks its first model", () => {
    const cfg = config();
    const { model, name } = createProvider(cfg, "ollama");
    expect(name).toBe("ollama");
    expect(model).toBe("qwen2.5:1.5b");
  });

  test("keeps the configured model if it is valid for the target provider", () => {
    const cfg = config({ openai: ["qwen/qwen3.8-27b", "gpt-4o"] });
    const { model, name } = createProvider(cfg, "openai");
    expect(name).toBe("openai");
    expect(model).toBe("qwen/qwen3.8-27b");
  });

  test("falls back to provider's first model when configured model is missing", () => {
    const cfg = config({ openai: ["gpt-4o"] });
    const { model, name } = createProvider(cfg, "openai");
    expect(name).toBe("openai");
    expect(model).toBe("gpt-4o");
  });

  test("throws for an unknown provider name", () => {
    const cfg = config();
    expect(() => createProvider(cfg, "nonexistent")).toThrow("Unknown provider");
  });
});
