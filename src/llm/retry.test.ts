import { describe, expect, test } from "bun:test";
import { parseRetryAfter, sleepAbortable, isTransientRateLimit, isLongRateLimitWindow, parseContextGap } from "./retry";

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

  test("parses minute-composite windows (Groq TPD wording)", () => {
    const res = { headers: { get: () => null } };
    // The exact wording from a real Groq daily-quota 429. The old parser read
    // this as 22 seconds and burned every retry against a 27-minute window.
    const body =
      "Rate limit reached for model `qwen/qwen3.8-27b` on tokens per day (TPD): Limit 200000, Used 199314. Please try again in 27m22.464s.";
    expect(parseRetryAfter(res, body)).toBe(60_000); // clamped max
  });

  test("parses hour-composite windows", () => {
    const res = { headers: { get: () => null } };
    expect(parseRetryAfter(res, "try again in 2h5m30s")).toBe(60_000); // clamped max
  });

  test("bare-minute windows parse as minutes, not seconds", () => {
    const res = { headers: { get: () => null } };
    expect(parseRetryAfter(res, "try again in 5m")).toBe(60_000); // clamped max
    expect(parseRetryAfter(res, "try again in 0.5m")).toBe(30_000);
  });

  test("millisecond windows parse as milliseconds, not minutes", () => {
    const res = { headers: { get: () => null } };
    // Real Groq TPM wording. Parsed as 825 minutes it falsely triggered the
    // long-window fail-over for a hiccup that heals in under a second.
    expect(parseRetryAfter(res, "Please try again in 825ms. Need more tokens?")).toBe(1000);
    expect(parseRetryAfter(res, "try again in 1500ms")).toBe(1500);
    expect(isLongRateLimitWindow("Please try again in 825ms.")).toBe(false);
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

describe("parseContextGap", () => {
  test("parses Requested/Limit out of a real Groq 413 body", () => {
    const body =
      'Request too large for model `openai/gpt-oss-120b` on tokens per minute (TPM): Limit 8000, Requested 9555, please reduce your message size and try again.';
    expect(parseContextGap(body)).toBe(1555);
  });

  test("returns null when the request actually fits", () => {
    expect(parseContextGap("Limit 8000, Requested 7100")).toBeNull();
    expect(parseContextGap("Limit 8000, Requested 8000")).toBeNull();
  });

  test("returns null when figures are missing or malformed", () => {
    expect(parseContextGap("no numbers here")).toBeNull();
    expect(parseContextGap("Requested abc, Limit 8000")).toBeNull();
    expect(parseContextGap("Requested 9555")).toBeNull();
  });
});

describe("isLongRateLimitWindow", () => {
  test("flags daily/hourly quota wording as a long window", () => {
    expect(isLongRateLimitWindow("Please try again in 27m22.464s.")).toBe(true);
    expect(isLongRateLimitWindow("Please try again in 2h5m.")).toBe(true);
  });

  test("short windows are not long", () => {
    expect(isLongRateLimitWindow("Please try again in 19.02s.")).toBe(false);
    expect(isLongRateLimitWindow("no hint at all")).toBe(false);
  });
});