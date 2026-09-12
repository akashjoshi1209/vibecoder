import { describe, expect, test, afterEach } from "bun:test";
import { OpenAICompatibleProvider } from "./openai-compatible";
import { AnthropicProvider } from "./anthropic";
import { ContextTooLargeError, type ProviderConfig } from "../types";

const originalFetch = globalThis.fetch;

function fakeFetch(status: number, body: string): void {
  globalThis.fetch = (async () => {
    return {
      status,
      ok: status >= 200 && status < 300,
      text: async () => body,
      body: null,
    } as any;
  }) as any;
}

afterEach(() => {
  globalThis.fetch = originalFetch;
});

const groqCfg: ProviderConfig = {
  type: "openai-compatible",
  baseURL: "https://api.groq.com/openai/v1",
  apiKeyEnv: "GROQ_API_KEY",
  models: [],
};

const anthropicCfg: ProviderConfig = {
  type: "anthropic",
  baseURL: "https://api.anthropic.com/v1",
  apiKeyEnv: "ANTHROPIC_API_KEY",
  models: [],
};

const opts = {
  model: "qwen/qwen3.8-27b",
  messages: [{ role: "user" as const, content: "hi" }],
};

describe("413/400 context-too-large mapping", () => {
  test("openai-compatible: 413 throws ContextTooLargeError (Groq body)", async () => {
    process.env.GROQ_API_KEY = "test";
    fakeFetch(
      413,
      '{"error":{"message":"Request too large for model ... on input tokens per minute (ITPM): Limit 7000","type":"tokens","code":"rate_limit_exceeded"}}',
    );
    const p = new OpenAICompatibleProvider(groqCfg);
    await expect(p.streamChat(opts, () => {})).rejects.toBeInstanceOf(ContextTooLargeError);
  });

  test("openai-compatible: 413 without a body still maps to ContextTooLargeError", async () => {
    process.env.GROQ_API_KEY = "test";
    fakeFetch(413, "");
    const p = new OpenAICompatibleProvider(groqCfg);
    await expect(p.streamChat(opts, () => {})).rejects.toBeInstanceOf(ContextTooLargeError);
  });

  test("openai-compatible: 400 with context-length wording maps to ContextTooLargeError", async () => {
    process.env.GROQ_API_KEY = "test";
    fakeFetch(400, "This model's maximum context length is 120000 tokens...");
    const p = new OpenAICompatibleProvider(groqCfg);
    await expect(p.streamChat(opts, () => {})).rejects.toBeInstanceOf(ContextTooLargeError);
  });

  test("openai-compatible: unrelated 400 stays a generic error", async () => {
    process.env.GROQ_API_KEY = "test";
    fakeFetch(400, '{"error":{"message":"bad request"}}');
    const p = new OpenAICompatibleProvider(groqCfg);
    await expect(p.streamChat(opts, () => {})).rejects.not.toBeInstanceOf(ContextTooLargeError);
  });

  test("anthropic: prompt_too_long maps to ContextTooLargeError", async () => {
    process.env.ANTHROPIC_API_KEY = "test";
    fakeFetch(400, '{"type":"error","error":{"type":"invalid_request_error","message":"prompt_too_long"}}');
    const p = new AnthropicProvider(anthropicCfg);
    await expect(p.streamChat(opts, () => {})).rejects.toBeInstanceOf(ContextTooLargeError);
  });

  test("anthropic: unrelated 400 stays a generic error", async () => {
    process.env.ANTHROPIC_API_KEY = "test";
    fakeFetch(400, '{"type":"error","error":{"type":"invalid_request_error","message":"invalid x-api-key"}}');
    const p = new AnthropicProvider(anthropicCfg);
    await expect(p.streamChat(opts, () => {})).rejects.not.toBeInstanceOf(ContextTooLargeError);
  });

  test("error carries the status code", async () => {
    process.env.GROQ_API_KEY = "test";
    fakeFetch(413, "too large");
    const p = new OpenAICompatibleProvider(groqCfg);
    try {
      await p.streamChat(opts, () => {});
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(ContextTooLargeError);
      expect((err as ContextTooLargeError).status).toBe(413);
    }
  });
});