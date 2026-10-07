// Shared executor for queued tasks. Used by both the standalone daemon and the
// in-app poller so queued tasks behave identically wherever they run.
import type { RootConfig } from "./llm/client";
import { ModelRouter } from "./llm/router";
import { runAgent } from "./agent/loop";
import {
  claimTask,
  markTaskDone,
  markTaskFailed,
  markTaskRetry,
  nextQueued,
  type QueuedTask,
} from "./queue";
import { bannedReason } from "./tools/bash";
import { resolvePermissions, type PermissionsConfig } from "./permissions";
import type { Message } from "./llm/types";
import type { RouteResult } from "./llm/router";
import type { RunTrace } from "./trace";
import "./tools/bash";
import "./tools/files";
import "./tools/search";
import "./tools/net";
import "./tools/repo-install";

export interface QueueRunnerDeps {
  config: RootConfig;
  router: ModelRouter;
  maxSteps?: number;
  /** Stream model text / tool activity to a log, TUI, or the void. */
  onLog?: (line: string) => void;
  /** When true, destructive commands are blocked even in auto-run. */
  autoApproveExceptDestructive?: boolean;
  /** When false, mutating tools (git_commit, env_set, write_file, ...) are also
   *  refused during auto-run. Defaults to true to preserve existing behaviour;
   *  set false for unattended runs you do not want touching git or .env. */
  autoApproveMutating?: boolean;
  /** Permission model for unattended runs. When omitted, a queued task is
   *  sandboxed to its own cwd and does not get API-key env vars. */
  permissions?: PermissionsConfig;
}

const log = (deps: QueueRunnerDeps, line: string) => deps.onLog?.(line);

const OFFLINE_PLAN_SYSTEM =
  "You are planning a coding task while this machine is OFFLINE. You cannot run commands, read files, or use the internet. Based only on the task statement and your general knowledge, draft a concise to-do plan so the task can be executed later when connectivity returns. " +
  "Remember the plan is a starting point: whoever runs it will verify against the real repository. " +
  "Respond with a compact plan exactly in this shape:\n" +
  "PLAN:\n1. <step>\n2. <step>\n...\n" +
  "FILES: <files you expect to create or touch>\n" +
  "RISKS: <caveats, assumptions, or unknown repo state>";

/**
 * Draft a plan note for a task given while offline, using the local model.
 * Best-effort: throws on failure so callers can decide how to handle it
 * (the task is still queued either way).
 */
export async function draftPlanNote(
  route: RouteResult,
  userMessage: string,
  timeoutMs = 120_000,
): Promise<string> {
  const messages: Message[] = [
    { role: "system", content: OFFLINE_PLAN_SYSTEM },
    { role: "user", content: userMessage },
  ];
  const res = await route.provider.streamChat(
    { model: route.model, messages, max_tokens: 400, timeoutMs, temperature: 0.4 },
    () => {},
  );
  const text = (res.text ?? "").trim();
  if (!text) throw new Error("local model returned an empty plan");
  return text;
}

/**
 * The task-scoped approval gate for unattended runs.
 *
 * With `autoApproveExceptDestructive` (the default for queued tasks) every tool
 * runs without prompting except Bash commands that match the destructive guard
 * (rm -rf, mkfs, force-push, package uninstall, system control, sudo …). The
 * gate returns `false` for those, and the agent sees a "rejected by policy"
 * tool result telling it to avoid the command.
 *
 * `autoApproveMutating: false` additionally refuses the tools that change state
 * through a non-shell path — git_commit, git_checkout_branch, git_push_ff,
 * env_set, write_file, edit_file. The bash guard cannot see those, so an
 * unattended run could otherwise rewrite .env or push to a remote while every
 * shell command passed.
 *
 * Also rejects when the task's runner is mid-abort (signal fired) so queued
 * tasks stop promptly on interrupt.
 */
export function queuedToolPolicy(
  deps: QueueRunnerDeps,
  signal?: AbortSignal,
): (name: string, args: Record<string, unknown>) => Promise<boolean> {
  return async (name, args) => {
    if (deps.autoApproveExceptDestructive !== false) {
      if (name === "bash") {
        const why = bannedReason(String(args.command ?? ""));
        if (why) {
          log(deps, `  [[auto-run policy]] blocked ${name}: ${why}`);
          return false;
        }
      }
      // Mutating tools that no human is watching. The bash guard above only
      // sees shell commands, so without this an unattended run could commit,
      // push and rewrite .env while auto-approving everything else.
      const mutating: Record<string, string> = {
        git_commit: "commits changes",
        git_checkout_branch: "switches branches",
        git_push_ff: "pushes to a remote",
        env_set: "writes to .env",
        write_file: "writes files",
        edit_file: "edits files",
      };
      const why = mutating[name];
      if (why && deps.autoApproveMutating === false) {
        log(deps, `  [[auto-run policy]] blocked ${name}: ${why}`);
        return false;
      }
    }
    if (signal?.aborted) return false;
    return true;
  };
}

/**
 * Execute one queued task to completion (or failure). Claims it, runs the
 * heavy model over it with the auto-run tool policy, and records the outcome.
 * Returns the updated task, or `null` if another runner grabbed it first.
 */
export async function runQueuedTask(
  task: QueuedTask,
  deps: QueueRunnerDeps,
  signal?: AbortSignal,
): Promise<QueuedTask | null> {
  const claimed = claimTask(task.id);
  if (!claimed) return null;

  const { config, router } = deps;
  log(deps, `▶ [${task.id}] ${task.userMessage.slice(0, 120)}${task.planNote ? " (with offline plan)" : ""}`);

  const messages: Message[] = [{ role: "system", content: task.systemPrompt }];
  if (task.planNote) {
    messages.push({
      role: "user",
      content:
        "While offline, a draft plan was recorded for this task. Treat it as a starting point, verify it against the actual repository and codebase state with your tools, and correct anything that no longer applies.\n\n" +
        task.planNote,
    });
  }
  messages.push({ role: "user", content: task.userMessage });

  try {
    const route = await router.resolve(task.userMessage, "heavy");
    const chatOptions = {
      temperature: config.temperature ?? 0.7,
      max_tokens: config.maxTokens,
    };
    // Unattended failover: same contract as the REPL turn — when the heavy side
    // exhausts a daily quota mid-task, hand the remaining steps to another
    // configured provider instead of failing the task after 5 retries.
    const failover = async () => {
      const fb = router.fallbackSide({ providerName: route.providerName, model: route.model });
      return fb
        ? { provider: fb.provider.streamChat.bind(fb.provider), model: fb.model }
        : null;
    };
    const result = await runAgent(
      {
        provider: route.provider.streamChat.bind(route.provider),
        systemPrompt: task.systemPrompt,
        model: route.model,
        initialMessages: messages,
        // Unattended runs must honour the same permission model as interactive
        // ones, and they run unattended, so default to the stricter sandbox
        // unless the queue explicitly opts out.
        toolCtx: {
          cwd: task.cwd,
          signal,
          permissions: resolvePermissions(
            deps.permissions ?? { permissions: { filesystem: "workspace", exposeSecrets: false } },
            task.cwd,
          ),
        },
        signal,
        chatOptions,
        maxInputTokens: route.maxInputTokens,
        maxInputTokensPerMinute: route.maxInputTokensPerMinute,
        onProviderFailover: failover,
      },
      {
        maxSteps: deps.maxSteps ?? 40,
        onModelText: (t) => log(deps, t),
        onToolStart: (name, args) =>
          log(deps, `  ⚡ ${name} ${JSON.stringify(args ?? {}).slice(0, 200)}`),
        onToolEnd: (name, out) => log(deps, `  └ ${name} → ${out.split("\n")[0].slice(0, 200)}`),
        confirmTool: queuedToolPolicy(deps, signal),
      },
    );

    const done = markTaskDone(task.id, result.finalText || "(no final text)");
    log(deps, `✅ [${task.id}] done in ${result.steps} step(s), ${result.toolCalls} tool call(s)`);
    return done;
  } catch (err: any) {
    const msg = err?.message ?? String(err);
    const existingAttempts = claimed.attempts ?? 0;
    const nextAttempts = existingAttempts + 1;
    if (nextAttempts >= 5) {
      // Exhausted the retry cap — mark permanently failed.
      const failed = markTaskFailed(task.id, msg, nextAttempts);
      log(deps, `✘ [${task.id}] failed (attempt ${nextAttempts}/5): ${msg}`);
      return failed ?? claimed;
    }
    // Retry: requeue with backoff. 30s base, doubling each attempt, cap 5min.
    const backoffMs = Math.min(300_000, 30_000 * Math.pow(2, nextAttempts - 1));
    // markTaskRetry applies the backoff itself; mutating the returned object
    // afterwards was writing to a detached copy (and crashed when null).
    const retried = markTaskRetry(task.id, nextAttempts);
    log(deps, `↻ [${task.id}] failed (attempt ${nextAttempts}/5) — will retry in ${(backoffMs / 1000).toFixed(0)}s`);
    return retried ?? claimed;
  }
}

/** A fan-out child: prompt + optional context facts, with its own step budget
 *  and wall-clock cap. `cwd`/`permissions` scope what it may touch. */
export interface ChildLoopSpec {
  prompt: string;
  /** Extra context rendered as a preamble (`- k: v` lines) before the prompt. */
  inputs?: Record<string, unknown>;
  /** Step budget for this child (default 12, max 60). */
  budget?: number;
  /** Wall-clock cap for this child (default 120s, min 1s, max 10min). */
  timeoutMs?: number;
  /** Workspace root for the child's tools. Defaults to the current cwd. */
  cwd?: string;
  systemPrompt?: string;
  permissions?: PermissionsConfig;
  /** Sibling trace file (RunTrace.subTrace) the child's records go to. */
  trace?: RunTrace;
}

/** Outcome of one child loop. Failure is data here, never a throw: the whole
 *  point of fan-out is that one child's crash does not take the rest down. */
export interface ChildLoopResult {
  ok: boolean;
  finalText: string;
  steps: number;
  toolCalls: number;
  ms: number;
  error?: string;
  timedOut?: boolean;
}

/**
 * Run one isolated child loop for the `task` tool / `/task` command: same
 * model-routing, compaction, retry and permission pipeline as a queued task,
 * but scoped to a spec, capped by budget and timeout, and running
 * **unattended** — no prompter is attached, so anything that would ask a human
 * (destructive: "ask", sandbox writes outside the workspace) is explicitly
 * refused inside the child instead of stalling the fan-out.
 *
 * Never throws: router errors, provider errors, timeouts and aborts all come
 * back as `{ ok: false, error }` so `Promise.all` over children is safe.
 */
export async function runChildLoop(
  spec: ChildLoopSpec,
  deps: QueueRunnerDeps,
  parentSignal?: AbortSignal,
): Promise<ChildLoopResult> {
  const startedAt = Date.now();
  const budget = Math.min(60, Math.max(1, Math.floor(spec.budget ?? 12)));
  const timeoutMs = Math.min(600_000, Math.max(1_000, spec.timeoutMs ?? 120_000));
  const cwd = spec.cwd ?? process.cwd();
  const ac = new AbortController();
  const onParentAbort = () => ac.abort();
  parentSignal?.addEventListener("abort", onParentAbort, { once: true });
  let timedOut = false;
  let rejectTimeout: ((err: Error) => void) | null = null;
  const timer = setTimeout(() => {
    timedOut = true;
    ac.abort();
    rejectTimeout?.(new Error(`timed out after ${timeoutMs}ms`));
  }, timeoutMs);
  const timeoutP = new Promise<never>((_, reject) => {
    rejectTimeout = reject;
  });
  const done = (r: Partial<ChildLoopResult> & { ok: boolean }): ChildLoopResult => ({
    finalText: "",
    steps: 0,
    toolCalls: 0,
    ms: Date.now() - startedAt,
    ...r,
  });

  try {
    const route = await deps.router.resolve(spec.prompt, "heavy");
    const preamble =
      spec.inputs && Object.keys(spec.inputs).length > 0
        ? "Context for this task:\n" +
          Object.entries(spec.inputs)
            .map(([k, v]) => `- ${k}: ${String(v)}`)
            .join("\n") +
          "\n\n"
        : "";
    const messages: Message[] = [{ role: "user", content: preamble + spec.prompt }];
    const agentP = runAgent(
      {
        provider: route.provider.streamChat.bind(route.provider),
        systemPrompt: spec.systemPrompt ?? deps.config.systemPrompt ?? "You are Vibecoder.",
        model: route.model,
        // Children run unattended too — same failover contract as queued tasks.
        onProviderFailover: async () => {
          const fb = deps.router.fallbackSide({ providerName: route.providerName, model: route.model });
          return fb
            ? { provider: fb.provider.streamChat.bind(fb.provider), model: fb.model }
            : null;
        },
        initialMessages: messages,
        // Scope + posture: strict workspace sandbox by default, and no
        // prompter — a child that needs human consent reports it as a
        // refusal in its result rather than blocking siblings.
        toolCtx: {
          cwd,
          signal: ac.signal,
          permissions: resolvePermissions(
            spec.permissions ?? { permissions: { filesystem: "workspace", exposeSecrets: false } },
            cwd,
          ),
          trace: spec.trace,
        },
        signal: ac.signal,
        chatOptions: {
          temperature: deps.config.temperature ?? 0.7,
          max_tokens: deps.config.maxTokens,
        },
        maxInputTokens: route.maxInputTokens,
        maxInputTokensPerMinute: route.maxInputTokensPerMinute,
        trace: spec.trace,
      },
      {
        maxSteps: budget,
        onModelText: (t) => deps.onLog?.(`  [child] ${t}`),
        onToolStart: (name, args) =>
          deps.onLog?.(`  [child] ⚡ ${name} ${JSON.stringify(args ?? {}).slice(0, 200)}`),
        onToolEnd: (name, out) =>
          deps.onLog?.(`  [child] └ ${name} → ${out.split("\n")[0].slice(0, 200)}`),
      },
    );
    // The abort stops the loop between steps, but a provider that never
    // resolves would otherwise hang the fan-out join — race it too.
    agentP.catch(() => {});
    const result = await Promise.race([agentP, timeoutP]);

    if (result.aborted) {
      return done({
        ok: false,
        finalText: result.finalText ?? "",
        steps: result.steps,
        toolCalls: result.toolCalls,
        timedOut,
        error: timedOut ? `timed out after ${timeoutMs}ms` : "aborted",
      });
    }
    return done({
      ok: true,
      finalText: result.finalText ?? "",
      steps: result.steps,
      toolCalls: result.toolCalls,
    });
  } catch (err: any) {
    const msg = err?.message ?? String(err);
    return done({ ok: false, timedOut, error: timedOut ? `timed out after ${timeoutMs}ms` : msg });
  } finally {
    clearTimeout(timer);
    parentSignal?.removeEventListener("abort", onParentAbort);
  }
}

/** Drain the queue: run every queued (or stale-running) task until empty. */
export async function drainQueue(
  deps: QueueRunnerDeps,
  signal?: AbortSignal,
): Promise<{ ran: number; failed: number }> {
  let ran = 0;
  let failed = 0;
  let task: QueuedTask | null;
  while ((task = nextQueued()) && !signal?.aborted) {
    const result = await runQueuedTask(task, deps, signal);
    if (!result) return { ran, failed }; // claimed elsewhere — stop competing
    if (result.status === "failed") failed++;
    ran++;
  }
  return { ran, failed };
}