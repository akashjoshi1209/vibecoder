// Node-compatible subprocess helper: spawn + collect stdout/stderr, with the
// process-group kill semantics the tools rely on (timeout / ctrl-c abort).
// Works identically under Bun and Node.
import { spawn, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname } from "node:path";
import { platform } from "node:os";
import type { ChildProcess } from "node:child_process";
import { numberSetting } from "../runtime";

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
  /**
   * Opt-in settle grace after a timeout kill, in ms.
   *
   * When > 0 the result waits up to this long for `close` after the tree kill
   * so a clean exit code and fully flushed pipes win over an immediate -1.
   * The timeout remains the contract: if `close` does not arrive, we settle
   * ourselves when the grace expires. 0 (default) preserves the round-2
   * behaviour of settling immediately. Overrides the `settleGraceMs` config
   * value — the config knob is the project-wide default, this is per call.
   */
  settleGraceMs?: number;
}

export interface SpawnCollectResult {
  stdout: string;
  stderr: string;
  exitCode: number;
  timedOut: boolean;
  aborted: boolean;
}

/**
 * Kill a spawned child and everything it started.
 *
 * The POSIX path kills the process group (children are spawned detached, so the
 * child is a group leader and `-pid` reaches the whole tree).
 *
 * Windows has no process groups in that sense: `process.kill(-pid)` throws, the
 * fallback `child.kill()` kills only the immediate child, and any grandchild it
 * started survives. That is not cosmetic. `bash -lc "sleep 30"` dies, but
 * `sleep` keeps the inherited stdout pipe open, so Node never emits `close` and
 * the tool call does not return until the grandchild exits on its own — a
 * 120s timeout that is not honoured, holding an agent step open for two minutes.
 * This was the cause of the long-flaky `bash` suite: a different test failed on
 * each run depending on which child happened to inherit the pipe.
 *
 * `taskkill /T` is the documented way to kill a Windows process tree.
 */
export function killProcessGroup(
  child: { pid?: number; kill: (signal?: NodeJS.Signals) => boolean },
  signal: NodeJS.Signals = "SIGKILL",
): void {
  if (child.pid === undefined || child.pid <= 0) return;
  if (platform() === "win32") {
    try {
      spawnSync("taskkill", ["/pid", String(child.pid), "/T", "/F"], {
        stdio: ["ignore", "ignore", "ignore"],
      });
      // taskkill reports a non-zero status when the pid is already gone; that is
      // a success for our purposes. Still fall through to child.kill() as a
      // belt-and-braces attempt.
    } catch {
      /* fall through */
    }
    try {
      child.kill(signal);
    } catch {
      /* already gone */
    }
    return;
  }
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

/**
 * Kill the process group first (covers grandchildren such as a `sleep` spawned
 * by the shell), then the child itself as a fallback for platforms where
 * process groups are unavailable.
 */
export function killProcessTree(
  child: { pid?: number; kill: (signal?: NodeJS.Signals) => boolean },
  signal: NodeJS.Signals = "SIGKILL",
): void {
  if (child.pid === undefined || child.pid <= 0) return;
  killProcessGroup(child, signal);
  try {
    child.kill(signal);
  } catch {
    // already gone
  }
}

export function killChildGroup(child: SpawnedChild, signal: NodeJS.Signals = "SIGKILL"): void {
  killProcessGroup(child, signal);
}

/** Resolve a command name to an absolute path so spawn succeeds even when the
 *  executable is not on the current PATH (common on Windows where e.g. bash
 *  lives under MSYS2/Git but is not in process.env.PATH). Falls back to the
 *  bare name when no candidate is found. */
export function resolveCommand(cmd: string): string {
  if (cmd.includes("/") || cmd.includes("\\")) return cmd;
  const pathEnv = process.env.PATH ?? "";
  const dirs = pathEnv.split(pathSep).filter(Boolean);
  const exts = [""].concat((process.env.PATHEXT ?? ".EXE;.BAT;.CMD;.CMD;.VBS;.VBE;.JS;.JSE;.WSF;.WSH;.MSC").split(pathSep).map((e) => e.toLowerCase()));
  for (const dir of dirs) {
    const base = join2(dir, cmd);
    for (const ext of exts) {
      const candidate = ext ? base + ext : base;
      if (existsSync(candidate)) return candidate;
    }
  }
  if (platform() !== "win32") {
    const prefixes = ["/usr/bin", "/usr/local/bin", "/bin", "/usr/sbin", "/usr/local/sbin"];
    for (const p of prefixes) {
      const candidate = join2(p, cmd);
      if (existsSync(candidate)) return candidate;
    }
    try {
      const lookedUp = spawnSync("which", [cmd], { stdio: ["ignore", "pipe", "ignore"] });
      if (lookedUp && lookedUp.stdout && existsSync(lookedUp.stdout.toString().trim())) {
        return lookedUp.stdout.toString().trim();
      }
    } catch {
      // which not available
    }
  } else {
    // Windows: check common Git Bash / MSYS2 install locations
    const winPrefixes = [
      "C:\\Users\\Administrator\\AppData\\Local\\hermes\\git\\usr\\bin",
      "C:\\Program Files\\Git\\usr\\bin",
      "C:\\Program Files (x86)\\Git\\usr\\bin",
      "C:\\msys64\\usr\\bin",
      "C:\\msys64\\mingw64\\bin",
      "C:\\Program Files\\Git\\bin",
    ];
    for (const p of winPrefixes) {
      const candidate = join2(p, cmd);
      if (existsSync(candidate)) return candidate;
      // Also try with .exe extension
      const exeCandidate = candidate + ".exe";
      if (existsSync(exeCandidate)) return exeCandidate;
    }
    // Fallback: try cmd /c for shell commands as a last resort
    if (cmd === "bash" || cmd === "sh") {
      // If bash/sh not found, return cmd as-is (let spawn fail with ENOENT)
      // rather than silently substituting cmd — that would mask the real issue
      return cmd;
    }
  }
  // Not found anywhere on PATH or in the well-known prefixes. Hand back the bare
  // name and let spawn surface the real ENOENT instead of guessing.
  return cmd;
}

function join2(a: string, b: string): string {
  if (a.endsWith("/") || a.endsWith("\\")) return a + b;
  return a + "/" + b;
}

const pathSep = process.platform === "win32" ? ";" : ":";

export function spawnCollect(opts: SpawnCollectOptions): Promise<SpawnCollectResult> {
  return new Promise<SpawnCollectResult>((resolvePromise) => {
    let child: ChildProcess | null = null;
    try {
      const resolvedCmd = resolveCommand(opts.cmd[0]);
      child = spawn(resolvedCmd, opts.cmd.length > 1 ? opts.cmd.slice(1) : [], {
        cwd: opts.cwd,
        env: opts.env,
        stdio: ["ignore", "pipe", "pipe"],
        // POSIX: detached makes the child a group leader, which is what lets
        // `process.kill(-pid)` reach the whole tree. Windows has no such
        // groups — taskkill /T is the tree kill — and PowerShell 5.1 under
        // DETACHED_PROCESS silently loses its stdout (and can exit before its
        // -Command finishes), so the default there is attached. Either way the
        // caller can override explicitly.
        detached: opts.detached ?? platform() !== "win32",
      });
    } catch (err: unknown) {
      const msg = err && typeof err === "object" && "message" in err ? String((err as Record<string, unknown>).message) : String(err);
      resolvePromise({ stdout: "", stderr: `spawn error: ${msg}`, exitCode: -1, timedOut: false, aborted: false });
      return;
    }

    let stdout = "";
    let stderr = "";
    child.stdout?.on("data", (d: Buffer) => (stdout += d.toString()));
    child.stderr?.on("data", (d: Buffer) => (stderr += d.toString()));

    let timedOut = false;
    let aborted = false;
    let settled = false;
    let spawnError = "";
    let timer: ReturnType<typeof setTimeout> | null = null;
    let graceTimer: ReturnType<typeof setTimeout> | null = null;

    const settle = (exitCode: number) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      if (graceTimer) clearTimeout(graceTimer);
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
        killProcessTree(child);
        // Return whatever we have now. `close` waits for the stdout/stderr pipes
        // to close, and a surviving grandchild (Windows tree-kill failure, or a
        // process that outlived SIGKILL) would hold them open for as long as it
        // runs — so waiting for `close` is what let a 120s timeout stretch into
        // minutes. The timeout is the contract; honour it whether or not the
        // kernel cooperates.
        //
        // settleGraceMs (opt-in, default 0 = off) is the deliberate exception:
        // a bounded window — timeout + grace, never more — for `close` to land
        // after the kill, so callers that prefer a clean exit code and flushed
        // pipes can ask for it without reintroducing the unbounded wait. If
        // close does not come, we settle ourselves when the grace expires.
        const graceMs = opts.settleGraceMs ?? numberSetting("settleGraceMs", 0, 0);
        if (graceMs > 0) {
          graceTimer = setTimeout(() => settle(-1), graceMs);
          return;
        }
        settle(-1);
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