// Native recursive text search (grep). Runs entirely in-process, so it is
// fast everywhere (Node and Bun, incl. Termux/proot), never passes the pattern
// or include glob through a shell (no injection), and treats the pattern as
// data even when it starts with "-".
import { registerTool, type ToolContext } from "./registry";
import { readdir, readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { globScan } from "./glob";

const MAX_RESULTS = 50;
const MAX_SCANNED = 100_000;
const MAX_FILE_BYTES = 4 * 1024 * 1024;
const MAX_LINE_CHARS = 2000;
const EXCLUDED_DIRS = new Set(["node_modules", ".git", ".hg", ".svn"]);
const DEFAULT_TIMEOUT_MS = 60_000;

interface ScanHit {
  path: string;
  line: number;
  text: string;
}

/** Convert a glob (e.g. `*.ts`, `src/**&#47;*.ts`) to a regex over path strings. */
function globToRegExp(glob: string): RegExp {
  let rx = "^";
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === "*") {
      if (glob[i + 1] === "*") {
        rx += ".*";
        i++;
      } else {
        rx += "[^/]*";
      }
    } else if (c === "?") {
      rx += "[^/]";
    } else {
      rx += c.replace(/[.+^${}()|[\]\\]/g, "\\$&");
    }
  }
  return new RegExp(rx + "$");
}

async function scanDir(
  root: string,
  pattern: RegExp,
  includeRx: RegExp,
  limit: number,
  deadline: number,
): Promise<{ hits: ScanHit[]; timedOut: boolean }> {
  const hits: ScanHit[] = [];
  let scanned = 0;
  let timedOut = false;

  const walk = async (dir: string, rel: string): Promise<void> => {
    if (hits.length >= limit || timedOut) return;
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    for (const e of entries) {
      if (hits.length >= limit || timedOut) return;
      if (EXCLUDED_DIRS.has(e.name)) continue;
      const childRel = rel ? `${rel}/${e.name}` : e.name;
      const full = join(dir, e.name);
      if (e.isDirectory()) {
        if (Date.now() >= deadline) {
          timedOut = true;
          return;
        }
        await walk(full, childRel);
      } else if (e.isFile()) {
        if (++scanned > MAX_SCANNED) return;
        if (!includeRx.test(e.name) && !includeRx.test(childRel)) continue;
        let size: number;
        try {
          size = (await stat(full)).size;
        } catch {
          continue;
        }
        if (size > MAX_FILE_BYTES) continue;
        let content: string;
        try {
          content = await readFile(full, "utf8");
        } catch {
          continue;
        }
        if (content.includes("\0")) continue; // skip binary files
        const lines = content.split("\n");
        for (let i = 0; i < lines.length && hits.length < limit; i++) {
          if (pattern.test(lines[i])) {
            let text = lines[i];
            if (text.length > MAX_LINE_CHARS) text = text.slice(0, MAX_LINE_CHARS) + "…";
            hits.push({ path: childRel, line: i + 1, text });
          }
        }
        if (Date.now() >= deadline) {
          timedOut = true;
          return;
        }
      }
    }
  };

  await walk(root, "");
  return { hits, timedOut };
}

registerTool({
  definition: {
    type: "function",
    function: {
      name: "glob",
      description:
        "List files matching a glob pattern (e.g. **/*.ts, src/**). Returns matching file paths.",
      parameters: {
        type: "object",
        properties: {
          pattern: { type: "string", description: "Glob pattern to search" },
          cwd: { type: "string", description: "Directory to search in (optional, defaults to workspace)" },
        },
        required: ["pattern"],
      },
    },
  },
  async run(args: Record<string, unknown>, ctx: ToolContext): Promise<string> {
    const pattern = String(args.pattern ?? "");
    const dir = args.cwd ? String(args.cwd) : ctx.cwd;
    const matches: string[] = [];
    try {
      const found = await globScan(pattern, { cwd: dir, onlyFiles: true, maxResults: MAX_SCANNED });
      matches.push(...found);
    } catch (err: any) {
      return `ERROR: glob failed: ${err?.message ?? String(err)}`;
    }
    const list = matches.slice(0, MAX_RESULTS);
    let out = list.sort().join("\n");
    if (list.length === 0) out = "(no matches)";
    else if (matches.length > MAX_RESULTS) out += `\n...(${matches.length - MAX_RESULTS} more)`;
    return out;
  },
});

registerTool({
  definition: {
    type: "function",
    function: {
      name: "grep",
      description:
        "Search file contents with a regex. Returns file paths and line numbers of matches.",
      parameters: {
        type: "object",
        properties: {
          pattern: { type: "string", description: "Regex pattern to search for" },
          include: { type: "string", description: "File glob to filter (e.g. *.ts) (optional)" },
          path: { type: "string", description: "Directory to search (optional, defaults to workspace)" },
          timeout: { type: "number", description: "Timeout in milliseconds (optional, default 60000)" },
        },
        required: ["pattern"],
      },
    },
  },
  async run(args: Record<string, unknown>, ctx: ToolContext): Promise<string> {
    const patternText = String(args.pattern ?? "");
    const dir = args.path ? String(args.path) : ctx.cwd;
    const include = args.include ? String(args.include) : "*";
    const timeout = Math.max(0, Number(args.timeout ?? DEFAULT_TIMEOUT_MS) || DEFAULT_TIMEOUT_MS);

    let pattern: RegExp;
    try {
      pattern = new RegExp(patternText);
    } catch (err: any) {
      return `ERROR: invalid search pattern: ${err?.message ?? String(err)}`;
    }

    let includeRx: RegExp;
    try {
      includeRx = globToRegExp(include);
    } catch (err: any) {
      return `ERROR: invalid include pattern: ${err?.message ?? String(err)}`;
    }

    let rootInfo;
    try {
      rootInfo = await stat(dir);
    } catch (err: any) {
      return `ERROR: cannot search directory "${dir}": ${err?.message ?? String(err)}`;
    }
    if (!rootInfo.isDirectory()) return `ERROR: not a directory: ${dir}`;

    const { hits, timedOut } = await scanDir(dir, pattern, includeRx, MAX_RESULTS + 1, Date.now() + timeout);

    const shown = hits.slice(0, MAX_RESULTS);
    let output = shown.map((h) => `${h.path}:${h.line}:${h.text}`).join("\n");
    if (timedOut) output += (output ? "\n" : "") + `[killed: timed out after ${timeout} ms]`;
    if (shown.length === 0) {
      output = output.trim() || "(no matches)";
    } else if (hits.length > shown.length) {
      output += `\n...(${hits.length - shown.length} more)`;
    }
    return output;
  },
});