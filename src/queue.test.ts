import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  enqueueTask,
  listTasks,
  loadTask,
  nextQueued,
  claimTask,
  markTaskDone,
  markTaskFailed,
  requeueTask,
  resetStale,
  deleteTask,
  resetQueueRoot,
  type QueuedTask,
} from "./queue";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "vcqueue-"));
  process.env.VIBECODER_SESSION_DIR = dir;
  resetQueueRoot();
});

afterEach(() => {
  delete process.env.VIBECODER_SESSION_DIR;
  resetQueueRoot();
});

function makeTask(over: Partial<QueuedTask> = {}): QueuedTask {
  return enqueueTask({
    userMessage: "write a test file",
    cwd: "/tmp",
    sessionId: "sess-1",
    systemPrompt: "You are Vibecoder.",
    ...over,
  });
}

describe("task queue", () => {
  test("enqueue persists to disk and appears in listTasks", () => {
    const t = makeTask();
    expect(t.status).toBe("queued");
    expect(loadTask(t.id)).toBeTruthy();
    expect(listTasks()).toHaveLength(1);
    expect(existsSync(join(dir, "queue.json"))).toBe(true);
  });

  test("planNote is stored with the task", () => {
    const t = makeTask({ planNote: "PLAN: 1. inspect\n2. write" });
    expect(loadTask(t.id)?.planNote).toContain("PLAN:");
  });

  test("nextQueued returns oldest queued first", () => {
    const a = makeTask();
    const b = makeTask({ userMessage: "second task" });
    a.createdAt = 1;
    b.createdAt = 2;
    expect(nextQueued()?.id).toBe(a.id);
  });

  test("claimTask marks running and locks with pid", () => {
    const t = makeTask();
    const claimed = claimTask(t.id);
    expect(claimed?.status).toBe("running");
    expect(claimed?.runnerPid).toBe(process.pid);
    expect(loadTask(t.id)?.status).toBe("running");
    expect(nextQueued()).toBeNull(); // claimed task is not handed out again
  });

  test("done/failed record result", () => {
    const t = makeTask();
    claimTask(t.id);
    markTaskDone(t.id, "wrote 4 bytes");
    const done = loadTask(t.id)!;
    expect(done.status).toBe("done");
    expect(done.result).toBe("wrote 4 bytes");
    expect(done.error).toBeUndefined();

    const f = makeTask({ userMessage: "fail me" });
    claimTask(f.id);
    markTaskFailed(f.id, "LLM 502");
    expect(loadTask(f.id)?.status).toBe("failed");
    expect(loadTask(f.id)?.error).toBe("LLM 502");
  });

  test("requeueTask clears running state", () => {
    const t = makeTask();
    claimTask(t.id);
    requeueTask(t.id);
    expect(loadTask(t.id)?.status).toBe("queued");
    expect(loadTask(t.id)?.runnerPid).toBeUndefined();
    expect(nextQueued()?.id).toBe(t.id);
  });

  test("resetStale returns crashed running tasks to queued", () => {
    const t = makeTask();
    // Simulate a crash: forge a task left "running" by a dead process.
    const forged = { ...t, status: "running", runnerPid: 999999999 };
    const { writeFileSync } = require("node:fs") as typeof import("node:fs");
    writeFileSync(join(dir, "queue.json"), JSON.stringify([forged], null, 2));
    const n = resetStale();
    expect(n).toBe(1);
    const after = loadTask(t.id)!;
    expect(after.status).toBe("queued");
    expect(after.runnerPid).toBeUndefined();
  });

  test("deleteTask removes only the target", () => {
    const a = makeTask();
    const b = makeTask({ userMessage: "keep me" });
    expect(deleteTask(a.id)).toBe(true);
    expect(loadTask(a.id)).toBeNull();
    expect(loadTask(b.id)).toBeTruthy();
    expect(deleteTask("nope")).toBe(false);
  });

  test("listTasks can filter by status", () => {
    const a = makeTask();
    const b = makeTask({ userMessage: "fail" });
    markTaskFailed(b.id, "x");
    expect(listTasks("queued")).toHaveLength(1);
    expect(listTasks("failed")).toHaveLength(1);
    expect(listTasks("done")).toHaveLength(0);
  });
});