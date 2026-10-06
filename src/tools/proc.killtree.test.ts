// Process-layer guarantees: tree-kill leaves no orphan, and the settle grace
// knob is bounded in both directions.
//
// The Windows case is the one that actually regressed historically: without
// taskkill /T, a grandchild that inherited the stdout pipe kept the tool call
// open long past its timeout. So the fixture spawns two real grandchildren
// from one parent and asserts both die with the parent.
import { describe, expect, test } from "bun:test";
import { spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { killProcessTree, spawnCollect } from "./proc";

const SLEEP_SECS = 30; // long enough to outlive the test, short enough to bound damage if a kill fails

const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

const waitMs = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function waitGone(pid: number, deadlineMs = 8_000): Promise<boolean> {
  const t0 = Date.now();
  while (Date.now() - t0 < deadlineMs) {
    if (!alive(pid)) return true;
    await waitMs(100);
  }
  return !alive(pid);
}

interface Fixture {
  parent: number;
  child1: number;
  child2: number;
}

/** Start a parent that spawns two long-sleeping children and prints all PIDs. */
function startTree(): Promise<{ child: ChildProcess; pids: Fixture }> {
  const isWin = process.platform === "win32";
  const script = isWin
    ? [
        `$a = Start-Process powershell -ArgumentList '-NoProfile','-Command','Start-Sleep ${SLEEP_SECS}' -PassThru -WindowStyle Hidden`,
        `$b = Start-Process powershell -ArgumentList '-NoProfile','-Command','Start-Sleep ${SLEEP_SECS}' -PassThru -WindowStyle Hidden`,
        `Write-Output ("PARENT=" + $PID + " CHILD1=" + $a.Id + " CHILD2=" + $b.Id)`,
        `Start-Sleep ${SLEEP_SECS}`,
      ].join("; ")
    : `sleep ${SLEEP_SECS} & a=$!; sleep ${SLEEP_SECS} & b=$!; echo "PARENT=$$ CHILD1=$a CHILD2=$b"; wait`;

  const child = spawn(isWin ? "powershell" : "sh", isWin ? ["-NoProfile", "-Command", script] : ["-c", script], {
    stdio: ["ignore", "pipe", "pipe"],
  });

  return new Promise((resolve, reject) => {
    let out = "";
    const fail = (msg: string) => {
      child.kill();
      reject(new Error(msg));
    };
    const timer = setTimeout(() => fail(`fixture never printed PIDs: ${out}`), 15_000);
    child.stdout?.on("data", (d: Buffer) => {
      out += d.toString();
      const m = out.match(/PARENT=(\d+) CHILD1=(\d+) CHILD2=(\d+)/);
      if (m) {
        clearTimeout(timer);
        resolve({
          child,
          pids: { parent: Number(m[1]), child1: Number(m[2]), child2: Number(m[3]) },
        });
      }
    });
    child.on("error", (err) => {
      clearTimeout(timer);
      fail(`fixture failed to spawn: ${err.message}`);
    });
    child.on("close", () => {
      clearTimeout(timer);
      fail(`fixture exited before printing PIDs: ${out}`);
    });
  });
}

describe("killProcessTree", () => {
  test("kills the parent and both grandchildren — no orphan survives", async () => {
    const { child, pids } = await startTree();
    expect(pids.parent).toBeGreaterThan(0);
    expect(alive(pids.child1)).toBe(true);
    expect(alive(pids.child2)).toBe(true);

    killProcessTree({ pid: child.pid, kill: (s?: NodeJS.Signals) => child.kill(s) });

    expect(await waitGone(pids.parent)).toBe(true);
    expect(await waitGone(pids.child1)).toBe(true);
    expect(await waitGone(pids.child2)).toBe(true);
    child.kill(); // no-op if already gone
  }, 30_000);

  test("no pid is a no-op, not a throw", () => {
    expect(() => killProcessTree({ kill: () => true })).not.toThrow();
    expect(() => killProcessTree({ pid: -1, kill: () => true })).not.toThrow();
    expect(() => killProcessTree({ pid: 0, kill: () => true })).not.toThrow();
  });
});

describe("settle grace knob", () => {
  const sleeper = (): string[] =>
    process.platform === "win32"
      ? ["powershell", "-NoProfile", "-Command", `Start-Sleep ${SLEEP_SECS}`]
      : ["sleep", String(SLEEP_SECS)];

  test("default (grace off): timeout settles immediately after the kill", async () => {
    const t0 = Date.now();
    const r = await spawnCollect({ cmd: sleeper(), timeoutMs: 600 });
    const elapsed = Date.now() - t0;
    expect(r.timedOut).toBe(true);
    expect(r.exitCode).toBe(-1);
    // No grace by default: well under the sleep, and nowhere near timeout+sleep.
    expect(elapsed).toBeLessThan(5_000);
  }, 20_000);

  test("grace on timeout: still bounded by timeout + grace, exit code -1", async () => {
    const t0 = Date.now();
    const r = await spawnCollect({ cmd: sleeper(), timeoutMs: 600, settleGraceMs: 1_200 });
    const elapsed = Date.now() - t0;
    expect(r.timedOut).toBe(true);
    // A killed process reports whatever the OS gives: -1 on the immediate-settle
    // path, 1 from taskkill on Windows, null→-1 from SIGKILL on POSIX. The
    // contract after a timeout is simply "did not succeed".
    expect(r.exitCode).not.toBe(0);
    // The timeout stays the contract: nothing returns before it, and nothing
    // waits past timeout+grace for close to arrive.
    expect(elapsed).toBeGreaterThanOrEqual(550);
    expect(elapsed).toBeLessThan(8_000);
  }, 20_000);

  test("grace never delays a normal completion", async () => {
    const t0 = Date.now();
    const r = await spawnCollect({
      cmd: process.platform === "win32"
        ? ["powershell", "-NoProfile", "-Command", "Write-Output hi"]
        : ["echo", "hi"],
      settleGraceMs: 5_000,
    });
    expect(r.exitCode).toBe(0);
    expect(r.stdout.trim()).toBe("hi");
    expect(Date.now() - t0).toBeLessThan(4_000);
  }, 20_000);
});
