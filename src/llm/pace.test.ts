import { describe, expect, test } from "bun:test";
import { RatePacer, paceWait } from "./pace";

describe("RatePacer", () => {
  test("no delay when under cap", () => {
    const p = new RatePacer(7000);
    p.record(3000);
    expect(p.waitMs(3000)).toBe(0);
  });

  test("delays when window total exceeds cap", () => {
    const p = new RatePacer(7000);
    p.record(5000);
    const ms = p.waitMs(3000);
    expect(ms).toBeGreaterThan(0);
    expect(ms).toBeLessThanOrEqual(60_000);
  });

  test("old records expire after the window", () => {
    let now = 1000;
    const p = new RatePacer(7000, 60_000, () => now);
    p.record(6500);
    now += 30_000;
    expect(p.waitMs(1000)).toBeGreaterThan(0);
    now += 40_000; // past 60s window
    expect(p.waitMs(1000)).toBe(0);
  });

  test("delay scales with overage", () => {
    const p = new RatePacer(7000, 60_000, () => 0);
    p.record(7000);
    const overMinute = p.waitMs(7000);
    const overHalf = p.waitMs(7000);
    void overMinute;
    // 7000 + 7000 - 7000 = 7000 over / (7000/60000 per ms) = 60000 ms
    expect(overHalf).toBe(60_000);
  });

  test("paceWait with zero delay resolves immediately", async () => {
    const p = new RatePacer(7000);
    p.record(1000);
    const t0 = Date.now();
    await paceWait(p, 1000, new AbortController().signal);
    expect(Date.now() - t0).toBeLessThan(50);
  });

  test("paceWait with null pacer does nothing", async () => {
    const t0 = Date.now();
    await paceWait(null, 10_000, new AbortController().signal);
    expect(Date.now() - t0).toBeLessThan(50);
  });
});