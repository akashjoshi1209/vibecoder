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
  /** Optional per-session cost cap in USD. When set, the agent stops after the
   *  cumulative estimated cost exceeds this value. Default: undefined (no cap). */
  maxCostUsd?: number;
  /** Plan mode: task turns investigate + produce a plan for human approval before executing. */
  planMode?: boolean;
  queue?: QueueConfig;
  connectivity?: ConnectivityConfig;
  /** Permission model for tool execution. Controls what the agent is allowed to do. */
  permissions?: {
    /** Controls destructive shell commands (rm -rf, chmod 777, etc.).
     *  "allow" = run freely (default, backward-compatible). "ask" = prompt before running.
     *  "deny" = block entirely. */
    destructive?: "allow" | "ask" | "deny";
    /** Controls network access from bash (curl, wget, fetch, etc.). */
    network?: "allow" | "deny";
    /** Controls filesystem access scope for file tools and bash.
     *  "workspace" = restrict to the current working directory tree.
     *  "full" = allow access to the entire filesystem (default, backward-compatible). */
    filesystem?: "workspace" | "full";
  };
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
