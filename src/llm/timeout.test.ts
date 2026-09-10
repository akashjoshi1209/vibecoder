import { describe, expect, test } from "bun:test";
import { withTimeout, LLMTimeoutError } from "./timeout";

describe("withTimeout", () => {
  test("resolves when work completes", async () => {
    const out = await withTimeout({ timeoutMs: 5000, idleMs: 4000 }, async (signal, markData) => {
      markData();
      return 42;
    });
    expect(out).toBe(42);
  });

  test("forwards a user abort", async () => {
    const ac = new AbortController();
    const promise = withTimeout({ signal: ac.signal, timeoutMs: 5000 }, (signal) => {
      return new Promise((_, reject) => {
        signal.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")), { once: true });
      });
    });
    ac.abort();
    await expect(promise).rejects.toThrow("aborted");
  });

  test("idle timeout fires when no data arrives", async () => {
    let fired: LLMTimeoutError | undefined;
    await expect(
      withTimeout(
        { timeoutMs: 50_000, idleMs: 100, onTimeout: (e) => (fired = e) },
        (signal) =>
          new Promise((_, reject) => {
            signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
          }),
      ),
    ).rejects.toThrow("aborted");
    expect(fired?.kind).toBe("idle");
  });

  test("total timeout fires as a ceiling", async () => {
    let fired: LLMTimeoutError | undefined;
    await expect(
      withTimeout(
        { timeoutMs: 80, idleMs: 10_000, onTimeout: (e) => (fired = e) },
        (signal, markData) =>
          new Promise((_, reject) => {
            const iv = setInterval(markData, 20); // keep data flowing: only total can fire
            signal.addEventListener("abort", () => {
              clearInterval(iv);
              reject(new Error("aborted"));
            }, { once: true });
          }),
      ),
    ).rejects.toThrow("aborted");
    expect(fired?.kind).toBe("total");
  });

  test("an already-aborted user signal aborts immediately", async () => {
    const ac = new AbortController();
    ac.abort();
    const promise = withTimeout({ signal: ac.signal, timeoutMs: 5000 }, (signal) => {
      return new Promise((_, reject) => {
        signal.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")), { once: true });
      });
    });
    await expect(promise).rejects.toThrow("aborted");
  });
});