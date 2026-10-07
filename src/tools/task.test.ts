// The `task` tool: fan-out into isolated child loops. What matters here is the
// contract around the join — every child runs, one that throws is reported and
// not propagated, each child records into its own sibling trace file, the
// parent trace gets one `task` record per child for replay, and validation
// refuses nonsense before spawning anything.
import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { executeTool, type ToolContext } from "./registry";
import { RunTrace, replayTrace, formatReplaySummary } from "../trace";
import type { ChildLoopResult, ChildLoopSpec } from "../queue-runner";
import "./task";

let dirs: string[] = [];
function newDir(): string {
  const d = mkdtempSync(join(tmpdir(), "vc-task-"));
  dirs.push(d);
  return d;
}
afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
  dirs = [];
});

describe("task tool validation", () => {
  test("refuses without an injected child runner", async () => {
    const ctx: ToolContext = { cwd: newDir() };
    const out = await executeTool("task", { tasks: [{ prompt: "x" }] }, ctx);
    expect(out).toContain("child loops are not available");
  });

  test("refuses an empty list, too many tasks, and an empty prompt", async () => {
    const ctx: ToolContext = { cwd: newDir(), runChild: async () => ({ ok: true, finalText: "", steps: 0, toolCalls: 0, ms: 1 }) };
    expect(await executeTool("task", { tasks: [] }, ctx)).toContain("non-empty array");
    const five = Array.from({ length: 5 }, (_, i) => ({ prompt: `p${i}` }));
    expect(await executeTool("task", { tasks: five }, ctx)).toContain("at most 4 tasks");
    expect(await executeTool("task", { tasks: [{ prompt: "   " }] }, ctx)).toContain("empty prompt");
  });
});

describe("task fan-out", () => {
  test("joins results, isolates a crashing child, and writes per-child + parent trace records", async () => {
    const d = newDir();
    const traceFile = join(d, "run.jsonl");
    const trace = new RunTrace(traceFile, { cwd: d });
    const seen: ChildLoopSpec[] = [];
    const runChild = async (spec: ChildLoopSpec): Promise<ChildLoopResult> => {
      seen.push(spec);
      spec.trace?.write({ kind: "note", text: `child ran: ${spec.prompt}` });
      if (spec.prompt === "boom") throw new Error("child runner exploded");
      const failed = spec.prompt === "flaky";
      return {
        ok: !failed,
        finalText: failed ? "" : `result of ${spec.prompt}`,
        steps: 3,
        toolCalls: 2,
        ms: 250,
        error: failed ? "provider died" : undefined,
      };
    };
    const ctx: ToolContext = { cwd: d, trace, runChild };

    const out = await executeTool(
      "task",
      { tasks: [{ prompt: "alpha" }, { prompt: "boom" }, { prompt: "flaky" }] },
      ctx,
    );

    // Join: the surviving results come back, the throw is a result too.
    expect(out).toContain("task 1 ok");
    expect(out).toContain("result of alpha");
    expect(out).toContain("task 2 FAILED");
    expect(out).toContain("child runner exploded");
    expect(out).toContain("task 3 FAILED");
    expect(out).toContain("provider died");
    expect(out).toContain("1/3 children succeeded");

    // Scope: every child is rooted at the parent's cwd.
    expect(seen).toHaveLength(3);
    expect(seen.every((s) => s.cwd === d)).toBe(true);

    // Isolation of records: each child got its own sibling file, with content.
    const subFiles = seen.map((s) => s.trace?.file);
    expect(subFiles.every((f) => typeof f === "string")).toBe(true);
    expect(new Set(subFiles).size).toBe(3);
    expect(existsSync(join(d, "run.task-1.jsonl"))).toBe(true);
    expect(readFileSync(join(d, "run.task-1.jsonl"), "utf8")).toContain("child ran: alpha");

    // Compendium into the parent trace: one `task` record per child, replayed.
    const replay = replayTrace(traceFile);
    expect(replay.summary.tasks).toBe(3);
    expect(replay.summary.failedTasks).toBe(2);
    expect(formatReplaySummary(replay.summary)).toContain("3 child task(s)");
  });

  test("passes per-child budget and timeout through to the runner", async () => {
    const d = newDir();
    const seen: ChildLoopSpec[] = [];
    const ctx: ToolContext = {
      cwd: d,
      runChild: async (spec) => {
        seen.push(spec);
        return { ok: true, finalText: "fine", steps: 1, toolCalls: 0, ms: 10 };
      },
    };
    const out = await executeTool(
      "task",
      { tasks: [{ prompt: "one", budget: 5, timeoutMs: 30000, inputs: { repo: "vibecoder" } }] },
      ctx,
    );
    expect(out).toContain("task 1 ok");
    expect(seen[0].budget).toBe(5);
    expect(seen[0].timeoutMs).toBe(30000);
    expect(seen[0].inputs).toEqual({ repo: "vibecoder" });
  });

  test("clips a runaway child body instead of flooding the model context", async () => {
    const d = newDir();
    const ctx: ToolContext = {
      cwd: d,
      runChild: async () => ({
        ok: true,
        finalText: "x".repeat(5000),
        steps: 1,
        toolCalls: 0,
        ms: 10,
      }),
    };
    const out = await executeTool("task", { tasks: [{ prompt: "long" }] }, ctx);
    expect(out.length).toBeLessThan(3000);
    expect(out).toContain("truncated");
  });
});
