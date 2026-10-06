import { afterEach, describe, expect, mock, test } from "bun:test";
import { executeTool, type ToolContext } from "./registry";

type Result = { stdout: string; stderr: string; exitCode: number; timedOut: boolean; aborted: boolean };
const queue: Result[] = [];
const calls: any[] = [];

const spawnCollectMock = mock(async (opts: any): Promise<Result> => {
  calls.push(opts);
  return queue.length ? queue.shift()! : { stdout: "", stderr: "", exitCode: 0, timedOut: false, aborted: false };
});

mock.module("./proc", () => ({ spawnCollect: spawnCollectMock }));

import "./termux";

const ctx: ToolContext = { cwd: process.cwd() };

afterEach(() => {
  queue.length = 0;
  calls.length = 0;
  spawnCollectMock.mockClear();
});

describe("termux_notify", () => {
  test("pushes a notification when the command succeeds", async () => {
    const res = await executeTool("termux_notify", { title: "Build done" }, ctx);
    expect(res).toBe('notification pushed: "Build done"');
    expect(calls[0].cmd[0]).toBe("termux-notification");
    expect(calls[0].cmd).toContain("--title");
    expect(calls[0].cmd).toContain("Build done");
  });

  test("defaults message to title and caps lengths", async () => {
    await executeTool("termux_notify", { title: "T".repeat(150), message: "M".repeat(600) }, ctx);
    const cmd = calls[0].cmd;
    const title = cmd[cmd.indexOf("--title") + 1];
    const content = cmd[cmd.indexOf("--content") + 1];
    expect(title.length).toBe(100);
    expect(content.length).toBe(500);
  });

  test("includes stderr and exit code on failure", async () => {
    queue.push({ stdout: "", stderr: "boom", exitCode: 3, timedOut: false, aborted: false });
    const res = await executeTool("termux_notify", { title: "x" }, ctx);
    expect(res).toContain("boom");
    expect(res).toContain("[exit code: 3]");
  });

  test("reports a missing binary with the termux-api hint", async () => {
    queue.push({ stdout: "", stderr: "spawn error: ENOENT", exitCode: -1, timedOut: false, aborted: false });
    const res = await executeTool("termux_notify", { title: "x" }, ctx);
    expect(res).toContain("ERROR");
    expect(res).toContain("termux-api");
  });

  test("marks a timed-out command", async () => {
    queue.push({ stdout: "", stderr: "", exitCode: 0, timedOut: true, aborted: false });
    const res = await executeTool("termux_notify", { title: "x" }, ctx);
    expect(res).toContain("timed out");
  });

  test("requires a title", async () => {
    const res = await executeTool("termux_notify", {}, ctx);
    expect(res).toBe("ERROR: title is required");
    expect(calls.length).toBe(0);
  });
});

describe("termux_wake_lock", () => {
  test("acquires by default and releases on acquire=false", async () => {
    const acquired = await executeTool("termux_wake_lock", {}, ctx);
    expect(acquired).toBe("wake lock acquired");
    expect(calls[0].cmd[0]).toBe("termux-wake-lock");

    const released = await executeTool("termux_wake_lock", { acquire: false }, ctx);
    expect(released).toBe("wake lock released");
    expect(calls[1].cmd[0]).toBe("termux-wake-unlock");
  });

  test("hints termux-api when the binary is missing", async () => {
    queue.push({ stdout: "", stderr: "spawn error: ENOENT", exitCode: -1, timedOut: false, aborted: false });
    const res = await executeTool("termux_wake_lock", {}, ctx);
    expect(res).toContain("ERROR");
    expect(res).toContain("termux-api");
  });
});

describe("termux_battery", () => {
  test("returns the battery status output", async () => {
    queue.push({ stdout: '{"percentage":87,"status":"CHARGING"}', stderr: "", exitCode: 0, timedOut: false, aborted: false });
    const res = await executeTool("termux_battery", {}, ctx);
    expect(res).toContain('"percentage":87');
    expect(calls[0].cmd[0]).toBe("termux-battery-status");
  });
});