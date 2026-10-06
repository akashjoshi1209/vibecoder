import { describe, expect, test } from "bun:test";
import {
  buildWorkingSet,
  findFirstUserIdx,
  planFold,
  renderForSummary,
  summaryMessage,
  summarizeHistory,
  type CompactionState,
} from "./compact";
import { estimateMessagesTokens } from "./tokens";
import type { ChatOptions, Message, StreamResult } from "./types";

const sys = (content: string): Message => ({ role: "system", content });
const user = (content: string): Message => ({ role: "user", content });
const asst = (content: string): Message => ({ role: "assistant", content });
const toolMsg = (id: string, content: string): Message => ({
  role: "tool",
  content,
  tool_call_id: id,
  name: "test_tool",
});
const toolCallAsst = (content: string): Message => ({
  role: "assistant",
  content,
  tool_calls: [{ id: "c1", name: "test_tool", arguments: "{}" }],
});

function contents(messages: Message[]): string[] {
  return messages.map((m) => m.content ?? "");
}

describe("findFirstUserIdx", () => {
  test("skips the system message and finds the first user turn", () => {
    expect(findFirstUserIdx([sys("s"), asst("a"), user("u"), user("u2")])).toBe(2);
    expect(findFirstUserIdx([sys("s")])).toBe(-1);
  });
});

describe("buildWorkingSet", () => {
  const history = [sys("system prompt"), user("do the task"), toolCallAsst("working"), toolMsg("c1", "result"), asst("next")];

  test("no state: identical conversation, same order", () => {
    const out = buildWorkingSet(history, null);
    expect(out.map((m) => m.role)).toEqual(["system", "user", "assistant", "tool", "assistant"]);
    expect(contents(out)).toEqual(contents(history));
  });

  test("folded range is replaced by the digest; first user survives verbatim", () => {
    const state: CompactionState = { summary: "DIGEST", foldedCount: 4 };
    const out = buildWorkingSet(history, state);
    expect(out[0].role).toBe("system");
    expect(out[0].content).toBe("system prompt");
    // first user (index 1) is inside the folded range — kept ahead of the digest
    expect(out[1].role).toBe("user");
    expect(out[1].content).toBe("do the task");
    expect(out[2].content).toContain("DIGEST");
    // folded messages (assistant tool-call + tool result) are gone
    expect(out.some((m) => m.content === "result")).toBe(false);
    // messages past the fold boundary remain
    expect(out.some((m) => m.content === "next")).toBe(true);
  });

  test("carried digest (foldedCount = 1) covers messages not in this history", () => {
    const state: CompactionState = { summary: "CARRIED", foldedCount: 1 };
    const out = buildWorkingSet(history, state);
    // system, first user, digest, then everything else except the hoisted user
    expect(out.map((m) => m.role)).toEqual(["system", "user", "user", "assistant", "tool", "assistant"]);
    expect(out[1].content).toBe("do the task");
    expect(out[2].content).toContain("CARRIED");
    expect(contents(out)).toContain("result");
  });

  test("first user sitting after the tail start is still hoisted once", () => {
    const h = [sys("s"), asst("early"), user("task statement"), asst("later")];
    const out = buildWorkingSet(h, { summary: "D", foldedCount: 1 });
    // "task statement" appears exactly once, before the digest
    expect(contents(out).filter((c) => c === "task statement")).toHaveLength(1);
    expect(out[1].content).toBe("task statement");
    expect(out[2].content).toContain("D");
  });
});

describe("planFold", () => {
  const fat = (tag: string) => `${tag} ${"x".repeat(2000)}`;

  test("null under the watermark", () => {
    const history = [sys("s"), user(fat("task")), asst(fat("a1")), user(fat("u2"))];
    const plan = planFold(history, null, { budgetTokens: 100_000 });
    expect(plan).toBeNull();
  });

  test("folds the middle: never the first user block, never the newest block", () => {
    const history = [
      sys("s"),
      user("ORIGINAL TASK"),
      toolCallAsst("step one"),
      toolMsg("c1", fat("result-one")),
      toolCallAsst("step two"),
      toolMsg("c2", fat("result-two")),
    ];
    const plan = planFold(history, null, { budgetTokens: 100, force: true });
    expect(plan).not.toBeNull();
    // excludes system + first user message
    expect(plan!.start).toBe(2);
    // excludes the newest block (assistant tool-call + its result): current work
    expect(plan!.end).toBe(4);
    expect(plan!.tokens).toBeGreaterThan(0);
  });

  test("never folds past the newest block even with a large window pressure", () => {
    const history = [sys("s"), user("T"), toolCallAsst("a1"), toolMsg("c1", "r1"), asst("final")];
    const plan = planFold(history, null, { budgetTokens: 1, force: true });
    expect(plan).not.toBeNull();
    // newest block is just [asst("final")] (index 4); fold ends before it
    expect(plan!.end).toBeLessThanOrEqual(4);
    expect(plan!.end).toBe(4); // a1+r1 foldable, final is current work
  });

  test("already-folded ranges are not re-planned", () => {
    const history = [sys("s"), user("T"), asst("a1"), asst("a2"), asst("final")];
    const state: CompactionState = { summary: "D", foldedCount: 4 };
    const plan = planFold(history, state, { budgetTokens: 1, force: true });
    // only [3..4) sits between foldedCount and the newest block, and it is a
    // single message block — but foldedCount=4 means index 3 already folded? No:
    // foldedCount 4 covers 0..3, so index 4+ only = newest. Nothing to fold.
    expect(plan).toBeNull();
  });

  test("maxFoldTokens caps the range so the summarizer input stays bounded", () => {
    const history = [
      sys("s"),
      user("T"),
      toolCallAsst("a1"),
      toolMsg("c1", fat("r1")),
      toolCallAsst("a2"),
      toolMsg("c2", fat("r2")),
      asst("final"),
    ];
    const plan = planFold(history, null, { budgetTokens: 1, force: true, maxFoldTokens: 700 });
    expect(plan).not.toBeNull();
    // one ~500-token result fits; the second would blow the cap
    expect(plan!.end).toBe(4);
    expect(plan!.tokens).toBeLessThanOrEqual(700);
  });

  test("trivial history never folds", () => {
    expect(planFold([sys("s"), user("only")], null, { budgetTokens: 1, force: true })).toBeNull();
    expect(planFold([sys("s")], null, { budgetTokens: 1, force: true })).toBeNull();
  });

  test("working set after a plan is smaller than before", () => {
    const history = [
      sys("s"),
      user("T"),
      toolCallAsst("a1"),
      toolMsg("c1", "x".repeat(4000)),
      asst("final"),
    ];
    const plan = planFold(history, null, { budgetTokens: 1, force: true })!;
    const before = estimateMessagesTokens(buildWorkingSet(history, null));
    const after = estimateMessagesTokens(
      buildWorkingSet(history, { summary: "tiny digest", foldedCount: plan.end }),
    );
    expect(after).toBeLessThan(before);
  });
});

describe("renderForSummary", () => {
  test("labels roles including tool identity", () => {
    const text = renderForSummary([user("hi"), toolMsg("c1", "output here")]);
    expect(text).toContain("user: hi");
    expect(text).toContain("tool:test_tool: output here");
  });

  test("caps a single huge message instead of truncating the whole range", () => {
    const text = renderForSummary([{ role: "tool", content: "y".repeat(50_000), tool_call_id: "c1", name: "big" }]);
    expect(text.length).toBeLessThan(9000);
    expect(text).toContain("chars truncated");
  });

  test("renders pending tool calls", () => {
    const text = renderForSummary([toolCallAsst(null as unknown as string)]);
    expect(text).toContain("requested: test_tool({})");
  });
});

describe("summarizeHistory", () => {
  const okProvider = (reply: string) =>
    async (opts: ChatOptions): Promise<StreamResult> => {
      (okProvider as unknown as { last?: ChatOptions }).last = opts;
      return { text: reply, toolCalls: [], finishReason: "stop" };
    };

  test("sends system instructions + source, returns the digest", async () => {
    const provider = okProvider("THE DIGEST");
    const out = await summarizeHistory(provider, {
      model: "m",
      source: [user("task"), asst("findings")],
      budgetTokens: 4000,
    });
    expect(out?.text).toBe("THE DIGEST");
    const opts = (okProvider as unknown as { last?: ChatOptions }).last!;
    expect(opts.messages).toHaveLength(2);
    expect(opts.messages[0].role).toBe("system");
    expect(opts.messages[0].content).toContain("compaction");
    expect(opts.messages[1].content).toContain("task");
    expect(opts.messages[1].content).toContain("findings");
  });

  test("an existing digest is passed as EXISTING DIGEST for merging", async () => {
    const provider = okProvider("MERGED");
    const out = await summarizeHistory(provider, {
      model: "m",
      source: [asst("new material")],
      existing: "older facts",
      budgetTokens: 4000,
    });
    expect(out?.text).toBe("MERGED");
    const opts = (okProvider as unknown as { last?: ChatOptions }).last!;
    expect(opts.messages[1].content).toContain("EXISTING DIGEST");
    expect(opts.messages[1].content).toContain("older facts");
    expect(opts.messages[1].content).toContain("new material");
  });

  test("provider failure degrades to null (fall back to trim)", async () => {
    const out = await summarizeHistory(async () => {
      throw new Error("network down");
    }, { model: "m", source: [user("x")], budgetTokens: 4000 });
    expect(out).toBeNull();
  });

  test("empty reply degrades to null", async () => {
    const out = await summarizeHistory(async () => ({ text: "   ", toolCalls: [], finishReason: "stop" }), {
      model: "m",
      source: [user("x")],
      budgetTokens: 4000,
    });
    expect(out).toBeNull();
  });

  test("empty source does not call the provider", async () => {
    let called = false;
    const out = await summarizeHistory(async () => {
      called = true;
      return { text: "x", toolCalls: [], finishReason: "stop" };
    }, { model: "m", source: [{ role: "assistant", content: null }], budgetTokens: 4000 });
    expect(out).toBeNull();
    expect(called).toBe(false);
  });
});

describe("summaryMessage", () => {
  test("is a user-role message with a fold marker", () => {
    const m = summaryMessage("facts");
    expect(m.role).toBe("user");
    expect(m.content).toContain("[Conversation summary");
    expect(m.content).toContain("facts");
  });
});
