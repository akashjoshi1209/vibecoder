import { describe, expect, test, afterEach } from "bun:test";
import { mkdtempSync, rmSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { executeTool, type ToolContext } from "./registry";

// importing files.ts triggers side-effect registration
import "./files";
import { ledgerPath, readLedger } from "../self-edit";

let tmpDir: string;
let prevRepoRoot: string | undefined;
const ctx: ToolContext = { get cwd() { return tmpDir; } };

afterEach(() => {
  if (tmpDir) rmSync(tmpDir, { recursive: true, force: true });
  if (prevRepoRoot !== undefined) process.env.VIBECODER_REPO_ROOT = prevRepoRoot;
  else delete process.env.VIBECODER_REPO_ROOT;
});

function setup() {
  tmpDir = mkdtempSync(join(tmpdir(), "vc-files-test-"));
  prevRepoRoot = process.env.VIBECODER_REPO_ROOT;
  process.env.VIBECODER_REPO_ROOT = tmpDir;
}

describe("write_file", () => {
  test("creates a file in an existing directory", async () => {
    setup();
    const res = await executeTool("write_file", { path: join(tmpDir, "hello.txt"), content: "hello" }, ctx);
    expect(res).toMatch("Wrote 5 bytes");
    expect(readFileSync(join(tmpDir, "hello.txt"), "utf8")).toBe("hello");
  });

  test("creates parent directories recursively", async () => {
    setup();
    const path = join(tmpDir, "a", "b", "c", "deep.txt");
    const res = await executeTool("write_file", { path, content: "deep value" }, ctx);
    expect(res).toMatch("Wrote");
    expect(existsSync(path)).toBe(true);
    expect(readFileSync(path, "utf8")).toBe("deep value");
  });

  test("overwrites an existing file", async () => {
    setup();
    const path = join(tmpDir, "over.txt");
    await executeTool("write_file", { path, content: "first" }, ctx);
    await executeTool("write_file", { path, content: "second" }, ctx);
    expect(readFileSync(path, "utf8")).toBe("second");
  });
});

describe("read_file", () => {
  test("reads a file with line numbers from offset 1", async () => {
    setup();
    const path = join(tmpDir, "nums.txt");
    await executeTool("write_file", { path, content: "aaa\nbbb\nccc" }, ctx);
    const res = await executeTool("read_file", { path }, ctx);
    expect(res).toContain("1: aaa");
    expect(res).toContain("2: bbb");
    expect(res).toContain("3: ccc");
  });

  test("reads a subset with offset and limit", async () => {
    setup();
    const path = join(tmpDir, "long.txt");
    await executeTool("write_file", { path, content: "a\nb\nc\nd\ne" }, ctx);
    const res = await executeTool("read_file", { path, offset: 2, limit: 2 }, ctx);
    expect(res).toContain("2: b");
    expect(res).toContain("3: c");
    expect(res).not.toContain("4: d");
  });

  test("returns error for missing file", async () => {
    setup();
    const res = await executeTool("read_file", { path: join(tmpDir, "nope.txt") }, ctx);
    expect(res).toMatch("ERROR");
  });
});

describe("edit_file", () => {
  test("replaces unique match", async () => {
    setup();
    const path = join(tmpDir, "e.txt");
    await executeTool("write_file", { path, content: "hello world" }, ctx);
    const res = await executeTool("edit_file", { path, oldString: "hello", newString: "hi" }, ctx);
    expect(res).toMatch("replaced 1");
    expect(readFileSync(path, "utf8")).toBe("hi world");
  });

  test("returns error when oldString not found", async () => {
    setup();
    const path = join(tmpDir, "e2.txt");
    await executeTool("write_file", { path, content: "hello world" }, ctx);
    const res = await executeTool("edit_file", { path, oldString: "zzz", newString: "aaa" }, ctx);
    expect(res).toMatch("ERROR");
    expect(readFileSync(path, "utf8")).toBe("hello world");
  });

  test("returns error when oldString matches multiple times", async () => {
    setup();
    const path = join(tmpDir, "e3.txt");
    await executeTool("write_file", { path, content: "ab ab ab" }, ctx);
    const res = await executeTool("edit_file", { path, oldString: "ab", newString: "x" }, ctx);
    expect(res).toMatch("ERROR");
  });

  test("returns error when file not found", async () => {
    setup();
    const res = await executeTool("edit_file", { path: join(tmpDir, "nope.txt"), oldString: "x", newString: "y" }, ctx);
    expect(res).toMatch("ERROR");
  });
});

describe("self-edit guardrails", () => {
  test("write to config.json is audited in the ledger but still applies", async () => {
    setup();
    const cfgPath = join(tmpDir, "config.json");
    await executeTool("write_file", { path: cfgPath, content: `{"a":1}` }, ctx);
    const res = await executeTool("write_file", { path: cfgPath, content: `{"a":2}` }, ctx);
    expect(res).toContain("SELF-EDIT recorded");
    expect(readFileSync(cfgPath, "utf8")).toBe(`{"a":2}`);
    const ledger = readLedger();
    expect(ledger.length).toBe(2); // creation + update, both audited
    expect(ledger[0].file).toBe("config.json");
    expect(ledger[0].tool).toBe("write_file");
    expect(ledger[0].beforeSha).not.toBe(ledger[0].afterSha);
  });

  test("edit to config.json is audited", async () => {
    setup();
    const cfgPath = join(tmpDir, "config.json");
    await executeTool("write_file", { path: cfgPath, content: `{"temperature":0.7}` }, ctx);
    const res = await executeTool("edit_file", { path: cfgPath, oldString: "0.7", newString: "0.2" }, ctx);
    expect(res).toContain("SELF-EDIT recorded");
    expect(readFileSync(cfgPath, "utf8")).toBe(`{"temperature":0.2}`);
    expect(readLedger(10).some((e) => e.tool === "edit_file")).toBe(true);
  });

  test("ledger itself is protected from write_file and edit_file", async () => {
    setup();
    const lp = ledgerPath();
    const w = await executeTool("write_file", { path: lp, content: "tampered\n" }, ctx);
    expect(w).toContain("PROTECTED");
    expect(existsSync(lp)).toBe(false);
    const e = await executeTool("edit_file", { path: lp, oldString: "tampered", newString: "x" }, ctx);
    expect(e).toContain("ERROR");
    expect(existsSync(lp)).toBe(false);
  });

  test("ordinary files outside self-files are not audited", async () => {
    setup();
    const res = await executeTool("write_file", { path: join(tmpDir, "src", "x.txt"), content: "hi" }, ctx);
    expect(res).not.toContain("SELF-EDIT");
    expect(readLedger().length).toBe(0);
  });
});

describe("list_dir", () => {
  test("lists subdirectories first, then files with sizes", async () => {
    setup();
    await executeTool("write_file", { path: join(tmpDir, "zz.txt"), content: "12345" }, ctx);
    await executeTool("write_file", { path: join(tmpDir, "sub", "inner.txt"), content: "x" }, ctx);
    const res = await executeTool("list_dir", {}, ctx);
    expect(res).toContain("sub/");
    expect(res).toContain("zz.txt");
    // subdirectory sorts before files
    expect(res.indexOf("sub/")).toBeLessThan(res.indexOf("zz.txt"));
    // file has a human-readable size
    expect(res).toMatch(/zz\.txt\s+5B/);
  });

  test("lists an explicit path argument", async () => {
    setup();
    await executeTool("write_file", { path: join(tmpDir, "sub", "inner.txt"), content: "x" }, ctx);
    const res = await executeTool("list_dir", { path: "sub" }, ctx);
    expect(res).toContain("inner.txt");
  });

  test("returns an error for a missing directory", async () => {
    setup();
    const res = await executeTool("list_dir", { path: join(tmpDir, "missing") }, ctx);
    expect(res).toMatch("ERROR");
  });
});
