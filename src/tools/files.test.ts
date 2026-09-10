import { describe, expect, test, afterEach } from "bun:test";
import { mkdtempSync, rmSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { executeTool, type ToolContext } from "./registry";

// importing files.ts triggers side-effect registration
import "./files";

let tmpDir: string;
const ctx: ToolContext = { get cwd() { return tmpDir; } };

afterEach(() => {
  if (tmpDir) rmSync(tmpDir, { recursive: true, force: true });
});

function setup() {
  tmpDir = mkdtempSync(join(tmpdir(), "vc-files-test-"));
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
