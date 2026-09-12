import { ContextTooLargeError, type ChatOptions, type ChatChunk, type StreamResult, type ToolCall, type LLMProvider, type ProviderConfig } from "../types";
import { withTimeout, LLMTimeoutError, type TimeoutSpec } from "../timeout";
import { isTransientRateLimit, parseRetryAfter, sleepAbortable } from "../retry";

export function mapToAnthropic(messages: ChatOptions["messages"]): any[] {
  const out: any[] = [];

  for (const m of messages) {
    if (m.role === "tool") {
      // Anthropic requires all tool_result blocks for one assistant turn to be
      // grouped in a SINGLE user message. Consecutive tool messages are merged.
      const result = {
        type: "tool_result" as const,
        tool_use_id: m.tool_call_id,
        content: m.content ?? "",
      };
      const last = out[out.length - 1];
      if (last && last.role === "user" && last._toolGroup) {
        last.content.push(result);
      } else {
        out.push({ role: "user", content: [result], _toolGroup: true });
      }
      continue;
    }

    const content: any[] = [];
    if (m.content) content.push({ type: "text", text: m.content });
    if (m.tool_calls && m.tool_calls.length) {
      for (const tc of m.tool_calls) {
        content.push({
          type: "tool_use",
          id: tc.id,
          name: tc.name,
          input: JSON.parse(tc.arguments || "{}"),
        });
      }
    }
    // A persisted assistant message may have neither text nor tool calls;
    // Anthropic rejects an empty content array, so emit a placeholder block.
    if (content.length === 0) content.push({ type: "text", text: "" });
    out.push({ role: m.role, content });
  }

  // Strip the internal grouping marker.
  for (const m of out) delete m._toolGroup;
  return out;
}

export class AnthropicProvider implements LLMProvider {
  constructor(private config: ProviderConfig) {}

  async streamChat(options: ChatOptions, onChunk: (chunk: ChatChunk) => void): Promise<StreamResult> {
    const key = this.config.apiKeyEnv ? process.env[this.config.apiKeyEnv] : undefined;
    if (!key) throw new Error(`Missing API key for Anthropic (set ${this.config.apiKeyEnv})`);

    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      "x-api-key": key,
      "anthropic-version": "2023-06-01",
    };

    const system = options.messages
      .filter((m) => m.role === "system")
      .map((m) => m.content ?? "")
      .join("\n");

    const body: any = {
      model: options.model,
      max_tokens: options.max_tokens ?? 4096,
      stream: true,
      messages: mapToAnthropic(options.messages.filter((m) => m.role !== "system")),
    };
    if (system) body.system = system;
    if (options.temperature !== undefined) body.temperature = options.temperature;
    if (options.tools && options.tools.length) {
      body.tools = options.tools.map((t) => ({
        name: t.function.name,
        description: t.function.description,
        input_schema: t.function.parameters,
      }));
    }

    let timedOut: LLMTimeoutError | null = null;
    const timeoutOpts: TimeoutSpec = {
      signal: options.signal,
      timeoutMs: options.timeoutMs ?? this.config.timeoutMs,
      idleMs: options.timeoutIdleMs ?? this.config.timeoutIdleMs,
      onTimeout: (e) => (timedOut = e),
    };
    try {
      return await withTimeout(timeoutOpts, async (signal, markData) => {
        const maxAttempts = (this.config.maxRateLimitRetries ?? 2) + 1;
        for (let attempt = 0; attempt < maxAttempts; attempt++) {
          const res = await fetch(`${this.config.baseURL}/messages`, {
            method: "POST",
            headers,
            body: JSON.stringify(body),
            signal,
          });
          if (isTransientRateLimit(res.status)) {
            const text = await res.text().catch(() => "");
            if (attempt === maxAttempts - 1) {
              throw new Error(`Rate limited (HTTP ${res.status}) after ${maxAttempts} attempts: ${text.slice(0, 400)}`);
            }
            await sleepAbortable(parseRetryAfter(res, text), signal);
            markData();
            continue;
          }
          if (res.status === 413 || res.status === 400) {
            const text = await res.text().catch(() => "");
            if (res.status === 413 || /(prompt_too_long|request_too_large|too_many_tokens|maximum context|too long)/i.test(text)) {
              throw new ContextTooLargeError(res.status, `Context too large (HTTP ${res.status}): ${text.slice(0, 500)}`);
            }
            throw new Error(`Anthropic request failed (${res.status}): ${text.slice(0, 500)}`);
          }
          markData();
          if (!res.ok || !res.body) {
            const text = await res.text().catch(() => "");
            throw new Error(`Anthropic request failed (${res.status}): ${text.slice(0, 500)}`);
          }
          return this.parseSSE(res.body, onChunk, markData);
        }
        throw new Error("unreachable");
      });
    } catch (err) {
      if (timedOut) throw timedOut;
      throw err;
    }
  }

  private async parseSSE(
    body: ReadableStream<Uint8Array>,
    onChunk: (chunk: ChatChunk) => void,
    onData?: () => void,
  ): Promise<StreamResult> {
    const reader = body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let text = "";
    const toolCalls: ToolCall[] = [];
    let finishReason: string | null = null;
    let currentTool: { id: string; name: string; startIdx: number; args: string } | null = null;

    const flushTool = () => {
      if (!currentTool) return;
      toolCalls.push({
        id: currentTool.id,
        name: currentTool.name,
        arguments: currentTool.args || "{}",
      });
      currentTool = null;
    };

    const processLine = (line: string) => {
      if (!line.startsWith("data:")) return;
      const data = line.slice(5).trim();
      if (data === "[DONE]") return;
      let json: any;
      try {
        json = JSON.parse(data);
      } catch {
        return;
      }
      const type = json.type;
      if (type === "message_delta") {
        finishReason = json.delta?.stop_reason ?? finishReason;
      } else if (type === "content_block_start") {
        if (json.content_block?.type === "tool_use") {
          flushTool();
          currentTool = {
            id: json.content_block.id,
            name: json.content_block.name,
            startIdx: toolCalls.length,
            args: "",
          };
        }
      } else if (type === "content_block_delta") {
        const delta = json.delta;
        if (delta?.type === "text_delta") {
          text += delta.text;
          onChunk({ content: delta.text ?? "" });
        } else if (delta?.type === "input_json_delta" && currentTool) {
          currentTool.args += delta.partial_json ?? "";
        }
      } else if (type === "content_block_stop") {
        flushTool();
      } else if (type === "message_start") {
        // ignore
      }
    };

    while (true) {
      const { done, value } = await reader.read();
      onData?.();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";
      for (const line of lines) {
        const trimmed = line.trim();
        if (trimmed) processLine(trimmed);
      }
    }
    flushTool();
    if (toolCalls.length) onChunk({ content: "", tool_calls: toolCalls.map((c) => ({ ...c })) });
    return { text, toolCalls, finishReason };
  }
}
