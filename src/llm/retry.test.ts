import { describe, expect, test } from "bun:test";
import { parseRetryAfter, sleepAbortable, isTransientRateLimit } from "./retry";

describe("parseRetryAfter", () => {
  test("honors the Retry-After header", () => {
    const res = { headers: { get: () => "19" } };
    expect(parseRetryAfter(res, "")).toBe(19_000);
  });

  test("parses the delay from the error body", () => {
    const res = { headers: { get: () => null } };
    const body =
      "Rate limit reached... Please try again in 19.02s. Need more tokens? Upgrade.";
    expect(parseRetryAfter(res, body)).toBe(19_020);
  });

  test("falls back to a default and clamps to sane bounds", () => {
    const res = { headers: { get: () => null } };
    expect(parseRetryAfter(res, "no hint")).toBe(5000);
    expect(parseRetryAfter(res, "try again in 12345s")).toBe(60_000);
    expect(parseRetryAfter(res, "try again in 0.2s")).toBe(1000);
  });
});

describe("sleepAbortable", () => {
  test("resolves after the delay", async () => {
    const start = Date.now();
    await sleepAbortable(40, new AbortController().signal);
    expect(Date.now() - start).toBeGreaterThanOrEqual(35);
  });

  test("rejects immediately when aborted", async () => {
    const ac = new AbortController();
    ac.abort();
    await expect(sleepAbortable(1000, ac.signal)).rejects.toThrow("aborted");
  });

  test("rejects early when the signal fires during the wait", async () => {
    const ac = new AbortController();
    const started = Date.now();
    const p = sleepAbortable(10_000, ac.signal);
    setTimeout(() => ac.abort(), 20);
    await expect(p).rejects.toThrow("aborted");
    expect(Date.now() - started).toBeLessThan(1000);
  });
});

describe("isTransientRateLimit", () => {
  test("flags 429 and transient 5xx", () => {
    expect(isTransientRateLimit(429)).toBe(true);
    expect(isTransientRateLimit(502)).toBe(true);
    expect(isTransientRateLimit(503)).toBe(true);
    expect(isTransientRateLimit(504)).toBe(true);
    expect(isTransientRateLimit(200)).toBe(false);
    expect(isTransientRateLimit(401)).toBe(false);
    expect(isTransientRateLimit(500)).toBe(false);
  });
});