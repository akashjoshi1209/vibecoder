import { registerTool, type ToolContext } from "./registry";

/**
 * Push a Termux notification. Useful for long-running agent tasks: the agent
 * fires this when a build/query finishes so you can step away and still know
 * when it's done. Inert when termux-notification isn't installed.
 */
registerTool({
  definition: {
    type: "function",
    function: {
      name: "termux_notify",
      description:
        "Push a notification to the Android status bar via Termux:API (termux-notification). Use at the end of long tasks so you know when they finish without watching the terminal. Takes a title and optional message. Returns the command output or a clear 'not available' note.",
      parameters: {
        type: "object",
        properties: {
          title: { type: "string", description: "Notification title (short)" },
          message: { type: "string", description: "Notification body (optional, defaults to title)" },
        },
        required: ["title"],
      },
    },
  },
  async run(args: Record<string, unknown>, ctx: ToolContext): Promise<string> {
    const title = String(args.title ?? "").slice(0, 100);
    const message = String(args.message ?? title).slice(0, 500);
    if (!title) return "ERROR: title is required";

    const proc = Bun.spawn({
      cmd: [
        "termux-notification",
        "--title", title,
        "--content", message,
      ],
      stdout: "pipe",
      stderr: "pipe",
      env: { ...process.env, NO_COLOR: "1" },
      detached: true,
    });

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
      return output || `notification pushed: "${title}"`;
    } catch (err: any) {
      return `ERROR: termux-notification failed: ${err?.message ?? String(err)} (is termux-api installed? pkg install termux-api)`;
    }
  },
});
