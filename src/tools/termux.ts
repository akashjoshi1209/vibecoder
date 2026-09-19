import { registerTool, type ToolContext } from "./registry";
import { spawnCollect } from "./proc";

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

    const res = await spawnCollect({
      cmd: ["termux-notification", "--title", title, "--content", message],
      env: { ...process.env, NO_COLOR: "1" } as Record<string, string>,
      timeoutMs: 30_000,
      signal: ctx.signal,
    });

    // A spawn error (exitCode -1) means the binary isn't installed.
    if (res.exitCode < 0) {
      return "ERROR: termux-notification failed: " + (res.stderr.trim() || "could not be spawned") +
        " (is termux-api installed? pkg install termux-api)";
    }

    let output = "";
    if (res.stdout) output += res.stdout;
    if (res.stderr) output += res.stderr ? (output ? "\n" : "") + res.stderr : "";
    if (res.timedOut) output += (output ? "\n" : "") + "[killed: timed out]";
    if (res.aborted) output += (output ? "\n" : "") + "[killed: interrupted]";
    if (!res.timedOut && !res.aborted && res.exitCode !== 0) {
      output += (output ? "\n" : "") + `[exit code: ${res.exitCode}]`;
    }
    return output || `notification pushed: "${title}"`;
  },
});