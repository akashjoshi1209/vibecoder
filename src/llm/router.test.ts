import { describe, expect, test } from "bun:test";
import { classifyMessage, ModelRouter, type RoutingConfig } from "./router";
import type { RootConfig } from "./client";

function config(routingOverride?: Partial<RoutingConfig>, strategy: "keyword" | "hybrid" = "hybrid"): RootConfig {
  return {
    provider: "groq",
    model: "qwen/qwen3.8-27b",
    providers: {
      groq: {
        type: "openai-compatible",
        baseURL: "https://api.groq.com/openai/v1",
        apiKeyEnv: "GROQ_API_KEY",
        models: ["qwen/qwen3.8-27b"],
      },
      nvidia: {
        type: "openai-compatible",
        baseURL: "https://integrate.api.nvidia.com/v1",
        apiKeyEnv: "NVIDIA_API_KEY",
        models: ["nvidia/nemotron-3-ultra-550b-a55b"],
      },
      ollama: {
        type: "openai-compatible",
        baseURL: "http://localhost:11434/v1",
        apiKeyEnv: "",
        models: ["llama3.1", "qwen2.5:1.5b"],
      },
    },
    routing: {
      chatProvider: "groq",
      chatModel: "qwen/qwen3.8-27b",
      heavyProvider: "nvidia",
      heavyModel: "nvidia/nemotron-3-ultra-550b-a55b",
      strategy,
      ...routingOverride,
    },
  };
}

describe("classifyMessage", () => {
  test("chat: greetings", () => {
    for (const t of ["hi", "hello!", "hey", "good morning", "yo", "sup"]) expect(classifyMessage(t)).toBe("chat");
  });

  test("chat: short ack / social", () => {
    for (const t of ["ok", "thanks", "thank you", "great", "how are you?", "lol", "sounds good"]) expect(classifyMessage(t)).toBe("chat");
  });

  test("chat: identity and simple factual", () => {
    for (const t of ["who are you", "what model are you", "what models do you have", "what is a database", "tell me about yourself"]) {
      expect(classifyMessage(t)).toBe("chat");
    }
  });

  test("heavy: code and idioms", () => {
    expect(classifyMessage("```python\nprint('hi')\n```")).toBe("heavy");
    expect(classifyMessage("def add(a, b):\n    return a + b")).toBe("heavy");
    expect(classifyMessage("import foo from './bar.ts'")).toBe("heavy");
  });

  test("heavy: coding verbs / bugs", () => {
    for (const t of [
      "fix this bug in my code",
      "write me a python script that sorts a list",
      "create a REST API with express",
      "refactor this function",
      "deploy this app to kubernetes",
      "the build is failing",
      "my server keeps crashing",
      "analyze the architecture of this repo",
      "help me write a test for this module",
      "install sqlite and configure it",
    ]) {
      expect(classifyMessage(t)).toBe("heavy");
    }
  });

  test("heavy: long task-ish text", () => {
    const long = "code ".repeat(80);
    expect(classifyMessage(long)).toBe("heavy");
  });

  test("ambiguous: no strong signal", () => {
    for (const t of ["so what do you think?", "nice weather today", "tell me a story"]) expect(classifyMessage(t)).toBe("ambiguous");
  });
});

describe("ModelRouter.resolve", () => {
  const limits = { maxInputTokens: 5000, maxInputTokensPerMinute: 6500 };

  test("mode=chat always routes to the chat model with light limits", async () => {
    const r = new ModelRouter(config(), limits);
    const res = await r.resolve("write me a full web app in python", "chat", true);
    expect(res.providerName).toBe("groq");
    expect(res.model).toBe("qwen/qwen3.8-27b");
    expect(res.maxInputTokens).toBe(5000);
    expect(res.maxInputTokensPerMinute).toBe(6500);
  });

  test("mode=heavy always routes to the heavy model with no light limits", async () => {
    const r = new ModelRouter(config(), limits);
    const res = await r.resolve("hi", "heavy");
    expect(res.providerName).toBe("nvidia");
    expect(res.model).toBe("nvidia/nemotron-3-ultra-550b-a55b");
    expect(res.maxInputTokens).toBeUndefined();
    expect(res.maxInputTokensPerMinute).toBeUndefined();
  });

  test("auto: obvious chat → chat side", async () => {
    const r = new ModelRouter(config(), limits);
    expect((await r.resolve("hello there", "auto")).providerName).toBe("groq");
  });

  test("auto: obvious heavy → heavy side", async () => {
    const r = new ModelRouter(config(), limits);
    expect((await r.resolve("fix this bug in my code", "auto")).providerName).toBe("nvidia");
  });

  test("auto + ambiguous + keyword strategy → chat side (no classifier call)", async () => {
    const r = new ModelRouter(config({}, "keyword"), limits);
    let classifierCalls = 0;
    r.setClassifier(() => {
      classifierCalls++;
      return Promise.resolve("heavy" as const);
    });
    const res = await r.resolve("so what do you think?", "auto");
    expect(res.providerName).toBe("groq");
    expect(classifierCalls).toBe(0);
  });

  test("auto + ambiguous + hybrid → follows the classifier verdict", async () => {
    const r = new ModelRouter(config(), limits);
    r.setClassifier(() => Promise.resolve("heavy" as const));
    expect((await r.resolve("so what do you think?", "auto")).providerName).toBe("nvidia");

    const r2 = new ModelRouter(config(), limits);
    r2.setClassifier(() => Promise.resolve("chat" as const));
    expect((await r2.resolve("so what do you think?", "auto")).providerName).toBe("groq");
  });

  test("auto + ambiguous + taskActive → sticky heavy, classifier not consulted", async () => {
    const r = new ModelRouter(config({}, "keyword"), limits);
    let classifierCalls = 0;
    r.setClassifier(() => {
      classifierCalls++;
      return Promise.resolve("chat" as const);
    });
    const res = await r.resolve("so what do you think?", "auto", true);
    expect(res.providerName).toBe("nvidia");
    expect(classifierCalls).toBe(0);
  });

  test("auto + ambiguous + hybrid + taskActive → sticky heavy", async () => {
    const r = new ModelRouter(config(), limits);
    r.setClassifier(() => {
      throw new Error("should not be called while task is active");
    });
    const res = await r.resolve("can you do that too?", "auto", true);
    expect(res.providerName).toBe("nvidia");
  });

  test("fallback: heavy provider missing degrades to chat side", async () => {
    const r = new ModelRouter(config({ heavyProvider: "missing" }), limits);
    expect(r.heavyIdentity().provider).toBe("groq");
    const res = await r.resolve("fix this bug in my code", "auto");
    expect(res.providerName).toBe("groq");
  });

  test("isHeavy identifies heavy routes", async () => {
    const r = new ModelRouter(config(), limits);
    expect(r.isHeavy(await r.resolve("hi", "heavy"))).toBe(true);
    expect(r.isHeavy(await r.resolve("hi", "chat"))).toBe(false);
  });

  test("resolveOffline routes to the configured offline model", async () => {
    const r = new ModelRouter(config({ offlineProvider: "ollama", offlineModel: "qwen2.5:1.5b" }), limits);
    const res = r.resolveOffline("hello, are we offline?");
    expect(res.offline).toBe(true);
    expect(res.providerName).toBe("ollama");
    expect(res.model).toBe("qwen2.5:1.5b");
    // Local model: generous small budget, no per-minute pacing.
    expect(res.maxInputTokens).toBe(4000);
    expect(res.maxInputTokensPerMinute).toBeUndefined();
  });

  test("resolveOffline degrades to chat side when no offline provider is set", () => {
    const r = new ModelRouter(config(), limits);
    const res = r.resolveOffline("hello");
    expect(res.offline).toBe(true);
    expect(res.providerName).toBe("groq");
    expect(res.model).toBe("qwen/qwen3.8-27b");
  });

  test("resolveOffline falls back to chat side when offline provider missing", () => {
    const r = new ModelRouter(config({ offlineProvider: "nope" }), limits);
    const res = r.resolveOffline("hello");
    expect(res.offline).toBe(true);
    expect(res.providerName).toBe("groq");
  });
});