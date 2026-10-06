// The ask → approve → re-run contract.
//
// A human's "yes" must actually let the command run: it used to re-ask on its
// own re-run (the check is a pure function of the command) and land in
// "no approver attached", so destructive: "ask" approved nothing. Consent is
// one-shot (approvalSig on the ToolContext, cleared when the call returns),
// declining or being unattended must refuse without executing.
import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { executeTool, type ToolContext } from "../tools/registry";
import { resolvePermissions } from "../permissions";
import { runAgent } from "./loop";
import type { StreamResult } from "../llm/types";
import "../tools/bash";

let dirs: string[] = [];
function askCtx(): ToolContext {
  const d = mkdtempSync(join(tmpdir(), "vc-ask-"));
  dirs.push(d);
  writeFileSync(join(d, "f.txt"), "x");
  return { cwd: d, permissions: resolvePermissions({ permissions: { destructive: "ask" } } as never, d) };
}
afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
  dirs = [];
});

const base = {
  systemPrompt: "s",
  model: "m",
  initialMessages: [{ role: "user" as const, content: "go" }],
};

/** Provider that calls bash exactly once with `command`, then finishes. */
function bashOnce(command: string) {
  let step = 0;
  return async (): Promise<StreamResult> => {
    step++;
    if (step === 1) {
      return {
        text: "",
        toolCalls: [{ id: "c1", name: "bash", arguments: JSON.stringify({ command }) }],
        finishReason: "tool_calls",
      };
    }
    return { text: "done", toolCalls: [], finishReason: "stop" };
  };
}

describe("destructive: ask", () => {
  test("direct executeTool throws instead of running", async () => {
    const ctx = askCtx();
    await expect(executeTool("bash", { command: "rm f.txt" }, ctx)).rejects.toThrow();
    expect(existsSync(join(ctx.cwd, "f.txt"))).toBe(true);
  });

  test("an approved destructive command actually runs", async () => {
    const ctx = askCtx();
    let output = "";
    await runAgent(
      { ...base, provider: bashOnce("rm f.txt"), toolCtx: ctx },
      {
        confirmTool: async () => true,
        onToolEnd: (_n, r) => {
          output = r;
        },
      },
    );
    expect(existsSync(join(ctx.cwd, "f.txt"))).toBe(false);
    expect(output).not.toContain("no approver");
    expect(output).not.toContain("BLOCKED");
  });

  test("a declined destructive command never runs", async () => {
    const ctx = askCtx();
    let output = "";
    await runAgent(
      { ...base, provider: bashOnce("rm f.txt"), toolCtx: ctx },
      {
        confirmTool: async () => false,
        onToolEnd: (_n, r) => {
          output = r;
        },
      },
    );
    expect(existsSync(join(ctx.cwd, "f.txt"))).toBe(true);
    expect(output).toContain("BLOCKED");
  });

  test("unattended (no prompter) refuses without running", async () => {
    const ctx = askCtx();
    let output = "";
    await runAgent(
      { ...base, provider: bashOnce("rm f.txt"), toolCtx: ctx },
      {
        onToolEnd: (_n, r) => {
          output = r;
        },
      },
    );
    expect(existsSync(join(ctx.cwd, "f.txt"))).toBe(true);
    expect(output).toContain("no approver");
  });

  test("consent is one-shot: the next identical call asks again", async () => {
    const ctx = askCtx();
    await runAgent({ ...base, provider: bashOnce("rm f.txt"), toolCtx: ctx }, {
      confirmTool: async () => true,
    });
    // The marker is cleared when the approved call returns — a fresh direct
    // call with the same arguments must ask again, not ride the old consent.
    writeFileSync(join(ctx.cwd, "f.txt"), "x");
    await expect(executeTool("bash", { command: "rm f.txt" }, ctx)).rejects.toThrow();
    expect(existsSync(join(ctx.cwd, "f.txt"))).toBe(true);
  });
});
