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
  /** Windows only: pass through to spawn so `cmd.exe /d /s /c` wrappers keep
   *  their argument semantics (needed for .cmd shims like npm.cmd — Node's
   *  CVE-2024-27980 guard rejects spawning them directly). */
  windowsVerbatimArguments?: boolean;
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

/** A long-lived child with line-oriented stdin/stdout — the shape MCP stdio
 *  (and anything else newline-delimited JSON-RPC) needs. spawnCollect is
 *  one-shot; this keeps the child alive between messages. Same process-layer
 *  rules apply: resolveCommand for PATH-less platforms, killProcessTree for
 *  teardown (the CI guard keeps spawn itself inside this file). */
export interface SpawnSessionOptions {
  cmd: string[];
  cwd?: string;
  /** Full environment (ProcessEnv — undefined values mean "omit"). */
  env?: NodeJS.ProcessEnv;
  /** Each line the child writes to stderr (MCP servers log there). */
  onStderr?: (line: string) => void;
}

export interface SpawnSession {
  readonly pid: number | undefined;
  /** False once the child exited or failed to spawn. */
  readonly alive: boolean;
  /** Append one line (a trailing \n) to the child's stdin. False when the pipe is gone. */
  write(line: string): boolean;
  /** Handle one stdout line (newline-delimited; the tail partial line is buffered). */
  onLine(cb: (line: string) => void): void;
  /** Called once on exit — replayed immediately when the child already exited. */
  onExit(cb: (code: number | null) => void): void;
  /** End stdin (lets a well-behaved server exit on EOF), then kill the tree. */
  close(): void;
}

export function spawnSession(opts: SpawnSessionOptions): SpawnSession {
  let child: ChildProcess;
  try {
    child = spawn(resolveCommand(opts.cmd[0]), opts.cmd.slice(1), {
      cwd: opts.cwd,
      env: opts.env,
      stdio: ["pipe", "pipe", "pipe"],
      // Same split as spawnCollect: group leader on POSIX for tree kills;
      // Windows uses taskkill /T.
      detached: platform() !== "win32",
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    opts.onStderr?.(`spawn error: ${msg}`);
    return {
      pid: undefined,
      alive: false,
      write: () => false,
      onLine: () => {},
      onExit: (cb) => cb(null), // already dead — replay immediately
      close: () => {},
    };
  }

  let alive = true;
  let exited = false;
  let exitCode: number | null = null;
  let lineCb: ((line: string) => void) | null = null;
  const exitCbs: Array<(code: number | null) => void> = [];
  let outBuf = "";
  let errBuf = "";
  // Writing to a pipe whose reader is gone (crashed server, ENOENT race)
  // surfaces as a stream 'error' — unhandled, that takes the process down.
  child.stdin?.on("error", () => {});
  child.stdout?.on("error", () => {});

  child.stdout?.on("data", (d: Buffer) => {
    outBuf += d.toString();
    let i: number;
    while ((i = outBuf.indexOf("\n")) !== -1) {
      const line = outBuf.slice(0, i).replace(/\r$/, "");
      outBuf = outBuf.slice(i + 1);
      if (line.trim()) lineCb?.(line);
    }
  });
  child.stderr?.on("data", (d: Buffer) => {
    errBuf += d.toString();
    let i: number;
    while ((i = errBuf.indexOf("\n")) !== -1) {
      const line = errBuf.slice(0, i).replace(/\r$/, "");
      errBuf = errBuf.slice(i + 1);
      if (line.trim()) opts.onStderr?.(line);
    }
  });

  const settle = (code: number | null) => {
    if (exited) return;
    exited = true;
    alive = false;
    exitCode = code;
    for (const cb of exitCbs) {
      try {
        cb(code);
      } catch {
        /* listener errors must not break teardown */
      }
    }
  };
  child.on("close", (code) => settle(code ?? null));
  child.on("error", (err: Error) => {
    opts.onStderr?.(`spawn error: ${err.message}`);
    settle(null);
  });

  return {
    get pid() {
      return child.pid;
    },
    get alive() {
      return alive;
    },
    write(line: string): boolean {
      if (!alive || !child.stdin?.writable) return false;
      try {
        child.stdin.write(line + "\n");
        return true;
      } catch {
        return false;
      }
    },
    onLine(cb) {
      lineCb = cb;
    },
    onExit(cb) {
      if (exited) {
        cb(exitCode);
        return;
      }
      exitCbs.push(cb);
    },
    close() {
      try {
        child.stdin?.end();
      } catch {
        /* already closed */
      }
      if (!exited) killProcessTree(child);
      settle(null);
    },
  };
}

export function spawnCollect(opts: SpawnCollectOptions): Promise<SpawnCollectResult> {
  return new Promise<SpawnCollectResult>((resolvePromise) => {
    let child: ChildProcess | null = null;
    try {
      const resolvedCmd = resolveCommand(opts.cmd[0]);
      child = spawn(resolvedCmd, opts.cmd.length > 1 ? opts.cmd.slice(1) : [], {
        cwd: opts.cwd,
        env: opts.env,
        stdio: ["ignore", "pipe", "pipe"],
        windowsVerbatimArguments: opts.windowsVerbatimArguments,
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