import { registerTool, type ToolContext } from "./registry";

/**
 * Push a notification to the Android status bar via Termux:API (termux-notification).
 * Use at the end of long tasks so the user can step away and still be alerted
 * when the agent finishes. Inert when termux-notification isn't on PATH — returns
 * a clear note, never throws.
 */
registerTool({
  definition: {
    type: "function",
    function: {
      name: "termux_notify",
      description:
        "Push an Android notification via Termux:API (termux-notification). Use when a long task finishes so the user can step away and still be alerted. Returns the command output, or a note if termux-notification isn't installed.",
      parameters: {
        type: "object",
        properties: {
          title: { type: "string", description: "Notification title (required, ≤100 chars)" },
          message: { type: "string", description: "Notification body (optional, ≤500 chars)" },
        },
        required: ["title"],
      },
    },
  },
  async run(args: Record<string, unknown>, ctx: ToolContext): Promise<string> {
    const title = String(args.title ?? "").slice(0, 100);
    const message = String(args.message ?? title).slice(0, 500);
    if (!title) return "ERROR: title is required";
    return runTermuxCmd(["termux-notification", "--title", title, "--content", message]);
  },
});

/**
 * Acquire or release a Termux wake lock so the phone does not sleep while
 * the agent works. Without args (or acquire=true) → acquire. acquire=false → release.
 * Use at the start of a long task; release when done or if the task is abandoned.
 * Inert when the binary isn't on PATH.
 */
registerTool({
  definition: {
    type: "function",
    function: {
      name: "termux_wake_lock",
      description:
        "Acquire or release a Termux wake lock (termux-wake-lock / termux-wake-unlock). Keeps the phone awake during a long agent run so it does not sleep mid-task. Without args or acquire=true acquires the lock; pass acquire=false to release. Inert when the binary isn't installed.",
      parameters: {
        type: "object",
        properties: {
          acquire: { type: "boolean", description: "true to acquire (default), false to release" },
        },
      },
    },
  },
  async run(args: Record<string, unknown>, ctx: ToolContext): Promise<string> {
    const acquire = args.acquire !== false;
    return runTermuxCmd(acquire ? ["termux-wake-lock"] : ["termux-wake-unlock"]);
  },
});

/**
 * Battery status via termux-battery-status (Termux:API). Returns level,
 * charging state, temperature, voltage. Useful before long tasks to confirm
 * the phone is charging and will not die mid-run.
 * Inert when the binary isn't on PATH.
 */
registerTool({
  definition: {
    type: "function",
    function: {
      name: "termux_battery",
      description:
        "Get battery status via Termux:API (termux-battery-status): level, status (charging/discharging/full), temperature, voltage. Check before long tasks to confirm the phone is charging. Inert when the binary isn't installed.",
      parameters: { type: "object", properties: {} },
    },
  },
  async run(_args: Record<string, unknown>, ctx: ToolContext): Promise<string> {
    return runTermuxCmd(["termux-battery-status"]);
  },
});

// ── shared helper ────────────────────────────────────────────────────────────

async function runTermuxCmd(cmd: string[], signal?: AbortSignal): Promise<string> {
  const proc = Bun.spawn({
    cmd,
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env, NO_COLOR: "1" },
    detached: true,
    signal,
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  let out = "";
  if (stdout) out += stdout;
  if (stderr) out += (out ? "\n" : "") + stderr;
  if (exitCode !== 0) out += (out ? "\n" : "") + `[exit code: ${exitCode}]`;
  return out || `(ran ${cmd[0]})`;
}
