import { describe, test, expect } from "bun:test";
import { isOnline, createConnectivityPoller } from "./connectivity";

function fakeFetch(status: number | "abort" | "dns") {
  return async (_url: string, _init?: RequestInit): Promise<Response> => {
    if (status === "abort") {
      const err = new Error("The operation was aborted due to timeout");
      err.name = "TimeoutError";
      throw err;
    }
    if (status === "dns") {
      const err = new Error("fetch failed");
      (err as any).cause = new Error("getaddrinfo ENOTFOUND api.groq.com");
      throw err;
    }
    return { status } as Response;
  };
}

describe("isOnline", () => {
  test("any HTTP response is online", async () => {
    expect(await isOnline({ probeUrl: "x", fetchImpl: fakeFetch(401) })).toBe(true);
    expect(await isOnline({ probeUrl: "x", fetchImpl: fakeFetch(200) })).toBe(true);
    expect(await isOnline({ probeUrl: "x", fetchImpl: fakeFetch(503) })).toBe(true);
  });

  test("timeout / DNS failure is offline", async () => {
    expect(await isOnline({ probeUrl: "x", fetchImpl: fakeFetch("abort") })).toBe(false);
    expect(await isOnline({ probeUrl: "x", fetchImpl: fakeFetch("dns") })).toBe(false);
  });
});

describe("createConnectivityPoller", () => {
  test("reports initial state via onChange and checkNow", async () => {
    let f = fakeFetch(200);
    const changes: boolean[] = [];
    const poller = createConnectivityPoller(
      { probeUrl: "x", fetchImpl: (u: string, i?: RequestInit) => f(u, i), pollMs: 9999 },
      (o) => changes.push(o),
    );
    expect(await poller.checkNow()).toBe(true);
    f = fakeFetch("dns");
    expect(await poller.checkNow()).toBe(false);
    expect(changes).toEqual([true, false]);
    poller.stop();
  });

  test("does not fire onChange when state is unchanged", async () => {
    const changes: boolean[] = [];
    const f = fakeFetch(200);
    const poller = createConnectivityPoller(
      { probeUrl: "x", fetchImpl: (u: string, i?: RequestInit) => f(u, i), pollMs: 9999 },
      (o) => changes.push(o),
    );
    await poller.checkNow();
    await poller.checkNow();
    expect(changes).toEqual([true]);
    poller.stop();
  });
});