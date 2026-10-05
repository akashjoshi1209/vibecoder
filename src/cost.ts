// ── cost tracking ──────────────────────────────────────────────────────────────
// Tracks token usage and estimated cost across turns. Persists a running
// session ledger in memory and can report per-turn and cumulative cost.

export interface CostEvent {
  turnIndex: number;
  provider: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
  reasoningTokens?: number;
  estimatedCostUsd: number;
  timestamp: number;
}

export interface CostSummary {
  turnCount: number;
  totalInputTokens: number;
  totalOutputTokens: number;
  totalReasoningTokens: number;
  totalCostUsd: number;
  byTurn: CostEvent[];
}

const byTurn: CostEvent[] = [];
let turnIndex = 0;

// Rough per-token costs (USD). Keep updated as provider pricing changes.
const TOKEN_COSTS: Record<string, { input: number; output: number; reasoning?: number }> = {
  // GROQ (free tier: 0, paid tier approximations)
  groq:            { input: 0.0000,  output: 0.00000 },
  openai:          { input: 0.000005, output: 0.000015 },
  anthropic:       { input: 0.000003, output: 0.000015 },
  nvidia:          { input: 0.0000005, output: 0.0000015 },
  ollama:          { input: 0.0, output: 0.0 },
};

function rateFor(provider: string, _model: string): { input: number; output: number; reasoning?: number } {
  return TOKEN_COSTS[provider] ?? { input: 0.00001, output: 0.00003 };
}

export function recordCost(params: {
  provider: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
  reasoningTokens?: number;
}): CostEvent {
  const rate = rateFor(params.provider, params.model);
  const inputCost = params.inputTokens * rate.input;
  const outputCost = params.outputTokens * rate.output;
  const reasoningCost = (params.reasoningTokens ?? 0) * (rate.reasoning ?? rate.output);
  const event: CostEvent = {
    turnIndex: turnIndex++,
    provider: params.provider,
    model: params.model,
    inputTokens: params.inputTokens,
    outputTokens: params.outputTokens,
    reasoningTokens: params.reasoningTokens,
    estimatedCostUsd: inputCost + outputCost + reasoningCost,
    timestamp: Date.now(),
  };
  byTurn.push(event);
  return event;
}

export function costSummary(): CostSummary {
  const totalInput = byTurn.reduce((s, e) => s + e.inputTokens, 0);
  const totalOutput = byTurn.reduce((s, e) => s + e.outputTokens, 0);
  const totalReasoning = byTurn.reduce((s, e) => s + (e.reasoningTokens ?? 0), 0);
  const totalCost = byTurn.reduce((s, e) => s + e.estimatedCostUsd, 0);
  return {
    turnCount: byTurn.length,
    totalInputTokens: totalInput,
    totalOutputTokens: totalOutput,
    totalReasoningTokens: totalReasoning,
    totalCostUsd: totalCost,
    byTurn: byTurn,
  };
}

export function clearCostTracking(): void {
  byTurn.length = 0;
  turnIndex = 0;
}

export function costReportText(): string {
  const s = costSummary();
  if (!s.turnCount) return "  no cost data yet (this session)";
  const lines = [
    `  ${s.turnCount} turn(s)`,
    `  input:  ${s.totalInputTokens.toLocaleString()} tokens`,
    `  output: ${s.totalOutputTokens.toLocaleString()} tokens`,
    `  reasoning: ${s.totalReasoningTokens.toLocaleString()} tokens`,
    `  estimated cost: $${s.totalCostUsd.toFixed(6)} (this session, rough estimate)`,
    ``,
    `  per-turn breakdown:`,
    ...s.byTurn.map((e) =>
      `    turn ${e.turnIndex}: ${e.provider}/${e.model} · in ${e.inputTokens} · out ${e.outputTokens}${e.reasoningTokens ? ` · reasoning ${e.reasoningTokens}` : ""} · ~$${e.estimatedCostUsd.toFixed(6)}`
    ),
  ];
  return lines.join("\n");
}
