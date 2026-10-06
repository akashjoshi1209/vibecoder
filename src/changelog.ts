// Per-session record of every file the agent modified, with the pre-image kept
// so the change can be inspected and undone.
//
// Why this exists
//
// There is already an append-only ledger (self-edit.ts) but it covers exactly
// two files — config.json and .env — because that is all self-editing needed.
// Everything else the agent writes was invisible: after a 40-step task you
// could not answer "which files did it touch" without scrolling back through
// the transcript, and /undo-self-edits would not restore a source file.
//
// So this is the general case of the same idea: a change log for all writes,
// plus a pre-image store so `revert` is a real restore rather than a report.
//
// Storage
//   ~/.vibecoder/changes.jsonl   append-only log, one JSON object per change
//   ~/.vibecoder/undo/<sha>.bak  pre-image content, content-addressed so
//                                repeated edits to one file do not duplicate it
//
// The log and the store are protected from agent writes (see isChangeStorePath)
// for the same reason the self-edit ledger is: an agent that can rewrite its own
// audit trail has no audit trail.
import { createHash } from "node:crypto";
import {
  appendFileSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

export const CHANGE_LOG_NAME = "changes.jsonl";
const UNDO_DIR_NAME = "undo";

/** Pre-images larger than this are recorded by size only — restoring them would
 *  cost more disk than the change is worth, and nobody reverts a binary. */
const MAX_UNDO_BYTES = 512 * 1024;

export interface ChangeEntry {
  ts: string;
  sessionId: string;
  tool: string;
  /** Absolute path as resolved by the tool. */
  path: string;
  /** Path relative to the session cwd when possible, for display. */
  rel: string;
  beforeSha: string;
  afterSha: string;
  /** False when the file did not exist before (i.e. the agent created it). */
  existedBefore: boolean;
  /** Filename inside the undo store, or null when too large / unreadable. */
  undoFile: string | null;
  beforeBytes: number;
  afterBytes: number;
  /** Free-form note, e.g. "replaced 1 occurrence". */
  note: string;
}

/** Notes that are not file mutations (git commits, pushes) so the timeline is
 *  complete. They carry no pre-image and cannot be reverted. */
export interface NoteEntry {
  ts: string;
  sessionId: string;
  tool: string;
  note: string;
}

export type ChangeRecord = ChangeEntry | NoteEntry;

function dataRoot(): string {
  const env = process.env.VIBECODER_SESSION_DIR;
  return env || join(homedir(), ".vibecoder");
}

export function changeLogPath(): string {
  return join(dataRoot(), CHANGE_LOG_NAME);
}

export function undoDir(): string {
  return join(dataRoot(), UNDO_DIR_NAME);
}

/** True for the log and the undo store, so file tools refuse to write them. */
export function isChangeStorePath(abs: string): boolean {
  const a = resolve(abs);
  if (a === resolve(changeLogPath())) return true;
  // sep, not "/": on Windows the path separator is a backslash, so a hardcoded
  // slash made every containment check miss and left the undo store writable.
  const dir = resolve(undoDir());
  return a === dir || a.startsWith(dir + sep);
}

export function shaOf(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

/** The id of the session currently being recorded, set once by the REPL. */
let currentSession = "";
export function setChangeSession(id: string): void {
  currentSession = id;
}
export function changeSession(): string {
  return currentSession;
}

/**
 * Record a file mutation and stash its pre-image.
 *
 * Called by write_file and edit_file before the write lands, so the pre-image is
 * always the real previous content. `beforeText` is null for a new file.
 */
export function recordChange(params: {
  tool: string;
  path: string;
  cwd: string;
  beforeText: string | null;
  afterText: string;
  note?: string;
}): ChangeEntry {
  const abs = resolve(params.path);
  const existed = params.beforeText !== null;
  const entry: ChangeEntry = {
    ts: new Date().toISOString(),
    sessionId: currentSession,
    tool: params.tool,
    path: abs,
    rel: displayPath(abs, params.cwd),
    beforeSha: params.beforeText === null ? "" : shaOf(params.beforeText),
    afterSha: shaOf(params.afterText),
    existedBefore: existed,
    undoFile: null,
    beforeBytes: params.beforeText === null ? 0 : Buffer.byteLength(params.beforeText),
    afterBytes: Buffer.byteLength(params.afterText),
    note: params.note ?? "",
  };

  // Stash the pre-image, content-addressed so editing one file ten times stores
  // each distinct prior state once rather than ten copies of the whole file.
  if (existed && params.beforeText !== null) {
    const bytes = Buffer.byteLength(params.beforeText);
    if (bytes <= MAX_UNDO_BYTES) {
      const name = `${entry.beforeSha.slice(0, 16)}.bak`;
      const dest = join(undoDir(), name);
      try {
        mkdirSync(undoDir(), { recursive: true });
        // Write via a temp name so a crash cannot leave a half-written pre-image
        // that would silently restore corrupted content later.
        const tmp = `${dest}.${process.pid}.tmp`;
        writeFileSync(tmp, params.beforeText, "utf8");
        copyFileSync(tmp, dest);
        try { unlinkSync(tmp); } catch { /* best effort */ }
        entry.undoFile = name;
      } catch {
        entry.undoFile = null;
      }
    }
  }

  append(changeLogPath(), entry);
  return entry;
}

/** Record a non-file action (git commit, push) so the timeline reads in order. */
export function recordNote(tool: string, note: string): void {
  append(changeLogPath(), {
    ts: new Date().toISOString(),
    sessionId: currentSession,
    tool,
    note,
  } as NoteEntry);
}

function append(file: string, record: ChangeRecord): void {
  try {
    mkdirSync(dirname(file), { recursive: true });
    appendFileSync(file, JSON.stringify(record) + "\n", "utf8");
  } catch {
    // Best-effort. A read-only home directory must not break the write that the
    // agent asked for; the change simply goes unlogged and /diff will not show
    // it.
  }
}

function displayPath(abs: string, cwd: string): string {
  try {
    const rel = relative(resolve(cwd), abs);
    // Only show a relative path when it stays inside the workspace; a walk
    // upwards is confusing to read.
    if (rel && !rel.startsWith("..") && !isAbsolute(rel)) return rel.replace(/\\/g, "/");
  } catch {
    /* fall through */
  }
  return abs;
}

/** All records, optionally filtered to one session. Newest last. */
export function readChanges(sessionId?: string): ChangeRecord[] {
  const file = changeLogPath();
  if (!existsSync(file)) return [];
  let text: string;
  try {
    text = readFileSync(file, "utf8");
  } catch {
    return [];
  }
  const out: ChangeRecord[] = [];
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    try {
      const rec = JSON.parse(line) as ChangeRecord;
      if (sessionId && rec.sessionId !== sessionId) continue;
      out.push(rec);
    } catch {
      // A partial line from an interrupted append — skip rather than fail.
    }
  }
  return out;
}

/** File-mutating changes only, oldest first. */
export function readChangeEntries(sessionId?: string): ChangeEntry[] {
  return readChanges(sessionId).filter((r): r is ChangeEntry => "path" in r);
}

/**
 * Distinct files touched in a session, in first-touch order, each with the
 * *earliest* pre-image so a revert restores the original rather than an
 * intermediate state.
 */
export interface SessionDiff {
  files: {
    path: string;
    rel: string;
    /** Pre-image filename, or null if it was created (or too large to stash). */
    undoFile: string | null;
    created: boolean;
    edits: number;
    firstTs: string;
    lastTs: string;
  }[];
  notes: NoteEntry[];
}

/** Fold a session's change entries down to one line per file. */
export function sessionDiff(sessionId: string): SessionDiff {
  const byPath = new Map<string, SessionDiff["files"][number]>();
  const notes: NoteEntry[] = [];
  for (const rec of readChanges(sessionId)) {
    if (!("path" in rec)) {
      notes.push(rec);
      continue;
    }
    const prior = byPath.get(rec.path);
    if (!prior) {
      byPath.set(rec.path, {
        path: rec.path,
        rel: rec.rel,
        undoFile: rec.undoFile,
        created: !rec.existedBefore,
        edits: 1,
        firstTs: rec.ts,
        lastTs: rec.ts,
      });
    } else {
      prior.edits++;
      prior.lastTs = rec.ts;
      // Keep the earliest pre-image: that is the true "before" for this file.
      if (prior.undoFile === null && rec.undoFile) prior.undoFile = rec.undoFile;
    }
  }
  return { files: [...byPath.values()], notes };
}

export type RevertResult =
  | { ok: true; restored: string[]; deleted: string[]; skipped: string[] }
  | { ok: false; error: string };

/**
 * Undo changes in a session.
 *
 * `paths` empty means everything. A file the agent *created* is deleted; a file
 * it *modified* is rewritten from its pre-image. Files whose pre-image was not
 * stashed (too large, unreadable) are reported as skipped rather than silently
 * left modified.
 */
export function revertSession(sessionId: string, paths: string[] = []): RevertResult {
  const diff = sessionDiff(sessionId);
  const wanted = new Set(paths.map((p) => resolve(p)));
  const targets = diff.files.filter((f) => wanted.size === 0 || wanted.has(resolve(f.path)));

  if (!targets.length) {
    return { ok: false, error: paths.length ? `no changes recorded for: ${paths.join(", ")}` : "no changes recorded in this session" };
  }

  const restored: string[] = [];
  const deleted: string[] = [];
  const skipped: string[] = [];
  for (const f of targets) {
    if (f.created) {
      try {
        // rmSync is imported lazily to keep the module's import list honest
        // about what it needs for the read paths.
        rmSync(f.path, { force: true });
        deleted.push(f.rel);
      } catch (err: any) {
        skipped.push(`${f.rel} (delete failed: ${err?.message ?? err})`);
      }
      continue;
    }
    if (!f.undoFile) {
      skipped.push(`${f.rel} (no pre-image stored — too large to snapshot)`);
      continue;
    }
    try {
      const src = join(undoDir(), f.undoFile);
      if (!existsSync(src)) {
        skipped.push(`${f.rel} (pre-image missing: ${f.undoFile})`);
        continue;
      }
      copyFileSync(src, f.path);
      restored.push(f.rel);
    } catch (err: any) {
      skipped.push(`${f.rel} (${err?.message ?? err})`);
    }
  }
  return { ok: true, restored, deleted, skipped };
}

/** Human-readable summary of what a session changed. */
export function describeDiff(diff: SessionDiff): string {
  if (!diff.files.length && !diff.notes.length) return "no file changes recorded in this session";
  const lines: string[] = [];
  for (const f of diff.files) {
    const verb = f.created ? "created" : "modified";
    const times = f.edits > 1 ? ` (${f.edits} edits)` : "";
    const undoable = f.created ? "" : f.undoFile ? "" : " [no pre-image]";
    lines.push(`  ${verb}  ${f.rel}${times}${undoable}`);
  }
  for (const n of diff.notes) lines.push(`  ${n.tool}  ${n.note}`);
  return lines.join("\n");
}

