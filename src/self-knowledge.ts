// Self-knowledge: lets vibecoder answer "who/what are you?" accurately from its
// own runtime state — model + provider, model card, config, tools, boundaries.
// A small runtime identity (provider/model) is kept here because the REPL can
// switch providers mid-session without writing config.json.
import { listTools } from "./tools/registry";
import { findModelCard } from "./llm/model-cards";
import { loadConfig } from "./llm/client";
import { loadConfigInfo } from "./config";
import { readPackageJson } from "./paths";
import { ledgerSummary, ledgerPath } from "./self-edit";
import { registerTool } from "./tools/registry";

let identity = { provider: "", model: "" };
export function setRuntimeIdentity(provider: string, model: string): void {
  identity = { provider, model };
}
export function runtimeIdentity(): { provider: string; model: string } {
  return { ...identity };
}

export const SELF_EDIT_PROTOCOL = `
SELF-EDIT PROTOCOL (appended by the runtime; config edits cannot remove it):
- Editing your live config (config.json — the file /about reports; in user installs this is ~/.vibecoder/config.json, or .env in a repo install) is a SELF-EDIT. Each one is written to SELF_EDITS.jsonl, an append-only audit ledger.
- Self-edits are STAGED: they only go live after the human runs /reload-config. Never claim a config change is live.
- If you intend to change config.json, tell the human what changed and that it needs /reload-config (approve) or /undo-self-edits (revert) before continuing.
- Never modify or delete SELF_EDITS.jsonl, and never remove the /reload-config or /undo-self-edits commands — such edits are blocked or audited and revertible via git (repo) or backups (user install).
- For source-code/style changes, edit files as normal; those are versioned by git.`;

function toolListLines(): string[] {
  return listTools().map((t) => `  - ${t.function.name}: ${t.function.description}`);
}

function cardLines(model: string): string[] {
  const c = findModelCard(model);
  if (!c) return ["  - no model card on file for this id — details not published"];
  const a = c.paramsActive ? ` (${c.paramsActive} active)` : "";
  return [
    `  - family: ${c.family}`,
    `  - architecture: ${c.architecture}`,
    `  - parameters: ${c.paramsTotal}${a}`,
    `  - context: ${c.context.toLocaleString("en")} tokens · max output: ${c.maxOutput}`,
    `  - data cutoff: ${c.dataCutoff}`,
    `  - license: ${c.license}`,
    `  - capabilities: ${c.capabilities.join(", ")}`,
    `  - limits: ${c.limits.join("; ")}`,
  ];
}

/** Human-facing /about report. */
export async function buildSelfReport(): Promise<string> {
  const model = identity.model || "unknown";
  const provider = identity.provider || "unknown";
  const pkg = readPackageJson();
  const version = pkg?.version || "dev";
  const { config: cfg, paths } = await loadConfigInfo();
  const cfgPath = paths.effectiveFile;

  const lines: string[] = [
    `\n${"\x1b[1m"}${"\x1b[32m"}vibecoder — self-knowledge report${"\x1b[0m"}`,
    ``,
    `Identity`,
    `  - I am Vibecoder, an autonomous AI coding agent running inside a terminal.`,
    `  - build: v${version} (runtime ${process.versions.bun ? "bun " + process.versions.bun : "node " + process.version})`,
    `  - provider: ${provider} · model: ${model}`,
    ``,
    `Model card`,
    ...cardLines(model),
    ``,
    `Routing`,
    ...routingReportLines(cfg),
    ``,
    `Runtime configuration`,
    `  - config file: ${cfgPath}${paths.merged ? " (built-in defaults + your ~/.vibecoder/config.json)" : ""}`,
    `  - systemPrompt: ${cfg?.systemPrompt ? "custom (from config)" : "not set explicitly"}`,
    `  - temperature: ${cfg?.temperature ?? "unset"} · maxTokens: ${cfg?.maxTokens ?? "unset"}`,
    `  - maxInputTokens: ${cfg?.maxInputTokens ?? "unset"} · maxInputTokensPerMinute: ${cfg?.maxInputTokensPerMinute ?? "unset"}`,
    ``,
    `Tools available to me (${listTools().length})`,
    ...toolListLines(),
    ``,
    `Self-edit state`,
    `  - audit ledger: ${ledgerPath()} (append-only, protected)`,
    ...(ledgerSummary(3).length ? ledgerSummary(3) : ["  - no self-edits recorded"]),
  ];
  return lines.join("\n");
}

function routingReportLines(cfg: Awaited<ReturnType<typeof loadConfig>> | null): string[] {
  const r = cfg?.routing;
  if (!r) return ["  - not configured — single model is used for everything"];
  const strategyNote = r.strategy === "keyword" ? "ambiguous → chat (keyword only)" : "ambiguous → asked to the cheap model";
  return [
    `  - auto-router: chat ${r.chatProvider}/${r.chatModel}  ·  heavy ${r.heavyProvider}/${r.heavyModel}`,
    `  - strategy: ${r.strategy} (${strategyNote})`,
    `  - the identity above reflects the model used for the last turn`,
  ];
}

/** Authenticity boundary text, shared by tool and /about. */
export async function buildSelfToolReport(): Promise<string> {
  const model = identity.model || "unknown";
  const provider = identity.provider || "unknown";
  const cfg = await loadConfig().catch(() => null);
  const c = findModelCard(model);
  const r = cfg?.routing;
  return [
    "I am Vibecoder, a terminal coding agent. I do not have a body or a life outside this conversation.",
    `provider=${provider} model=${model}`,
    c
      ? `model card: ${c.family} · ${c.architecture} · ${c.paramsTotal}${c.paramsActive ? " (" + c.paramsActive + " active)" : ""} · context ${c.context} · max output ${c.maxOutput} · data cutoff ${c.dataCutoff} · license ${c.license}`
      : "model card: not on file",
    `capabilities: ${(c ? c.capabilities : ["text chat", "tool calling"]).join(", ")}`,
    `boundaries: ${(c ? c.limits : ["no facts beyond what these tools show", "text-only"]).join("; ")}`,
    `routing: ${r ? `auto (chat ${r.chatProvider}/${r.chatModel} ↔ heavy ${r.heavyProvider}/${r.heavyModel}, strategy ${r.strategy}) · last turn used ${provider}/${model}` : "single model for everything"}`,
    `tools: ${listTools().map((t) => t.function.name).join(", ")}`,
    `config: temperature=${cfg?.temperature ?? "unset"} maxInputTokens=${cfg?.maxInputTokens ?? "unset"} maxInputTokensPerMinute=${cfg?.maxInputTokensPerMinute ?? "unset"} systemPrompt=${cfg?.systemPrompt ? "custom" : "default"}`,
    `self-edits are staged + audited in SELF_EDITS.jsonl; they go live only after the human runs /reload-config`,
  ].join("\n");
}

registerTool({
  definition: {
    type: "function",
    function: {
      name: "self_about",
      description:
        "Report who/what you are: your model, provider, capabilities, boundaries, tools, and runtime configuration. Use when the user asks 'who are you', 'what model are you', or 'what can you do'.",
      parameters: { type: "object", properties: {}, required: [] },
    },
  },
  async run(): Promise<string> {
    return buildSelfToolReport();
  },
});