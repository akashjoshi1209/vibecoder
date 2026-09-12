import { registerTool, type ToolContext } from "./registry";

const MAX_OUTPUT = 30000;

registerTool({
  definition: {
    type: "function",
    function: {
      name: "bash",
      description:
        "Run a shell command. Use for executing commands, running scripts, git, package managers, etc. Returns stdout+stderr. Set workdir via the workdir param instead of 'cd X && ...'.",
      parameters: {
        type: "object",
        properties: {
          command: { type: "string", description: "The shell command to run" },
          workdir: { type: "string", description: "Working directory to run in (optional)" },
          timeout: { type: "number", description: "Timeout in milliseconds (optional, default 120000)" },
        },
        required: ["command"],
      },
    },
  },
  async run(args: Record<string, unknown>, ctx: ToolContext): Promise<string> {
    const command = String(args.command ?? "");
    const cwd = args.workdir ? String(args.workdir) : ctx.cwd;
    const timeout = Math.max(0, Number(args.timeout ?? 120000));

    const proc = Bun.spawn({
      cmd: ["bash", "-lc", command],
      cwd,
      stdout: "pipe",
      stderr: "pipe",
      env: { ...process.env, NO_COLOR: "1" },
      detached: true,
    });

    const killTree = () => {
      try { process.kill(-proc.pid, "SIGKILL"); } catch {
        try { proc.kill(); } catch {}
      }
    };

    let timedOut = false;
    const timer = timeout > 0 ? setTimeout(() => {
      timedOut = true;
      killTree();
    }, timeout) : null;
    const onAbort = () => killTree();
    if (ctx.signal?.aborted) onAbort();
    else ctx.signal?.addEventListener("abort", onAbort, { once: true });

    try {
      const [stdout, stderr, exitCode] = await Promise.all([
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
        proc.exited,
      ]);

      let output = "";
      if (stdout) output += stdout;
      if (stderr) output += stderr ? (output ? "\n" : "") + stderr : "";
      if (exitCode !== 0) output += (output ? "\n" : "") + `[exit code: ${exitCode}]`;
      if (timedOut) output += (output ? "\n" : "") + `[killed: timed out after ${timeout}ms]`;
      if (ctx.signal?.aborted) output += (output ? "\n" : "") + "[killed: interrupted]";
      if (!output) output = "(no output)";

      return output.length > MAX_OUTPUT ? output.slice(0, MAX_OUTPUT) + `\n...[truncated ${output.length - MAX_OUTPUT} chars]` : output;
    } finally {
      if (timer) clearTimeout(timer);
      ctx.signal?.removeEventListener("abort", onAbort);
    }
  },
});
