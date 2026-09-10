import type { ChatOptions, Message, StreamResult, ToolCall } from "../llm/types";
import { listTools, executeTool, type ToolContext } from "../tools/registry";
import { parseToolCalls } from "./tool-call";

export interface AgentCallbacks {
  onModelText?: (text: string) => void;
  onToolStart?: (name: string, args: Record<string, unknown>) => void;
  onToolEnd?: (name: string, result: string) => void;
  onDone?: (result: StreamResult) => void;
  confirmTool?: (name: string, args: Record<string, unknown>) => Promise<boolean>;
  maxSteps?: number;
}

export interface AgentResult {
  finalText: string;
  toolCalls: number;
  steps: number;
  aborted: boolean;
}

export async function runAgent(
  options: {
    provider: (opts: ChatOptions, onChunk: (c: any) => void) => Promise<StreamResult>;
    systemPrompt: string;
    model: string;
    initialMessages: Message[];
    toolCtx: ToolContext;
    signal?: AbortSignal;
  },
  callbacks: AgentCallbacks = {},
): Promise<AgentResult> {
  const maxSteps = callbacks.maxSteps ?? 40;
  const messages: Message[] = [{ role: "system", content: options.systemPrompt }, ...options.initialMessages];
  const toolDefs = listTools();
  let toolCalls = 0;

  for (let step = 0; step < maxSteps; step++) {
    if (options.signal?.aborted) {
      callbacks.onDone?.({ text: "", toolCalls: [], finishReason: "aborted" });
      return { finalText: "\n[interrupted]", toolCalls, steps: step, aborted: true };
    }

    const chatOpts: ChatOptions = {
      model: options.model,
      messages,
      tools: toolDefs,
      signal: options.signal,
    };

    let result: StreamResult;
    try {
      result = await options.provider(chatOpts, (chunk) => {
        if (chunk.content) callbacks.onModelText?.(chunk.content);
      });
    } catch (err: any) {
      if (options.signal?.aborted || err?.name === "AbortError") {
        callbacks.onDone?.({ text: "", toolCalls: [], finishReason: "aborted" });
        return { finalText: "\n[interrupted]", toolCalls, steps: step, aborted: true };
      }
      throw err;
    }

    if (result.text) {
      messages.push({ role: "assistant", content: result.text });
    } else if (result.toolCalls.length === 0) {
      messages.push({ role: "assistant", content: null });
    }

    if (result.toolCalls.length === 0) {
      // No tool calls: conversation finished
      callbacks.onDone?.(result);
      return { finalText: result.text, toolCalls, steps: step + 1, aborted: false };
    }

    // Assistant message carries the tool calls
    const assistantMsg: Message = {
      role: "assistant",
      content: result.text || null,
      tool_calls: result.toolCalls.map((tc) => ({ ...tc })),
    };
    // If we already pushed it above without tool_calls, replace it
    if (messages[messages.length - 1]?.role === "assistant") {
      messages[messages.length - 1] = assistantMsg;
    } else {
      messages.push(assistantMsg);
    }

    const parsed = parseToolCalls(result.toolCalls);

    for (const call of parsed) {
      toolCalls++;
      if (!call.name) {
        const id = call.id || `call_${toolCalls}`;
        messages.push({
          role: "tool",
          tool_call_id: id,
          content:
            "ERROR: the model emitted a tool call with no function name. Reissue a valid tool call or finish by responding with plain text.",
          name: "unknown",
        });
        continue;
      }
      callbacks.onToolStart?.(call.name, call.args);
      let output: string;
      let approved = true;
      if (callbacks.confirmTool) {
        approved = await callbacks.confirmTool(call.name, call.args);
      }
      if (!approved) {
        output = "(tool call rejected by user — inform the user and adjust your approach)";
      } else {
        try {
          output = await executeTool(call.name, call.args, options.toolCtx);
        } catch (err: any) {
          output = `ERROR: ${err?.message ?? String(err)}`;
        }
      }
      callbacks.onToolEnd?.(call.name, output);
      messages.push({ role: "tool", tool_call_id: call.id, content: output, name: call.name });
    }
  }

  callbacks.onDone?.({ text: "", toolCalls: [], finishReason: "max_steps" });
  return { finalText: "(reached max steps without completion)", toolCalls, steps: maxSteps, aborted: false };
}