import { sleepAbortable } from "./retry";

/**
 * Tracks an input-token-per-minute budget and paces requests so the sum of
 * estimated tokens sent within a rolling window stays under a provider cap
 * (e.g. GROQ's free-tier 7000 ITPM). Pacing is a pure sleep — no cost.
 */
export class RatePacer {
  private history: { at: number; tokens: number }[] = [];

  constructor(private cap: number, private windowMs = 60_000, private now: () => number = Date.now) {}

  record(tokens: number): void {
    this.prune();
    this.history.push({ at: this.now(), tokens });
  }

  /** Milliseconds to wait before sending `nextTokens`, 0 if no delay needed. */
  waitMs(nextTokens: number): number {
    this.prune();
    let sum = nextTokens;
    for (const h of this.history) sum += h.tokens;
    if (sum <= this.cap) return 0;
    const over = sum - this.cap;
    const rate = this.cap / this.windowMs; // tokens per ms
    return Math.min(60_000, Math.ceil(over / rate));
  }

  private prune(): void {
    const cutoff = this.now() - this.windowMs;
    this.history = this.history.filter((h) => h.at >= cutoff);
  }
}

/** Sleep guard; if a delay is computed, await it abortably. */
export async function paceWait(pacer: RatePacer | null, tokens: number, signal?: AbortSignal): Promise<void> {
  if (!pacer) return;
  const ms = pacer.waitMs(tokens);
  if (ms <= 0) return;
  await sleepAbortable(ms, signal ?? new AbortController().signal);
}