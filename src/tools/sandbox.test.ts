// Sandbox depth: the workspace write-allowlist for shell redirections ("ask"
// outside, unless approved), scratch-target exemptions, the TMP/TEMP/TMPDIR
// redirection into the workspace scratch dir, and the audit trail every
// sandbox decision leaves behind.
import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { executeTool, type ToolContext } from "./registry";
import { decide, permissionAudit, resolvePermissions } from "../permissions";
import { isSandboxScratch, redirectTargets } from "./bash";
import { runAgent } from "../agent/loop";
import type { StreamResult } from "../llm/types";
import "./bash";

const scratchFiles: string[] = [];
let dirs: string[] = [];
function sandboxCtx(): { ctx: ToolContext; dir: string } {
  const d = mkdtempSync(join(tmpdir(), "vc-sandbox-"));
  dirs.push(d);
  return { ctx: { cwd: d, permissions: resolvePermissions({ permissions: { filesystem: "workspace" } } as never, d) }, dir: d };
}
afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
  for (const f of scratchFiles) rmSync(f, { force: true });
});

describe("redirectTargets", () => {
  test("extracts plain, appended and stderr redirects", () => {
    expect(redirectTargets("echo hi > out.txt")).toEqual(["out.txt"]);
    expect(redirectTargets("a && b >> logs/x")).toEqual(["logs/x"]);
    expect(redirectTargets("make 2> err.log")).toEqual(["err.log"]);
  });

  test("fd duplication writes nothing and is not a target", () => {
    expect(redirectTargets("git status 2>&1")).toEqual([]);
    expect(redirectTargets("cmd >&2")).toEqual([]);
  });

  test("deduplicates repeated targets", () => {
    expect(redirectTargets("x > a && y > a")).toEqual(["a"]);
  });
});

describe("isSandboxScratch", () => {
  test("accepts null devices and OS temp dirs, in either path style", () => {
    expect(isSandboxScratch("/dev/null")).toBe(true);
    expect(isSandboxScratch("/dev/stdout")).toBe(true);
    expect(isSandboxScratch("/tmp/x")).toBe(true);
    expect(isSandboxScratch("/var/tmp/y")).toBe(true);
    expect(isSandboxScratch("C:\\Windows\\Temp\\z")).toBe(true);
    expect(isSandboxScratch("C:/Windows/Temp/z")).toBe(true);
  });

  test("rejects real destinations", () => {
    expect(isSandboxScratch("/etc/passwd")).toBe(false);
    expect(isSandboxScratch("C:\\important.txt")).toBe(false);
    expect(isSandboxScratch("out.txt")).toBe(false);
  });
});

describe("sandbox.write decisions", () => {
  test("sandbox off (filesystem not workspace-scoped) always allows", () => {
    const perms = resolvePermissions({} as never, join(tmpdir(), "vc-full"));
    const d = decide({ domain: "sandbox.write", path: "/etc/passwd", perms });
    expect(d.rule).toBe("sandbox=off");
    expect(d.action).toBe("allow");
  });

  test("workspace-scoped: inside allows, outside asks when interactive, denies when not", () => {
    const ws = join(tmpdir(), "vc-sandbox-ws");
    const perms = resolvePermissions({ permissions: { filesystem: "workspace" } } as never, ws);
    expect(decide({ domain: "sandbox.write", path: join(ws, "sub", "f.txt"), perms }).action).toBe("allow");
    const outside = decide({ domain: "sandbox.write", path: join(tmpdir(), "..", "elsewhere.txt"), perms, interactive: true });
    expect(outside.rule).toBe("sandbox=write-allowlist");
    expect(outside.action).toBe("ask");
    const unattended = decide({ domain: "sandbox.write", path: join(tmpdir(), "..", "elsewhere.txt"), perms });
    expect(unattended.action).toBe("deny");
  });
});

describe("bash in sandbox mode", () => {
  test("a redirect inside the workspace runs", async () => {
    const { ctx, dir } = sandboxCtx();
    const out = await executeTool("bash", { command: "echo hi > in-sandbox.txt" }, ctx);
    expect(out).not.toContain("BLOCKED");
    expect(existsSync(join(dir, "in-sandbox.txt"))).toBe(true);
  });

  test("a redirect outside the workspace asks and writes nothing", async () => {
    const { ctx, dir } = sandboxCtx();
    const victim = join(dir, "..", `vc-sandbox-escape-${process.pid}.txt`);
    scratchFiles.push(victim);
    const before = permissionAudit().length;
    await expect(
      executeTool("bash", { command: `echo escaped > ../vc-sandbox-escape-${process.pid}.txt` }, ctx),
    ).rejects.toThrow();
    expect(existsSync(victim)).toBe(false);
    // The refusal left an audited decision: domain + rule + ask.
    const decisions = permissionAudit().filter((d) => d.domain === "sandbox.write");
    expect(decisions.length).toBeGreaterThan(0);
    const last = decisions[decisions.length - 1];
    expect(last.action).toBe("ask");
    expect(last.rule).toBe("sandbox=write-allowlist");
    expect(permissionAudit().length).toBeGreaterThan(before);
  });

  test("scratch redirects are exempt — no prompt, no refusal", async () => {
    const { ctx } = sandboxCtx();
    const out = await executeTool("bash", { command: "echo hi > /dev/null" }, ctx);
    expect(out).not.toContain("BLOCKED");
    expect(out).not.toContain("approval");
  });

  test("an approved outside redirect runs once the human says yes", async () => {
    const { ctx, dir } = sandboxCtx();
    const victim = join(dir, "..", `vc-sandbox-approved-${process.pid}.txt`);
    scratchFiles.push(victim);
    let output = "";
    let step = 0;
    const command = `echo approved > ../vc-sandbox-approved-${process.pid}.txt`;
    const provider = async (): Promise<StreamResult> => {
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
    await runAgent(
      {
        systemPrompt: "s",
        model: "m",
        initialMessages: [{ role: "user" as const, content: "go" }],
        provider,
        toolCtx: ctx,
      },
      {
        confirmTool: async () => true,
        onToolEnd: (_n, r) => {
          output = r;
        },
      },
    );
    expect(existsSync(victim)).toBe(true);
    expect(output).not.toContain("no approver");
  });

  test("sandboxed commands get TMP/TEMP/TMPDIR pointed at the workspace scratch dir", async () => {
    const { ctx, dir } = sandboxCtx();
    const out = await executeTool("bash", { command: 'echo "$TMP"' }, ctx);
    const scratch = join(dir, ".vibecoder", "tmp");
    expect(existsSync(scratch)).toBe(true);
    expect(out).toContain(scratch);
  });
});
