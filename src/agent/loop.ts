import { ContextTooLargeError, type ChatOptions, type Message, type StreamResult, type ToolCall } from "../llm/types";
import { listTools, executeTool, type ToolContext } from "../tools/registry";
import { normalizeToolCalls, parseToolCalls } from "./tool-call";
import { estimateTokens, estimateMessagesTokens, trimMessages, type TrimResult } from "../llm/tokens";
import { RatePacer, paceWait } from "../llm/pace";

export interface AgentCallbacks {
  onModelText?: (text: string) => void;
  onReasoning?: (text: string) => void;
  onToolStart?: (name: string, args: Record<string, unknown>) => void;
  onToolEnd?: (name: string, result: string) => void;
  onDone?: (result: StreamResult) => void;
  confirmTool?: (name: string, args: Record<string, unknown>) => Promise<boolean>;
  maxSteps?: number;
  /** If trimmed, a short note is passed through this callback. */
  onTrimmed?: (trimmed: number, truncatedChars: number) => void;
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
    chatOptions?: Partial<ChatOptions>;
    /** Max input tokens the provider accepts per request. When set, messages are
     *  trimmed before each step and a 413/ContextTooLarge triggers a tighter retry. */
    maxInputTokens?: number;
    /** Optional per-minute input-token cap (e.g. GROQ free-tier ITPM). When set,
     *  requests are paced (free sleep) so the rolling-minute estimate stays under it. */
    maxInputTokensPerMinute?: number;
  },
  callbacks: AgentCallbacks = {},
): Promise<AgentResult> {
  const maxSteps = callbacks.maxSteps ?? 40;
  const messages: Message[] = [{ role: "system", content: options.systemPrompt }, ...options.initialMessages];
  const toolDefs = listTools();
  let toolCalls = 0;

  // Pre-compute fixed overhead once (tokens consumed outside the messages array).
  const systemTokens = options.maxInputTokens ? estimateTokens(options.systemPrompt) : 0;
  const toolsJson = options.maxInputTokens && toolDefs.length ? JSON.stringify(toolDefs) : "";
  const toolsTokens = options.maxInputTokens ? estimateTokens(toolsJson) : 0;

  // Calibration data (GROQ real usage vs estimate) showed estimates run ~1.26x
  // low on tool_args-heavy traffic. Trim to maxInputTokens/SAFETY_FACTOR so the
  // real request stays well under the provider's hard cap even if users raise it.
  const SAFETY_FACTOR = 1.3;
  let retryBudgetDelta = 0;
  const effectiveBudget = () =>
    options.maxInputTokens ? Math.floor(options.maxInputTokens / SAFETY_FACTOR) : 0;
  const effectiveReserved = () =>
    Math.floor((systemTokens + toolsTokens) / SAFETY_FACTOR) + retryBudgetDelta;
  const estimateRequestTokens = () =>
    (options.maxInputTokens ? systemTokens + toolsTokens : 0) + estimateMessagesTokens(messages);
  const pacer = options.maxInputTokensPerMinute
    ? new RatePacer(options.maxInputTokensPerMinute)
    : null;

  for (let step = 0; step < maxSteps; step++) {
    if (options.signal?.aborted) {
      callbacks.onDone?.({ text: "", toolCalls: [], finishReason: "aborted" });
      return { finalText: "\n[interrupted]", toolCalls, steps: step, aborted: true };
    }

    let result: StreamResult;
    retryBudgetDelta = 0;
    // ContextTooLarge retry: try once more with a tighter budget before giving up.
    for (;;) {
      if (options.maxInputTokens) {
        const trim = trimMessages(messages, {
          budgetTokens: effectiveBudget(),
          reservedTokens: effectiveReserved(),
        });
        messages.length = 0;
        messages.push(...trim.messages);
        if (trim.trimmed > 0 && retryBudgetDelta === 0) callbacks.onTrimmed?.(trim.trimmed, trim.truncatedChars);
      }

      const chatOpts: ChatOptions = {
        model: options.model,
        messages,
        tools: toolDefs,
        signal: options.signal,
        ...options.chatOptions,
      };

      // Pace to the provider's per-minute budget before sending.
      await paceWait(pacer, estimateRequestTokens(), options.signal);

      try {
        result = await options.provider(chatOpts, (chunk) => {
          if (chunk.reasoning) callbacks.onReasoning?.(chunk.reasoning);
          if (chunk.content) callbacks.onModelText?.(chunk.content);
        });
        if (pacer) pacer.record(estimateRequestTokens());
        break; // success
      } catch (err: any) {
        if (err instanceof ContextTooLargeError && retryBudgetDelta === 0) {
          retryBudgetDelta = 512;
          continue;
        }
        if (options.signal?.aborted || err?.name === "AbortError") {
          callbacks.onDone?.({ text: "", toolCalls: [], finishReason: "aborted" });
          return { finalText: "\n[interrupted]", toolCalls, steps: step, aborted: true };
        }
        throw err;
      }
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

    // Normalize tool-call ids so the assistant message and its tool results
    // always reference the same id, even when the provider omits one.
    const normalizedCalls = normalizeToolCalls(result.toolCalls, step + 1);
    // Assistant message carries the tool calls
    const assistantMsg: Message = {
      role: "assistant",
      content: result.text || null,
      tool_calls: normalizedCalls.map((tc) => ({ ...tc })),
    };
    // If we already pushed it above without tool_calls, replace it
    if (messages[messages.length - 1]?.role === "assistant") {
      messages[messages.length - 1] = assistantMsg;
    } else {
      messages.push(assistantMsg);
    }

    const parsed = parseToolCalls(normalizedCalls);

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