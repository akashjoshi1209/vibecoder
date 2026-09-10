import { registerTool, type ToolContext } from "./registry";

const MAX_RESULTS = 50;

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
    const r = new Bun.Glob(pattern).scan({ cwd: dir, onlyFiles: true });
    for await (const m of r) matches.push(m);
    const list = matches.slice(0, MAX_RESULTS);
    let out = list.sort().join("\n");
    if (matches.length === 0) out = "(no matches)";
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
        },
        required: ["pattern"],
      },
    },
  },
  async run(args: Record<string, unknown>, ctx: ToolContext): Promise<string> {
    const pattern = String(args.pattern ?? "");
    const dir = args.path ? String(args.path) : ctx.cwd;
    const include = args.include ? String(args.include) : undefined;

    const proc = Bun.spawn({
      cmd: ["bash", "-lc", `LC_ALL=C grep -rn --include='${include ?? "*"}' -E "${pattern.replace(/"/g, '\\"')}" "${dir}" || true`],
      stdout: "pipe",
      stderr: "pipe",
      env: { ...process.env, NO_COLOR: "1" },
    });
    const [out, err] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
    ]);
    await proc.exited;
    const lines = out.split("\n").filter(Boolean);
    const shown = lines.slice(0, MAX_RESULTS);
    let result = shown.join("\n") || "(no matches)";
    if (lines.length > MAX_RESULTS) result += `\n...(${lines.length - MAX_RESULTS} more)`;
    return result;
  },
});