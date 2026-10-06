// Tests for the session change log and its revert path.
//
// These use a redirected VIBECODER_SESSION_DIR rather than the real ~/.vibecoder,
// because the module resolves its store at call time from that variable. Writing
// a test's changes into the user's real change log would be a genuinely bad
// outcome: /revert would then offer to restore files the user never touched.
import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  changeLogPath,
  describeDiff,
  isChangeStorePath,
  readChangeEntries,
  recordChange,
  recordNote,
  revertSession,
  sessionDiff,
  setChangeSession,
  undoDir,
} from "./changelog";

const dataRoot = mkdtempSync(join(tmpdir(), "vc-cl-root-"));
const work = mkdtempSync(join(tmpdir(), "vc-cl-work-"));
const priorRoot = process.env.VIBECODER_SESSION_DIR;

beforeAll(() => {
  process.env.VIBECODER_SESSION_DIR = dataRoot;
});
afterAll(() => {
  if (priorRoot === undefined) delete process.env.VIBECODER_SESSION_DIR;
  else process.env.VIBECODER_SESSION_DIR = priorRoot;
  rmSync(dataRoot, { recursive: true, force: true });
  rmSync(work, { recursive: true, force: true });
});

function freshSession(id: string): void {
  setChangeSession(id);
}

describe("recordChange", () => {
  test("records a creation with no pre-image", () => {
    freshSession("s-create");
    const p = join(work, "new.ts");
    writeFileSync(p, "hello\n");
    const e = recordChange({ tool: "write_file", path: p, cwd: work, beforeText: null, afterText: "hello\n" });
    expect(e.existedBefore).toBe(false);
    expect(e.undoFile).toBeNull();
    expect(e.beforeSha).toBe("");
    expect(e.afterSha).toBeTruthy();
  });

  test("stashes the pre-image for a modification", () => {
    freshSession("s-mod");
    const p = join(work, "mod.ts");
    writeFileSync(p, "original\n");
    const e = recordChange({
      tool: "edit_file",
      path: p,
      cwd: work,
      beforeText: "original\n",
      afterText: "changed\n",
    });
    expect(e.existedBefore).toBe(true);
    expect(e.undoFile).toBeTruthy();
    // The stash must hold the content as it was, not as it will be.
    const stored = readFileSync(join(undoDir(), e.undoFile!), "utf8");
    expect(stored).toBe("original\n");
  });

  test("deduplicates identical pre-images across repeated edits", () => {
    freshSession("s-dedupe");
    const p = join(work, "dedupe.ts");
    const a = recordChange({ tool: "edit_file", path: p, cwd: work, beforeText: "v1", afterText: "v2" });
    const b = recordChange({ tool: "edit_file", path: p, cwd: work, beforeText: "v2", afterText: "v3" });
    expect(a.undoFile).not.toBe(b.undoFile);
    const again = recordChange({ tool: "edit_file", path: p, cwd: work, beforeText: "v1", afterText: "vx" });
    // Same prior state → same stash entry. Ten edits to one file should not store
    // ten copies of the same content.
    expect(again.undoFile).toBe(a.undoFile);
  });

  test("skips stashing content that is too large, and says so", () => {
    freshSession("s-big");
    const p = join(work, "big.bin");
    const huge = "x".repeat(600 * 1024);
    const e = recordChange({ tool: "write_file", path: p, cwd: work, beforeText: huge, afterText: "y" });
    // Recorded by size, but not restorable — and the difference must be visible
    // rather than showing up later as a revert that silently does nothing.
    expect(e.undoFile).toBeNull();
    expect(e.beforeBytes).toBeGreaterThan(512 * 1024);
  });

  test("the log is append-only JSONL, one object per line", () => {
    // Self-sufficient on purpose: bun test --randomize shuffles tests within
    // the file too, so this assertion may run first. It must create the data
    // it reads instead of assuming earlier tests already did.
    freshSession("s-jsonl");
    for (let i = 0; i < 4; i++) {
      recordChange({
        tool: "edit_file",
        path: join(work, "jsonl.ts"),
        cwd: work,
        beforeText: `v${i}`,
        afterText: `v${i + 1}`,
      });
    }
    const text = readFileSync(changeLogPath(), "utf8");
    const lines = text.split("\n").filter(Boolean);
    expect(lines.length).toBeGreaterThan(3);
    for (const l of lines) expect(() => JSON.parse(l)).not.toThrow();
  });
});

describe("readChangeEntries / sessionDiff", () => {
  test("filters by session", () => {
    freshSession("s-a");
    recordChange({ tool: "write_file", path: join(work, "a1"), cwd: work, beforeText: null, afterText: "x" });
    freshSession("s-b");
    recordChange({ tool: "write_file", path: join(work, "b1"), cwd: work, beforeText: null, afterText: "x" });
    expect(readChangeEntries("s-a").every((e) => e.sessionId === "s-a")).toBe(true);
    expect(readChangeEntries("s-b").every((e) => e.sessionId === "s-b")).toBe(true);
  });

  test("folds repeated edits of one file into a single line", () => {
    freshSession("s-fold");
    const p = join(work, "fold.ts");
    for (let i = 0; i < 4; i++) {
      recordChange({ tool: "edit_file", path: p, cwd: work, beforeText: `v${i}`, afterText: `v${i + 1}` });
    }
    const diff = sessionDiff("s-fold");
    expect(diff.files.length).toBe(1);
    expect(diff.files[0].edits).toBe(4);
  });

  test("keeps the EARLIEST pre-image, so revert restores the original", () => {
    freshSession("s-orig");
    const p = join(work, "orig.ts");
    const first = recordChange({ tool: "edit_file", path: p, cwd: work, beforeText: "ORIGINAL", afterText: "v2" });
    recordChange({ tool: "edit_file", path: p, cwd: work, beforeText: "v2", afterText: "v3" });
    recordChange({ tool: "edit_file", path: p, cwd: work, beforeText: "v3", afterText: "FINAL" });
    const diff = sessionDiff("s-orig");
    // Not the most recent pre-image — that would undo only the last edit and
    // leave the file at an intermediate state while reporting success.
    expect(diff.files[0].undoFile).toBe(first.undoFile);
    expect(readFileSync(join(undoDir(), diff.files[0].undoFile!), "utf8")).toBe("ORIGINAL");
  });

  test("surfaces git notes alongside file changes", () => {
    freshSession("s-notes");
    recordChange({ tool: "write_file", path: join(work, "n1"), cwd: work, beforeText: null, afterText: "x" });
    recordNote("git_commit", "committed 2 file(s)");
    const diff = sessionDiff("s-notes");
    expect(diff.notes.length).toBe(1);
    expect(describeDiff(diff)).toContain("git_commit");
  });
});

describe("revertSession", () => {
  test("restores a modified file byte-for-byte", () => {
    const p = join(work, "restore.txt");
    writeFileSync(p, "before\n");
    freshSession("s-restore");
    recordChange({ tool: "edit_file", path: p, cwd: work, beforeText: "before\n", afterText: "after\n" });
    writeFileSync(p, "after\n");
    const res = revertSession("s-restore");
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.restored.length).toBe(1);
    expect(readFileSync(p, "utf8")).toBe("before\n");
  });

  test("deletes a file the agent created", () => {
    const p = join(work, "created.txt");
    freshSession("s-create2");
    recordChange({ tool: "write_file", path: p, cwd: work, beforeText: null, afterText: "new\n" });
    writeFileSync(p, "new\n");
    expect(existsSync(p)).toBe(true);
    const res = revertSession("s-create2");
    expect(res.ok).toBe(true);
    // The agent made it, so undoing means removing it, not leaving an empty file.
    expect(existsSync(p)).toBe(false);
  });

  test("reverts only the named paths", () => {
    const a = join(work, "one.txt");
    const b = join(work, "two.txt");
    writeFileSync(a, "a1");
    writeFileSync(b, "b1");
    freshSession("s-partial");
    recordChange({ tool: "edit_file", path: a, cwd: work, beforeText: "a1", afterText: "a2" });
    recordChange({ tool: "edit_file", path: b, cwd: work, beforeText: "b1", afterText: "b2" });
    writeFileSync(a, "a2");
    writeFileSync(b, "b2");
    const res = revertSession("s-partial", [a]);
    expect(res.ok).toBe(true);
    expect(readFileSync(a, "utf8")).toBe("a1");
    // Untouched: a targeted revert must not sweep the whole session.
    expect(readFileSync(b, "utf8")).toBe("b2");
  });

  test("reports a file with no stashed pre-image as skipped, not silently done", () => {
    const p = join(work, "nosnap.bin");
    freshSession("s-nosnap");
    recordChange({
      tool: "write_file",
      path: p,
      cwd: work,
      beforeText: "z".repeat(600 * 1024),
      afterText: "changed",
    });
    writeFileSync(p, "changed");
    const res = revertSession("s-nosnap");
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.restored.length).toBe(0);
      expect(res.skipped.length).toBe(1);
      expect(res.skipped[0]).toContain("no pre-image");
    }
  });

  test("says so when there is nothing to undo", () => {
    const res = revertSession("s-never-used");
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toContain("no changes");
  });

  test("says so for an unknown path rather than reverting everything", () => {
    freshSession("s-unknown");
    recordChange({ tool: "write_file", path: join(work, "keep.txt"), cwd: work, beforeText: null, afterText: "x" });
    const res = revertSession("s-unknown", [join(work, "not-touched.txt")]);
    expect(res.ok).toBe(false);
  });
});

describe("isChangeStorePath", () => {
  test("protects the log and the undo store from agent writes", () => {
    expect(isChangeStorePath(changeLogPath())).toBe(true);
    expect(isChangeStorePath(undoDir())).toBe(true);
    // An agent that can rewrite its own audit trail has no audit trail, so the
    // protection has to cover the directory, not just the one known filename.
    expect(isChangeStorePath(join(undoDir(), "anything.bak"))).toBe(true);
  });

  test("leaves ordinary workspace files alone", () => {
    expect(isChangeStorePath(join(work, "src", "index.ts"))).toBe(false);
  });
});