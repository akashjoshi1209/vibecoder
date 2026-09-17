import { registerTool, type ToolContext } from "./registry";

const MAX_RESULTS = 50;
const MAX_SCANNED = 2000;
const DEFAULT_TIMEOUT_MS = 60_000;

function killTree(p: Bun.Subprocess): void {
  try {
    if (p.pid > 0) process.kill(-p.pid, "SIGKILL");
  } catch {
    try {
      p.kill();
    } catch {
      // already gone
    }
  }
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
      const r = new Bun.Glob(pattern).scan({ cwd: dir, onlyFiles: true });
      for await (const m of r) {
        if (matches.length >= MAX_SCANNED) {
          matches.push("...(scan limit reached, results truncated)");
          break;
        }
        if (m.split("/").some((seg) => seg === "node_modules" || seg === ".git")) continue;
        matches.push(m);
      }
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

    const proc = Bun.spawn({
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
      stdout: "pipe",
      stderr: "pipe",
      env: { ...process.env, NO_COLOR: "1" },
      detached: true,
    });

    let timedOut = false;
    const timer =
      timeout > 0
        ? setTimeout(() => {
            timedOut = true;
            killTree(proc);
          }, timeout)
        : null;
    const onAbort = () => killTree(proc);
    if (ctx.signal?.aborted) onAbort();
    else ctx.signal?.addEventListener("abort", onAbort, { once: true });

    try {
      const [out, err, exitCode] = await Promise.all([
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
        proc.exited,
      ]);
      const lines = out.split("\n").filter(Boolean);
      const shown = lines.slice(0, MAX_RESULTS);
      let result = shown.join("\n");
      if (timedOut) result += `\n[killed: timed out after ${timeout} ms]`;
      else if (ctx.signal?.aborted) result += "\n[aborted]";
      if (exitCode !== 0 && !lines.length) result += (err.trim() ? `ERROR: ${err.trim()}` : "");
      if (!lines.length) result = result.trim() || "(no matches)";
      else if (lines.length > MAX_RESULTS) result += `\n...(${lines.length - MAX_RESULTS} more)`;
      return result;
    } finally {
      if (timer) clearTimeout(timer);
      ctx.signal?.removeEventListener("abort", onAbort);
    }
  },
});