import { ContextTooLargeError, type ChatOptions, type Message, type StreamResult, type ToolCall } from "../llm/types";
import { listTools, executeTool, needsApproval, type ToolContext } from "../tools/registry";
import {
  approvalSig,
  isApprovalRequired,
  noPrompterMessage,
  rejectedMessage,
} from "../tools/approval";
import { normalizeToolCalls, parseToolCalls, type ParsedToolCall } from "./tool-call";
import { estimateTokens, estimateMessagesTokens, trimMessages, type TrimResult } from "../llm/tokens";
import {
  DEFAULT_WATERMARK,
  buildWorkingSet,
  planFold,
  summarizeHistory,
  type CompactionState,
} from "../llm/compact";
import { numberSetting } from "../runtime";
import { RatePacer, paceWait } from "../llm/pace";
import type { RunTrace } from "../trace";

export interface AgentCallbacks {
  onModelText?: (text: string) => void;
  onReasoning?: (text: string) => void;
  onToolStart?: (name: string, args: Record<string, unknown>) => void;
  onToolEnd?: (name: string, result: string) => void;
  onDone?: (result: StreamResult) => void;
  /** Approval gate. `reason` is set when the request came from the permission
   *  model (destructive: "ask") rather than from /approve being on — the UI
   *  should prompt on a reason even when blanket approval is off, because the
   *  user did explicitly ask to be consulted for destructive commands. */
  confirmTool?: (name: string, args: Record<string, unknown>, reason?: string) => Promise<boolean>;
  maxSteps?: number;
  /** If trimmed, a short note is passed through this callback. */
  onTrimmed?: (trimmed: number, truncatedChars: number) => void;
  /** Fired after a summarizing compaction folds older messages into a digest,
   *  so the UI can say so instead of context silently shrinking. */
  onCompact?: (info: { foldedMessages: number; foldedTokens: number; summaryTokens: number }) => void;
  /** Called at the start of each step with the current step index (1-based) and
   *  the running total of tool calls executed so far. UI can use this to show
   *  live progress in a status bar. */
  onStepUpdate?: (stepIndex: number, toolCallCount: number, maxSteps: number) => void;
}

export interface AgentResult {
  finalText: string;
  toolCalls: number;
  steps: number;
  aborted: boolean;
  /** Tokens spent across every step of this turn. A 40-step turn makes 41
   *  provider calls and costs accordingly, so this is the only figure worth
   *  showing; per-step costs are not what anyone budgets against. Undefined
   *  when the provider reported no usage at all. */
  usage?: { promptTokens: number; completionTokens: number; reasoningTokens: number };
  /** Set when the turn stopped because maxCostUsd was reached. */
  costCapHit?: { limitUsd: number; spentUsd: number };
  /** The compaction digest after this turn, when one exists. Persist it with
   *  the session and hand it back as `compactionSummary` on the next turn so
   *  folded-away findings survive resume instead of evaporating. */
  compactionSummary?: string;
}

/**
 * Run one tool call, handling a mid-run approval request.
 *
 * A tool in `permissions.destructive: "ask"` mode throws ApprovalRequiredError
 * instead of executing. That is control flow, not failure, so it is handled
 * here: ask the human, and re-run the same call if they say yes.
 *
 * The prompt is requested with a `reason`, which is how the UI knows to ask even
 * when /approve is off. Without that, "ask" degenerates back into the silent
 * no-op it was before.
 */
async function invokeWithApproval(
  call: ParsedToolCall,
  toolCtx: ToolContext,
  callbacks: AgentCallbacks,
  trace?: RunTrace,
): Promise<string> {
  const name = call.name as string;
  try {
    return await executeTool(name, call.args, toolCtx);
  } catch (err) {
    if (!isApprovalRequired(err)) {
      const msg = err && typeof err === "object" && "message" in err
        ? String((err as Record<string, unknown>).message)
        : String(err);
      return `ERROR: ${msg}`;
    }
    if (!callbacks.confirmTool) return noPrompterMessage(name, err.reason);
    const ok = await callbacks.confirmTool(name, call.args, err.reason);
    trace?.write({ kind: "approve", tool: name, approved: ok, source: "permission", reason: err.reason });
    if (!ok) return rejectedMessage(name, err.reason);
    // Approved: hand the consent to the tool for exactly this re-run. The
    // marker is one-shot — cleared below whatever happens — so a later call
    // with the same arguments has to ask again. Without it the tool's `ask`
    // check, being a pure function of the command, would fire again on its own
    // re-run and the human's "yes" would end in "no approver attached".
    // A request that still fires after that is the tool asking for consent a
    // second time (e.g. two destructive parts): do not loop.
    toolCtx.approval = { tool: name, sig: approvalSig(name, call.args), at: Date.now() };
    try {
      return await executeTool(name, call.args, toolCtx);
    } catch (retryErr) {
      if (isApprovalRequired(retryErr)) return noPrompterMessage(name, retryErr.reason);
      const msg = retryErr && typeof retryErr === "object" && "message" in retryErr
        ? String((retryErr as Record<string, unknown>).message)
        : String(retryErr);
      return `ERROR: ${msg}`;
    } finally {
      delete toolCtx.approval;
    }
  }
}

export async function runAgent(
  options: {
    provider: (opts: ChatOptions, onChunk: (c: any) => void) => Promise<StreamResult>;
    systemPrompt: string;
    model: string;
    initialMessages: Message[];
    toolCtx: ToolContext;
    signal?: AbortSignal;
    chatOptions?: Partial<ChatOptions>;
    /** Max input tokens the provider accepts per request. When set, messages are
     *  trimmed before each step and a 413/ContextTooLarge triggers a tighter retry. */
    maxInputTokens?: number;
    /** Optional per-minute input-token cap (e.g. GROQ free-tier ITPM). When set,
     *  requests are paced (free sleep) so the rolling-minute estimate stays under it. */
    maxInputTokensPerMinute?: number;
    /** Hard spend ceiling for this turn in USD.
     *
     * `maxCostUsd` in config.json was validated and documented but never read by
     * anything: the loop had no cost accounting at all, so setting it to 5 and
     * handing the agent a 40-step task produced no limit whatsoever. The cap is
     * enforced here, between steps, because that is the only place a decision
     * can still be made before the next provider call is billed. */
    maxCostUsd?: number;
    /** USD-per-million-token rates for the provider actually in use. Without
     *  these the cap cannot be evaluated and is skipped — an unenforceable cap
     *  that claims to be enforced is worse than none, so it reports why. */
    costRates?: { input: number; output: number; reasoning?: number };
    /** Digest carried over from a previous turn (see AgentResult.compactionSummary).
     *  Older findings then live in the digest rather than being re-lost the
     *  moment the fresh turn's context fills. */
    compactionSummary?: string;
    /** Structured run trace (JSONL); written best-effort, never throws. */
    trace?: RunTrace;
  },
  callbacks: AgentCallbacks = {},
): Promise<AgentResult> {
  const maxSteps = callbacks.maxSteps ?? 40;
  // `history` is the full conversation and is never trimmed; `messages` is the
  // working set actually sent to the provider, rebuilt from history at each
  // attempt as [system, firstUser, digest?, ...unfolded tail]. Keeping the two
  // apart is what makes summarizing compaction possible: trimming used to
  // mutate the only copy, so dropped messages could never be summarized after
  // the fact.
  const history: Message[] = [{ role: "system", content: options.systemPrompt }, ...options.initialMessages];
  let messages: Message[] = history;
  // A digest carried in from a previous turn starts covering nothing in this
  // array (foldedCount = 1: system only); its content speaks for history that
  // is no longer present. The first in-turn fold merges new material into it.
  let compaction: CompactionState | null = options.compactionSummary
    ? { summary: options.compactionSummary, foldedCount: 1 }
    : null;
  // Clamp the watermark from config rather than trusting it blindly: below ~0.5
  // it would compact every step, above ~0.97 it would never relieve pressure.
  const rawWatermark = numberSetting("compactionWatermark", DEFAULT_WATERMARK, 0.3);
  const watermark = rawWatermark > 0.97 ? DEFAULT_WATERMARK : rawWatermark;
  const toolDefs = listTools();
  let toolCalls = 0;

  // Pre-compute fixed overhead once (tokens consumed outside the messages array).
  const systemTokens = options.maxInputTokens ? estimateTokens(options.systemPrompt) : 0;
  const toolsJson = options.maxInputTokens && toolDefs.length ? JSON.stringify(toolDefs) : "";
  const toolsTokens = options.maxInputTokens ? estimateTokens(toolsJson) : 0;

  // Calibration data (GROQ real usage vs estimate) showed estimates run ~1.26x
  // low on tool_args-heavy traffic. Trim to maxInputTokens/SAFETY_FACTOR so the
  // real request stays well under the provider's hard cap even if users raise it.
  const SAFETY_FACTOR = 1.3;
  let retryBudgetDelta = 0;
  const effectiveBudget = () =>
    options.maxInputTokens ? Math.floor(options.maxInputTokens / SAFETY_FACTOR) : 0;
  const effectiveReserved = () =>
    Math.floor((systemTokens + toolsTokens) / SAFETY_FACTOR) + retryBudgetDelta;
  const estimateRequestTokens = () =>
    (options.maxInputTokens ? systemTokens + toolsTokens : 0) + estimateMessagesTokens(messages);
  const pacer = options.maxInputTokensPerMinute
    ? new RatePacer(options.maxInputTokensPerMinute)
    : null;

  // Step-level resilience: track consecutive LLM failures and a running summary
  // so that even when the step budget is exhausted we can report progress.
  const MAX_STEP_RETRIES = 2;
  const MAX_CONSECUTIVE_FAILURES = 3;
  let consecutiveFailures = 0;
  const stepSummaries: string[] = [];

  // Running token totals for the whole turn. Accumulated per successful step
  // rather than read off the final result, because a 40-step turn bills 41
  // provider calls and the last one alone says almost nothing about the cost.
  let promptTokens = 0;
  let completionTokens = 0;
  let reasoningTokens = 0;
  let sawUsage = false;
  const usageOrUndefined = () =>
    sawUsage ? { promptTokens, completionTokens, reasoningTokens } : undefined;
  const costCap = options.maxCostUsd;
  const rates = options.costRates;
  const spentUsd = () =>
    rates
      ? (promptTokens * rates.input +
          completionTokens * rates.output +
          reasoningTokens * (rates.reasoning ?? rates.output)) /
        1_000_000
      : 0;
  /** What one provider response cost, for the per-step trace record. */
  const stepCostUsd = (u?: { promptTokens?: number | null; completionTokens?: number | null; reasoningTokens?: number | null }) =>
    !rates || !u
      ? 0
      : ((u.promptTokens ?? 0) * rates.input +
          (u.completionTokens ?? 0) * rates.output +
          (u.reasoningTokens ?? 0) * (rates.reasoning ?? rates.output)) /
        1_000_000;

  /**
   * Fold the oldest foldable range of `history` into the digest.
   *
   * `force` (ContextTooLargeError) skips the watermark check. Any failure —
   * no foldable range, summarizer error, empty digest — returns false and
   * leaves behaviour exactly as it was: trim drops the range. Compaction is an
   * improvement over dropping, never a prerequisite for working.
   */
  const compactNow = async (force: boolean): Promise<boolean> => {
    if (!options.maxInputTokens) return false;
    const plan = planFold(history, compaction, {
      budgetTokens: effectiveBudget(),
      watermark,
      force,
    });
    if (!plan) return false;
    const source = history.slice(plan.start, plan.end);
    // The summarizer call is a real request on the same per-minute budget.
    await paceWait(pacer, plan.tokens, options.signal);
    const summary = await summarizeHistory(options.provider, {
      model: options.model,
      source,
      existing: compaction?.summary,
      budgetTokens: effectiveBudget(),
      signal: options.signal,
    });
    if (pacer) pacer.record(plan.tokens);
    if (!summary) return false;
    // The summarizer is billed like any other call; count it into the turn.
    if (summary.usage) {
      sawUsage = true;
      promptTokens += summary.usage.promptTokens ?? 0;
      completionTokens += summary.usage.completionTokens ?? 0;
      reasoningTokens += summary.usage.reasoningTokens ?? 0;
    }
    compaction = { summary: summary.text, foldedCount: plan.end };
    const info = {
      foldedMessages: plan.end - plan.start,
      foldedTokens: plan.tokens,
      summaryTokens: estimateTokens(summary.text),
    };
    callbacks.onCompact?.(info);
    options.trace?.write({ kind: "compact", ...info });
    return true;
  };

  /** Every exit path carries the digest out so the caller can persist it.
   *  Also the single place a turn can end, so the trace's turn.end record is
   *  emitted here — one record per runAgent call, whatever the exit path. */
  const withState = (r: AgentResult): AgentResult => {
    options.trace?.write({
      kind: "turn.end",
      steps: r.steps,
      aborted: r.aborted,
      usage: r.usage ?? null,
      costCapHit: r.costCapHit ?? null,
      costUsd: sawUsage ? spentUsd() : null,
    });
    return compaction ? { ...r, compactionSummary: compaction.summary } : r;
  };

  options.trace?.write({ kind: "turn.start", model: options.model, cwd: options.toolCtx.cwd });

  for (let step = 0; step < maxSteps; step++) {
    // Cost cap, evaluated before the next provider call is billed. Checked at the
    // top of the step rather than the bottom so a turn that overshoots stops
    // without one further round trip.
    if (costCap !== undefined && rates && sawUsage && spentUsd() >= costCap) {
      const spent = spentUsd();
      const msg =
        `(stopped at the cost cap: ~$${spent.toFixed(4)} of the configured $${costCap.toFixed(2)}. ` +
        `The work so far is on disk — /diff shows what changed. Raise maxCostUsd in config.json, ` +
        `or split the task. This is an estimate from token counts, so treat it as close, not exact.)`;
      callbacks.onModelText?.(`\n${msg}\n`);
      callbacks.onDone?.({ text: "", toolCalls: [], finishReason: "cost_cap" });
      return withState({
        finalText: msg,
        toolCalls,
        steps: step,
        aborted: false,
        usage: usageOrUndefined(),
        costCapHit: { limitUsd: costCap, spentUsd: spent },
      });
    }
    if (options.signal?.aborted) {
      callbacks.onDone?.({ text: "", toolCalls: [], finishReason: "aborted" });
      return withState({ finalText: "\n[interrupted]", toolCalls, steps: step, aborted: true, usage: usageOrUndefined() });
    }
    callbacks.onStepUpdate?.(step + 1, toolCalls, maxSteps);

    let result: StreamResult | null = null;
    let stepOk = false;

    // Step-level retry: transient network/provider errors are retried up to
    // MAX_STEP_RETRIES times before counting as a consecutive failure.
    for (let attempt = 0; attempt <= MAX_STEP_RETRIES && !stepOk; attempt++) {
      retryBudgetDelta = 0;
      // One soft (watermark) and one hard (ContextTooLarge) compaction attempt
      // per call attempt — enough to relieve pressure, bounded so a broken
      // summarizer cannot loop.
      let watermarkTried = false;
      let forceTried = false;
      // ContextTooLarge retry: try once more with a tighter budget before giving up.
      for (;;) {
        // Rebuild the working set from history every attempt: this is where a
        // fold from this or a previous attempt (or a carried-in digest) takes
        // effect. With no compaction state the rebuild is a no-op by content.
        messages = buildWorkingSet(history, compaction);
        if (options.maxInputTokens && !watermarkTried) {
          watermarkTried = true;
          if (await compactNow(false)) messages = buildWorkingSet(history, compaction);
        }
        if (options.maxInputTokens) {
          const trim = trimMessages(messages, {
            budgetTokens: effectiveBudget(),
            reservedTokens: effectiveReserved(),
          });
          messages = trim.messages;
          if (trim.trimmed > 0 && retryBudgetDelta === 0) {
            callbacks.onTrimmed?.(trim.trimmed, trim.truncatedChars);
            options.trace?.write({ kind: "trim", messages: trim.trimmed, chars: trim.truncatedChars });
          }
        }

        const chatOpts: ChatOptions = {
          model: options.model,
          messages,
          tools: toolDefs,
          signal: options.signal,
          ...options.chatOptions,
        };

        // Pace to the provider's per-minute budget before sending.
        try {
          await paceWait(pacer, estimateRequestTokens(), options.signal);

          result = await options.provider(chatOpts, (chunk) => {
            if (chunk.reasoning) callbacks.onReasoning?.(chunk.reasoning);
            if (chunk.content) callbacks.onModelText?.(chunk.content);
          });
          if (pacer) pacer.record(estimateRequestTokens());
          stepOk = true;
          // Fold this step's billing into the turn total. Providers that omit
          // usage leave the counters alone and sawUsage stays false, so the
          // caller can tell "unknown" from "free".
          if (result.usage) {
            sawUsage = true;
            promptTokens += result.usage.promptTokens ?? 0;
            completionTokens += result.usage.completionTokens ?? 0;
            reasoningTokens += result.usage.reasoningTokens ?? 0;
          }
          options.trace?.write({
            kind: "llm.step",
            step: step + 1,
            promptTokens: result.usage?.promptTokens ?? null,
            completionTokens: result.usage?.completionTokens ?? null,
            reasoningTokens: result.usage?.reasoningTokens ?? null,
            finish: result.finishReason,
            costUsd: stepCostUsd(result.usage),
          });
          break; // success
        } catch (err: any) {
          if (err instanceof ContextTooLargeError) {
            // Hard overflow: folding the middle into a digest shrinks the
            // request for real (a tighter trim delta only squeezes harder on
            // what is left). Try that before falling back to the old
            // delta-512 retry.
            if (!forceTried) {
              forceTried = true;
              if (await compactNow(true)) continue; // rebuilt at loop top
            }
            if (retryBudgetDelta === 0) {
              retryBudgetDelta = 512;
              continue;
            }
          }
          if (options.signal?.aborted || err?.name === "AbortError") {
            callbacks.onDone?.({ text: "", toolCalls: [], finishReason: "aborted" });
            return withState({ finalText: "\n[interrupted]", toolCalls, steps: step, aborted: true, usage: usageOrUndefined() });
          }
          // For transient errors, let the step-retry loop handle it.
          break; // will retry if attempts remain
        }
      }
    }

    if (!stepOk || !result) {
      // All step-level retries exhausted for this step.
      consecutiveFailures++;
      // Show the error to the user so failures are never silent.
      const failMsg = `[step ${step + 1}: LLM call failed (${consecutiveFailures}/${MAX_CONSECUTIVE_FAILURES} consecutive)]`;
      callbacks.onModelText?.(`\n${failMsg}\n`);
      if (consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
        const summary = stepSummaries.length
          ? `\nLast steps: ${stepSummaries.slice(-3).join("; ")}`
          : "";
        const finalMsg = `(stopped after ${consecutiveFailures} consecutive LLM failures — check your network and provider status.${summary})`;
        callbacks.onModelText?.(`${finalMsg}\n`);
        callbacks.onDone?.({ text: "", toolCalls: [], finishReason: "error" });
        return withState({
          finalText: finalMsg,
          toolCalls,
          steps: step,
          aborted: false,
          usage: usageOrUndefined(),
        });
      }
      // Skip this step but continue the loop (transient glitch).
      continue;
    }

    // Reset consecutive failure counter on a successful LLM call.
    consecutiveFailures = 0;

    if (result.text) {
      history.push({ role: "assistant", content: result.text });
    } else if (result.toolCalls.length === 0) {
      history.push({ role: "assistant", content: null });
    }

    if (result.toolCalls.length === 0) {
      // No tool calls: conversation finished
      callbacks.onDone?.(result);
      return withState({ finalText: result.text, toolCalls, steps: step + 1, aborted: false, usage: usageOrUndefined() });
    }

    // Normalize tool-call ids so the assistant message and its tool results
    // always reference the same id, even when the provider omits one.
    const normalizedCalls = normalizeToolCalls(result.toolCalls, step + 1);
    // Assistant message carries the tool calls
    const assistantMsg: Message = {
      role: "assistant",
      content: result.text || null,
      tool_calls: normalizedCalls.map((tc) => ({ ...tc })),
    };
    // If we already pushed it above without tool_calls, replace it
    if (history[history.length - 1]?.role === "assistant") {
      history[history.length - 1] = assistantMsg;
    } else {
      history.push(assistantMsg);
    }

    const parsed = parseToolCalls(normalizedCalls);

    // Run independent tool calls in parallel when there are 2+ and no abort
    // pending. Sequential execution is kept when there is only one call, when
    // the user has asked to confirm tools one at a time, or when the permission
    // model may need to ask a human mid-run (confirmTool may depend on prior
    // tool results being visible, and approvals must not interleave).
    const PARALLEL_THRESHOLD = 2;
    const parallelCalls = parsed.filter((c) => c.name);
    const runOne = async (call: ParsedToolCall): Promise<ToolResult> => {
      toolCalls++;
      if (!call.name) {
        const id = call.id || `call_${toolCalls}`;
        return {
          call,
          message: {
            role: "tool" as const,
            tool_call_id: id,
            content:
              "ERROR: the model emitted a tool call with no function name. Reissue a valid tool call or finish by responding with plain text.",
            name: "unknown",
          },
          output: "",
        };
      }
      const name = call.name;
      callbacks.onToolStart?.(name, call.args);
      let output: string;
      let approved = true;
      // Interactive approval (/approve on) gates every call. Note the marker is
      // NOT seeded here: with /approve off this returns true automatically
      // (nobody was asked), and treating an auto-yes as human consent would
      // silently neuter destructive: "ask". Only the permission path below —
      // where a reason means a human actually answered — records consent.
      if (callbacks.confirmTool) {
        approved = await callbacks.confirmTool(name, call.args);
        options.trace?.write({ kind: "approve", tool: name, approved, source: "interactive", step: step + 1 });
      }
      const execStartedAt = Date.now();
      if (!approved) {
        // Same wording as a permission-model decline, for the same reason: the
        // observed failure was a model that read a flat rejection and then went
        // looking for another way to do the thing.
        output = rejectedMessage(name, "you declined it at the approval prompt");
      } else {
        output = await invokeWithApproval(call, options.toolCtx, callbacks, options.trace);
      }
      callbacks.onToolEnd?.(call.name, output);
      options.trace?.write({
        kind: "tool",
        tool: name,
        input: call.args,
        output,
        ms: Date.now() - execStartedAt,
        ok: approved && !/^(ERROR|BLOCKED)/.test(output),
        step: step + 1,
      });
      return {
        call,
        message: { role: "tool" as const, tool_call_id: call.id, content: output, name: call.name },
        output,
      };
    };

    type ToolResult = {
      call: ParsedToolCall;
      message: Message;
      output: string;
    };

    // Approval may arrive mid-run (permissions.destructive === "ask"), so it
    // cannot be decided before the parallel fan-out.
    const approvalMayFire = needsApproval(options.toolCtx);
    let results: ToolResult[];
    if (parallelCalls.length >= PARALLEL_THRESHOLD && !callbacks.confirmTool && !approvalMayFire) {
      // Parallel: fire all tool starts together, then collect results in order.
      toolCalls += parallelCalls.length;
      for (const call of parallelCalls) {
        callbacks.onToolStart?.(call.name, call.args);
      }
      const outputs = await Promise.all(
        parallelCalls.map(async (call) => {
          let output: string;
          const execStartedAt = Date.now();
          try {
            output = await executeTool(call.name, call.args, options.toolCtx);
          } catch (err: any) {
            // This path is parallel precisely because nothing can prompt, so an
            // approval request is an unattended refusal — not a generic error.
            output = isApprovalRequired(err)
              ? noPrompterMessage(call.name, err.reason)
              : `ERROR: ${err?.message ?? String(err)}`;
          }
          callbacks.onToolEnd?.(call.name, output);
          options.trace?.write({
            kind: "tool",
            tool: call.name,
            input: call.args,
            output,
            ms: Date.now() - execStartedAt,
            ok: !/^(ERROR|BLOCKED)/.test(output),
            step: step + 1,
          });
          return { call, output };
        }),
      );
      results = outputs.map((r) => ({
        ...r,
        message: { role: "tool" as const, tool_call_id: r.call.id, content: r.output, name: r.call.name },
      }));
      // Also handle the no-name calls (they're not in parallelCalls since they have no name).
      const noNameResults = await Promise.all(
        parsed.filter((c) => !c.name).map((call) => runOne(call)),
      );
      results = [...noNameResults, ...results];
    } else {
      // Truly sequential. This used to be `Promise.all(parsed.map(runOne))`,
      // which despite the comment ran every call concurrently — so with
      // /approve on, or with destructive:"ask", several prompts could be
      // interleaved and the answers could land against the wrong calls.
      results = [];
      for (const call of parsed) {
        results.push(await runOne(call));
      }
    }

    for (const r of results) {
      history.push(r.message);
    }

    // Track what happened this step for the progress summary.
    const stepToolNames = parsed.filter((c) => c.name).map((c) => c.name);
    if (stepToolNames.length) {
      stepSummaries.push(`step ${step + 1}: ${stepToolNames.join(", ")}`);
      if (stepSummaries.length > 20) stepSummaries.shift();
    }
  }

  // Reached max steps without natural completion. Give a compact progress
  // summary so even on a phone screen the user sees what was accomplished.
  const progressLines: string[] = [];
  if (stepSummaries.length) {
    progressLines.push("Progress:");
    for (const s of stepSummaries.slice(-8)) progressLines.push("  " + s);
  }
  const maxMsg =
    progressLines.length > 0
      ? `(reached max steps without completion.\n${progressLines.join("\n")}\n${stepSummaries.length} step(s) ran, ${toolCalls} tool call(s). Try a more focused task or raise --max-steps.)`
      : `(reached max steps without completion. ${toolCalls} tool call(s) were attempted.)`;
  callbacks.onModelText?.(`\n${maxMsg}\n`);
  callbacks.onDone?.({ text: "", toolCalls: [], finishReason: "max_steps" });
  return withState({ finalText: maxMsg, toolCalls, steps: maxSteps, aborted: false, usage: usageOrUndefined() });
}