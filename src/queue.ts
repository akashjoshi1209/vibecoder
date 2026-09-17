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
  const candidates = tasks
    .filter((t) => t.status === "queued" || (t.status === "running" && t.runnerPid && !processExists(t.runnerPid)))
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

export function markTaskDone(id: string, result: string): QueuedTask | null {
  return withLock(() => update(id, { status: "done", result, finishedAt: Date.now(), runnerPid: undefined, error: undefined }));
}

export function markTaskFailed(id: string, error: string): QueuedTask | null {
  return withLock(() => update(id, { status: "failed", error, finishedAt: Date.now(), runnerPid: undefined }));
}

export function requeueTask(id: string): QueuedTask | null {
  return withLock(() => update(id, { status: "queued", runnerPid: undefined, error: undefined }));
}

/** Return queued/running-after-crash tasks back to "queued" (on daemon startup). */
export function resetStale(): number {
  return withLock(() => {
    const tasks = read();
    let n = 0;
    for (const t of tasks) {
      if (t.status === "running") {
        if (!t.runnerPid || !processExists(t.runnerPid)) {
          n++;
          t.status = "queued";
          t.runnerPid = undefined;
        }
      }
      if (t.status === "queued" && t.runnerPid) t.runnerPid = undefined;
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