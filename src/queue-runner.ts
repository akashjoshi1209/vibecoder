// Shared executor for queued tasks. Used by both the standalone daemon and the
// in-app poller so queued tasks behave identically wherever they run.
import type { RootConfig } from "./llm/client";
import { ModelRouter } from "./llm/router";
import { runAgent } from "./agent/loop";
import {
  claimTask,
  markTaskDone,
  markTaskFailed,
  nextQueued,
  type QueuedTask,
} from "./queue";
import { bannedReason } from "./tools/bash";
import type { Message } from "./llm/types";
import type { RouteResult } from "./llm/router";
import "./tools/bash";
import "./tools/files";
import "./tools/search";
import "./tools/net";

export interface QueueRunnerDeps {
  config: RootConfig;
  router: ModelRouter;
  maxSteps?: number;
  /** Stream model text / tool activity to a log, TUI, or the void. */
  onLog?: (line: string) => void;
  /** When true, destructive commands are blocked even in auto-run. */
  autoApproveExceptDestructive?: boolean;
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
 * tool result telling it to avoid the command. Also rejects when the task's
 * runner is mid-abort (signal fired) so queued tasks stop promptly on interrupt.
 */
export function queuedToolPolicy(
  deps: QueueRunnerDeps,
  signal?: AbortSignal,
): (name: string, args: Record<string, unknown>) => Promise<boolean> {
  return async (name, args) => {
    if (deps.autoApproveExceptDestructive !== false && name === "bash") {
      const command = String(args.command ?? "");
      const why = bannedReason(command);
      if (why) {
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
    const result = await runAgent(
      {
        provider: route.provider.streamChat.bind(route.provider),
        systemPrompt: task.systemPrompt,
        model: route.model,
        initialMessages: messages,
        toolCtx: { cwd: task.cwd, signal },
        signal,
        chatOptions,
        maxInputTokens: route.maxInputTokens,
        maxInputTokensPerMinute: route.maxInputTokensPerMinute,
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
    log(deps, `✔ [${task.id}] done in ${result.steps} step(s), ${result.toolCalls} tool call(s)`);
    return done;
  } catch (err: any) {
    const msg = err?.message ?? String(err);
    const failed = markTaskFailed(task.id, msg);
    log(deps, `✘ [${task.id}] failed: ${msg}`);
    return failed ?? claimed;
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