import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  resetSessionRoot,
  sanitizeId,
  saveSession,
  loadSession,
  listSessions,
  deleteSession,
  saveLast,
  loadLast,
  resolveResumeArg,
  type SessionData,
} from "./session";

let dir: string;
function makeSession(overrides: Partial<SessionData> = {}): SessionData {
  return {
    id: "demo",
    title: "A demo conversation",
    createdAt: Date.now(),
    updatedAt: Date.now(),
    provider: "groq",
    model: "qwen/qwen3.8-27b",
    cwd: "/tmp",
    systemPrompt: "You are Vibecoder.",
    messages: [{ role: "user", content: "hello" }],
    messageCount: 1,
    ...overrides,
  };
}

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "vc-session-test-"));
  process.env.VIBECODER_SESSION_DIR = dir;
  resetSessionRoot();
});

afterAll(() => {
  delete process.env.VIBECODER_SESSION_DIR;
  resetSessionRoot();
  rmSync(dir, { recursive: true, force: true });
});

describe("session persistence", () => {
  test("sanitizeId strips unsafe characters", () => {
    expect(sanitizeId("a b/c")).toBe("a_b_c");
    expect(sanitizeId("../evil")).toBe("___evil");
    expect(sanitizeId("ok.name-2")).toBe("ok_name-2");
  });

  test("save + load round-trips a session", () => {
    saveSession(makeSession({ id: "roundtrip" }));
    const loaded = loadSession("roundtrip");
    expect(loaded).not.toBeNull();
    expect(loaded!.title).toBe("A demo conversation");
    expect(loaded!.messages).toHaveLength(1);
    expect(loaded!.messages[0].role).toBe("user");
    expect(existsSync(join(dir, "sessions", "roundtrip.json"))).toBe(true);
  });

  test("listSessions returns saved sessions newest first", async () => {
    saveSession(makeSession({ id: "older" }));
    await Bun.sleep(10);
    saveSession(makeSession({ id: "newer" }));
    const ids = listSessions().map((s) => s.id);
    expect(ids[0]).toBe("newer");
    expect(ids).toContain("older");
    expect(ids.indexOf("newer")).toBeLessThan(ids.indexOf("older"));
  });

  test("loadSession returns null for unknown ids", () => {
    expect(loadSession("does-not-exist")).toBeNull();
  });

  test("deleteSession removes a session", () => {
    saveSession(makeSession({ id: "todelete" }));
    expect(deleteSession("todelete")).toBe(true);
    expect(loadSession("todelete")).toBeNull();
    expect(deleteSession("todelete")).toBe(false);
  });

  test("saveLast + loadLast round-trips the last session", () => {
    saveLast(makeSession({ id: "last-one", title: "Last thing I did" }));
    const l = loadLast();
    expect(l).not.toBeNull();
    expect(l!.title).toBe("Last thing I did");
  });
});

describe("resolveResumeArg", () => {
  test("no --resume flag means no resume", () => {
    expect(resolveResumeArg(["vibecoder", "--prompt", "x"])).toEqual({ resume: false, name: null });
  });

  test("bare --resume means resume the last conversation", () => {
    expect(resolveResumeArg(["vibecoder", "--resume"])).toEqual({ resume: true, name: null });
  });

  test("--resume <name> targets the named session", () => {
    expect(resolveResumeArg(["vibecoder", "--resume", "mysession"])).toEqual({ resume: true, name: "mysession" });
  });

  test("a following flag is not swallowed as a session name", () => {
    expect(resolveResumeArg(["vibecoder", "--resume", "--prompt", "x"])).toEqual({ resume: true, name: null });
  });
});