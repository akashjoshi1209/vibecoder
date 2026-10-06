import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { executeTool, type ToolContext } from "./registry";
import { bannedReason } from "./bash";

import "./bash";
import "./files";

const dirs: string[] = [];
function ctx(planPhase = false): ToolContext {
  const d = mkdtempSync(join(tmpdir(), "vc-plan-guard-"));
  dirs.push(d);
  return { cwd: d, planPhase };
}

afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
  dirs.length = 0;
});

describe("plan-phase tool guards", () => {
  test("write_file is blocked in plan mode", async () => {
    const res = await executeTool("write_file", { path: join(ctx(true).cwd, "x.txt"), content: "x" }, ctx(true));
    expect(res).toContain("BLOCKED");
  });

  test("edit_file is blocked in plan mode", async () => {
    const res = await executeTool("edit_file", { path: "/tmp/vc-nope.txt", oldString: "a", newString: "b" }, ctx(true));
    expect(res).toContain("BLOCKED");
  });

  test("destructive bash is blocked in plan mode", async () => {
    const res = await executeTool("bash", { command: "rm -rf /tmp/vc-plan-should-not-exist" }, ctx(true));
    expect(res).toContain("BLOCKED");
  });

  test("bannedReason catches destructive commands at start, after separators, and after whitespace", () => {
    expect(bannedReason("rm -rf /x")).toBeTruthy();
    expect(bannedReason("  rm -rf /x")).toBeTruthy();
    expect(bannedReason("git push origin master")).toBeTruthy();
    expect(bannedReason("cd /tmp && rm -rf x")).toBeTruthy();
    expect(bannedReason("ls\nsudo reboot")).toBeTruthy();
    expect(bannedReason("echo hi > file.txt")).toBeTruthy();
  });

  test("bannedReason allows read-only investigation commands", () => {
    expect(bannedReason("ls -la")).toBeNull();
    expect(bannedReason("cat README.md")).toBeNull();
    expect(bannedReason("git status")).toBeNull();
    expect(bannedReason("grep -rn planPhase src")).toBeNull();
  });

  test("write_file still works when plan mode is off", async () => {
    const c = ctx(false).cwd;
    const res = await executeTool("write_file", { path: join(c, "ok.txt"), content: "hi" }, { cwd: c });
    expect(res).toContain("Wrote");
  });
});