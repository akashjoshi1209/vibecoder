import type { ChatOptions, LLMProvider, ProviderConfig } from "./types";
import type { RoutingConfig } from "./router";
import { AnthropicProvider } from "./providers/anthropic";
import { OpenAICompatibleProvider } from "./providers/openai-compatible";
import { join } from "node:path";

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

const DEFAULT_CONFIG_PATH = (() => {
  const env = process.env.VIBECODER_CONFIG;
  if (env) return env;
  return join(import.meta.dir, "../../config.json");
})();

export async function loadConfig(path = DEFAULT_CONFIG_PATH): Promise<RootConfig> {
  const text = await Bun.file(path).text();
  return JSON.parse(text) as RootConfig;
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
