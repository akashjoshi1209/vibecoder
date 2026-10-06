// Tests for the approval flow that permissions.destructive: "ask" now drives,
// and for the output cap that replaced tail-only truncation.
import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, existsSync, writeFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { executeTool } from "./registry";
import type { ToolContext } from "./registry";
import { ApprovalRequiredError, isApprovalRequired, rejectedMessage, noPrompterMessage } from "./approval";
import { destructiveReason } from "../permissions";
import { resolvePermissions } from "../permissions";

import "./bash";
import { capOutput } from "./bash";

const tmp = mkdtempSync(join(tmpdir(), "vc-approval-"));

function ctxWith(perms: Record<string, unknown>): ToolContext {
  return {
    cwd: tmp,
    permissions: resolvePermissions({ permissions: perms } as any, tmp),
  };
}

describe("destructiveReason", () => {
  test("names the reason without deciding what to do about it", () => {
    expect(destructiveReason("rm -rf build")).toContain("rm");
    expect(destructiveReason("git reset --hard")).toBeTruthy();
    expect(destructiveReason("echo hi")).toBeNull();
  });
});

describe('destructive: "ask"', () => {
  test("bash throws ApprovalRequiredError instead of returning a PENDING string", async () => {
    const ctx = ctxWith({ destructive: "ask" });
    // The old behaviour returned the literal string
    // "PENDING (ask): ... — awaiting approval" as a tool result. Nothing prompted
    // and the model read it as a soft denial.
    let thrown: unknown = null;
    try {
      await executeTool("bash", { command: "rm -rf ./somedir" }, ctx);
    } catch (err) {
      thrown = err;
    }
    expect(thrown).not.toBeNull();
    expect(isApprovalRequired(thrown)).toBe(true);
    const err = thrown as ApprovalRequiredError;
    expect(err.tool).toBe("bash");
    expect(err.reason).toBeTruthy();
    expect(err.args.command).toContain("rm -rf");
  });

  test("the thrown error is control flow, not an ERROR: string", async () => {
    const ctx = ctxWith({ destructive: "ask" });
    try {
      await executeTool("bash", { command: "rm -rf x" }, ctx);
      throw new Error("should have thrown");
    } catch (err) {
      // A flattened string would start with "ERROR:" and the loop could not tell
      // it apart from a genuine failure.
      if (err instanceof Error && err.message === "should have thrown") throw err;
      expect(String((err as Error).message).startsWith("ERROR:")).toBe(false);
      expect(isApprovalRequired(err)).toBe(true);
    }
  });

  test("non-destructive commands still run without asking", async () => {
    const ctx = ctxWith({ destructive: "ask" });
    const out = await executeTool("bash", { command: "echo allowed" }, ctx);
    expect(out).toContain("allowed");
  });

  test('destructive: "deny" still refuses inline rather than throwing', async () => {
    const ctx = ctxWith({ destructive: "deny" });
    const out = await executeTool("bash", { command: "rm -rf y" }, ctx);
    expect(out).toContain("BLOCKED");
    // No prompt is possible or wanted: deny means refuse.
    expect(out).not.toContain("awaiting approval");
  });

  test('destructive: "allow" runs with no interruption', async () => {
    const ctx = ctxWith({ destructive: "allow" });
    const out = await executeTool("bash", { command: "echo fine" }, ctx);
    expect(out).toContain("fine");
  });
});

describe("isApprovalRequired", () => {
  test("recognises the error across module boundaries", () => {
    // A bundler can duplicate the class, so instanceof alone is not reliable.
    const impostor = Object.assign(new Error("x"), { name: "ApprovalRequiredError", reason: "rm" });
    expect(isApprovalRequired(impostor)).toBe(true);
  });

  test("does not claim ordinary errors", () => {
    expect(isApprovalRequired(new Error("boom"))).toBe(false);
    expect(isApprovalRequired("BLOCKED: nope")).toBe(false);
    expect(isApprovalRequired(null)).toBe(false);
    expect(isApprovalRequired(undefined)).toBe(false);
  });
});

describe("approval messages", () => {
  test("a decline tells the model not to work around it", () => {
    const msg = rejectedMessage("bash", "file removal");
    expect(msg).toContain("BLOCKED");
    expect(msg).toContain("declined");
    // Explicit, because the observed failure mode was the model retrying with
    // something sneakier.
    expect(msg).toMatch(/do not retry|don't retry/i);
  });

  test("no prompter is an honest failure, not a silent allow", () => {
    const msg = noPrompterMessage("bash", "file removal");
    expect(msg).toContain("BLOCKED");
    expect(msg.toLowerCase()).toContain("no approver");
    // Must not read as permission granted, which was the original defect.
    expect(msg).not.toMatch(/\bok\b.*proceed/i);
  });
});

describe("capOutput", () => {
  test("leaves short output untouched", () => {
    expect(capOutput("hello", 30_000)).toBe("hello");
  });

  test("keeps both ends instead of only the tail", () => {
    const head = "FIRST_ERROR_AT_THE_TOP\n" + "x".repeat(100);
    const tail = "\nLAST_SUMMARY_LINE";
    const out = capOutput(head + "y".repeat(60_000) + tail, 10_000);
    // The head carries the first failure; the tail carries the summary. Trimming
    // the tail only is what previously left the model with a summary and no
    // diagnosis.
    expect(out).toContain("FIRST_ERROR_AT_THE_TOP");
    expect(out).toContain("LAST_SUMMARY_LINE");
  });

  test("says how much was dropped and how to raise the cap", () => {
    const out = capOutput("a".repeat(80_000), 10_000);
    expect(out).toMatch(/omitted from the middle/);
    expect(out).toContain("VIBECODER_MAX_OUTPUT");
    // The elision notice must not silently imply the output was short.
    expect(out).toMatch(/\d+ characters omitted/);
  });

  test("output stays within the cap plus the notice", () => {
    const out = capOutput("z".repeat(100_000), 5_000);
    // The notice itself is overhead, but the body must respect the cap.
    expect(out.length).toBeLessThan(5_000 + 400);
  });

  test("keeps a useful head when max is small but above the floor", () => {
    const out = capOutput("HEAD_MARKER\n" + "q".repeat(50_000) + "\nTAIL_MARKER", 2_000);
    expect(out).toContain("HEAD_MARKER");
    expect(out).toContain("TAIL_MARKER");
  });
});

// Cleanup has to be deferred. A top-level rmSync runs when the file is
// evaluated, which is before any test body executes — so it deletes the cwd the
// tests were about to spawn in, and every spawn fails with ENOENT.
afterAll(() => rmSync(tmp, { recursive: true, force: true }));