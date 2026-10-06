// Run-trace tests: the writer's guarantees (JSONL, truncation, anon scrubbing),
// the offline replayer's rendering and counting, the permission-decision
// listener seam, and end-to-end records from runAgent.
import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { RunTrace, replayTrace, formatReplaySummary } from "./trace";
import { checkDestructiveCommand, onPermissionDecision, resolvePermissions, type PermissionDecision } from "./permissions";
import { runAgent } from "./agent/loop";
import { registerTool, type ToolContext } from "./tools/registry";
import type { ChatOptions, ChatChunk, StreamResult } from "./llm/types";

const tmp = mkdtempSync(join(tmpdir(), "vc-trace-"));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

let fileNo = 0;
const nextFile = () => join(tmp, `t${fileNo++}.jsonl`);
const readRecords = (file: string): Array<Record<string, unknown>> =>
  readFileSync(file, "utf8")
    .split(/\r?\n/)
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l));

/** A harmless probe tool so the loop test does not shell out. */
let probeRuns = 0;
registerTool({
  definition: {
    type: "function",
    function: {
      name: "trace_probe_tool",
      description: "records that it ran",
      parameters: { type: "object", properties: {}, required: [] },
    },
  },
  async run(): Promise<string> {
    probeRuns++;
    return "probe output ok";
  },
});

const base = {
  systemPrompt: "s",
  model: "test-model",
  initialMessages: [{ role: "user" as const, content: "go" }],
};

describe("RunTrace writer", () => {
  test("appends one JSONL record per write", () => {
    const file = nextFile();
    const tr = new RunTrace(file);
    tr.write({ kind: "note", text: "a" });
    tr.write({ kind: "note", text: "b" });
    const recs = readRecords(file);
    expect(recs.length).toBe(2);
    expect(recs[0].kind).toBe("note");
    expect(recs[0].text).toBe("a");
    expect(typeof recs[0].t).toBe("number");
  });

  test("long string fields are truncated instead of fattening the log", () => {
    const file = nextFile();
    const tr = new RunTrace(file, { truncateChars: 50 });
    tr.write({ kind: "tool", tool: "x", output: "y".repeat(500) });
    const rec = readRecords(file)[0];
    expect(String(rec.output).length).toBeLessThan(120);
    expect(String(rec.output)).toContain("chars)");
    // Truncation applies in raw mode too — a 30k output must not land in the file.
    expect(String(rec.output)).not.toHaveLength(500);
  });

  test("anon mode scrubs cwd, home and secret-shaped tokens; raw mode keeps them", () => {
    const secretish = `API_KEY=abc123456 ghp_${"a".repeat(36)}`;
    const rawFile = nextFile();
    new RunTrace(rawFile, { cwd: tmp }).write({ kind: "note", text: `${join(tmp, "f")} ${secretish}` });
    expect(String(readRecords(rawFile)[0].text)).toContain("abc123456");

    const anonFile = nextFile();
    new RunTrace(anonFile, { anon: true, cwd: tmp }).write({
      kind: "note",
      text: `${join(tmp, "f")} ${secretish}`,
    });
    const text = String(readRecords(anonFile)[0].text);
    expect(text).not.toContain(tmp);
    expect(text).toContain("<cwd>");
    expect(text).toContain("API_KEY=<redacted>");
    expect(text).not.toContain("abc123456");
    expect(text).not.toContain("ghp_");
  });

  test("a failing path never throws out of write()", () => {
    // A path that cannot be created (drive root on Windows / null byte anywhere).
    const tr = new RunTrace(join(tmp, "x\0y", "nested", "t.jsonl"));
    expect(() => tr.write({ kind: "note", text: "ignored" })).not.toThrow();
  });
});

describe("replayTrace", () => {
  test("renders a timeline and counts the run's totals", () => {
    const file = nextFile();
    const tr = new RunTrace(file);
    tr.write({ kind: "turn.start", model: "m", cwd: tmp });
    tr.write({
      kind: "llm.step",
      step: 1,
      promptTokens: 100,
      completionTokens: 10,
      finish: "tool_calls",
      costUsd: 0.001,
    });
    tr.write({ kind: "tool", tool: "bash", input: { command: "ls" }, output: "ok", ms: 5, ok: true });
    tr.write({ kind: "approve", tool: "bash", approved: true, source: "interactive" });
    tr.write({
      kind: "permission",
      domain: "shell.destructive",
      rule: "destructive=ask",
      action: "ask",
      reason: "recursive delete",
    });
    tr.write({ kind: "compact", foldedMessages: 4, foldedTokens: 800, summaryTokens: 90 });
    tr.write({ kind: "trim", messages: 3, chars: 900 });
    tr.write({ kind: "turn.end", steps: 3, aborted: false, costUsd: 0.002 });

    const { lines, summary } = replayTrace(file);
    expect(lines.length).toBe(8);
    expect(summary.turns).toBe(1);
    expect(summary.steps).toBe(1);
    expect(summary.tools).toBe(1);
    expect(summary.approvals).toBe(1);
    expect(summary.permissions).toBe(1);
    expect(summary.compactions).toBe(1);
    expect(summary.trims).toBe(1);
    expect(summary.costUsd).toBeCloseTo(0.002, 6);
    expect(summary.skipped).toBe(0);
    expect(lines.some((l) => l.includes("tool bash"))).toBe(true);
    expect(lines.some((l) => l.includes("permission ask"))).toBe(true);
    expect(lines.some((l) => l.includes("compact −4 msg"))).toBe(true);
    expect(lines.some((l) => l.includes("turn start · m"))).toBe(true);
    const text = formatReplaySummary(summary);
    expect(text).toContain("1 turn(s)");
    expect(text).toContain("$0.0020");
  });

  test("skips malformed lines instead of failing the whole replay", () => {
    const file = nextFile();
    writeFileSync(file, `{"t":1,"kind":"note","text":"ok"}\nnot json at all\n{"no":"t"}\n`);
    const { lines, summary } = replayTrace(file);
    expect(lines.length).toBe(1);
    expect(summary.skipped).toBe(2);
  });
});

describe("permission decision listener", () => {
  test("fires for every audited decision and stops after unsubscribe", () => {
    const seen: PermissionDecision[] = [];
    const off = onPermissionDecision((d) => seen.push(d));
    const deny = resolvePermissions({ permissions: { destructive: "deny" } } as never, tmp);
    expect(checkDestructiveCommand("rm -rf /tmp/whatever", deny)).toBeTruthy();
    expect(seen.length).toBe(1);
    expect(seen[0].domain).toBe("shell.destructive");
    expect(seen[0].action).toBe("deny");
    expect(typeof seen[0].rule).toBe("string");

    off();
    checkDestructiveCommand("rm -rf /tmp/whatever", deny);
    expect(seen.length).toBe(1);
  });

  test("a throwing listener does not break the check", () => {
    const off = onPermissionDecision(() => {
      throw new Error("bad listener");
    });
    const deny = resolvePermissions({ permissions: { destructive: "deny" } } as never, tmp);
    expect(() => checkDestructiveCommand("rm -rf /tmp/whatever", deny)).not.toThrow();
    off();
  });
});

describe("runAgent writes the trace", () => {
  test("turn.start, llm.step, tool and turn.end land in the file in order", async () => {
    const file = nextFile();
    const tr = new RunTrace(file);
    probeRuns = 0;
    let step = 0;
    const provider = async (_o: ChatOptions, onChunk: (c: ChatChunk) => void): Promise<StreamResult> => {
      step++;
      if (step === 1) {
        return {
          text: "",
          toolCalls: [{ id: "c1", name: "trace_probe_tool", arguments: "{}" }],
          finishReason: "tool_calls",
        };
      }
      onChunk({ content: "done" });
      return { text: "done", toolCalls: [], finishReason: "stop" };
    };
    const res = await runAgent({ ...base, provider, toolCtx: { cwd: tmp } as ToolContext, trace: tr }, {});

    expect(res.steps).toBe(2);
    expect(probeRuns).toBe(1);
    const recs = readRecords(file);
    const kinds = recs.map((r) => r.kind);
    expect(kinds[0]).toBe("turn.start");
    expect(kinds[kinds.length - 1]).toBe("turn.end");
    expect(kinds).toContain("llm.step");
    expect(kinds).toContain("tool");

    const toolRec = recs.find((r) => r.kind === "tool")!;
    expect(toolRec.tool).toBe("trace_probe_tool");
    expect(String(toolRec.output)).toContain("probe output ok");
    expect(toolRec.ok).toBe(true);
    expect(typeof toolRec.ms).toBe("number");

    const end = recs[kinds.length - 1];
    expect(end.steps).toBe(2);
    expect(end.aborted).toBe(false);
  });

  test("a declined interactive approval records approve + failed tool", async () => {
    const file = nextFile();
    const tr = new RunTrace(file);
    probeRuns = 0;
    let step = 0;
    const provider = async (): Promise<StreamResult> => {
      step++;
      if (step === 1) {
        return {
          text: "",
          toolCalls: [{ id: "c1", name: "trace_probe_tool", arguments: "{}" }],
          finishReason: "tool_calls",
        };
      }
      return { text: "done", toolCalls: [], finishReason: "stop" };
    };
    await runAgent(
      { ...base, provider, toolCtx: { cwd: tmp } as ToolContext, trace: tr },
      { confirmTool: async () => false },
    );

    const recs = readRecords(file);
    const approve = recs.find((r) => r.kind === "approve")!;
    expect(approve.approved).toBe(false);
    expect(approve.source).toBe("interactive");
    const toolRec = recs.find((r) => r.kind === "tool")!;
    expect(toolRec.ok).toBe(false);
    expect(String(toolRec.output)).toContain("BLOCKED");
    expect(probeRuns).toBe(0);
  });
});
