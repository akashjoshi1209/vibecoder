import { registerTool, type ToolContext } from "./registry";
import { spawnCollect } from "./proc";

const ENV = () => ({ ...process.env, NO_COLOR: "1" }) as Record<string, string>;

/**
 * Run a Termux:API command and normalize stdout/stderr/exit code into a single
 * string. spawnCollect never throws, so a missing binary surfaces as a
 * negative exit code and gets a clear "install termux-api" hint.
 */
async function runTermux(
  cmd: string[],
  ctx: ToolContext,
  opts: { timeoutMs?: number; emptyText?: string } = {},
): Promise<string> {
  const res = await spawnCollect({
    cmd,
    env: ENV(),
    timeoutMs: opts.timeoutMs ?? 30_000,
    signal: ctx.signal,
  });

  if (res.exitCode < 0) {
    return `ERROR: ${cmd[0]} failed: ${res.stderr.trim() || "could not be spawned"} (is termux-api installed? pkg install termux-api)`;
  }

  let output = "";
  if (res.stdout) output += res.stdout;
  if (res.stderr) output += res.stderr ? (output ? "\n" : "") + res.stderr : "";
  if (res.timedOut) output += (output ? "\n" : "") + "[killed: timed out]";
  if (res.aborted) output += (output ? "\n" : "") + "[killed: interrupted]";
  if (!res.timedOut && !res.aborted && res.exitCode !== 0) {
    output += (output ? "\n" : "") + `[exit code: ${res.exitCode}]`;
  }
  return output || opts.emptyText || `(ran ${cmd[0]})`;
}

/**
 * Push a notification to the Android status bar via Termux:API
 * (termux-notification). Use at the end of long tasks so the user can step
 * away and still be alerted. Inert when termux-notification isn't installed.
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
          title: { type: "string", description: "Notification title (short, ≤100 chars)" },
          message: { type: "string", description: "Notification body (optional, ≤500 chars; defaults to title)" },
        },
        required: ["title"],
      },
    },
  },
  async run(args: Record<string, unknown>, ctx: ToolContext): Promise<string> {
    const title = String(args.title ?? "").slice(0, 100);
    const message = String(args.message ?? title).slice(0, 500);
    if (!title) return "ERROR: title is required";
    return runTermux(["termux-notification", "--title", title, "--content", message], ctx, {
      emptyText: `notification pushed: "${title}"`,
    });
  },
});

/**
 * Acquire or release a Termux wake lock so the phone does not sleep while the
 * agent works. Without args (or acquire=true) → acquire; acquire=false → release.
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
    return runTermux(acquire ? ["termux-wake-lock"] : ["termux-wake-unlock"], ctx, {
      emptyText: acquire ? "wake lock acquired" : "wake lock released",
    });
  },
});

/**
 * Battery status via termux-battery-status (Termux:API). Returns level,
 * charging state, temperature, voltage. Useful before long tasks to confirm
 * the phone is charging and will not die mid-run. Inert when the binary isn't
 * on PATH.
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
    return runTermux(["termux-battery-status"], ctx, { emptyText: "(no battery output)" });
  },
});
