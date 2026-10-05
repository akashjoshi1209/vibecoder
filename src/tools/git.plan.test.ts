import { describe, test, expect, afterAll } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { execFileSync } from "node:child_process";
import { executeTool, type ToolContext } from "./registry";
import { resolvePermissions } from "../permissions";

import "./git";

const tmpDirs: string[] = [];
function repo(): string {
  const d = mkdtempSync(join(tmpdir(), "vc-git-test-"));
  tmpDirs.push(d);
  const env = { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" };
  execFileSync("git", ["init", "-q"], { cwd: d, env });
  writeFileSync(join(d, "a.txt"), "one" + "\n");
  execFileSync("git", ["add", "-A"], { cwd: d, env });
  execFileSync("git", ["commit", "-q", "-m", "init"], { cwd: d, env });
  return d;
}

afterAll(() => {
  for (const d of tmpDirs) rmSync(d, { recursive: true, force: true });
});

/** Each test gets perms rooted at its own temp repo, since the workspace scope
 *  is compared against the real resolved path. */
function ctxFor(d: string, planPhase?: boolean): ToolContext {
  return {
    cwd: d,
    planPhase,
    permissions: resolvePermissions({ permissions: { filesystem: "workspace" } }, d),
  };
}

describe("git tools in plan mode", () => {
  test("git_commit is refused and creates no commit", async () => {
    const d = repo();
    const ctx = ctxFor(d, true);
    writeFileSync(join(d, "a.txt"), "changed" + "\n");
    const res = await executeTool("git_commit", { message: "should not happen", files: "a.txt" }, ctx);
    expect(res).toContain("BLOCKED IN PLAN MODE");
    // The change must still be uncommitted.
    const status = await executeTool("git_status", {}, ctxFor(d));
    expect(status).toContain("a.txt");
  });

  test("git_checkout_branch is refused and stays on the same branch", async () => {
    const d = repo();
    const ctx = ctxFor(d, true);
    const res = await executeTool("git_checkout_branch", { name: "feature-x" }, ctx);
    expect(res).toContain("BLOCKED IN PLAN MODE");
    const out = execFileSync("git", ["rev-parse", "--abbrev-ref", "HEAD"], { cwd: d }).toString().trim();
    expect(out === "feature-x").toBe(false);
  });

  test("git_push_ff is refused in plan mode", async () => {
    const d = repo();
    const ctx = ctxFor(d, true);
    const res = await executeTool("git_push_ff", {}, ctx);
    expect(res).toContain("BLOCKED IN PLAN MODE");
  });

  test("git_push_ff is refused when destructive=deny", async () => {
    const d = repo();
    const ctx: ToolContext = {
      cwd: d,
      permissions: resolvePermissions({ permissions: { destructive: "deny" } }, d),
    };
    const res = await executeTool("git_push_ff", {}, ctx);
    expect(res).toContain("BLOCKED (deny)");
  });

  test("git_checkout_branch validates the branch name", async () => {
    const d = repo();
    const ctx = ctxFor(d);
    const res = await executeTool("git_checkout_branch", { name: "bad;name" }, ctx);
    expect(res).toContain("invalid branch name");
  });

  test("git_checkout_branch accepts a `branch` alias", async () => {
    const d = repo();
    const ctx = ctxFor(d);
    const res = await executeTool("git_checkout_branch", { branch: "aliased" }, ctx);
    expect(res).toContain("aliased");
  });

  test("read-only git tools still work in plan mode", async () => {
    const d = repo();
    const ctx = ctxFor(d, true);
    const status = await executeTool("git_status", {}, ctx);
    // The status header names the current branch; on a fresh repo that is
    // main or master depending on the installed git's init.defaultBranch.
    expect(status).toMatch(/##\s+\S+/);
    const log = await executeTool("git_log", {}, ctx);
    expect(log).toContain("init");
  });
});

describe("git_commit outside plan mode", () => {
  test("refuses an unscoped git add -A", async () => {
    const d = repo();
    const ctx = ctxFor(d);
    writeFileSync(join(d, "a.txt"), "changed" + "\n");
    const res = await executeTool("git_commit", { message: "sweep" }, ctx);
    expect(res).toContain("refusing an unscoped");
    // Nothing was staged.
    const status = await executeTool("git_status", {}, ctx);
    expect(status).toContain("a.txt");
  });

  test("commits when files are named explicitly", async () => {
    const d = repo();
    const ctx = ctxFor(d);
    writeFileSync(join(d, "a.txt"), "changed" + "\n");
    const res = await executeTool("git_commit", { message: "explicit", files: "a.txt" }, ctx);
    expect(res).toContain("Committed as");
    expect(readFileSync(join(d, "a.txt"), "utf8").trim()).toBe("changed");
  });
});
