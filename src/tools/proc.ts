// Node-compatible subprocess helper: spawn + collect stdout/stderr, with the
// process-group kill semantics the tools rely on (timeout / ctrl-c abort).
// Works identically under Bun and Node.
import { spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";

export interface SpawnCollectOptions {
  cmd: string[];
  cwd?: string;
  env?: Record<string, string>;
  detached?: boolean;
  /** Hard ceiling in ms; 0 or undefined disables. */
  timeoutMs?: number;
  signal?: AbortSignal;
  /** Called exactly once when the timeout fires (before the kill). */
  onTimeout?: () => void;
}

export interface SpawnCollectResult {
  stdout: string;
  stderr: string;
  exitCode: number;
  timedOut: boolean;
  aborted: boolean;
}

/** Kill the whole process group (works because children are detached/group leaders). */
export function killProcessGroup(
  child: { pid?: number; kill: (signal?: NodeJS.Signals) => boolean },
  signal: NodeJS.Signals = "SIGKILL",
): void {
  if (child.pid === undefined || child.pid <= 0) return;
  try {
    process.kill(-child.pid, signal);
  } catch {
    try {
      child.kill(signal);
    } catch {
      // already gone
    }
  }
}

type SpawnedChild = { pid?: number; kill: (signal?: NodeJS.Signals) => boolean };

export function killChildGroup(child: SpawnedChild, signal: NodeJS.Signals = "SIGKILL"): void {
  killProcessGroup(child, signal);
}

export function spawnCollect(opts: SpawnCollectOptions): Promise<SpawnCollectResult> {
  return new Promise<SpawnCollectResult>((resolvePromise) => {
    const child: ChildProcess = spawn(opts.cmd[0], opts.cmd.slice(1), {
      cwd: opts.cwd,
      env: opts.env,
      stdio: ["ignore", "pipe", "pipe"],
      detached: opts.detached ?? true,
    });

    let stdout = "";
    let stderr = "";
    child.stdout?.on("data", (d: Buffer) => (stdout += d.toString()));
    child.stderr?.on("data", (d: Buffer) => (stderr += d.toString()));

    let timedOut = false;
    let aborted = false;
    let settled = false;
    let spawnError = "";
    let timer: ReturnType<typeof setTimeout> | null = null;

    const settle = (exitCode: number) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      opts.signal?.removeEventListener("abort", onAbort);
      if (spawnError) {
        stderr = (stderr ? stderr + "\n" : "") + `spawn error: ${spawnError}`;
      }
      resolvePromise({ stdout, stderr, exitCode, timedOut, aborted });
    };

    if (opts.timeoutMs && opts.timeoutMs > 0) {
      timer = setTimeout(() => {
        timedOut = true;
        opts.onTimeout?.();
        killProcessGroup(child);
      }, opts.timeoutMs);
    }

    const onAbort = () => {
      aborted = true;
      killProcessGroup(child);
    };
    if (opts.signal?.aborted) onAbort();
    else opts.signal?.addEventListener("abort", onAbort, { once: true });

    child.on("close", (code) => settle(code ?? -1));
    child.on("error", (err: Error) => {
      spawnError = err.message;
      settle(-1);
    });
  });
}