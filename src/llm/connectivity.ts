// Connectivity probe: decides whether the online provider endpoints are
// reachable. Any HTTP status counts as online (401/403 still means the network
// path works) — only network-level failures (DNS, refused, timeout) are offline.
export interface ConnectivityOptions {
  probeUrl: string;
  timeoutMs?: number;
  /** Injectable fetch for tests. */
  fetchImpl?: ((url: string, init?: RequestInit) => Promise<Response>) | typeof fetch;
}

export async function isOnline(opts: ConnectivityOptions): Promise<boolean> {
  const timeoutMs = opts.timeoutMs ?? 8_000;
  const f = opts.fetchImpl ?? fetch;
  try {
    const res = await f(opts.probeUrl, {
      method: "GET",
      signal: AbortSignal.timeout(timeoutMs),
      redirect: "follow",
    });
    void res;
    return true;
  } catch {
    return false;
  }
}

export interface ConnectivityPoller {
  online: boolean;
  start(): void;
  stop(): void;
  /** Force a probe now; returns updated online state. */
  checkNow(): Promise<boolean>;
}

/** Polls connectivity on an interval and calls `onChange(online)` each time the
 *  state flips. The first probe runs immediately during `start()`; that result is
 *  delivered through `onChange` too. */
export function createConnectivityPoller(
  opts: ConnectivityOptions & { pollMs?: number },
  onChange: (online: boolean) => void,
): ConnectivityPoller {
  const pollMs = opts.pollMs ?? 15000;
  let online = false;
  let timer: ReturnType<typeof setInterval> | null = null;
  let stopped = false;

  const probe = async (): Promise<boolean> => {
    const now = await isOnline(opts);
    if (now !== online) {
      online = now;
      if (!stopped) onChange(online);
    }
    return now;
  };

  return {
    get online() {
      return online;
    },
    start() {
      stopped = false;
      void probe();
      if (!timer) timer = setInterval(() => void probe(), pollMs);
    },
    stop() {
      stopped = true;
      if (timer) {
        clearInterval(timer);
        timer = null;
      }
    },
    async checkNow() {
      return probe();
    },
  };
}