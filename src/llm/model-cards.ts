// "Self-knowledge" catalog: what vibecoder knows about the models it can run.
// Fields are intentionally honest — entries marked "unknown"/"not published"
// stay that way until verified rather than guessing.

export interface ModelCard {
  id: string;
  alias?: string[];
  family: string;
  architecture: string;
  paramsTotal: string;
  paramsActive?: string;
  context: number;
  maxOutput: number;
  dataCutoff: string;
  license: string;
  capabilities: string[];
  limits: string[];
}

const CARDS: ModelCard[] = [
  {
    id: "nvidia/nemotron-3-ultra-550b-a55b",
    family: "NVIDIA Nemotron 3",
    architecture: "Hybrid Mamba-Transformer Mixture-of-Experts",
    paramsTotal: "550B",
    paramsActive: "55B",
    context: 1_000_000,
    maxOutput: 32768,
    dataCutoff: "post-training May 2026 / pre-training Sep 2025",
    license: "OpenMDW-1.1",
    capabilities: ["text chat", "long-context agentic workflows", "reasoning/planning", "tool calling"],
    limits: ["text-only (no native image/video input)", "hosted trial API — NVIDIA NIM terms apply"],
  },
  {
    id: "nvidia/nemotron-3-super-120b-a12b",
    alias: ["nvidia/nemotron-3-super"],
    family: "NVIDIA Nemotron 3",
    architecture: "LatentMoE — Mamba-2 + MoE + attention hybrid, Multi-Token Prediction",
    paramsTotal: "120B",
    paramsActive: "12B",
    context: 1_000_000,
    maxOutput: 32768,
    dataCutoff: "not published",
    license: "OpenMDW-1.1",
    capabilities: ["text chat", "agentic workloads", "tool calling"],
    limits: ["text-only", "hosted trial API — NVIDIA NIM terms apply"],
  },
  {
    id: "qwen3.8-27b",
    alias: ["qwen/qwen3.8-27b"],
    family: "Qwen (Alibaba)",
    architecture: "unknown (GROQ-hosted; Qwen3 family)",
    paramsTotal: "~27B (per model id)",
    context: 128_000,
    maxOutput: 4000,
    dataCutoff: "not published for this hosting",
    license: "Apache-2.0 (Qwen3)",
    capabilities: ["text chat", "tool calling"],
    limits: ["text-only", "GROQ free tier caps input at 7000 tokens/min"],
  },
  {
    id: "openai/gpt-oss-120b",
    family: "OpenAI GPT-OSS",
    architecture: "Mixture-of-Experts decoder",
    paramsTotal: "120B",
    paramsActive: "5B",
    context: 128_000,
    maxOutput: 32768,
    dataCutoff: "not published",
    license: "Apache-2.0 + OpenAI additional terms",
    capabilities: ["text chat", "tool calling"],
    limits: ["text-only"],
  },
  {
    id: "openai/gpt-oss-20b",
    family: "OpenAI GPT-OSS",
    architecture: "Mixture-of-Experts decoder",
    paramsTotal: "21B",
    paramsActive: "3.6B",
    context: 128_000,
    maxOutput: 32768,
    dataCutoff: "not published",
    license: "Apache-2.0 + OpenAI additional terms",
    capabilities: ["text chat", "tool calling"],
    limits: ["text-only"],
  },
  {
    id: "groq/compound",
    family: "GROQ compiler/routing model",
    architecture: "unknown (provider-composite)",
    paramsTotal: "not published",
    context: 128_000,
    maxOutput: 4000,
    dataCutoff: "not published",
    license: "proprietary (hosted)",
    capabilities: ["text chat", "tool calling"],
    limits: ["text-only", "GROQ free tier caps input at 7000 tokens/min"],
  },
  {
    id: "qwen2.5:1.5b",
    family: "Qwen2.5 (Alibaba)",
    architecture: "Dense Transformer decoder",
    paramsTotal: "1.5B",
    context: 131_072,
    maxOutput: 8192,
    dataCutoff: "knowledge cutoff Sep 2024 (per Qwen2.5)",
    license: "Apache-2.0",
    capabilities: ["text chat", "tool calling"],
    limits: ["text-only", "small model — keep tasks simple", "local Ollama — depends on host hardware"],
  },
  {
    id: "llama3.1",
    family: "Meta Llama 3.1",
    architecture: "Dense Transformer decoder",
    paramsTotal: "varies by tag (default tag resolves to a specific size)",
    context: 131_072,
    maxOutput: 8192,
    dataCutoff: "Dec 2023 (base pretraining)",
    license: "Llama 3.1 Community License",
    capabilities: ["text chat"],
    limits: ["text-only", "local Ollama — depends on host hardware"],
  },
  {
    id: "gpt-4o",
    family: "OpenAI",
    architecture: "Transformer (proprietary)",
    paramsTotal: "not published",
    context: 128_000,
    maxOutput: 16384,
    dataCutoff: "Oct 2023",
    license: "proprietary (hosted)",
    capabilities: ["text chat", "tool calling", "image input (API-dependent)"],
    limits: ["paid API — not free tier"],
  },
  {
    id: "gpt-4o-mini",
    family: "OpenAI",
    architecture: "Transformer (proprietary)",
    paramsTotal: "not published",
    context: 128_000,
    maxOutput: 16384,
    dataCutoff: "Oct 2023",
    license: "proprietary (hosted)",
    capabilities: ["text chat", "tool calling"],
    limits: ["paid API — not free tier"],
  },
  {
    id: "claude-sonnet-4-5",
    family: "Anthropic Claude family",
    architecture: "proprietary (Anthropic)",
    paramsTotal: "not published",
    context: 200_000,
    maxOutput: 8192,
    dataCutoff: "not published",
    license: "proprietary (hosted)",
    capabilities: ["text chat", "tool calling"],
    limits: ["paid API — not free tier", "hosted by Anthropic"],
  },
  {
    id: "claude-3-5-haiku-latest",
    family: "Anthropic Claude family",
    architecture: "proprietary (Anthropic)",
    paramsTotal: "not published",
    context: 200_000,
    maxOutput: 8192,
    dataCutoff: "Apr 2024 (initial 3.5 Haiku)",
    license: "proprietary (hosted)",
    capabilities: ["text chat", "tool calling"],
    limits: ["paid API — not free tier", "hosted by Anthropic"],
  },
];

export function findModelCard(model: string): ModelCard | null {
  const m = model.toLowerCase();
  return (
    CARDS.find(
      (c) => c.id.toLowerCase() === m || (c.alias ?? []).some((a) => a.toLowerCase() === m),
    ) ??
    CARDS.find((c) => c.id.toLowerCase().includes(m) || m.includes(c.id.toLowerCase())) ??
    null
  );
}

export function listModelCards(): ModelCard[] {
  return CARDS;
}