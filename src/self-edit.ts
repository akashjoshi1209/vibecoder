// Self-edit guardrails: an append-only audit ledger for changes the agent makes
// to its own configuration, plus a revert path to the last approved state.
//
// Design:
//  - Self-files are the live config (config.json) and, in a repo dev install,
//    the gitignored .env. Every write/edit to them is recorded in the ledger.
//  - Self-edits are staged: they only go live when the human runs /reload-config
//    in the REPL (that's the explicit approve step). /undo-self-edits restores
//    the last approved state.
//  - Install mode determines the undo mechanism:
//      * repo install (has .git) — `git restore` to the last commit, as before.
//      * global/user install — restore the newest snapshot from
//        ~/.vibecoder/backups/ (taken before each self-edit).
//  - The ledger itself is PROTECTED: direct file-tool writes to it are blocked.
//    The reset/reload commands live in code that is itself git-tracked, so
//    removing them is visible in `git diff` and revertible.
import { createHash } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, readFileSync, appendFileSync, readdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { spawnSync } from "node:child_process";
import { userConfigFile } from "./config";
import { packageRoot, resolvePackageFile } from "./paths";

export interface SelfEditEntry {
  ts: string;
  tool: string;
  file: string; // display path (relative where possible)
  beforeSha: string;
  afterSha: string;
  note: string;
}

export const LEDGER_NAME = "SELF_EDITS.jsonl";

export type InstallMode = "repo" | "user";

function repoRoot(): string {
  const env = process.env.VIBECODER_REPO_ROOT;
  if (env) return resolve(env);
  return dirname(packageRoot());
}

export function installMode(): InstallMode {
  if (process.env.VIBECODER_REPO_ROOT) return "repo";
  const root = dirname(packageRoot());
  if (existsSync(join(root, ".git")) || existsSync(join(packageRoot(), ".git"))) return "repo";
  return "user";
}

function userDataRoot(): string {
  if (process.env.VIBECODER_SESSION_DIR) return process.env.VIBECODER_SESSION_DIR;
  return join(homedir(), ".vibecoder");
}

/** Real-name config.json in the repo (only meaningful in a repo install). */
function repoConfigFile(): string | null {
  return resolvePackageFile("config.json");
}

/** Absolute path of the live config file (the one self-edits target). */
export function liveConfigFile(): string {
  const repo = reposWhere();
  if (repo && installMode() === "repo") return repo.config;
  const repoCfg = repoConfigFile();
  if (installMode() === "repo" && repoCfg && !existsSync(userConfigFile())) return repoCfg;
  return userConfigFile();
}

export function ledgerPath(): string {
  return installMode() === "repo" ? join(repoRoot(), LEDGER_NAME) : join(userDataRoot(), LEDGER_NAME);
}

function backupsDir(): string {
  return join(userDataRoot(), "backups");
}

function isSameFile(a: string, b: string): boolean {
  return resolve(a) === resolve(b);
}

/** Repo self-files when the repo is pinned via VIBECODER_REPO_ROOT (tests, devs). */
function reposWhere(): { root: string; config: string; env: string } | null {
  if (process.env.VIBECODER_REPO_ROOT) {
    const root = resolve(process.env.VIBECODER_REPO_ROOT);
    return { root, config: join(root, "config.json"), env: join(root, ".env") };
  }
  return null;
}

export function isSelfFile(abs: string): boolean {
  const a = resolve(abs);
  const repo = reposWhere();
  if (repo && (isSameFile(a, repo.config) || isSameFile(a, repo.env))) return true;
  if (isSameFile(a, liveConfigFile())) return true;
  return false;
}

export function isProtectedFile(abs: string): boolean {
  return isSameFile(abs, ledgerPath());
}

export function shaOf(text: string): string {
  return createHash("sha256").update(text).digest("hex");
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
    mkdirSync(dirname(ledgerPath()), { recursive: true });
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

/** Snapshot `content` to ~/.vibecoder/backups/ before a config change happens. */
function snapshotConfig(content: string): string {
  const dir = backupsDir();
  mkdirSync(dir, { recursive: true });
  const ts = new Date().toISOString().replace(/[:.]/g, "-");
  const file = join(dir, `config-${ts}.json`);
  writeFileSync(file, content, "utf8");
  return file;
}

function newestBackup(): string | null {
  try {
    const dir = backupsDir();
    if (!existsSync(dir)) return null;
    const files = readdirSync(dir)
      .filter((f) => f.startsWith("config-") && f.endsWith(".json"))
      .sort();
    return files.length ? join(dir, files[files.length - 1]) : null;
  } catch {
    return null;
  }
}

/** Record a self-edit made by tool `toolName`; returns the note to show the model. */
export function auditSelfEdit(toolName: string, abs: string, beforeText: string, afterText: string, note: string): string {
  if (installMode() === "user" && isSameFile(abs, liveConfigFile())) {
    snapshotConfig(beforeText);
  }
  const display = isSameFile(abs, liveConfigFile()) ? "config.json" : abs;
  const ok = appendLedger({ tool: toolName, file: display, beforeSha: shaOf(beforeText), afterSha: shaOf(afterText), note });
  if (!ok) {
    return `WARNING: SELF-EDIT on ${display} (${toolName}) could NOT be written to ${LEDGER_NAME} — treat it as UNAUDITED and re-run with write access.`;
  }
  return `SELF-EDIT recorded to ${LEDGER_NAME} (file ${display}): staged, not live. Tell the human it needs /reload-config to go live, or /undo-self-edits to revert.`;
}

/** Restore self-files to the last approved state (git in repos, snapshots otherwise). */
export function restoreSelfFiles(): { ok: boolean; out: string } {
  const target = liveConfigFile();
  const repoCfg = reposWhere()?.config ?? repoConfigFile();
  if (installMode() === "repo" && repoCfg && isSameFile(target, repoCfg)) {
    const res = spawnSync("git", ["restore", "--worktree", "--", "config.json"], {
      cwd: repoRoot(),
      encoding: "utf8",
    });
    const out = (res.stdout || "") + (res.stderr || "");
    return { ok: res.status === 0, out: out.trim() };
  }
  const backup = newestBackup();
  if (!backup) {
    return { ok: false, out: "no snapshot found in ~/.vibecoder/backups — nothing to restore" };
  }
  try {
    mkdirSync(dirname(target), { recursive: true });
    copyFileSync(backup, target);
    return { ok: true, out: `restored ${target} from snapshot ${backup}` };
  } catch (err: any) {
    return { ok: false, out: String(err?.message ?? err) };
  }
}

/** Describe pending self-file changes (what /reload-config would apply). */
export function selfFileDiffStat(): string {
  const target = liveConfigFile();
  const repoCfg = reposWhere()?.config ?? repoConfigFile();
  if (installMode() === "repo" && repoCfg && isSameFile(target, repoCfg)) {
    const res = spawnSync("git", ["diff", "--stat", "--", "config.json"], { cwd: repoRoot(), encoding: "utf8" });
    return (res.stdout || res.stderr || "").trim();
  }
  const backup = newestBackup();
  if (!existsSync(target)) return "";
  if (!backup) return readIfExists(target) ? "config.json is present (no snapshot yet)" : "";
  const current = readIfExists(target);
  const prev = readIfExists(backup);
  if (current === prev) return "";
  const changed = current.split("\n").filter((l) => !prev.split("\n").includes(l)).length;
  return `config.json changed since last snapshot (${backup.split("/").pop()}) — ~${changed} line(s) differ`;
}