export type Role = "system" | "user" | "assistant" | "tool";

export interface ToolCall {
  id: string;
  name: string;
  arguments: string;
}

export interface Message {
  role: Role;
  content: string | null;
  tool_calls?: ToolCall[];
  tool_call_id?: string;
  name?: string;
}

export interface ChatChunk {
  content: string;
  tool_calls?: Partial<ToolCall>[];
  finish_reason?: string | null;
  reasoning?: string;
  /** Token accounting, when the provider sends it. Streaming APIs usually
   *  deliver it only in the final chunk, so it appears once per turn. */
  usage?: TokenUsage;
}

/**
 * Token counts for one provider response.
 *
 * Field names follow the OpenAI-compatible shape, which is also what the
 * Anthropic provider maps onto it. Optional because several providers omit
 * usage on streamed responses unless explicitly asked, and a missing count must
 * not break a turn — cost tracking degrades to an estimate, it does not fail.
 */
export interface TokenUsage {
  promptTokens?: number;
  completionTokens?: number;
  /** Reasoning/thinking tokens, reported separately by several providers and
   *  billed at their own rate on some of them. */
  reasoningTokens?: number;
}

export interface ChatOptions {
  model: string;
  messages: Message[];
  temperature?: number;
  max_tokens?: number;
  tools?: ToolDefinition[];
  signal?: AbortSignal;
  timeoutMs?: number;
  timeoutIdleMs?: number;
}

export interface ToolDefinition {
  type: "function";
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
}

export interface ProviderConfig {
  type: "openai-compatible" | "anthropic";
  baseURL: string;
  apiKeyEnv: string;
  models: string[];
  timeoutMs?: number;
  timeoutIdleMs?: number;
  maxRateLimitRetries?: number;
}

export interface StreamResult {
  text: string;
  toolCalls: ToolCall[];
  finishReason: string | null;
  reasoning?: string;
  /** Token usage for this response, if the provider reported it. Absent means
   *  "unknown", not "zero" — cost tracking must not treat it as free. */
  usage?: TokenUsage;
}

export interface LLMProvider {
  streamChat(options: ChatOptions, onChunk: (chunk: ChatChunk) => void): Promise<StreamResult>;
}

export class ContextTooLargeError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.name = "ContextTooLargeError";
    this.status = status;
  }
}
