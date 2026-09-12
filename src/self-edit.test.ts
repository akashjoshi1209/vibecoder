import { describe, expect, test, afterEach } from "bun:test";
import { findModelCard } from "./llm/model-cards";
import {
  isSelfFile,
  isProtectedFile,
  appendLedger,
  readLedger,
  auditSelfEdit,
  shaOf,
  ledgerSummary,
} from "./self-edit";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

describe("model cards", () => {
  test("finds a card by exact id", () => {
    const c = findModelCard("nvidia/nemotron-3-ultra-550b-a55b");
    expect(c).not.toBeNull();
    expect(c!.paramsTotal).toBe("550B");
    expect(c!.context).toBe(1_000_000);
  });

  test("finds a card by substring", () => {
    const c = findModelCard("nemotron-3-ultra");
    expect(c).not.toBeNull();
    expect(c!.family).toContain("Nemotron");
  });

  test("returns null for unknown model", () => {
    expect(findModelCard("totally/unknown-model")).toBeNull();
  });
});

describe("self-edit guardrail helpers (pure)", () => {
  let dir: string;
  let prev: string | undefined;

  const setup = () => {
    dir = mkdtempSync(join(tmpdir(), "vc-selftest-"));
    prev = process.env.VIBECODER_REPO_ROOT;
    process.env.VIBECODER_REPO_ROOT = dir;
  };
  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
    if (prev !== undefined) process.env.VIBECODER_REPO_ROOT = prev;
    else delete process.env.VIBECODER_REPO_ROOT;
  });

  test("isSelfFile / isProtectedFile classify paths", () => {
    setup();
    expect(isSelfFile(join(dir, "config.json"))).toBe(true);
    expect(isSelfFile(join(dir, ".env"))).toBe(true);
    expect(isSelfFile(join(dir, "src", "x.ts"))).toBe(false);
    expect(isSelfFile("/etc/hostname")).toBe(false);
    expect(isProtectedFile(join(dir, "SELF_EDITS.jsonl"))).toBe(true);
    expect(isProtectedFile(join(dir, "config.json"))).toBe(false);
  });

  test("appendLedger + readLedger round-trip, newest first", () => {
    setup();
    expect(readLedger()).toEqual([]);
    appendLedger({ tool: "write_file", file: "config.json", beforeSha: "a", afterSha: "b", note: "one" });
    appendLedger({ tool: "write_file", file: "config.json", beforeSha: "b", afterSha: "c", note: "two" });
    const led = readLedger();
    expect(led.length).toBe(2);
    expect(led[0].note).toBe("two");
    expect(led[1].note).toBe("one");
    expect(existsSync(join(dir, "SELF_EDITS.jsonl"))).toBe(true);
  });

  test("readLedger respects limit", () => {
    setup();
    for (let i = 0; i < 8; i++) appendLedger({ tool: "t", file: "f", beforeSha: "", afterSha: "", note: String(i) });
    expect(readLedger(3).length).toBe(3);
  });

  test("shaOf is stable and differs by content", () => {
    expect(shaOf("abc")).toBe(shaOf("abc"));
    expect(shaOf("abc")).not.toBe(shaOf("abd"));
  });

  test("auditSelfEdit returns staged note with tool and file", () => {
    setup();
    const note = auditSelfEdit("edit_file", join(dir, "config.json"), "before", "after", "changed temp");
    expect(note).toContain("staged");
    expect(note).toContain("/reload-config");
    expect(note).toContain("SELF_EDITS.jsonl");
  });

  test("ledgerSummary formats entries", () => {
    setup();
    appendLedger({ tool: "write_file", file: "config.json", beforeSha: "x", afterSha: "y", note: "n1" });
    const s = ledgerSummary(1);
    expect(s[0]).toContain("config.json");
    expect(s[0]).toContain("changed");
  });
});