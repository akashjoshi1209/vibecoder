import type { ToolCall } from "../llm/types";
import { parseToolArguments } from "../llm/args";

interface ParsedToolCall {
  id: string;
  name: string;
  args: Record<string, unknown>;
}

/**
 * Guarantees every tool call carries a stable, unique id. Providers sometimes
 * omit the id on streamed tool calls; the assistant message and the matching
 * tool-result message must reference the same id or the API cannot pair them.
 */
export function normalizeToolCalls(toolCalls: ToolCall[], seed = 1): ToolCall[] {
  return toolCalls.map((tc, i) => ({
    ...tc,
    id: tc.id || `call_${seed}_${i}`,
  }));
}

export function parseToolCalls(toolCalls: ToolCall[]): ParsedToolCall[] {
  return toolCalls.map((tc) => ({
    id: tc.id,
    name: tc.name,
    args: parseToolArguments(tc.arguments),
  }));
}