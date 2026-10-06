// Fallback search engine: correctness on a synthetic tree (the cases that
// made the shell-grep dependency a liability), the include/glob translation,
// and the bounds that keep a pathological tree from hanging an agent step.
import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { grepFallback, includeToRegExp } from "./grep-fallback";

const root = mkdtempSync(join(tmpdir(), "vc-grepfb-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));

let built = false;
function tree(): string {
  if (built) return root;
  built = true;
  writeFileSync(join(root, "a.txt"), "alpha one\nbeta line");
  writeFileSync(join(root, "b.ts"), "const alpha = 1;");
  writeFileSync(join(root, "build.log"), "alpha built"); // root .gitignore
  writeFileSync(join(root, ".gitignore"), "build.log\n");
  mkdirSync(join(root, "src"));
  writeFileSync(join(root, "src", "deep.ts"), "alpha deep");
  mkdirSync(join(root, "node_modules", "pkg"), { recursive: true });
  writeFileSync(join(root, "node_modules", "pkg", "index.js"), "alpha junk");
  mkdirSync(join(root, ".git"));
  writeFileSync(join(root, ".git", "config"), "alpha git");
  mkdirSync(join(root, "sub"));
  // Nested ignore file: *.log below sub/, with a negation for one file.
  writeFileSync(join(root, "sub", ".gitignore"), "*.log\n!important.log\n");
  writeFileSync(join(root, "sub", "keep.log"), "alpha keep");
  writeFileSync(join(root, "sub", "notes.log"), "alpha notes");
  writeFileSync(join(root, "sub", "important.log"), "alpha important");
  // Binary: NUL in the first bytes must not be searched.
  writeFileSync(join(root, "bin.dat"), Buffer.from("alpha\0binary", "utf8"));
  return root;
}

describe("grepFallback", () => {
  test("finds matches in grep -rn format, skipping ignores and binaries", () => {
    const r = grepFallback(tree(), /alpha/);
    expect("error" in r).toBe(false);
    if ("error" in r) return;
    // Set-compare: readdir order is platform-dependent.
    expect(new Set(r.lines)).toEqual(
      new Set([
        "a.txt:1:alpha one",
        "b.ts:1:const alpha = 1;",
        "src/deep.ts:1:alpha deep",
        // nested .gitignore: *.log ignores keep/notes, !important.log re-keeps it
        "sub/important.log:1:alpha important",
      ]),
    );
    // build.log is ignored by the root .gitignore; node_modules/.git/bin.dat excluded.
    expect(r.lines.some((l) => l.includes("build.log"))).toBe(false);
    expect(r.lines.some((l) => l.startsWith("bin.dat"))).toBe(false);
    expect(r.truncated).toBe(false);
    expect(r.scanned).toBeGreaterThan(0);
  });

  test("include=*.ts matches basenames at any depth (Windows-safe separator)", () => {
    const r = grepFallback(tree(), /alpha/, { include: "*.ts" });
    expect("error" in r).toBe(false);
    if ("error" in r) return;
    expect(new Set(r.lines)).toEqual(
      new Set(["b.ts:1:const alpha = 1;", "src/deep.ts:1:alpha deep"]),
    );
  });

  test("include=src/**/*.ts narrows to the subtree", () => {
    const r = grepFallback(tree(), /alpha/, { include: "src/**/*.ts" });
    expect("error" in r).toBe(false);
    if ("error" in r) return;
    expect(r.lines).toEqual(["src/deep.ts:1:alpha deep"]);
  });

  test("a stateful (/g) caller regex still matches across files", () => {
    const r = grepFallback(tree(), /alpha/g, { include: "*.txt" });
    expect("error" in r).toBe(false);
    if ("error" in r) return;
    expect(r.lines).toEqual(["a.txt:1:alpha one"]);
    // And across lines of the same file when the pattern repeats.
    writeFileSync(join(tree(), "multi.txt"), "alpha\nalpha\nalpha\n");
    const r2 = grepFallback(tree(), /alpha/g, { include: "multi.txt" });
    expect("error" in r2).toBe(false);
    if ("error" in r2) return;
    expect(r2.lines.length).toBe(3);
  });

  test("maxFiles cap stops the walk and flags truncation", () => {
    const r = grepFallback(tree(), /alpha/, { maxFiles: 1 });
    expect("error" in r).toBe(false);
    if ("error" in r) return;
    expect(r.scanned).toBe(1);
    expect(r.truncated).toBe(true);
  });

  test("maxMatches cap stops collecting and flags truncation", () => {
    writeFileSync(join(tree(), "many.txt"), "alpha\nalpha\nalpha\nalpha\nalpha\n");
    const r = grepFallback(tree(), /alpha/, { include: "many.txt", maxMatches: 2 });
    expect("error" in r).toBe(false);
    if ("error" in r) return;
    expect(r.lines.length).toBe(2);
    expect(r.truncated).toBe(true);
  });

  test("an already-aborted signal stops the walk", () => {
    const ac = new AbortController();
    ac.abort();
    const r = grepFallback(tree(), /alpha/, { signal: ac.signal });
    expect("error" in r).toBe(false);
    if ("error" in r) return;
    expect(r.lines.length).toBe(0);
  });

  test("a missing directory is an error, not a clean empty result", () => {
    const r = grepFallback(join(root, "does-not-exist"), /alpha/);
    expect("error" in r).toBe(true);
  });

  test("no matches returns an empty line set", () => {
    const r = grepFallback(tree(), /zzz_no_such_thing/);
    expect("error" in r).toBe(false);
    if ("error" in r) return;
    expect(r.lines).toEqual([]);
    expect(r.truncated).toBe(false);
  });
});

describe("includeToRegExp", () => {
  test("bare glob matches the basename at any depth", () => {
    const re = includeToRegExp("*.ts")!;
    expect(re.test("a.ts")).toBe(true);
    expect(re.test("src/deep/a.ts")).toBe(true);
    expect(re.test("src/a.tsx")).toBe(false);
  });

  test("anchored subtree glob", () => {
    const re = includeToRegExp("src/**/*.ts")!;
    expect(re.test("src/a.ts")).toBe(true);
    expect(re.test("src/x/a.ts")).toBe(true);
    expect(re.test("lib/a.ts")).toBe(false);
  });

  test("star-only glob means everything (null)", () => {
    expect(includeToRegExp("*")).toBeNull();
    expect(includeToRegExp("")).toBeNull();
  });

  test("regex metacharacters in the glob are literal", () => {
    const re = includeToRegExp("a+b.txt")!;
    expect(re.test("a+b.txt")).toBe(true);
    expect(re.test("aab.txt")).toBe(false);
  });
});
