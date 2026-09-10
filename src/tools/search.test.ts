import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { executeTool, type ToolContext } from "./registry";

import "./files";
import "./search";

let tmpDirs: string[] = [];
function ctx(): ToolContext {
  const d = mkdtempSync(join(tmpdir(), "vc-search-test-"));
  tmpDirs.push(d);
  writeFileSync(join(d, "a.txt"), "alpha beta\nline two");
  writeFileSync(join(d, "b.ts"), "const alpha = 1;");
  return { cwd: d };
}

afterAll(() => {
  for (const d of tmpDirs) rmSync(d, { recursive: true, force: true });
  tmpDirs = [];
});

describe("grep", () => {
  test("finds matches across files with path and line numbers", async () => {
    const res = await executeTool("grep", { pattern: "alpha" }, ctx());
    expect(res).toContain("a.txt");
    expect(res).toContain("b.ts");
    expect(res).toContain("1:");
  });

  test("honors the include filter", async () => {
    const res = await executeTool("grep", { pattern: "alpha", include: "*.ts" }, ctx());
    expect(res).toContain("b.ts");
    expect(res).not.toContain("a.txt");
  });

  test("does not execute shell metacharacters inside the pattern", async () => {
    const res = await executeTool("grep", { pattern: "alpha$(touch /tmp/vc-injected)" }, ctx());
    expect(res).toBe("(no matches)");
    const exists = await Bun.file("/tmp/vc-injected").exists();
    expect(exists).toBe(false);
  });

  test("handles a pattern starting with a dash", async () => {
    const res = await executeTool("grep", { pattern: "-alpha" }, ctx());
    expect(res).toBe("(no matches)");
  });

  test("reports a missing directory as an error", async () => {
    const res = await executeTool("grep", { pattern: "x", path: "/does/not/exist/xyz" }, ctx());
    expect(res).toMatch(/ERROR/i);
  });
});

describe("glob", () => {
  test("lists matching files", async () => {
    const res = await executeTool("glob", { pattern: "*.txt" }, ctx());
    expect(res).toContain("a.txt");
  });

  test("reports no matches cleanly", async () => {
    const res = await executeTool("glob", { pattern: "**/*.py" }, ctx());
    expect(res).toBe("(no matches)");
  });

  test("errors gracefully when the directory is missing", async () => {
    const res = await executeTool("glob", { pattern: "**/*", cwd: "/does/not/exist/xyz" }, ctx());
    expect(res).toMatch(/ERROR/i);
  });
});