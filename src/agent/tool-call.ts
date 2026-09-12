import type { ToolCall } from "../llm/types";

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
  return toolCalls.map((tc) => {
    let args: Record<string, unknown> = {};
    try {
      args = JSON.parse(tc.arguments || "{}");
      if (typeof args !== "object" || args === null || Array.isArray(args)) args = {};
    } catch {
      const extracted = extractJson(tc.arguments);
      if (extracted !== null) args = extracted;
    }
    return { id: tc.id, name: tc.name, args };
  });
}

function extractJson(raw: string): Record<string, unknown> | null {
  const first = raw.indexOf("{");
  const last = raw.lastIndexOf("}");
  if (first === -1 || last === -1 || last <= first) return null;
  try {
    const parsed = JSON.parse(raw.slice(first, last + 1));
    if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) return parsed;
  } catch {
    return null;
  }
  return null;
}