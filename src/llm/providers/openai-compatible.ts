import type { ChatOptions, ChatChunk, StreamResult, ToolCall, LLMProvider, ProviderConfig } from "../types";
import { withTimeout, LLMTimeoutError, type TimeoutSpec } from "../timeout";
import { isTransientRateLimit, parseRetryAfter, sleepAbortable } from "../retry";

export class OpenAICompatibleProvider implements LLMProvider {
  constructor(private config: ProviderConfig) {}

  async streamChat(options: ChatOptions, onChunk: (chunk: ChatChunk) => void): Promise<StreamResult> {
    const key = this.config.apiKeyEnv ? process.env[this.config.apiKeyEnv] : undefined;
    if (this.config.apiKeyEnv && !key) {
      throw new Error(`Missing ${this.config.apiKeyEnv} env var — set it to use this provider`);
    }
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
    };
    if (key) headers["Authorization"] = `Bearer ${key}`;

    const body: Record<string, unknown> = {
      model: options.model,
      messages: options.messages.map((m) => {
        const msg: Record<string, unknown> = { role: m.role, content: m.content };
        if (m.tool_calls && m.tool_calls.length) {
          msg.tool_calls = m.tool_calls.map((tc) => ({
            id: tc.id,
            type: "function",
            function: { name: tc.name, arguments: tc.arguments || "" },
          }));
        }
        if (m.tool_call_id) msg.tool_call_id = m.tool_call_id;
        if (m.name) msg.name = m.name;
        return msg;
      }),
      stream: true,
    };
    if (options.temperature !== undefined) body.temperature = options.temperature;
    if (options.max_tokens !== undefined) body.max_tokens = options.max_tokens;
    if (options.tools && options.tools.length) body.tools = options.tools;

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
          const res = await fetch(`${this.config.baseURL}/chat/completions`, {
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
          markData();
          if (!res.ok || !res.body) {
            const text = await res.text().catch(() => "");
            throw new Error(`LLM request failed (${res.status}): ${text.slice(0, 500)}`);
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
      const delta = json.choices?.[0]?.delta;
      finishReason = json.choices?.[0]?.finish_reason ?? finishReason;
      if (!delta) return;

      if (delta.content) {
        text += delta.content;
        onChunk({ content: delta.content });
      }

      if (delta.tool_calls) {
        for (const tc of delta.tool_calls) {
          const idx = tc.index ?? 0;
          while (toolCalls.length <= idx) toolCalls.push({ id: "", name: "", arguments: "" });
          const current = toolCalls[idx];
          if (tc.id) current.id += tc.id;
          if (tc.function?.name) current.name += tc.function.name;
          if (tc.function?.arguments) current.arguments += tc.function.arguments;
        }
        onChunk({
          content: "",
          tool_calls: [...toolCalls].map((c) => ({ ...c })),
        });
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

    return { text, toolCalls, finishReason };
  }
}
