// Restore points ("checkpoints") for a long agent run.
//
// The problem
//
// A run is all-or-nothing. `maxSteps` defaults to 40, and when a 40-step task
// runs out of steps, or the terminal dies, or you Ctrl-C at step 39, the
// transcript is resumable but the filesystem is not. `--resume` replays the
// conversation and hands the model its own history of half-finished edits with
// no idea which ones actually landed. Worse, the failure modes that need a
// restore point are exactly the ones where you are least able to reconstruct
// what went wrong: 40 steps of edits, then a wrong turn.
//
// Two layers, because two layers are needed
//
// 1. Git, when the workspace is a repo. `git stash create` builds a commit
//    object for the current working-tree state and prints its SHA without
//    touching the working tree, the index, HEAD, or any ref. That is precisely
//    a restore point: nothing moves, and `git stash apply <sha>` (or
//    `git checkout <sha> -- .`) puts it back. Nothing here rewrites the user's
//    history or leaves a stash entry to clean up.
//
// 2. The change log, always. Every write_file / edit_file stashed its pre-image
//    (see changelog.ts). That is a restore point even with no git at all, and it
//    is finer-grained than one: /revert can undo a single file rather than the
//    whole tree.
//
// So a checkpoint records which files are dirty (and their SHAs) plus, under
// git, a stash-create SHA. Restoring uses the pre-images, so a checkpoint is
// restorable even if the git object is later garbage-collected.
import { createHash } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import type { Dirent } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { spawnCollect } from "./tools/proc";

/** Untracked files above this size are recorded but not restorable. */
const MAX_BLOB_BYTES = 16 * 1024 * 1024;

export interface CheckpointFile {
  /** Absolute path. */
  path: string;
  /** Content hash, for drift detection. */
  sha: string;
  /** True when git considered the file untracked at checkpoint time. */
  untracked: boolean;
  /** Where the content is stashed, for untracked files. `git stash create`
   *  deliberately leaves untracked files out of its object (it has no `-u`
   *  equivalent), so their bytes have to be kept separately or a restore
   *  silently cannot bring them back. */
  blob: string | null;
}

export interface Checkpoint {
  /** Short id the user types to restore. */
  id: string;
  /** ISO timestamp. */
  ts: string;
  /** Session the checkpoint belongs to. */
  sessionId: string;
  label: string;
  /** Absolute workspace root at the time. */
  cwd: string;
  /** `git stash create` SHA, or null when not a repo / git failed. */
  gitSha: string | null;
  /** Dirty files with their content SHA, so drift since the checkpoint is
   *  detectable and a partial restore is possible. */
  files: CheckpointFile[];
  /** True when the workspace was already dirty before this checkpoint. */
  alreadyDirty: boolean;
}

function dataRoot(): string {
  const env = process.env.VIBECODER_SESSION_DIR;
  return env || join(homedir(), ".vibecoder");
}

function checkpointsDir(): string {
  return join(dataRoot(), "checkpoints");
}

function indexFile(): string {
  return join(checkpointsDir(), "index.json");
}

/** The checkpoint index location, for `vibecoder doctor`. */
export function indexPath(): string {
  return indexFile();
}

/** True if `dir` is inside a git work tree. */
export async function isGitRepo(dir: string): Promise<boolean> {
  const res = await spawnCollect({
    cmd: ["git", "-C", dir, "rev-parse", "--is-inside-work-tree"],
    timeoutMs: 5_000,
  });
  return res.exitCode === 0 && res.stdout.trim() === "true";
}

/**
 * Files git considers modified or untracked, with their content SHA.
 *
 * `--porcelain -z` output is NUL-separated with a fixed-width two-character
 * status prefix ("XY <path>\0", and for renames "XY <new>\0<old>\0"), so the
 * path is taken by offset rather than by splitting on whitespace — which is what
 * keeps paths containing spaces or quotes intact.
 *
 * Synchronous on purpose: this is also the comparison path for
 * `diffAgainstCheckpoint`, which is a plain data query with no reason to be
 * async, and duplicating the parser in two shapes is how the two drift apart.
 */
interface StatusEntry {
  path: string;
  untracked: boolean;
}

function statusEntries(cwd: string): StatusEntry[] {
  const res = spawnSync(
    "git",
    ["-C", cwd, "status", "--porcelain=v1", "-z", "--untracked-files=all"],
    { encoding: "utf8", timeout: 15_000, windowsHide: true },
  );
  if (res.status !== 0) return [];
  const fields = (res.stdout ?? "").split("\0").filter((f) => f.length > 0);
  const out: StatusEntry[] = [];
  for (let i = 0; i < fields.length; i++) {
    const field = fields[i];
    if (field.length < 4) continue;
    const status = field.slice(0, 2);
    const path = field.slice(3);
    // Renames/copies put the original path in the following NUL field.
    if (status[0] === "R" || status[0] === "C" || status[1] === "R" || status[1] === "C") i++;
    out.push({ path: resolve(cwd, path), untracked: status === "??" });
  }
  return out;
}

function dirtyFiles(cwd: string): CheckpointFile[] {
  const entries = statusEntries(cwd);
  // Outside a repo, `git status` fails and returns nothing. Treating that as
  // "clean" would mean a checkpoint in a plain directory silently records zero
  // files — and then /restore reports success while doing nothing, which is the
  // worst possible outcome for a safety feature. Fall back to a filesystem scan.
  if (entries.length === 0 && !isGitDirSync(cwd)) return scanFiles(cwd);
  return entries.map((e) => ({ ...e, sha: fileSha(e.path), blob: null }));
}

function isGitDirSync(cwd: string): boolean {
  // `git rev-parse --git-dir` so a worktree or subdirectory resolves correctly,
  // rather than looking for a literal .git folder in the given path.
  const res = spawnSync("git", ["-C", cwd, "rev-parse", "--git-dir"], {
    encoding: "utf8",
    timeout: 5_000,
    windowsHide: true,
  });
  return res.status === 0;
}

const SCAN_IGNORED = new Set([".git", "node_modules", ".vibecoder", "dist", "build", ".next", "target", "__pycache__"]);

/** Every file under `cwd`, for a workspace with no git to ask. */
function scanFiles(cwd: string): CheckpointFile[] {
  const out: CheckpointFile[] = [];
  const walk = (dir: string, depth: number): void => {
    // Bounded: a checkpoint on a huge tree should not become a filesystem crawl
    // that takes minutes and stashes gigabytes.
    if (depth > 6 || out.length >= 5_000) return;
    let items: Dirent[];
    try {
      items = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const item of items) {
      if (SCAN_IGNORED.has(item.name)) continue;
      const full = join(dir, item.name);
      if (item.isDirectory()) walk(full, depth + 1);
      else if (item.isFile()) out.push({ path: full, sha: fileSha(full), untracked: true, blob: null });
    }
  };
  walk(cwd, 0);
  return out;
}

function fileSha(abs: string): string {
  try {
    return createHash("sha256").update(readFileSync(abs)).digest("hex").slice(0, 16);
  } catch {
    // Unreadable, deleted, or a directory. Recorded so drift is still visible.
    return "unreadable";
  }
}

/**
 * Index file shape.
 *
 * `lastId` is stored rather than derived from the entry count. Deriving it
 * (`length + 1`) means that dropping a checkpoint frees its number for reuse, so
 * a later `/restore 13` silently resolves to a different checkpoint than the one
 * the user dropped. A counter that only ever goes up makes an id unambiguous for
 * as long as the index exists.
 */
interface Index {
  lastId: number;
  entries: Checkpoint[];
}

function readIndexFile(): Index {
  const f = indexFile();
  if (!existsSync(f)) return { lastId: 0, entries: [] };
  try {
    const parsed = JSON.parse(readFileSync(f, "utf8")) as Partial<Index>;
    const entries = Array.isArray(parsed?.entries) ? (parsed.entries as Checkpoint[]) : [];
    const fromEntries = entries.reduce((m, c) => Math.max(m, Number(c.id) || 0), 0);
    return {
      // Take the higher of the stored counter and the ids actually present, so a
      // hand-edited or truncated file cannot resurrect a reused id.
      lastId: Math.max(Number(parsed?.lastId) || 0, fromEntries),
      entries,
    };
  } catch {
    return { lastId: 0, entries: [] };
  }
}

function readIndex(): Checkpoint[] {
  return readIndexFile().entries;
}

function writeIndexFile(index: Index): void {
  mkdirSync(checkpointsDir(), { recursive: true });
  writeFileSync(indexFile(), JSON.stringify(index, null, 2), "utf8");
}

/**
 * Create a restore point.
 *
 * Under git, `git stash create` is the interesting part: it writes a commit
 * object but does not update HEAD, the index, or refs/stash. Nothing in the
 * user's repo moves, and no entry accumulates in `git stash list` to be tidied
 * up later — the SHA is just a dangling object until we use or prune it.
 *
 * Under no git, the change log already holds every pre-image, so the
 * checkpoint records the file list only and /revert does the work.
 */
export async function createCheckpoint(params: {
  sessionId: string;
  cwd: string;
  label?: string;
}): Promise<Checkpoint> {
  const cwd = resolve(params.cwd);
  const label = (params.label ?? "").trim();
  const gitRepo = await isGitRepo(cwd);

  let gitSha: string | null = null;
  if (gitRepo) {
    const res = await spawnCollect({
      cmd: ["git", "-C", cwd, "stash", "create", label ? `vibecoder checkpoint: ${label}` : "vibecoder checkpoint"],
      timeoutMs: 30_000,
    });
    const sha = res.stdout.trim();
    // An empty SHA means there was nothing to stash (clean tree) — not an error.
    gitSha = res.exitCode === 0 && /^[0-9a-f]{40}$/.test(sha) ? sha : null;
  }

  const files = dirtyFiles(cwd);
  // Stash the content of untracked files. `git stash create` leaves them out of
  // its object by design, so without this a restore would bring back modified
  // tracked files and silently skip every new file the agent created — which is
  // precisely the case a restore point is for.
  for (const f of files) {
    if (f.untracked) f.blob = stashBlob(f.path);
  }
  const index = readIndexFile();
  const id = String(++index.lastId);
  const cp: Checkpoint = {
    id,
    ts: new Date().toISOString(),
    sessionId: params.sessionId,
    label,
    cwd,
    gitSha,
    files,
    alreadyDirty: files.length > 0,
  };
  index.entries.push(cp);
  // Keep the most recent 50 entries; this is a convenience trail, not an
  // archive. lastId is deliberately not trimmed with them.
  index.entries = index.entries.slice(-50);
  writeIndexFile(index);
  return cp;
}

/** Content-addressed copy of one file, for untracked-file restore. */
function stashBlob(abs: string): string | null {
  try {
    const st = statSync(abs);
    if (!st.isFile() || st.size > MAX_BLOB_BYTES) return null;
    const buf = readFileSync(abs);
    const sha = createHash("sha256").update(buf).digest("hex");
    const name = `${sha}.blob`;
    const dest = join(blobDir(), name);
    if (!existsSync(dest)) {
      mkdirSync(blobDir(), { recursive: true });
      const tmp = `${dest}.${process.pid}.tmp`;
      writeFileSync(tmp, buf);
      copyFileSync(tmp, dest);
      try { unlinkSync(tmp); } catch { /* best effort */ }
    }
    return name;
  } catch {
    // A directory, an unreadable file, or something enormous. Reported as not
    // restorable rather than pretending the checkpoint is complete.
    return null;
  }
}

function blobDir(): string {
  return join(checkpointsDir(), "blobs");
}

export function listCheckpoints(sessionId?: string): Checkpoint[] {
  const all = readIndex();
  return sessionId ? all.filter((c) => c.sessionId === sessionId) : all;
}

export function getCheckpoint(id: string, sessionId?: string): Checkpoint | null {
  const want = id.trim();
  return (
    listCheckpoints(sessionId).find((c) => c.id === want) ??
    // Unqualified ids may also match the most recent checkpoint overall, so
    // /restore 3 works even after switching sessions.
    listCheckpoints().find((c) => c.id === want) ??
    null
  );
}

/** What has moved since a checkpoint was taken. */
export interface DriftReport {
  id: string;
  clean: boolean;
  /** Files that existed at both points with different content. */
  drifted: string[];
  /** Files that appeared after the checkpoint. */
  added: string[];
  /** Files that disappeared after the checkpoint. */
  removed: string[];
}

/**
 * Compare the workspace to a checkpoint without changing anything.
 *
 * The three buckets answer different questions, and the distinction matters
 * because they imply different things when you press /restore:
 *
 *   drifted — present at both points, content differs. Restoring overwrites.
 *   added   — did not exist at the checkpoint. Restoring leaves it alone.
 *   removed — existed at the checkpoint, gone now. Restoring brings it back.
 *
 * "Removed" is tested against the filesystem rather than against git's status,
 * because git keeps reporting a deleted tracked file as dirty (" D path") — so
 * comparing status lists would classify a deletion as a content change and say
 * nothing about the fact that the file needs to come back.
 */
export function diffAgainstCheckpoint(cp: Checkpoint): DriftReport {
  const now = dirtyFiles(cp.cwd);
  const thenMap = new Map(cp.files.map((f) => [f.path, f.sha]));
  const nowMap = new Map(now.map((f) => [f.path, f.sha]));

  const removed = cp.files.filter((f) => !existsSync(f.path)).map((f) => f.path);
  const drifted = now
    .filter((f) => existsSync(f.path) && thenMap.has(f.path) && thenMap.get(f.path) !== f.sha)
    .map((f) => f.path);
  const added = now.filter((f) => !thenMap.has(f.path)).map((f) => f.path);

  const clean = drifted.length === 0 && added.length === 0 && removed.length === 0;
  return { id: cp.id, clean, drifted, added, removed };
}

/**
 * Apply a checkpoint back onto the working tree.
 *
 * Uses `git checkout <object> -- <paths>` rather than `git stash apply`.
 *
 * `git stash apply` is the obvious choice and it is the wrong one: it refuses
 * with "Your local changes to the following files would be overwritten by merge"
 * whenever the working tree is dirty. But a dirty tree is the *only* situation in
 * which anyone wants a restore — restoring a checkpoint after the agent has done
 * nothing means there was nothing to undo. So `stash apply` fails precisely when
 * it is needed, and succeeds only in the case where the user had no reason to
 * press the button. `checkout <object> -- <paths>` is the path-scoped form of
 * "put these files back as they were" and overwrites unconditionally, which is
 * the intent, confirmed by the caller after a drift report.
 *
 * Untracked files are restored from the checkpoint's own blob store, because
 * `git stash create` omits them from its object.
 *
 * Nothing outside `cp.files` is touched: HEAD, the index, and unrelated files all
 * stay exactly as they are.
 */
export type RestoreResult =
  | { ok: true; restored: string[]; unrecoverable: string[] }
  | { ok: false; error: string; hint: string };

export async function restoreCheckpoint(cp: Checkpoint): Promise<RestoreResult> {
  const tracked = cp.files.filter((f) => !f.untracked);
  const untracked = cp.files.filter((f) => f.untracked && f.blob);
  const restored: string[] = [];
  const unrecoverable: string[] = [];

  if (tracked.length) {
    if (!cp.gitSha) {
      return {
        ok: false,
        error: `checkpoint #${cp.id} recorded ${tracked.length} tracked file(s) but has no git object`,
        hint: "the git object was pruned or gc'd. Use /revert to undo this session's writes, or recover the content from your own editor history.",
      };
    }
    // Positional pathspec after `--` so a filename beginning with `-` cannot be
    // read as an option.
    const pathspecs = tracked.map((f) => relative(cp.cwd, f.path) || f.path);
    const res = await spawnCollect({
      cmd: ["git", "-C", cp.cwd, "checkout", cp.gitSha, "--", ...pathspecs],
      timeoutMs: 120_000,
    });
    if (res.exitCode !== 0) {
      const detail = [res.stdout.trim(), res.stderr.trim()].filter(Boolean).join("\n");
      return {
        ok: false,
        error: detail || `git checkout exited ${res.exitCode}`,
        hint: "nothing was restored. Resolve the conflict by hand, or use /revert to undo just this session's writes.",
      };
    }
    restored.push(...tracked.map((f) => f.path));
  }

  for (const f of untracked) {
    try {
      const src = join(blobDir(), f.blob!);
      if (!existsSync(src)) {
        unrecoverable.push(f.path);
        continue;
      }
      mkdirSync(dirname(f.path), { recursive: true });
      copyFileSync(src, f.path);
      restored.push(f.path);
    } catch {
      unrecoverable.push(f.path);
    }
  }
  for (const f of cp.files) {
    // Recorded but not restorable (over the blob cap, or a directory).
    if (f.untracked && !f.blob) unrecoverable.push(f.path);
  }

  return { ok: true, restored, unrecoverable };
}

/**
 * Delete a checkpoint.
 *
 * The `git stash create` object is intentionally left to git's own gc: deleting
 * it here would require plumbing (`git update-ref -d` on a dangling object does
 * nothing) and an unreferenced object costs nothing but disk. The index entry is
 * what the user can see and wants gone.
 */
export function deleteCheckpoint(id: string, sessionId?: string): boolean {
  const index = readIndexFile();
  const next = index.entries.filter(
    (c) => c.id !== id.trim() || (sessionId !== undefined && c.sessionId !== sessionId),
  );
  if (next.length === index.entries.length) return false;
  index.entries = next;
  writeIndexFile(index);
  return true;
}

export function describeCheckpoint(cp: Checkpoint): string {
  const lines = [
    `  #${cp.id}  ${cp.ts}${cp.label ? `  ${cp.label}` : ""}`,
    `       ${cp.files.length} dirty file${cp.files.length === 1 ? "" : "s"}` +
      (cp.gitSha ? `  git object ${cp.gitSha.slice(0, 10)}` : "  (no git object — restore via /revert)"),
  ];
  for (const f of cp.files.slice(0, 20)) lines.push(`         ${f.path.slice(cp.cwd.length + 1)}  ${f.sha}`);
  if (cp.files.length > 20) lines.push(`         … and ${cp.files.length - 20} more`);
  return lines.join("\n");
}