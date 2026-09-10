import { describe, expect, test } from "bun:test";
import { parseToolCalls } from "./tool-call";
import type { ToolCall } from "../llm/types";

describe("parseToolCalls", () => {
  test("parses valid tool calls", () => {
    const input: ToolCall[] = [
      { id: "call_1", name: "bash", arguments: '{"command":"echo hi"}' },
    ];
    const result = parseToolCalls(input);
    expect(result).toEqual([{ id: "call_1", name: "bash", args: { command: "echo hi" } }]);
  });

  test("falls back to {} on invalid JSON arguments", () => {
    const input: ToolCall[] = [
      { id: "call_2", name: "grep", arguments: "not json at all" },
    ];
    const result = parseToolCalls(input);
    expect(result[0].args).toEqual({});
  });

  test("extracts nested JSON from messy strings", () => {
    const input: ToolCall[] = [
      { id: "call_3", name: "bash", arguments: 'Here is the JSON: {"command":"ls"} and more' },
    ];
    const result = parseToolCalls(input);
    expect(result[0].args).toEqual({ command: "ls" });
  });

  test("preserves empty name/id for caller to handle", () => {
    const input: ToolCall[] = [
      { id: "", name: "", arguments: "{}" },
    ];
    const result = parseToolCalls(input);
    expect(result[0].id).toBe("");
    expect(result[0].name).toBe("");
    expect(result[0].args).toEqual({});
  });

  test("handles missing arguments field", () => {
    const input: ToolCall[] = [
      { id: "call_4", name: "bash", arguments: "" },
    ];
    const result = parseToolCalls(input);
    expect(result[0].args).toEqual({});
  });

  test("multiple tool calls parsed independently", () => {
    const input: ToolCall[] = [
      { id: "c1", name: "bash", arguments: '{"command":"pwd"}' },
      { id: "c2", name: "read_file", arguments: "garbage" },
      { id: "c3", name: "grep", arguments: '{"pattern":"foo","path":"/tmp"}' },
    ];
    const result = parseToolCalls(input);
    expect(result).toHaveLength(3);
    expect(result[0].args).toEqual({ command: "pwd" });
    expect(result[1].args).toEqual({});
    expect(result[2].args).toEqual({ pattern: "foo", path: "/tmp" });
  });
});
