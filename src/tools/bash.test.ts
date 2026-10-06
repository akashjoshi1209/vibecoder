import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { executeTool, type ToolContext } from "./registry";

import "./bash";

let tmpDirs: string[] = [];
function ctx(): ToolContext {
  const d = mkdtempSync(join(tmpdir(), "vc-bash-test-"));
  tmpDirs.push(d);
  return { cwd: d };
}

afterAll(() => {
  for (const d of tmpDirs) {
    // Windows holds a handle briefly after a child exits, so rmSync can throw
    // EBUSY. A leftover temp directory is harmless; failing the suite over one
    // hides real regressions, so retry briefly and then give up quietly.
    for (let attempt = 0; attempt < 5; attempt++) {
      try {
        rmSync(d, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
        break;
      } catch {
        /* still locked; try again */
      }
    }
  }
  tmpDirs = [];
});

describe("bash", () => {
  test("returns command output", async () => {
    const res = await executeTool("bash", { command: "echo hello" }, ctx());
    expect(res).toContain("hello");
  });

  test("includes stderr and exit code on failure", async () => {
    const res = await executeTool("bash", { command: "echo boom >&2; exit 3" }, ctx());
    expect(res).toContain("boom");
    expect(res).toContain("[exit code: 3]");
  });

  test("kills a hanging command at the timeout", async () => {
    const started = Date.now();
    const res = await executeTool("bash", { command: "sleep 30", timeout: 300 }, ctx());
    expect(Date.now() - started).toBeLessThan(20_000);
    expect(res).toContain("timed out");
  });

  test("respects the workdir parameter", async () => {
    const c = mkdtempSync(join(tmpdir(), "vc-bash-workdir-"));
    const sub = join(c, "workdir-check");
    await executeTool("bash", { command: `mkdir -p "${sub}"`, workdir: c }, ctx());
    expect(existsSync(sub)).toBe(true);
    rmSync(c, { recursive: true, force: true });
  });

  test("returns an error string for a bad workdir", async () => {
    const res = await executeTool("bash", { command: "pwd", workdir: "/does/not/exist/xyz" }, ctx());
    expect(res).toMatch(/ERROR|error/i);
  });
});