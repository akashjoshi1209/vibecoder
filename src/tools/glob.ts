// Minimal async glob matcher (no dependencies). Supports the patterns the tool
// advertises: `**` (any depth), `*` (within a segment), `?`, and `[...]`
// character classes. Returns paths relative to the scan cwd, like Bun.Glob.
import { opendir } from "node:fs/promises";
import { access } from "node:fs/promises";
import { join } from "node:path";

export interface GlobScanOptions {
  cwd: string;
  onlyFiles?: boolean;
  maxResults?: number;
  maxScanned?: number;
  excludeDirs?: string[];
}

const EXCLUDE_DEFAULTS = ["node_modules", ".git"];

function segmentToRegExp(seg: string): RegExp {
  let re = "^";
  for (let i = 0; i < seg.length; i++) {
    const c = seg[i];
    if (c === "*") {
      if (seg[i + 1] === "*") {
        re += ".*";
        i++;
      } else {
        re += "[^/]*";
      }
    } else if (c === "?") {
      re += "[^/]";
    } else if (c === "[") {
      const end = seg.indexOf("]", i + 1);
      if (end === -1) re += "\\[";
      else {
        re += seg.slice(i, end + 1);
        i = end;
      }
    } else {
      re += c.replace(/[.+^${}()|\\]/g, "\\$&");
    }
  }
  return new RegExp(re + "$");
}

export async function globScan(pattern: string, opts: GlobScanOptions): Promise<string[]> {
  const cwd = opts.cwd;
  // A missing root is an error, not an empty result (matches Bun.Glob behaviour).
  try {
    await access(cwd);
  } catch (err) {
    throw err;
  }
  const onlyFiles = opts.onlyFiles ?? true;
  const maxResults = opts.maxResults ?? 2000;
  const maxScanned = opts.maxScanned ?? maxResults;
  const exclusions = new Set([...EXCLUDE_DEFAULTS, ...(opts.excludeDirs ?? [])]);

  let normalized = pattern.replace(/^\.\//, "").replace(/\/+$/, "");
  while (normalized.startsWith("/")) normalized = normalized.slice(1);
  if (!normalized) normalized = "**";
  const segs = normalized.split("/").filter((s) => s.length > 0 && s !== ".");

  const out: string[] = [];
  let scanned = 0;
  let truncated = false;
  const push = (p: string): void => {
    if (truncated) return;
    if (out.length >= maxResults) {
      truncated = true;
      return;
    }
    scanned++;
    out.push(p);
  };

  const hasMagic = (s: string): boolean => /[*?[]/.test(s);

  const recurse = async (remaining: string[], dir: string, rel: string): Promise<void> => {
    if (truncated || scanned >= maxScanned) return;
    const head = remaining[0];

    if (head === "**") {
      if (remaining.length === 1) {
        // Trailing '**' matches everything underneath (files and dirs).
        let entries;
        try {
          entries = await opendir(dir);
        } catch {
          return;
        }
        for await (const e of entries) {
          if (truncated || scanned >= maxScanned) break;
          if (exclusions.has(e.name)) continue;
          const childRel = rel ? `${rel}/${e.name}` : e.name;
          const childAbs = join(dir, e.name);
          if (e.isDirectory()) {
            await recurse(remaining, childAbs, childRel);
          } else if (!onlyFiles || e.isFile()) {
            push(childRel);
          }
        }
        return;
      }
      // Match zero or more directories, then continue with the rest.
      await recurse(remaining.slice(1), dir, rel);
      let entries;
      try {
        entries = await opendir(dir);
      } catch {
        return;
      }
      for await (const e of entries) {
        if (truncated || scanned >= maxScanned) break;
        if (e.isDirectory() && !exclusions.has(e.name)) {
          const childRel = rel ? `${rel}/${e.name}` : e.name;
          await recurse(remaining, join(dir, e.name), childRel);
        }
      }
      return;
    }

    if (!head) return;
    const magic = hasMagic(head);
    const rx = magic ? segmentToRegExp(head) : new RegExp(`^${head.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`);

    let entries;
    try {
      entries = await opendir(dir);
    } catch {
      return;
    }

    for await (const e of entries) {
      if (truncated || scanned >= maxScanned) break;
      if (exclusions.has(e.name)) continue;

      const isLast = remaining.length === 1;
      if (isLast) {
        if (onlyFiles && !e.isDirectory() && !e.isFile()) continue;
        if (onlyFiles && e.isDirectory()) continue;
        if (!onlyFiles && e.isDirectory()) {
          if (rx.test(e.name)) push(rel ? `${rel}/${e.name}` : e.name);
          continue;
        }
        if (rx.test(e.name)) push(rel ? `${rel}/${e.name}` : e.name);
      } else {
        if (!e.isDirectory()) continue;
        if (rx.test(e.name)) {
          const childRel = rel ? `${rel}/${e.name}` : e.name;
          await recurse(remaining.slice(1), join(dir, e.name), childRel);
        }
      }
    }
  };

  await recurse(segs, cwd, "");
  return out;
}