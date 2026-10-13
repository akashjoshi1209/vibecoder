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
  // Providers word the wait as "in 27m22.464s" or "in 2h5m". The old pattern
  // only matched bare seconds, so "27m22.464s" parsed as 22 seconds and every
  // retry burned itself against a quota that was still 27 minutes away.
  // Try the H/M/S composite first, then minutes, then bare seconds.
  const hms = bodyText.match(/in\s+(\d+(?:\.\d+)?)h(?:(\d+(?:\.\d+)?)m)?(?:(\d+(?:\.\d+)?)s)?/i);
  if (hms) {
    const h = Number(hms[1]) || 0;
    const m = Number(hms[2]) || 0;
    const s = Number(hms[3]) || 0;
    return clampMs(((h * 60 + m) * 60 + s) * 1000);
  }
  // Milliseconds (e.g. Groq TPM limits: "try again in 825ms"): must be tested
  // BEFORE the minutes pattern, and the minutes pattern must reject a directly
  // following "s" — otherwise "825ms" parses as 825 minutes and a sub-second
  // hiccup triggers the long-window (daily quota) fail-over path.
  const milli = bodyText.match(/in\s+(\d+(?:\.\d+)?)\s*ms\b/i);
  if (milli) {
    const n = Number(milli[1]);
    if (Number.isFinite(n)) return clampMs(n);
  }
  const mins = bodyText.match(/in\s+(\d+(?:\.\d+)?)m(?!s)(?:(\d+(?:\.\d+)?)s)?/i);
  if (mins) {
    const m = Number(mins[1]) || 0;
    const s = Number(mins[2]) || 0;
    return clampMs((m * 60 + s) * 1000);
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

/** Groq words its daily-token (TPD) exhaustion with a reset wait of minutes to
 *  hours. No in-process retry can outlast that — the caller must give up or
 *  fail over to another provider instead of sleeping through its attempts. */
export function isLongRateLimitWindow(bodyText: string): boolean {
  return parseRetryAfter({ headers: { get: () => null } }, bodyText, 0) >= 60_000;
}

/** Parse "Requested 9555" / "Limit 8000" token figures out of a Groq-style
 *  413/429 body so the caller can shrink a too-large request by exactly the
 *  required amount instead of guessing. Returns the gap when both figures are
 *  present and positive, null otherwise. */
export function parseContextGap(bodyText: string): number | null {
  const req = bodyText.match(/Requested\s+(\d+)/i);
  const lim = bodyText.match(/Limit\s+(\d+)/i);
  if (!req || !lim) return null;
  const requested = Number(req[1]);
  const limit = Number(lim[1]);
  if (!Number.isFinite(requested) || !Number.isFinite(limit)) return null;
  const gap = requested - limit;
  return gap > 0 ? gap : null;
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