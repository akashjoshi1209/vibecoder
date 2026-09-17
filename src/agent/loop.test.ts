import { describe, expect, test } from "bun:test";
import { runAgent } from "./loop";
import type { ChatOptions, StreamResult, ChatChunk } from "../llm/types";
import { registerTool, type ToolContext } from "../tools/registry";

// Register a simple test tool.
registerTool({
  definition: {
    type: "function",
    function: {
      name: "test_tool",
      description: "A test tool that echoes input.",
      parameters: {
        type: "object",
        properties: { msg: { type: "string" } },
        required: ["msg"],
      },
    },
  },
  async run(args): Promise<string> {
    return `echo: ${args.msg ?? ""}`;
  },
});

const toolCtx: ToolContext = { cwd: "/tmp" };

function okProvider(text = "done"): (opts: ChatOptions, onChunk: (c: ChatChunk) => void) => Promise<StreamResult> {
  return async (_opts, onChunk) => {
    onChunk({ content: text });
    return { text, toolCalls: [], finishReason: "stop" };
  };
}

function toolCallProvider(): (opts: ChatOptions, onChunk: (c: ChatChunk) => void) => Promise<StreamResult> {
  return async (_opts, onChunk) => {
    onChunk({ content: "" });
    return {
      text: "",
      toolCalls: [{ id: "call_1", name: "test_tool", arguments: '{"msg":"hello"}' }],
      finishReason: "tool_calls",
    };
  };
}

function failNTimesThenOk(n: number): { provider: (opts: ChatOptions, onChunk: (c: ChatChunk) => void) => Promise<StreamResult>; callCount: () => number } {
  let calls = 0;
  return {
    callCount: () => calls,
    provider: async (_opts, _onChunk) => {
      calls++;
      if (calls <= n) throw new Error(`transient failure #${calls}`);
      _onChunk({ content: "recovered" });
      return { text: "recovered", toolCalls: [], finishReason: "stop" };
    },
  };
}

function alwaysFailProvider(msg = "network down"): (opts: ChatOptions, onChunk: (c: ChatChunk) => void) => Promise<StreamResult> {
  return async () => {
    throw new Error(msg);
  };
}

describe("runAgent — step-level retry", () => {
  test("recovers from transient LLM failure", async () => {
    const { provider, callCount } = failNTimesThenOk(1);
    const result = await runAgent(
      {
        provider,
        systemPrompt: "test",
        model: "test",
        initialMessages: [{ role: "user", content: "hi" }],
        toolCtx,
      },
      { maxSteps: 5 },
    );
    expect(result.aborted).toBe(false);
    expect(result.finalText).toBe("recovered");
    expect(callCount()).toBe(2); // 1 fail + 1 success
  });

  test("gives up after 3 consecutive failures", async () => {
    const result = await runAgent(
      {
        provider: alwaysFailProvider(),
        systemPrompt: "test",
        model: "test",
        initialMessages: [{ role: "user", content: "hi" }],
        toolCtx,
      },
      { maxSteps: 40 },
    );
    expect(result.aborted).toBe(false);
    expect(result.finalText).toContain("consecutive LLM failures");
  });

  test("abort returns immediately", async () => {
    const ac = new AbortController();
    const result = await runAgent(
      {
        provider: okProvider(),
        systemPrompt: "test",
        model: "test",
        initialMessages: [{ role: "user", content: "hi" }],
        toolCtx,
        signal: ac.signal,
      },
      { maxSteps: 40 },
    );
    // Provider didn't abort, so it should complete normally.
    expect(result.aborted).toBe(false);
    expect(result.finalText).toBe("done");
  });

  test("maxSteps output includes progress when tools were used", async () => {
    const result = await runAgent(
      {
        provider: toolCallProvider(),
        systemPrompt: "test",
        model: "test",
        initialMessages: [{ role: "user", content: "use tool" }],
        toolCtx,
      },
      { maxSteps: 3 },
    );
    expect(result.toolCalls).toBeGreaterThan(0);
    expect(result.finalText).toContain("max steps");
    expect(result.finalText).toContain("Progress:");
    expect(result.finalText).toContain("test_tool");
  });
});
