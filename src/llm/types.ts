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
