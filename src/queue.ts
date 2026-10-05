// Persistent task queue: tasks captured while offline (or with a plan-mode note)
// are stored here and drained by the daemon / in-app poller once connectivity
// is back. Survives process restarts.
import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, dirname } from "node:path";

export type TaskStatus = "queued" | "running" | "done" | "failed";

export interface QueuedTask {
  id: string;
  userMessage: string;
  /** Optional plan-mode note drafted by the local model while offline. */
  planNote?: string;
  cwd: string;
  sessionId: string;
  systemPrompt: string;
  createdAt: number;
  status: TaskStatus;
  result?: string;
  error?: string;
  /** Pid of the runner holding the task (locks it against concurrent runners). */
  runnerPid?: number;
  startedAt?: number;
  finishedAt?: number;
  /** Number of times this task has been attempted (starts at 1, incremented on each retry). */
  attempts?: number;
  /** Unix ms timestamp after which the task may be retried (blocks rapid re-queue loops). */
  retryAfter?: number;
}

let _root: string | null = null;
let FILE_OVERRIDE: string | null = null;

function expandHome(p: string): string {
  if (p === "~") return homedir();
  if (p.startsWith("~/")) return join(homedir(), p.slice(2));
  return p;
}

function root(): string {
  if (_root) return _root;
  const envDir = process.env.VIBECODER_SESSION_DIR;
  _root = envDir || join(homedir(), ".vibecoder");
  mkdirSync(_root, { recursive: true });
  return _root;
}

export function resetQueueRoot(): void {
  _root = null;
  FILE_OVERRIDE = null;
}

export function setQueueFileOverride(path?: string): void {
  FILE_OVERRIDE = path ? expandHome(path) : null;
  _root = null;
}

export function queueFile(): string {
  if (FILE_OVERRIDE) return FILE_OVERRIDE;
  return join(root(), "queue.json");
}

function read(): QueuedTask[] {
  const f = queueFile();
  if (!existsSync(f)) return [];
  try {
    const arr = JSON.parse(readFileSync(f, "utf8"));
    return Array.isArray(arr) ? arr : [];
  } catch {
    return [];
  }
}

function write(tasks: QueuedTask[]): void {
  mkdirSync(dirname(queueFile()), { recursive: true });
  writeFileSync(queueFile(), JSON.stringify(tasks, null, 2));
}

function newId(): string {
  return `task-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

// ---------------------------------------------------------------------------
// Cross-process locking. The queue file is plain JSON, so concurrent daemons /
// repls could read-modify-write it non-atomically. We serialize critical
// sections with an exclusive lock directory (atomic mkdir). Stale locks (owner
// died without cleaning up) are broken after a grace period; we never hold a
// lock long enough for that to be a real risk.
// ---------------------------------------------------------------------------

const LOCK_STALE_MS = 2_000;
const LOCK_ACQUIRE_TIMEOUT_MS = 5_000;

function lockPath(): string {
  return `${queueFile()}.lock`;
}

function syncSleep(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function acquireLock(): void {
  const lp = lockPath();
  const deadline = Date.now() + LOCK_ACQUIRE_TIMEOUT_MS;
  for (;;) {
    try {
      mkdirSync(lp);
      return;
    } catch {
      // lock dir already exists — retry below
    }
    try {
      if (Date.now() - statSync(lp).mtimeMs > LOCK_STALE_MS && existsSync(lp)) {
        rmSync(lp, { recursive: true, force: true });
        continue;
      }
    } catch {
      // lock vanished between mkdir attempt and stat — retry
    }
    if (Date.now() > deadline) {
      throw new Error("task queue is busy (lock held) — try again");
    }
    syncSleep(25);
  }
}

function releaseLock(): void {
  try {
    rmSync(lockPath(), { recursive: true, force: true });
  } catch {
    // already gone
  }
}

function withLock<T>(fn: () => T): T {
  acquireLock();
  try {
    return fn();
  } finally {
    releaseLock();
  }
}

export function enqueueTask(input: {
  userMessage: string;
  cwd: string;
  sessionId: string;
  systemPrompt: string;
  planNote?: string;
}): QueuedTask {
  const task: QueuedTask = {
    id: newId(),
    userMessage: input.userMessage,
    planNote: input.planNote,
    cwd: input.cwd,
    sessionId: input.sessionId,
    systemPrompt: input.systemPrompt,
    createdAt: Date.now(),
    status: "queued",
  };
  return withLock(() => {
    const tasks = read();
    tasks.push(task);
    write(tasks);
    return task;
  });
}

export function listTasks(status?: TaskStatus): QueuedTask[] {
  const all = read();
  const out = status ? all.filter((t) => t.status === status) : all;
  return out.sort((a, b) => b.createdAt - a.createdAt);
}

export function loadTask(id: string): QueuedTask | null {
  return read().find((t) => t.id === id) ?? null;
}

export function nextQueued(): QueuedTask | null {
  const tasks = read();
  const now = Date.now();
  const candidates = tasks
    .filter((t) => {
      if (t.status === "queued") return true;
      if (t.status === "running" && t.runnerPid && !processExists(t.runnerPid)) return true;
      // Failed tasks become eligible for retry once retryAfter passes and
      // attempts is under the cap (5 attempts total).
      if (t.status === "failed" && t.attempts !== undefined && t.attempts < 5) {
        if (!t.retryAfter || now >= t.retryAfter) return true;
      }
      return false;
    })
    .sort((a, b) => a.createdAt - b.createdAt);
  return candidates[0] ?? null;
}

function processExists(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function update(id: string, patch: Partial<QueuedTask>): QueuedTask | null {
  const tasks = read();
  const idx = tasks.findIndex((t) => t.id === id);
  if (idx === -1) return null;
  tasks[idx] = { ...tasks[idx], ...patch };
  write(tasks);
  return tasks[idx];
}

/**
 * Mark a task as being executed by this process (claims it exclusively).
 * Returns null when the task is already claimed by a live runner process —
 * the caller should treat that as "claimed elsewhere" instead of racing it.
 */
export function claimTask(id: string): QueuedTask | null {
  return withLock(() => {
    const tasks = read();
    const t = tasks.find((x) => x.id === id);
    if (!t) return null;
    if (t.status === "running" && t.runnerPid && processExists(t.runnerPid)) return null;
    t.status = "running";
    t.runnerPid = process.pid;
    t.startedAt = Date.now();
    write(tasks);
    return { ...t };
  });
}

/** Put a task back in the queue immediately, regardless of any retry backoff.
 *  Used when a runner is killed or a task is re-driven by hand: unlike
 *  markTaskRetry it clears retryAfter so nextQueued() picks it up right away. */
export function requeueTask(id: string): QueuedTask | null {
  return withLock(() =>
    update(id, {
      status: "queued",
      runnerPid: undefined,
      error: undefined,
      result: undefined,
      retryAfter: undefined,
    }),
  );
}

export function markTaskDone(id: string, result: string): QueuedTask | null {
  return withLock(() => update(id, { status: "done", result, finishedAt: Date.now(), runnerPid: undefined, error: undefined }));
}

export function markTaskFailed(id: string, error: string, attempts?: number, retryAfter?: number): QueuedTask | null {
  return withLock(() => update(id, { status: "failed", error, finishedAt: Date.now(), runnerPid: undefined, attempts, retryAfter }));
}

export function markTaskRetry(id: string, attempts: number): QueuedTask | null {
  const now = Date.now();
  const backoffMs = Math.min(300_000, 30_000 * Math.pow(2, attempts - 1)); // 30s base, doubling, cap 5min
  // Keep status "failed", not "queued": nextQueued() only honours retryAfter for
  // failed tasks, so a queued task would be picked up again immediately and the
  // backoff would never take effect.
  return withLock(() => update(id, {
    status: "failed",
    runnerPid: undefined,
    error: undefined,
    attempts,
    retryAfter: now + backoffMs,
  }));
}

/** Return queued/running-after-crash tasks back to "queued" (on daemon startup).
 *  Also resurrect failed tasks whose retry window has passed, up to the attempt cap. */
export function resetStale(): number {
  return withLock(() => {
    const tasks = read();
    const now = Date.now();
    let n = 0;
    for (const t of tasks) {
      if (t.status === "running") {
        if (!t.runnerPid || !processExists(t.runnerPid)) {
          n++;
          t.status = "queued";
          t.runnerPid = undefined;
          t.retryAfter = undefined;
        }
      }
      if (t.status === "queued") {
        t.runnerPid = undefined;
        if (t.attempts !== undefined && t.attempts >= 5) {
          t.status = "failed"; // exhausted — leave as failed
          t.retryAfter = undefined;
        }
      }
      if (t.status === "failed" && t.attempts !== undefined && t.attempts < 5) {
        if (!t.retryAfter || now >= t.retryAfter) {
          n++;
          t.status = "queued";
          t.retryAfter = undefined;
        }
      }
    }
    write(tasks);
    return n;
  });
}

export function deleteTask(id: string): boolean {
  return withLock(() => {
    const tasks = read();
    const next = tasks.filter((t) => t.id !== id);
    if (next.length === tasks.length) return false;
    write(next);
    return true;
  });
}