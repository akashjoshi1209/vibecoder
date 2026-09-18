import type { ChatOptions, LLMProvider, ProviderConfig } from "./types";
import type { RoutingConfig } from "./router";
import { AnthropicProvider } from "./providers/anthropic";
import { OpenAICompatibleProvider } from "./providers/openai-compatible";
export { loadConfig, configPaths, userConfigFile } from "../config";
import { loadConfig } from "../config";

export interface QueueConfig {
  /** Absolute or ~-path to the queue JSON. Defaults to ~/.vibecoder/queue.json. */
  file?: string;
  /** Block destructive shell commands during unattended runs. Default true. */
  autoApproveExceptDestructive?: boolean;
  daemonLog?: string;
}

export interface ConnectivityConfig {
  probeUrl?: string;
  pollMs?: number;
  timeoutMs?: number;
}

export interface RootConfig {
  provider: string;
  model: string;
  providers: Record<string, ProviderConfig>;
  routing?: RoutingConfig;
  systemPrompt?: string;
  temperature?: number;
  maxTokens?: number;
  maxInputTokens?: number;
  /** Optional per-minute input-token cap for pacing (e.g. GROQ free-tier ITPM). */
  maxInputTokensPerMinute?: number;
  /** Plan mode: task turns investigate + produce a plan for human approval before executing. */
  planMode?: boolean;
  queue?: QueueConfig;
  connectivity?: ConnectivityConfig;
}

export function createProvider(config: RootConfig, providerName?: string): { provider: LLMProvider; model: string; name: string } {
  const name = providerName || config.provider;
  const pc = config.providers[name];
  if (!pc) throw new Error(`Unknown provider "${name}". Available: ${Object.keys(config.providers).join(", ")}`);
  let provider: LLMProvider;
  if (pc.type === "anthropic") {
    provider = new AnthropicProvider(pc);
  } else {
    provider = new OpenAICompatibleProvider(pc);
  }
  const model = pc.models.includes(config.model) ? config.model : (pc.models[0] ?? config.model);
  return { provider, model, name };
}
