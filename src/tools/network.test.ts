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

import "./network";

const ctx: ToolContext = { cwd: process.cwd() };

afterEach(() => {
  queue.length = 0;
  calls.length = 0;
  spawnCollectMock.mockClear();
});

describe("network_ping", () => {
  test("requires a host", async () => {
    const res = await executeTool("network_ping", {}, ctx);
    expect(res).toBe("ERROR: host is required");
    expect(calls.length).toBe(0);
  });

  test("returns ping output on success", async () => {
    queue.push({ stdout: "3 packets transmitted, 3 received", stderr: "", exitCode: 0, timedOut: false, aborted: false });
    const res = await executeTool("network_ping", { host: "1.1.1.1" }, ctx);
    expect(res).toContain("3 received");
    expect(calls[0].cmd).toEqual(["ping", "-c", "3", "-W", "5", "1.1.1.1"]);
  });

  test("reports a missing ping binary as a note", async () => {
    queue.push({ stdout: "", stderr: "spawn error: ENOENT", exitCode: -1, timedOut: false, aborted: false });
    const res = await executeTool("network_ping", { host: "x" }, ctx);
    expect(res).toContain("NOTE");
    expect(res).toContain("ping not available");
  });
});

describe("tailscale_status", () => {
  test("is inert when tailscale is not installed", async () => {
    queue.push({ stdout: "", stderr: "", exitCode: 1, timedOut: false, aborted: false });
    const res = await executeTool("tailscale_status", {}, ctx);
    expect(res).toContain("not found on PATH");
  });

  test("summarizes JSON status when connected", async () => {
    const status = {
      BackendState: "Running",
      HostInfo: { HostName: "phone" },
      Self: { TailscaleIPs: ["100.64.0.1"] },
      Peers: { "oppo-a9": { Online: true, TailscaleIPs: ["100.64.0.2"] } },
    };
    queue.push({ stdout: "/usr/bin/tailscale", stderr: "", exitCode: 0, timedOut: false, aborted: false });
    queue.push({ stdout: JSON.stringify(status), stderr: "", exitCode: 0, timedOut: false, aborted: false });
    const res = await executeTool("tailscale_status", {}, ctx);
    expect(res).toContain("tailscale: connected");
    expect(res).toContain("hostname: phone");
    expect(res).toContain("oppo-a9");
  });

  test("filters to a specific peer", async () => {
    const status = {
      BackendState: "Running",
      Peers: {
        "oppo-a9": { Online: true, TailscaleIPs: ["100.64.0.2"] },
        "laptop": { Online: false, TailscaleIPs: ["100.64.0.3"] },
      },
    };
    queue.push({ stdout: "/usr/bin/tailscale", stderr: "", exitCode: 0, timedOut: false, aborted: false });
    queue.push({ stdout: JSON.stringify(status), stderr: "", exitCode: 0, timedOut: false, aborted: false });
    const res = await executeTool("tailscale_status", { host: "oppo-a9" }, ctx);
    expect(res).toContain("oppo-a9 → 100.64.0.2");
    expect(res).not.toContain("laptop →");
  });
});
