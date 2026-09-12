import { describe, expect, test } from "bun:test";
import type { Message } from "../types";
import { mapToAnthropic } from "./anthropic";

function msg(m: Partial<Message> & { role: Message["role"] }): Message {
  return { content: null, ...m };
}

describe("mapToAnthropic", () => {
  test("converts a plain user/assistant conversation", () => {
    const out = mapToAnthropic([
      msg({ role: "user", content: "hello" }),
      msg({ role: "assistant", content: "hi" }),
    ]);
    expect(out).toEqual([
      { role: "user", content: [{ type: "text", text: "hello" }] },
      { role: "assistant", content: [{ type: "text", text: "hi" }] },
    ]);
  });

  test("converts assistant tool_calls into tool_use blocks", () => {
    const out = mapToAnthropic([
      msg({
        role: "assistant",
        content: "calling",
        tool_calls: [{ id: "tc_1", name: "bash", arguments: '{"command":"ls"}' }],
      }),
    ]);
    expect(out[0]).toEqual({
      role: "assistant",
      content: [
        { type: "text", text: "calling" },
        { type: "tool_use", id: "tc_1", name: "bash", input: { command: "ls" } },
      ],
    });
  });

  test("converts a single tool result into one user tool_result block", () => {
    const out = mapToAnthropic([msg({ role: "tool", tool_call_id: "tc_1", content: "ok" })]);
    expect(out).toEqual([{ role: "user", content: [{ type: "tool_result", tool_use_id: "tc_1", content: "ok" }] }]);
  });

  test("merges consecutive tool results into a single user message", () => {
    const out = mapToAnthropic([
      msg({ role: "tool", tool_call_id: "tc_1", content: "a" }),
      msg({ role: "tool", tool_call_id: "tc_2", content: "b" }),
    ]);
    expect(out).toHaveLength(1);
    expect(out[0].role).toBe("user");
    expect(out[0].content).toEqual([
      { type: "tool_result", tool_use_id: "tc_1", content: "a" },
      { type: "tool_result", tool_use_id: "tc_2", content: "b" },
    ]);
  });

  test("a fresh user message is not merged into a preceding tool_result group", () => {
    const out = mapToAnthropic([
      msg({ role: "tool", tool_call_id: "tc_1", content: "a" }),
      msg({ role: "user", content: "next question" }),
      msg({ role: "tool", tool_call_id: "tc_2", content: "b" }),
    ]);
    expect(out).toHaveLength(3);
    expect(out[0].content).toHaveLength(1);
    expect(out[1].content).toEqual([{ type: "text", text: "next question" }]);
    expect(out[2].content).toHaveLength(1);
  });

  test("emits a placeholder text block for an assistant message with no content", () => {
    const out = mapToAnthropic([msg({ role: "assistant", content: null })]);
    expect(out[0]).toEqual({ role: "assistant", content: [{ type: "text", text: "" }] });
  });

  test("does not leak the internal grouping marker", () => {
    const out = mapToAnthropic([
      msg({ role: "tool", tool_call_id: "tc_1", content: "a" }),
      msg({ role: "tool", tool_call_id: "tc_2", content: "b" }),
    ]);
    expect("_toolGroup" in out[0]).toBe(false);
    expect(JSON.stringify(out)).not.toContain("_toolGroup");
  });
});