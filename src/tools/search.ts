import { registerTool, type ToolContext } from "./registry";
import { spawnCollect } from "./proc";
import { globScan } from "./glob";

const MAX_RESULTS = 50;
const MAX_SCANNED = 2000;
const DEFAULT_TIMEOUT_MS = 60_000;

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
    const pattern = String(args.pattern ?? "");
    const dir = args.path ? String(args.path) : ctx.cwd;
    const include = args.include ? String(args.include) : "*";
    const timeout = Math.max(0, Number(args.timeout ?? DEFAULT_TIMEOUT_MS) || DEFAULT_TIMEOUT_MS);

    const res = await spawnCollect({
      cmd: [
        "grep",
        "-rn",
        "-E",
        "-e",
        pattern,
        `--include=${include}`,
        "--exclude-dir=node_modules",
        "--exclude-dir=.git",
        "--",
        dir,
      ],
      env: { ...process.env, NO_COLOR: "1" } as Record<string, string>,
      timeoutMs: timeout,
      signal: ctx.signal,
    });

    const lines = res.stdout.split("\n").filter(Boolean);
    const shown = lines.slice(0, MAX_RESULTS);
    let result = shown.join("\n");
    if (res.timedOut) result += `\n[killed: timed out after ${timeout} ms]`;
    else if (res.aborted) result += "\n[aborted]";
    if (res.exitCode !== 0 && !lines.length) result += (res.stderr.trim() ? `ERROR: ${res.stderr.trim()}` : "");
    if (!lines.length) result = result.trim() || "(no matches)";
    else if (lines.length > MAX_RESULTS) result += `\n...(${lines.length - MAX_RESULTS} more)`;
    return result;
  },
});