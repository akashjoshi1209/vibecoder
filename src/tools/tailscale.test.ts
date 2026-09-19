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

import "./tailscale";

const ctx: ToolContext = { cwd: process.cwd() };

afterEach(() => {
  queue.length = 0;
  calls.length = 0;
  spawnCollectMock.mockClear();
});

describe("tailscale_status", () => {
  test("reports when tailscale is not installed", async () => {
    queue.push({ stdout: "", stderr: "", exitCode: 1, timedOut: false, aborted: false });
    const res = await executeTool("tailscale_status", {}, ctx);
    expect(res).toContain("ERROR");
    expect(res).toContain("not found on PATH");
    expect(calls.length).toBe(1);
  });

  test("returns the full plain status output", async () => {
    queue.push(
      { stdout: "/usr/bin/tailscale\n", stderr: "", exitCode: 0, timedOut: false, aborted: false },
      { stdout: "100.x.y.z  somehost  -  100.64.0.1 offline\n", stderr: "", exitCode: 0, timedOut: false, aborted: false },
    );
    const res = await executeTool("tailscale_status", {}, ctx);
    expect(res).toContain("somehost");
    expect(calls[1].cmd).toEqual(["tailscale", "status"]);
  });

  test("summarizes the JSON form when summary is requested", async () => {
    queue.push(
      { stdout: "/usr/bin/tailscale\n", stderr: "", exitCode: 0, timedOut: false, aborted: false },
      {
        stdout: JSON.stringify({
          dnsName: "phone.tailnet.ts.net",
          magicDNSSrcIP: "100.101.1.2",
          BackendState: "Running",
          CanCarryPossibly: true,
          Self: { MagicDNSSrcIP: "100.101.1.2", TailscaleIPs: ["100.101.1.2", "fd7a:115c:a1e0::2"] },
          Peers: { peer1: { Online: true }, peer2: { Online: false } },
        }),
        stderr: "",
        exitCode: 0,
        timedOut: false,
        aborted: false,
      },
    );
    const res = await executeTool("tailscale_status", { summary: true }, ctx);
    expect(res).toContain("connected");
    expect(res).toContain("phone.tailnet");
    expect(res).toContain("peers: 2 total, 1 online");
    expect(calls[1].cmd).toEqual(["tailscale", "status", "--json"]);
  });

  test("falls back to raw output when JSON parsing fails", async () => {
    queue.push(
      { stdout: "/usr/bin/tailscale\n", stderr: "", exitCode: 0, timedOut: false, aborted: false },
      { stdout: "not json", stderr: "", exitCode: 0, timedOut: false, aborted: false },
    );
    const res = await executeTool("tailscale_status", { summary: true }, ctx);
    expect(res).toBe("not json");
  });

  test("reports a backend failure with the command errors", async () => {
    queue.push(
      { stdout: "/usr/bin/tailscale\n", stderr: "", exitCode: 0, timedOut: false, aborted: false },
      { stdout: "", stderr: "spawn error: ENOENT", exitCode: -1, timedOut: false, aborted: false },
    );
    const res = await executeTool("tailscale_status", {}, ctx);
    expect(res).toContain("ERROR");
  });

  test("appends the exit code for a nonzero status exit", async () => {
    queue.push(
      { stdout: "/usr/bin/tailscale\n", stderr: "", exitCode: 0, timedOut: false, aborted: false },
      { stdout: "", stderr: "access denied", exitCode: 1, timedOut: false, aborted: false },
    );
    const res = await executeTool("tailscale_status", {}, ctx);
    expect(res).toContain("access denied");
    expect(res).toContain("[exit code: 1]");
  });
});