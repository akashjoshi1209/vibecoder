export class LLMTimeoutError extends Error {
  constructor(
    readonly kind: "idle" | "total",
    readonly elapsedMs: number,
  ) {
    super(
      kind === "idle"
        ? `LLM stream stalled: no data for ${Math.round(elapsedMs / 1000)}s. Check your network connection (set timeoutIdleMs in config.json to tune).`
        : `LLM request timed out after ${Math.round(elapsedMs / 1000)}s. Check your network connection (set timeoutMs in config.json to tune).`,
    );
    this.name = "LLMTimeoutError";
  }
}

export interface TimeoutSpec {
  signal?: AbortSignal;
  timeoutMs?: number; // hard ceiling for the entire request/stream
  idleMs?: number; // max silence between received bytes
  onTimeout?: (t: LLMTimeoutError) => void;
}

/**
 * Runs `start(controllerSignal, markData)` enforcing both a total deadline and an
 * idle (no-data) deadline. Aborts the controller signal when either fires, calls
 * onTimeout with the reason, then cleans up. A user abort is forwarded unchanged.
 */
export function withTimeout<T>(
  opts: TimeoutSpec,
  start: (signal: AbortSignal, markData: () => void) => Promise<T>,
): Promise<T> {
  const total = opts.timeoutMs ?? 120_000;
  const idle = opts.idleMs ?? 60_000;

  const ac = new AbortController();
  const userSignal = opts.signal;
  const onUserAbort = () => ac.abort(userSignal?.reason);
  if (userSignal?.aborted) queueMicrotask(() => ac.abort(userSignal.reason));
  userSignal?.addEventListener("abort", onUserAbort, { once: true });

  let lastDataAt = Date.now();
  let fired: LLMTimeoutError | null = null;
  const fire = (kind: "idle" | "total") => {
    if (fired || ac.signal.aborted) return;
    const e = new LLMTimeoutError(kind, kind === "idle" ? Date.now() - lastDataAt : total);
    fired = e;
    opts.onTimeout?.(e);
    ac.abort(e);
  };

  const totalTimer = setTimeout(() => fire("total"), total);
  const watchdog = setInterval(() => {
    if (Date.now() - lastDataAt > idle) fire("idle");
  }, 250);

  const markData = () => {
    lastDataAt = Date.now();
  };

  return start(ac.signal, markData).finally(() => {
    clearTimeout(totalTimer);
    clearInterval(watchdog);
    userSignal?.removeEventListener("abort", onUserAbort);
  });
}