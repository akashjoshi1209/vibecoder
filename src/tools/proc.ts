// Node-compatible subprocess helper: spawn + collect stdout/stderr, with the
// process-group kill semantics the tools rely on (timeout / ctrl-c abort).
// Works identically under Bun and Node.
import { spawn, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname } from "node:path";
import { platform } from "node:os";
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
        detached: opts.detached ?? true,
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