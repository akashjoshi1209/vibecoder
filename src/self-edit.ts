// Self-edit guardrails: an append-only audit ledger for changes the agent makes
// to its own configuration, plus git-backed reset to the last approved state.
//
// Design:
//  - Self-files are config.json (behavior: system prompt, limits, providers) and
//    .env (secrets). Every write/edit to them is recorded in SELF_EDITS.jsonl.
//  - Self-edits are staged: they only go live when the human runs /reload-config
//    in the REPL (that's the explicit approve step). /undo-self-edits restores
//    the files from git (last commit = last approved state).
//  - The ledger itself is PROTECTED: direct file-tool writes to it are blocked.
//    The reset/reload commands live in code tracked by git, so removing them is
//    visible in `git diff` and revertible.
import { existsSync, readFileSync, mkdirSync, appendFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";

export interface SelfEditEntry {
  ts: string;
  tool: string;
  file: string; // relative to repo root
  beforeSha: string;
  afterSha: string;
  note: string;
}

export const LEDGER_NAME = "SELF_EDITS.jsonl";

// Behavior-affecting config files tracked by git (self-files that /undo-self-edits
// can restore). .env holds secrets and is gitignored, so it is never restored.
const RESTORE_FILES = ["config.json"];

function repoRoot(): string {
  const env = process.env.VIBECODER_REPO_ROOT;
  if (env) return resolve(env);
  return resolve(import.meta.dir, "..");
}

export function ledgerPath(): string {
  return join(repoRoot(), LEDGER_NAME);
}

function isInsideRepo(abs: string): boolean {
  const root = repoRoot();
  return abs === root || abs.startsWith(root.endsWith("/") ? root : root + "/");
}

function toRel(abs: string): string {
  const root = repoRoot();
  return abs.startsWith(root + "/") ? abs.slice(root.length + 1) : abs;
}

export function isSelfFile(abs: string): boolean {
  if (!isInsideRepo(abs)) return false;
  const rel = toRel(abs);
  return rel === "config.json" || rel === ".env";
}

export function isProtectedFile(abs: string): boolean {
  return toRel(abs) === LEDGER_NAME;
}

export function shaOf(text: string): string {
  return new Bun.CryptoHasher("sha256").update(text).digest("hex");
}

function readIfExists(abs: string): string {
  try {
    return existsSync(abs) ? readFileSync(abs, "utf8") : "";
  } catch {
    return "";
  }
}

/** Record a self-edit in the append-only ledger. Returns true on success. */
export function appendLedger(entry: Omit<SelfEditEntry, "ts">): boolean {
  try {
    const full: SelfEditEntry = { ts: new Date().toISOString(), ...entry };
    mkdirSync(repoRoot(), { recursive: true });
    appendFileSync(ledgerPath(), JSON.stringify(full) + "\n", "utf8");
    return true;
  } catch {
    return false;
  }
}

/** Last N ledger entries, newest first. */
export function readLedger(limit = 20): SelfEditEntry[] {
  try {
    if (!existsSync(ledgerPath())) return [];
    const lines = readFileSync(ledgerPath(), "utf8").split("\n").filter(Boolean);
    return lines
      .slice(-limit)
      .reverse()
      .map((l) => {
        try {
          return JSON.parse(l) as SelfEditEntry;
        } catch {
          return null;
        }
      })
      .filter((e): e is SelfEditEntry => e !== null);
  } catch {
    return [];
  }
}

/** A short summary line for the most recent edits, for humans. */
export function ledgerSummary(limit = 5): string[] {
  return readLedger(limit).map((e) => {
    const same = e.beforeSha === e.afterSha ? "no-content-change" : "changed";
    return `  ${e.ts.slice(0, 19)} ${e.tool} ${e.file} ${same} — ${e.note}`;
  });
}

/** Record a self-edit made by tool `toolName`; returns the note to show the model. */
export function auditSelfEdit(toolName: string, abs: string, beforeText: string, afterText: string, note: string): string {
  const rel = toRel(abs);
  const ok = appendLedger({ tool: toolName, file: rel, beforeSha: shaOf(beforeText), afterSha: shaOf(afterText), note });
  if (!ok) {
    // Never claim the edit was recorded when the ledger write failed — the
    // change would otherwise exist with no audit trail.
    return `WARNING: SELF-EDIT on ${rel} (${toolName}) could NOT be written to ${LEDGER_NAME} — treat it as UNAUDITED and re-run with write access.`;
  }
  return `SELF-EDIT recorded to ${LEDGER_NAME} (file ${rel}): staged, not live. Tell the human it needs /reload-config to go live, or /undo-self-edits to revert.`;
}

/** Restore self-files tracked by git to HEAD (the last approved state). */
export function restoreSelfFiles(): { ok: boolean; out: string } {
  const res = spawnSync("git", ["restore", "--worktree", "--", ...RESTORE_FILES], {
    cwd: repoRoot(),
    encoding: "utf8",
  });
  const out = (res.stdout || "") + (res.stderr || "");
  return { ok: res.status === 0, out: out.trim() };
}

/** git diff --stat for self-files tracked by git (what is staged/edited but uncommitted). */
export function selfFileDiffStat(): string {
  const res = spawnSync("git", ["diff", "--stat", "--", ...RESTORE_FILES], { cwd: repoRoot(), encoding: "utf8" });
  return (res.stdout || res.stderr || "").trim();
}