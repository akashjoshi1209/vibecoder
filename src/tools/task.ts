// The `task` tool: fan independent sub-tasks out into isolated child loops and
// join their results. Children run with their own step budget, wall-clock cap
// and workspace scope, cannot prompt for approval, and cannot crash the
// parent: a failed child is a failed result, nothing more.
import { registerTool, type ToolContext } from "./registry";
import type { ChildLoopResult, ChildLoopSpec } from "../queue-runner";

const MAX_TASKS = 4;
const DEFAULT_BUDGET = 12;
const BODY_CLIP = 1500;

function clip(text: string): string {
  const t = text.trim();
  if (t.length <= BODY_CLIP) return t;
  return `${t.slice(0, BODY_CLIP)}\n… (truncated ${t.length - BODY_CLIP} chars)`;
}

function indent(text: string, spaces: number): string {
  const pad = " ".repeat(spaces);
  return text
    .split("\n")
    .map((l) => pad + l)
    .join("\n");
}

registerTool({
  definition: {
    type: "function",
    function: {
      name: "task",
      description:
        `Run 1-${MAX_TASKS} independent sub-tasks in isolated child loops (fresh context, own step ` +
        "budget and timeout) and join their results. Use ONLY when the tasks can genuinely proceed " +
        "in parallel on disjoint files or areas (e.g. \"summarize module A\" alongside \"write tests for module B\"). " +
        "Never fan out work that mutates shared state — the same files, git, .env, the queue: run " +
        "those serially with normal tool calls instead. Children run unattended: anything that would " +
        "need human approval is refused inside the child and reported in its result.",
      parameters: {
        type: "object",
        properties: {
          tasks: {
            type: "array",
            minItems: 1,
            maxItems: MAX_TASKS,
            description: "The sub-tasks to run in parallel.",
            items: {
              type: "object",
              properties: {
                prompt: {
                  type: "string",
                  description:
                    "Self-contained instructions for this child. It shares no context with you or its siblings.",
                },
                inputs: {
                  type: "object",
                  description: "Optional context facts, rendered as `- key: value` lines before the prompt.",
                },
                budget: {
                  type: "number",
                  description: `Max steps for this child (default ${DEFAULT_BUDGET}, max 60).`,
                },
                timeoutMs: {
                  type: "number",
                  description: "Wall-clock cap for this child (default 120000, max 600000).",
                },
              },
              required: ["prompt"],
            },
          },
        },
        required: ["tasks"],
      },
    },
  },

  async run(args: Record<string, unknown>, ctx: ToolContext): Promise<string> {
    const raw = args.tasks;
    if (!Array.isArray(raw) || raw.length === 0) {
      return `ERROR: tasks must be a non-empty array of ${MAX_TASKS} or fewer prompts`;
    }
    if (raw.length > MAX_TASKS) {
      return `ERROR: at most ${MAX_TASKS} tasks per call — fan the rest out in a follow-up task call`;
    }
    const runChild = ctx.runChild;
    if (!runChild) {
      return "ERROR: child loops are not available in this context";
    }

    const specs: ChildLoopSpec[] = [];
    for (let i = 0; i < raw.length; i++) {
      const t = (raw[i] ?? {}) as Record<string, unknown>;
      const prompt = String(t.prompt ?? "").trim();
      if (!prompt) return `ERROR: task ${i + 1} has an empty prompt`;
      specs.push({
        prompt,
        inputs: (t.inputs as Record<string, unknown> | undefined) ?? undefined,
        budget: typeof t.budget === "number" ? t.budget : undefined,
        timeoutMs: typeof t.timeoutMs === "number" ? t.timeoutMs : undefined,
        cwd: ctx.cwd,
        // Each child records into its own sibling trace file so the fan-out
        // never interleaves records inside one file.
        trace: ctx.trace?.subTrace(`task-${i + 1}`),
      });
    }

    // Isolated fan-out: every child runs on its own; one that throws (or is
    // rejected by the runner) is reported as a failed result, not propagated.
    const results = await Promise.all(
      specs.map(async (spec, i): Promise<ChildLoopResult> => {
        const label = `task-${i + 1}`;
        try {
          const r = await runChild(spec);
          ctx.trace?.write({
            kind: "task",
            label,
            ok: r.ok,
            steps: r.steps,
            toolCalls: r.toolCalls,
            ms: r.ms,
            error: r.error ?? null,
          });
          return r;
        } catch (err) {
          const msg = err && typeof err === "object" && "message" in err
            ? String((err as Record<string, unknown>).message)
            : String(err);
          ctx.trace?.write({ kind: "task", label, ok: false, steps: 0, toolCalls: 0, ms: 0, error: msg });
          return { ok: false, finalText: "", steps: 0, toolCalls: 0, ms: 0, error: msg };
        }
      }),
    );

    const lines = results.map((r, i) => {
      const head =
        `task ${i + 1} ${r.ok ? "ok" : "FAILED"} · ${r.steps} step(s) · ` +
        `${r.toolCalls} tool call(s) · ${(r.ms / 1000).toFixed(1)}s`;
      const body = r.ok
        ? clip(r.finalText || "(no output)")
        : clip(r.finalText || `error: ${r.error ?? "failed"}`);
      return `${head}\n${indent(body, 2)}`;
    });
    const okCount = results.filter((r) => r.ok).length;
    return (
      `${lines.join("\n\n")}\n\n` +
      `[${okCount}/${results.length} children succeeded` +
      `${ctx.trace ? " — each child also wrote a sibling trace file (…task-N.jsonl)" : ""}]`
    );
  },
});
