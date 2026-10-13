// Two contract changes that came out of the "cannot build websites" diagnosis:
//
// 1. A 429 whose reset window is minutes-to-hours (daily/hourly token quotas,
//    e.g. Groq TPD) must fail FAST as a typed RateLimitError instead of
//    sleeping through three pointless retries.
// 2. The agent loop must (a) surface the provider's own error text instead of
//    a bare "LLM call failed", and (b) offer onProviderFailover a chance to
//    continue the turn on another configured provider.
import { describe, expect, test, afterEach } from "bun:test";
import { OpenAICompatibleProvider } from "../llm/providers/openai-compatible";
import { RateLimitError, type ProviderConfig } from "../llm/types";
import { runAgent } from "./loop";
import type { ToolContext } from "../tools/registry";
import type { ChatOptions, ChatChunk, StreamResult } from "../llm/types";

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

const cfg: ProviderConfig = {
  type: "openai-compatible",
  baseURL: "https://api.groq.com/openai/v1",
  apiKeyEnv: "GROQ_API_KEY",
  models: [],
};

// Real Groq daily-quota (TPD) body: the reset is 27 minutes away — nothing an
// in-process retry can outlast.
const TPD_BODY =
  '{"error":{"message":"Rate limit reached for model `qwen/qwen3.8-27b` on tokens per day (TPD): Limit 200000, Used 199314, Requested 4488. Please try again in 27m22.464s.","type":"tokens","code":"rate_limit_exceeded"}}';

describe("openai-compatible: daily-quota 429 fails fast", () => {
  test("long-window 429 throws RateLimitError on the first response (no retry sleeps)", async () => {
    process.env.GROQ_API_KEY = "test";
    let calls = 0;
    globalThis.fetch = (async () => {
      calls++;
      return {
        status: 429,
        ok: false,
        text: async () => TPD_BODY,
        body: null,
      } as any;
    }) as any;
    const p = new OpenAICompatibleProvider(cfg);
    let err: any;
    try {
      await p.streamChat({ model: "qwen/qwen3.8-27b", messages: [{ role: "user", content: "hi" }] }, () => {});
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(RateLimitError);
    expect(err.longWindow).toBe(true);
    expect(err.message).toContain("TPD");
    // Fail fast: exactly one HTTP call, not maxAttempts sleeps and re-fetches.
    expect(calls).toBe(1);
  }, 20_000);

  test("short-window 429 still retries in-process and ends as a generic error", async () => {
    process.env.GROQ_API_KEY = "test";
    let calls = 0;
    globalThis.fetch = (async () => {
      calls++;
      return {
        status: 429,
        ok: false,
        headers: new Headers(),
        text: async () => "Rate limit reached. Please try again in 0.5s.",
        body: null,
      } as any;
    }) as any;
    const p = new OpenAICompatibleProvider(cfg);
    let err: any;
    try {
      await p.streamChat({ model: "m", messages: [{ role: "user", content: "hi" }] }, () => {});
    } catch (e) {
      err = e;
    }
    expect(err).not.toBeInstanceOf(RateLimitError);
    expect(err.message).toContain("after 3 attempts");
    expect(calls).toBe(3);
  }, 20_000);
});

// ── loop failover ────────────────────────────────────────────────────────────

function failingProvider(msg: string) {
  return async (_opts: ChatOptions, _onChunk: (c: ChatChunk) => void): Promise<StreamResult> => {
    throw new Error(msg);
  };
}

function okProvider(text: string) {
  return async (_opts: ChatOptions, onChunk: (c: ChatChunk) => void): Promise<StreamResult> => {
    onChunk({ content: text });
    return { text, toolCalls: [], finishReason: "stop" };
  };
}

const toolCtx: ToolContext = { cwd: "/tmp" };
const base = {
  systemPrompt: "test",
  model: "primary-model",
  initialMessages: [{ role: "user" as const, content: "build something" }],
  toolCtx,
};

describe("runAgent — error surfacing and provider failover", () => {
  test("final message includes the provider's own error", async () => {
    const result = await runAgent(
      { ...base, provider: failingProvider("Rate limited (HTTP 429): tokens per day (TPD) exceeded") },
      { maxSteps: 10 },
    );
    expect(result.finalText).toContain("consecutive LLM failures");
    expect(result.finalText).toContain("TPD");
  });

  test("failover switches providers mid-turn and reports the new model", async () => {
    let switches = 0;
    const failover = async () => {
      switches++;
      return { provider: okProvider("finished on the fallback"), model: "fallback-model" };
    };
    const result = await runAgent(
      { ...base, provider: failingProvider("quota exhausted"), onProviderFailover: failover },
      { maxSteps: 10 },
    );
    expect(switches).toBe(1);
    expect(result.finalText).toBe("finished on the fallback");
    expect(result.failoverTo).toBe("fallback-model");
  });

  test("long rate-limit window fails over on the FIRST failure, not the third", async () => {
    let switches = 0;
    let attempts = 0;
    const rateLimited = async (
      _o: ChatOptions,
      _c: (c: ChatChunk) => void,
    ): Promise<StreamResult> => {
      attempts++;
      throw new RateLimitError(429, "Rate limited (HTTP 429): TPD exceeded. Try again in 27m22s.", true);
    };
    // The provider throws a long-window RateLimitError; the loop must call the
    // failover hook immediately after that single failed step.
    const failover = async () => {
      switches++;
      return { provider: okProvider("recovered"), model: "fallback-model" };
    };
    const flaky = async (
      o: ChatOptions,
      c: (c: ChatChunk) => void,
    ): Promise<StreamResult> => {
      // First call: long-window 429. Afterwards the (already switched-to)
      // fallback answers; this provider is never consulted again.
      if (attempts === 0) return rateLimited(o, c);
      attempts++;
      return okProvider("recovered")(o, c);
    };
    const result = await runAgent(
      { ...base, provider: flaky, onProviderFailover: failover },
      { maxSteps: 10 },
    );
    // One primary attempt, one failover, then success on the fallback.
    expect(attempts).toBe(1);
    expect(switches).toBe(1);
    expect(result.finalText).toBe("recovered");
    expect(result.failoverTo).toBe("fallback-model");
  });

  test("without onProviderFailover the turn still ends with the surfaced error", async () => {
    const result = await runAgent(
      { ...base, provider: failingProvider("network unreachable") },
      { maxSteps: 10 },
    );
    expect(result.finalText).toContain("network unreachable");
    expect(result.failoverTo).toBeUndefined();
  });
});
