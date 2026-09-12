import { describe, expect, test } from "bun:test";
import { estimateTokens, trimMessages, estimateMessagesTokens } from "./tokens";
import type { Message } from "./types";

function msg(role: Message["role"], content: string | null, extra: Partial<Message> = {}): Message {
  return { role, content, ...extra };
}

describe("estimateTokens", () => {
  test("approximates English at ~4 chars per token", () => {
    const t = estimateTokens("The quick brown fox jumps over the lazy dog");
    // 44 chars -> ~11-12 tokens
    expect(t).toBeGreaterThanOrEqual(8);
    expect(t).toBeLessThanOrEqual(15);
  });

  test("empty string is 0 tokens", () => {
    expect(estimateTokens("")).toBe(0);
  });

  test("CJK costs fewer chars per token", () => {
    const cjk = estimateTokens("你好世界你好世界");
    expect(cjk).toBeLessThanOrEqual(12);
  });
});

describe("trimMessages", () => {
  test("no trimming when everything fits", () => {
    const messages: Message[] = [
      msg("system", "sys"),
      msg("user", "hi"),
      msg("assistant", "hello"),
    ];
    const { messages: out, trimmed } = trimMessages(messages, { budgetTokens: 1000 });
    expect(trimmed).toBe(0);
    expect(out).toHaveLength(3);
    expect(out).toEqual(messages);
  });

  test("keeps first user message and the newest messages, drops middle", () => {
    const messages: Message[] = [
      msg("system", "sys"),
      msg("user", "TASK: build feature x"),
      msg("assistant", "mid assistant a"),
      msg("tool", "mid tool result a", { tool_call_id: "c1" }),
      msg("assistant", "mid assistant b"),
      msg("user", "most recent user"),
      msg("assistant", "newest assistant"),
    ];
    // Tiny budget: only first user + newest fit
    const { messages: out, trimmed } = trimMessages(messages, { budgetTokens: 60 });
    expect(trimmed).toBeGreaterThan(0);
    const roles = out.map((m) => m.role);
    expect(roles[0]).toBe("system");
    expect(roles).toContain("user");
    expect(roles[roles.length - 1]).toBe("assistant");
    expect(out[1].content).toBe("TASK: build feature x");
    expect(out[out.length - 1].content).toBe("newest assistant");
    expect(out.some((m) => m.content === "mid assistant a")).toBe(false);
  });

  test("a huge budget keeps everything", () => {
    const messages: Message[] = [
      msg("system", "sys"),
      msg("user", "hello"),
      msg("assistant", "world"),
    ];
    const { messages: out, trimmed } = trimMessages(messages, { budgetTokens: 100000 });
    expect(trimmed).toBe(0);
    expect(out).toHaveLength(3);
  });

  test("output is a copy, source messages untouched", () => {
    const messages: Message[] = [
      msg("user", "x".repeat(5000)),
      msg("assistant", "y".repeat(5000)),
    ];
    const original = JSON.stringify(messages);
    trimMessages(messages, { budgetTokens: 100 });
    expect(JSON.stringify(messages)).toBe(original);
  });

  test("keeps at least the newest message even when nothing fits", () => {
    const messages: Message[] = [
      msg("system", "sys"),
      msg("user", "very old"),
      msg("assistant", "newest"),
    ];
    const { messages: out } = trimMessages(messages, { budgetTokens: 1 });
    expect(out.length).toBeGreaterThan(0);
    expect(out[out.length - 1].content).toBe("newest");
  });

  test("truncates an over-budget single tool result until it fits", () => {
    const big = "a".repeat(30000);
    const messages: Message[] = [msg("tool", big, { tool_call_id: "c1" })];
    const { messages: out, truncatedChars } = trimMessages(messages, { budgetTokens: 500 });
    expect(truncatedChars).toBeGreaterThan(0);
    const total = estimateMessagesTokens(out);
    expect(total).toBeLessThanOrEqual(600);
  });

  test("truncated char count is reported and content is marked", () => {
    const big = "b".repeat(20000);
    const { messages: out, truncatedChars } = trimMessages([msg("user", big)], { budgetTokens: 300 });
    expect(truncatedChars).toBeGreaterThan(0);
    expect(out[0].content).toContain("[trimmed]");
  });

  test("never breaks tool_use/tool_result pairing when dropping old messages", () => {
    const messages: Message[] = [
      msg("system", "sys"),
      msg("user", "TASK"),
      msg("assistant", null, {
        tool_calls: [{ id: "c_old", name: "bash", arguments: '{"command":"old"}' }],
      }),
      msg("tool", "old result", { tool_call_id: "c_old", name: "bash" }),
      msg("user", "recent user"),
      msg("assistant", null, {
        tool_calls: [{ id: "c_new", name: "bash", arguments: '{"command":"new"}' }],
      }),
      msg("tool", "new result", { tool_call_id: "c_new", name: "bash" }),
      msg("assistant", "done"),
    ];
    // Budget only fits the newest pair + task → the OLD tool_use/tool_result must both be dropped together.
    const { messages: out, trimmed } = trimMessages(messages, { budgetTokens: 40 });
    expect(trimmed).toBeGreaterThan(0);
    const cids = out.filter((m) => m.role === "tool").map((m) => m.tool_call_id);
    // Any surviving tool result must have its matching tool_use present.
    for (const cid of cids) {
      const hasUse = out.some((m) => m.tool_calls?.some((tc) => tc.id === cid));
      expect(hasUse).toBe(true);
    }
  });

  test("still trims pairs, not halves, at a tiny budget", () => {
    const messages: Message[] = [
      msg("system", "sys"),
      msg("user", "TASK"),
      msg("assistant", null, {
        tool_calls: [{ id: "c_old", name: "bash", arguments: '{"command":"old"}' }],
      }),
      msg("tool", "old huge result " + "x".repeat(3000), { tool_call_id: "c_old", name: "bash" }),
      msg("assistant", null, {
        tool_calls: [{ id: "c_new", name: "bash", arguments: '{"command":"new"}' }],
      }),
      msg("tool", "new result", { tool_call_id: "c_new", name: "bash" }),
      msg("assistant", "done"),
    ];
    const { messages: out } = trimMessages(messages, { budgetTokens: 10 });
    // The surviving tool result (if any) must still match a surviving tool_use.
    const cids = out.filter((m) => m.role === "tool").map((m) => m.tool_call_id);
    for (const cid of cids) {
      const hasUse = out.some((m) => m.tool_calls?.some((tc) => tc.id === cid));
      expect(hasUse).toBe(true);
    }
  });

  test("orphan tool results are in their own block and can be trimmed", () => {
    const messages: Message[] = [
      msg("user", "TASK"),
      msg("tool", "orphan result " + "x".repeat(3000), { tool_call_id: "c_x", name: "bash" }),
      msg("assistant", "newest"),
    ];
    const { messages: out } = trimMessages(messages, { budgetTokens: 10 });
    const toolMsgs = out.filter((m) => m.role === "tool");
    expect(toolMsgs.length).toBe(0); // orphan dropped — it cannot justify a valid pairing
    expect(out[out.length - 1].content).toBe("newest");
  });
});