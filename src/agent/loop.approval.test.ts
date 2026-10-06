// Tests for the approval retry and the cost cap inside the agent loop —
// the two behaviours that only exist at this layer and cannot be observed from
// the tool side.
import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { runAgent } from "./loop";
import type { ChatOptions, StreamResult, ChatChunk, TokenUsage } from "../llm/types";
import { registerTool, type ToolContext } from "../tools/registry";
import { ApprovalRequiredError } from "../tools/approval";
import { resolvePermissions } from "../permissions";

const tmp = mkdtempSync(join(tmpdir(), "vc-loop-approve-"));

/** A tool that demands approval the first time and succeeds once approved. */
let askCount = 0;
let askRuns = 0;
registerTool({
  definition: {
    type: "function",
    function: {
      name: "ask_gate_tool",
      description: "A tool that requires approval.",
      parameters: { type: "object", properties: { n: { type: "string" } }, required: [] },
    },
  },
  async run(): Promise<string> {
    askRuns++;
    askCount++;
    if (askCount === 1) throw new ApprovalRequiredError("ask_gate_tool", "needs consent", {});
    return "ran after approval";
  },
});

function callThenOk(): (o: ChatOptions, c: (c: ChatChunk) => void) => Promise<StreamResult> {
  let step = 0;
  return async (_o, onChunk) => {
    step++;
    onChunk({ content: "" });
    if (step === 1) {
      return {
        text: "",
        toolCalls: [{ id: "c1", name: "ask_gate_tool", arguments: "{}" }],
        finishReason: "tool_calls",
      };
    }
    const text = "finished";
    onChunk({ content: text });
    return { text, toolCalls: [], finishReason: "stop" };
  };
}

function askCtx(destructive: "allow" | "ask" | "deny"): ToolContext {
  return {
    cwd: tmp,
    permissions: resolvePermissions({ permissions: { destructive } } as never, tmp),
  };
}

const base = {
  systemPrompt: "s",
  model: "test-model",
  initialMessages: [{ role: "user" as const, content: "go" }],
};

describe("approval inside the loop", () => {
  test("an approved call is re-run and the model sees its output", async () => {
    askCount = 0;
    askRuns = 0;
    let askedWithReason: string | undefined;
    const res = await runAgent(
      { ...base, provider: callThenOk(), toolCtx: askCtx("ask") },
      {
        confirmTool: async (_n, _a, reason) => {
          askedWithReason = reason;
          return true;
        },
      },
    );
    expect(askedWithReason).toBe("needs consent");
    expect(res.finalText).toBe("finished");
    // Once before the throw, once on the approved retry.
    expect(askRuns).toBe(2);
  });

  test("a declined call is not retried and the model is told not to work around it", async () => {
    askCount = 0;
    askRuns = 0;
    let prompted = 0;
    let toolSaw = "";
    const provider = async (o: ChatOptions, onChunk: (c: ChatChunk) => void): Promise<StreamResult> => {
      const msgs = (o.messages ?? []) as { role: string; content?: string | null }[];
      const last = msgs[msgs.length - 1];
      if (last?.role === "tool") {
        toolSaw = last.content ?? "";
        const t = "finished";
        onChunk({ content: t });
        return { text: t, toolCalls: [], finishReason: "stop" };
      }
      return {
        text: "",
        toolCalls: [{ id: "c1", name: "ask_gate_tool", arguments: "{}" }],
        finishReason: "tool_calls",
      };
    };
    await runAgent({ ...base, provider, toolCtx: askCtx("ask") }, {
      confirmTool: async () => { prompted++; return false; },
    });
    expect(prompted).toBe(1);
    // The tool never ran at all: the blanket approval prompt gated it first, so
    // the permission check was never reached. The old code returned a "PENDING"
    // string here and the model was free to try something sneakier.
    expect(askRuns).toBe(0);
    expect(toolSaw).toContain("BLOCKED");
    expect(toolSaw).toMatch(/do not retry|don't retry/i);
  });

  test("with no approver attached, ask fails loudly instead of proceeding", async () => {
    askCount = 0;
    askRuns = 0;
    let sawBlocked = false;
    const provider = async (_o: ChatOptions, onChunk: (c: ChatChunk) => void): Promise<StreamResult> => {
      const msgs = (_o.messages ?? []) as { role: string; content?: string | null }[];
      const last = msgs[msgs.length - 1];
      if (last?.role === "tool") {
        sawBlocked = (last.content ?? "").includes("BLOCKED");
        const text = "ok";
        onChunk({ content: text });
        return { text, toolCalls: [], finishReason: "stop" };
      }
      return {
        text: "",
        toolCalls: [{ id: "c1", name: "ask_gate_tool", arguments: "{}" }],
        finishReason: "tool_calls",
      };
    };
    const res = await runAgent({ ...base, provider, toolCtx: askCtx("ask") });
    expect(sawBlocked).toBe(true);
    expect(res.finalText).toBe("ok");
  });

  test("a tool that asks twice does not loop forever", async () => {
    // A retry that asks again must fall through to a blocked result, not spin.
    let runs = 0;
    registerTool({
      definition: {
        type: "function",
        function: { name: "always_asks", description: "always asks", parameters: { type: "object", properties: {} } },
      },
      async run(): Promise<string> {
        runs++;
        throw new ApprovalRequiredError("always_asks", "again", {});
      },
    });
    const provider = async (o: ChatOptions, onChunk: (c: ChatChunk) => void): Promise<StreamResult> => {
      const msgs = (o.messages ?? []) as { role: string }[];
      if (msgs[msgs.length - 1]?.role === "tool") {
        const t = "stopped";
        onChunk({ content: t });
        return { text: t, toolCalls: [], finishReason: "stop" };
      }
      return { text: "", toolCalls: [{ id: "c1", name: "always_asks", arguments: "{}" }], finishReason: "tool_calls" };
    };
    await runAgent({ ...base, provider, toolCtx: askCtx("ask") }, { confirmTool: async () => true });
    expect(runs).toBe(2);
  });
});

describe("cost accounting in the loop", () => {
  function usageProvider(usage: TokenUsage): (o: ChatOptions, c: (c: ChatChunk) => void) => Promise<StreamResult> {
    return async (_o, onChunk) => {
      const t = "answer";
      onChunk({ content: t, usage });
      return { text: t, toolCalls: [], finishReason: "stop", usage };
    };
  }

  test("accumulates tokens across every step of a turn", async () => {
    const perStep: TokenUsage = { promptTokens: 1000, completionTokens: 200 };
    let step = 0;
    const provider = async (_o: ChatOptions, onChunk: (c: ChatChunk) => void): Promise<StreamResult> => {
      step++;
      onChunk({ content: "" });
      if (step < 3) {
        return {
          text: "",
          toolCalls: [{ id: "c" + step, name: "test_tool", arguments: '{"msg":"x"}' }],
          finishReason: "tool_calls",
          usage: perStep,
        };
      }
      const t = "done";
      onChunk({ content: t, usage: perStep });
      return { text: t, toolCalls: [], finishReason: "stop", usage: perStep };
    };
    const res = await runAgent({ ...base, provider, toolCtx: { cwd: tmp } });
    // Three provider calls, and only the last one's usage would show up if the
    // total were read off the final result.
    expect(res.usage?.promptTokens).toBe(3000);
    expect(res.usage?.completionTokens).toBe(600);
  });

  test("reports no usage rather than zero when the provider sends none", async () => {
    const res = await runAgent(
      { ...base, provider: async (_o, onChunk) => { const t = "x"; onChunk({ content: t }); return { text: t, toolCalls: [], finishReason: "stop" }; }, toolCtx: { cwd: tmp } },
    );
    // "unknown" and "free" must not be confused: a missing count that reads as
    // zero would make every turn look free.
    expect(res.usage).toBeUndefined();
  });

  test("maxCostUsd stops the turn once the cap is passed", async () => {
    let step = 0;
    const provider = async (_o: ChatOptions, onChunk: (c: ChatChunk) => void): Promise<StreamResult> => {
      step++;
      const usage: TokenUsage = { promptTokens: 1_000_000, completionTokens: 1_000_000 };
      onChunk({ content: "", usage });
      if (step === 1) {
        return { text: "", toolCalls: [{ id: "c1", name: "test_tool", arguments: '{"msg":"x"}' }], finishReason: "tool_calls", usage };
      }
      const t = "should not get here";
      onChunk({ content: t, usage });
      return { text: t, toolCalls: [], finishReason: "stop", usage };
    };
    const res = await runAgent(
      {
        ...base,
        provider,
        toolCtx: { cwd: tmp },
        // $1 per million in, $1 per million out → 2 USD per step. Cap at 1.
        maxCostUsd: 1,
        costRates: { input: 1, output: 1 },
      },
    );
    expect(res.costCapHit).toBeTruthy();
    expect(res.costCapHit!.limitUsd).toBe(1);
    expect(step).toBe(1);
    expect(res.finalText).toContain("cost cap");
  });

  test("a turn under the cap runs to completion", async () => {
    const res = await runAgent(
      {
        ...base,
        provider: usageProvider({ promptTokens: 10, completionTokens: 10 }),
        toolCtx: { cwd: tmp },
        maxCostUsd: 5,
        costRates: { input: 1, output: 1 },
      },
    );
    expect(res.costCapHit).toBeUndefined();
    expect(res.finalText).toBe("answer");
  });

  test("no cap and no rates means no limit, not a crash", async () => {
    const res = await runAgent(
      {
        ...base,
        provider: usageProvider({ promptTokens: 1_000_000, completionTokens: 1_000_000 }),
        toolCtx: { cwd: tmp },
        maxCostUsd: 0.0001,
      },
    );
    // Without rates the cap cannot be evaluated. Claiming enforcement here would
    // be worse than not offering one.
    expect(res.costCapHit).toBeUndefined();
    expect(res.finalText).toBe("answer");
  });
});

// Deferred so the temp dir outlives every test body. A top-level rmSync would
// run at file evaluation, before any test body executes.
afterAll(() => rmSync(tmp, { recursive: true, force: true }));