// runChildLoop: the isolated child runner behind `task` / `/task`. The
// contract: never throws (router/provider/timeout failures come back as data),
// scoped to a workspace with unattended permissions (a consent request inside
// a child is an explicit refusal, not a hang), capped by budget and wall
// clock, and its records land in the sibling trace it is handed.
import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { runChildLoop, type QueueRunnerDeps } from "./queue-runner";
import { registerTool, type ToolContext } from "./tools/registry";
import { ApprovalRequiredError } from "./tools/approval";
import { RunTrace, replayTrace } from "./trace";
import type { Message } from "./llm/types";

let dirs: string[] = [];
function newDir(): string {
  const d = mkdtempSync(join(tmpdir(), "vc-child-"));
  dirs.push(d);
  return d;
}
afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
  dirs = [];
});

// A probe tool the fake provider can call: captures the context it ran with,
// and can be told to demand human consent (ApprovalRequiredError) once.
let seenCtx: ToolContext | null = null;
let failWith: Error | null = null;
registerTool({
  definition: {
    type: "function",
    function: { name: "task_probe", description: "probe", parameters: { type: "object", properties: {} } },
  },
  async run(_args: Record<string, unknown>, ctx: ToolContext): Promise<string> {
    seenCtx = ctx;
    if (failWith) {
      const e = failWith;
      failWith = null;
      throw e;
    }
    return "probe ok";
  },
});

type FakeProvider = { streamChat: (opts: any) => Promise<any> };

/** Provider script: `toolCallsAfter` empty until that many tool calls have
 *  been issued, then final text (or always-tool when -1). */
function makeProvider(opts: {
  toolCalls?: number; // how many steps issue a tool call (-1 = forever)
  delayMs?: number;
  captured?: Message[][];
}): FakeProvider {
  let step = 0;
  return {
    streamChat: async (o: any) => {
      if (opts.delayMs) await new Promise((r) => setTimeout(r, opts.delayMs));
      opts.captured?.push([...((o.messages ?? []) as Message[])]);
      const forever = opts.toolCalls === -1;
      if (forever || step < (opts.toolCalls ?? 0)) {
        step++;
        return {
          text: "",
          toolCalls: [{ id: `c${step}`, name: "task_probe", arguments: "{}" }],
          finishReason: "tool_calls",
        };
      }
      step++;
      return { text: `final ${step}`, toolCalls: [], finishReason: "stop" };
    },
  };
}

function stubDeps(provider: FakeProvider): QueueRunnerDeps {
  return {
    config: { systemPrompt: "child system prompt" } as any,
    router: { resolve: async () => ({ provider, model: "stub/model" }) } as any,
  };
}

describe("runChildLoop", () => {
  test("runs to completion and records into the handed trace", async () => {
    const d = newDir();
    const traceFile = join(d, "child.jsonl");
    const r = await runChildLoop(
      { prompt: "say done", cwd: d, trace: new RunTrace(traceFile, { cwd: d }) },
      stubDeps(makeProvider({})),
    );
    expect(r.ok).toBe(true);
    expect(r.finalText).toBe("final 1");
    expect(r.steps).toBe(1);
    expect(r.error).toBeUndefined();
    expect(existsSync(traceFile)).toBe(true);
    const replay = replayTrace(traceFile);
    expect(replay.summary.turns).toBe(1);
    expect(replay.summary.steps).toBe(1);
  });

  test("preps the child's message list: system prompt, inputs preamble, prompt", async () => {
    const captured: Message[][] = [];
    const r = await runChildLoop(
      { prompt: "do the thing", inputs: { repo: "vibecoder", note: "be brief" } },
      stubDeps(makeProvider({ captured })),
    );
    expect(r.ok).toBe(true);
    const msgs = captured[0];
    expect(msgs[0].role).toBe("system");
    expect(String(msgs[0].content)).toBe("child system prompt");
    const user = String(msgs[1].content);
    expect(user).toContain("- repo: vibecoder");
    expect(user).toContain("- note: be brief");
    expect(user).toContain("do the thing");
  });

  test("scopes the child to a workspace sandbox with unattended permissions", async () => {
    const d = newDir();
    seenCtx = null;
    await runChildLoop({ prompt: "touch", cwd: d }, stubDeps(makeProvider({ toolCalls: 1 })));
    expect(seenCtx).not.toBeNull();
    expect(seenCtx!.cwd).toBe(d);
    expect(seenCtx!.permissions?.filesystem).toBe("workspace");
    expect(seenCtx!.permissions?.exposeSecrets).toBe(false);
    // Unattended: nothing may prompt, and no consent marker exists on the child.
    expect(seenCtx!.approval).toBeUndefined();
  });

  test("a consent request inside a child is an explicit refusal, not a hang", async () => {
    const captured: Message[][] = [];
    seenCtx = null;
    failWith = new ApprovalRequiredError("task_probe", "needs a human", {});
    const r = await runChildLoop(
      { prompt: "ask something" },
      stubDeps(makeProvider({ toolCalls: 1, captured })),
    );
    // The child finished normally: the refusal was a tool result the model saw.
    expect(r.ok).toBe(true);
    expect(JSON.stringify(captured[1] ?? [])).toContain("no approver");
    expect(seenCtx).not.toBeNull();
  });

  test("budget caps the child's steps", async () => {
    seenCtx = null;
    const r = await runChildLoop(
      { prompt: "spin", budget: 1 },
      stubDeps(makeProvider({ toolCalls: -1 })),
    );
    expect(r.steps).toBe(1);
    expect(r.toolCalls).toBe(1);
    expect(r.ms).toBeLessThan(30_000);
  });

  test("timeout comes back as data: ok:false, timedOut, never throws", async () => {
    const r = await runChildLoop(
      { prompt: "spin", budget: 60, timeoutMs: 1000 },
      stubDeps(makeProvider({ toolCalls: -1, delayMs: 50 })),
    );
    expect(r.ok).toBe(false);
    expect(r.timedOut).toBe(true);
    expect(r.error).toContain("timed out after 1000ms");
    expect(r.ms).toBeGreaterThanOrEqual(900);
  });

  test("router failure comes back as a failed result", async () => {
    const deps = {
      config: { systemPrompt: "s" } as any,
      router: {
        resolve: async () => {
          throw new Error("no route available");
        },
      },
    } as unknown as QueueRunnerDeps;
    const r = await runChildLoop({ prompt: "x" }, deps);
    expect(r.ok).toBe(false);
    expect(r.error).toBe("no route available");
    expect(r.timedOut).toBeFalsy();
  });

  test("parent abort stops the child", async () => {
    const ac = new AbortController();
    const p = runChildLoop(
      { prompt: "spin", budget: 60, timeoutMs: 600_000 },
      stubDeps(makeProvider({ toolCalls: -1, delayMs: 50 })),
      ac.signal,
    );
    setTimeout(() => ac.abort(), 300);
    const r = await p;
    expect(r.ok).toBe(false);
    expect(r.timedOut).toBe(false);
    expect(r.error).toBe("aborted");
    expect(r.ms).toBeLessThan(60_000);
  });
});
