export function parseRetryAfter(
  res: { headers: { get(name: string): string | null } },
  bodyText: string,
  fallbackMs = 5000,
): number {
  const header = res.headers.get("retry-after");
  if (header) {
    const n = Number(header);
    if (Number.isFinite(n)) return clampMs(n * 1000);
  }
  const match = bodyText.match(/in\s+(\d+(?:\.\d+)?)\s*s(?:econds?)?/i);
  if (match) {
    const n = Number(match[1]);
    if (Number.isFinite(n)) return clampMs(n * 1000);
  }
  return clampMs(fallbackMs);
}

function clampMs(ms: number): number {
  return Math.min(60_000, Math.max(1000, Math.round(ms)));
}

export function sleepAbortable(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(signal.reason ?? new DOMException("aborted", "AbortError"));
      return;
    }
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal.reason ?? new DOMException("aborted", "AbortError"));
    };
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

export const isTransientRateLimit = (status: number): boolean =>
  status === 429 || status === 502 || status === 503 || status === 504;