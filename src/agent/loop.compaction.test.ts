import { describe, expect, test } from "bun:test";
import { runAgent } from "./loop";
import { ContextTooLargeError, type ChatOptions, type ChatChunk, type StreamResult } from "../llm/types";
import { registerTool, type ToolContext } from "../tools/registry";

// A deterministic echo tool so the loop has something harmless to call.
registerTool({
  definition: {
    type: "function",
    function: {
      name: "compaction_probe",
      description: "Echoes a marker.",
      parameters: { type: "object", properties: { msg: { type: "string" } }, required: ["msg"] },
    },
  },
  async run(args): Promise<string> {
    return `echo: ${args.msg ?? ""}`;
  },
});

const toolCtx: ToolContext = { cwd: "/tmp" };

type Provider = (opts: ChatOptions, onChunk: (c: ChatChunk) => void) => Promise<StreamResult>;

const SUMMARK = "DIGEST-CONTENT-42";
const isSummarizerCall = (opts: ChatOptions): boolean =>
  opts.messages.length === 2 &&
  opts.messages[0].role === "system" &&
  (opts.messages[0].content ?? "").includes("compaction engine");

/**
 * Scripted provider: summarizer calls get a fixed digest; main calls follow
 * `script` in order. Every main-call message array is captured for assertions.
 */
function scripted(script: Provider[], opts: { summarizerThrows?: boolean } = {}) {
  const summarizerCalls: ChatOptions[] = [];
  const mainCalls: Message_[][] = [];
  let i = 0;
  const provider: Provider = async (call, onChunk) => {
    if (isSummarizerCall(call)) {
      summarizerCalls.push(call);
      if (opts.summarizerThrows) throw new Error("summarizer unavailable");
      onChunk({ content: SUMMARK });
      return { text: SUMMARK, toolCalls: [], finishReason: "stop" };
    }
    mainCalls.push(call.messages.map((m) => ({ ...m })));
    const next = script[Math.min(i, script.length - 1)];
    i++;
    return next(call, onChunk);
  };
  return { provider, summarizerCalls, mainCalls };
}

type Message_ = ChatOptions["messages"][number];

const toolCallStep = (id: string, msg: string): Provider =>
  async (_o, onChunk) => {
    onChunk({ content: "" });
    return {
      text: "",
      toolCalls: [{ id, name: "compaction_probe", arguments: JSON.stringify({ msg }) }],
      finishReason: "tool_calls",
    };
  };

const finalStep = (text: string): Provider =>
  async (_o, onChunk) => {
    onChunk({ content: text });
    return { text, toolCalls: [], finishReason: "stop" };
  };

// 10k chars of "task " ≈ 3000 estimated tokens — comfortably over a 0.75
// watermark at the chosen window while leaving trim headroom above it.
const BIG_TASK = "task ".repeat(2000);

describe("runAgent — summarizing compaction", () => {
  test("folds older tool work into a digest instead of dropping it", async () => {
    const { provider, summarizerCalls, mainCalls } = scripted([
      toolCallStep("call_1", "step-one"),
      toolCallStep("call_2", "step-two"),
      finalStep("done"),
    ]);
    const compactEvents: number[] = [];
    const result = await runAgent(
      {
        provider,
        systemPrompt: "test",
        model: "test",
        initialMessages: [{ role: "user", content: BIG_TASK }],
        toolCtx,
        maxInputTokens: 4600,
      },
      {
        maxSteps: 10,
        onCompact: (info) => compactEvents.push(info.foldedMessages),
      },
    );

    expect(result.finalText).toBe("done");
    // Exactly one summarizer completion — the step-2 work is now current work
    // at step 3, so only step 1's pair is foldable.
    expect(summarizerCalls).toHaveLength(1);
    expect(compactEvents).toEqual([2]); // assistant tool-call + its result
    expect(result.compactionSummary).toBe(SUMMARK);

    // The summarizer source contained step one's result...
    const source = summarizerCalls[0].messages[1].content ?? "";
    expect(source).toContain("echo: step-one");
    // ...and the final main call kept the task statement, the digest, and the
    // current (step two) work — while step one's raw messages are gone.
    const last = mainCalls[mainCalls.length - 1];
    const flat = last.map((m) => m.content ?? "");
    expect(flat.some((c) => c === BIG_TASK)).toBe(true);
    expect(flat.some((c) => c.includes("[Conversation summary"))).toBe(true);
    expect(flat.some((c) => c.includes(SUMMARK))).toBe(true);
    expect(flat.some((c) => c.includes("echo: step-two"))).toBe(true);
    expect(flat.some((c) => c.includes("echo: step-one"))).toBe(false);
  });

  test("ContextTooLarge force-compacts and retries smaller", async () => {
    const boom: Provider = async () => {
      throw new ContextTooLargeError(413, "context too large");
    };
    const { provider, summarizerCalls, mainCalls } = scripted([boom, finalStep("recovered")]);
    const result = await runAgent(
      {
        provider,
        systemPrompt: "test",
        model: "test",
        initialMessages: [
          { role: "user", content: "task statement" },
          { role: "assistant", content: "intermediate findings ".repeat(100) },
          { role: "user", content: "continue" },
        ],
        toolCtx,
        maxInputTokens: 4000,
      },
      { maxSteps: 5 },
    );
    expect(result.finalText).toBe("recovered");
    expect(summarizerCalls).toHaveLength(1);
    expect(result.compactionSummary).toBe(SUMMARK);
    // The retry saw the digest in place of the folded assistant message.
    const retry = mainCalls[mainCalls.length - 1];
    expect(retry.some((m) => (m.content ?? "").includes(SUMMARK))).toBe(true);
    expect(retry.some((m) => (m.content ?? "").includes("intermediate findings"))).toBe(false);
  });

  test("summarizer failure falls back to plain trim — no crash, no digest", async () => {
    const { provider, summarizerCalls } = scripted(
      [toolCallStep("call_1", "step-one"), toolCallStep("call_2", "step-two"), finalStep("done")],
      { summarizerThrows: true },
    );
    const result = await runAgent(
      {
        provider,
        systemPrompt: "test",
        model: "test",
        initialMessages: [{ role: "user", content: BIG_TASK }],
        toolCtx,
        maxInputTokens: 4600,
      },
      { maxSteps: 10 },
    );
    expect(result.finalText).toBe("done");
    expect(summarizerCalls.length).toBeGreaterThan(0); // it tried
    expect(result.compactionSummary).toBeUndefined(); // and admitted nothing
  });

  test("a carried digest is fed to the provider ahead of later turns", async () => {
    const { provider, summarizerCalls, mainCalls } = scripted([finalStep("ok")]);
    const result = await runAgent(
      {
        provider,
        systemPrompt: "test",
        model: "test",
        initialMessages: [{ role: "user", content: "second turn" }],
        toolCtx,
        compactionSummary: "FINDINGS FROM TURN ONE",
      },
      { maxSteps: 5 },
    );
    expect(result.finalText).toBe("ok");
    expect(summarizerCalls).toHaveLength(0); // nothing foldable, nothing spent
    expect(result.compactionSummary).toBe("FINDINGS FROM TURN ONE");
    const first = mainCalls[0];
    const userIdx = first.findIndex((m) => m.role === "user" && m.content === "second turn");
    const digestIdx = first.findIndex((m) => (m.content ?? "").includes("FINDINGS FROM TURN ONE"));
    expect(digestIdx).toBeGreaterThan(-1);
    // original task statement stays chronologically first
    expect(userIdx).toBeGreaterThan(-1);
    expect(userIdx).toBeLessThan(digestIdx);
  });

  test("no maxInputTokens: no compaction attempt, digest still passed through", async () => {
    const { provider, summarizerCalls } = scripted([toolCallStep("call_1", "x"), finalStep("done")]);
    const result = await runAgent(
      {
        provider,
        systemPrompt: "test",
        model: "test",
        initialMessages: [{ role: "user", content: "hello" }],
        toolCtx,
        compactionSummary: "CARRIED",
      },
      { maxSteps: 5 },
    );
    expect(summarizerCalls).toHaveLength(0);
    expect(result.compactionSummary).toBe("CARRIED");
    expect(result.finalText).toBe("done");
  });
});
