// In-process fallback for the grep tool.
//
// The grep tool shelled out to `grep -rn` and had no other path: on a box
// without GNU grep (minimal containers, Windows without Git-bash on PATH) the
// tool failed outright or silently reported "no matches" from an error on
// stderr. This module gives search a bounded, dependency-free engine so the
// tool keeps working; the shell path stays the fast default when grep exists.
//
// Bounded by design: file-count, per-file-size and total-match caps keep a
// pathological tree from hanging an agent step.

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";

export interface GrepFallbackOptions {
  /** `--include`-style glob (e.g. `*.ts`, `src/**`); empty/undefined = all. */
  include?: string;
  /** Stop walking after this many files have been scanned. */
  maxFiles?: number;
  /** Skip files larger than this many bytes. */
  maxFileSize?: number;
  /** Abandon the walk when this many matches have accumulated. */
  maxMatches?: number;
  signal?: AbortSignal;
}

export interface GrepFallbackResult {
  /** Lines in GNU-grep `-rn` form: `path:line:text`. */
  lines: string[];
  /** Files inspected before stopping. */
  scanned: number;
  /** True when a cap (files/matches) stopped the walk early. */
  truncated: boolean;
}

/** Directories excluded by the shell engine's --exclude-dir flags — mirrored
 *  exactly so both engines search the same set of directories. Everything
 *  else (.gitignore patterns, dist/, coverage/) is the fallback's own extra
 *  courtesy, not a parity claim. */
const SKIP_DIRS = new Set(["node_modules", ".git"]);

/** Convert a shell-style include glob to a RegExp matching the file's
 *  path-relative-to-search-root, POSIX-style. */
export function includeToRegExp(glob: string): RegExp | null {
  const g = glob.trim();
  if (!g || g === "*") return null;
  let out = "";
  for (let i = 0; i < g.length; i++) {
    const c = g[i];
    if (c === "*") {
      if (g[i + 1] === "*") {
        out += ".*";
        i++;
        if (g[i + 1] === "/") i++; // `**/` eats the slash too
      } else {
        out += "[^/]*";
      }
    } else if (c === "?") out += "[^/]";
    else if ("\\^$+.()|{}[]".includes(c)) out += "\\" + c;
    else out += c;
  }
  // `*.ts` should match at any depth, like grep's --include does (basename
  // match when the glob has no slash). The separator is always "/" — rel
  // paths are POSIX-normalised below regardless of platform.
  if (!g.includes("/")) return new RegExp(`(^|/)${out}$`);
  return new RegExp(`^${out}$`);
}

function isBinary(buf: Buffer): boolean {
  const n = Math.min(buf.length, 4096);
  for (let i = 0; i < n; i++) if (buf[i] === 0) return true;
  return false;
}

interface IgnorePattern {
  neg: boolean;
  dirOnly: boolean;
  re: RegExp;
}

interface IgnoreSet {
  /** Directory the .gitignore file sits in (absolute). */
  dir: string;
  patterns: IgnorePattern[];
}

/**
 * Minimal .gitignore support: per-directory ignore files, `#` comments,
 * negation (`!`), directory-only (`dir/`), anchored (`/x`) and basic globs.
 * Patterns apply to the directory the file is in and its subtree; each
 * pattern is matched against the path relative to that directory.
 *
 * Read once per directory during the walk (not once up-front): a nested
 * .gitignore only becomes visible when the walk enters its directory, and a
 * single root-level read silently ignored every nested file.
 */
function readIgnoreSet(dir: string): IgnoreSet | null {
  let raw: string;
  try {
    raw = readFileSync(join(dir, ".gitignore"), "utf8");
  } catch {
    return null;
  }
  const patterns: IgnorePattern[] = [];
  for (let line of raw.split(/\r?\n/)) {
    if (!line || line.startsWith("#")) continue;
    let neg = false;
    if (line.startsWith("!")) {
      neg = true;
      line = line.slice(1);
    }
    let dirOnly = false;
    if (line.endsWith("/")) {
      dirOnly = true;
      line = line.slice(0, -1);
    }
    const anchored = line.startsWith("/");
    if (anchored) line = line.slice(1);
    if (!line) continue;
    let re = "";
    for (let i = 0; i < line.length; i++) {
      const c = line[i];
      if (c === "*") {
        if (line[i + 1] === "*") {
          re += ".*";
          i++;
          if (line[i + 1] === "/") i++;
        } else re += "[^/]*";
      } else if (c === "?") re += "[^/]";
      else if ("\\^$+.()|{}[]".includes(c)) re += "\\" + c;
      else re += c;
    }
    // Unanchored patterns match at any depth (gitignore semantics).
    patterns.push({ neg, dirOnly, re: new RegExp(anchored ? `^${re}` : `(^|/)${re}`) });
  }
  return patterns.length ? { dir, patterns } : null;
}

/** True when `absPath` is ignored by any of the collected rule sets.
 *  Last matching pattern wins (gitignore semantics), evaluated per set. */
function ignoredBy(absPath: string, isDir: boolean, sets: IgnoreSet[]): boolean {
  let ignored = false;
  for (const set of sets) {
    const sub = relative(set.dir, absPath).split(sep).join("/");
    if (!sub || sub.startsWith("..")) continue; // not under this set's dir
    for (const p of set.patterns) {
      if (p.dirOnly && !isDir) continue;
      if (p.re.test(sub)) ignored = !p.neg;
    }
  }
  return ignored;
}

/**
 * Recursive regex search over `dir`, returning grep-compatible result lines.
 *
 * The caller pages the lines exactly as it pages shell-grep stdout, so the
 * two engines are interchangeable downstream.
 */
export function grepFallback(
  dir: string,
  pattern: RegExp,
  opts: GrepFallbackOptions = {},
): GrepFallbackResult | { error: string } {
  const maxFiles = opts.maxFiles ?? 5000;
  const maxFileSize = opts.maxFileSize ?? 1_000_000;
  const maxMatches = opts.maxMatches ?? 20_000;
  const includeRe = opts.include ? includeToRegExp(opts.include) : null;
  // Test with a non-stateful copy: a caller passing /g or /y would otherwise
  // advance lastIndex between files and silently skip matches.
  const re = new RegExp(pattern.source, pattern.flags.replace(/[gy]/g, ""));
  const lines: string[] = [];
  let scanned = 0;
  let truncated = false;

  const walk = (d: string, inherited: IgnoreSet[]): void => {
    if (truncated || opts.signal?.aborted) return;
    const mine = readIgnoreSet(d);
    const ignores = mine ? [...inherited, mine] : inherited;
    let entries: string[];
    try {
      entries = readdirSync(d);
    } catch {
      return; // unreadable directory — skip, like grep does
    }
    for (const name of entries) {
      if (truncated || opts.signal?.aborted) return;
      if (name === ".git") continue;
      const abs = join(d, name);
      const rel = relative(dir, abs).split(sep).join("/");
      let st;
      try {
        st = statSync(abs);
      } catch {
        continue;
      }
      if (st.isDirectory()) {
        if (SKIP_DIRS.has(name)) continue;
        if (ignoredBy(abs, true, ignores)) continue;
        walk(abs, ignores);
        continue;
      }
      if (!st.isFile()) continue;
      if (st.size > maxFileSize) continue;
      if (includeRe && !includeRe.test(rel)) continue;
      if (ignoredBy(abs, false, ignores)) continue;
      if (scanned >= maxFiles) {
        truncated = true;
        return;
      }
      scanned++;
      let buf: Buffer;
      try {
        buf = readFileSync(abs);
      } catch {
        continue;
      }
      if (isBinary(buf)) continue;
      const fileLines = buf.toString("utf8").split("\n");
      for (let i = 0; i < fileLines.length; i++) {
        if (fileLines[i].endsWith("\r")) fileLines[i] = fileLines[i].slice(0, -1);
        if (!re.test(fileLines[i])) continue;
        lines.push(`${rel}:${i + 1}:${fileLines[i]}`);
        if (lines.length >= maxMatches) {
          truncated = true;
          return;
        }
      }
    }
  };

  try {
    statSync(dir); // distinguish "cannot read root" from "empty tree"
    walk(dir, []);
  } catch (err: any) {
    return { error: `cannot read directory: ${err?.message ?? String(err)}` };
  }
  return { lines, scanned, truncated };
}
