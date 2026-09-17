import { registerTool, type ToolContext } from "./registry";

const MAX_OUTPUT = 30000;

const PLAN_MODE_BANNED: { re: RegExp; why: string }[] = [
  { re: /(^|[;&|]\s*)(rm|rmdir|mv|dd|mkfs(\.[a-z0-9]+)?|truncate|fdisk|parted|mkfs)\s/, why: "file/directory-destroying command" },
  { re: /(^|[;&|]\s*)git\s+(reset\s+--hard|clean\s+-(f|d|fd)|checkout\s+\S+\s+--?[^;]*|push\b|remote\s+set-url|branch\s+-D|stash\s+drop|rebase\b|merge\b|cherry-pick\b)/, why: "git state mutation" },
  { re: /(^|[;&|]\s*)(npm|pnpm|yarn|bun|deno)\s+(i|install|add|update|remove|uninstall|upgrade)\b/, why: "package manager install/remove" },
  { re: /(^|[;&|]\s*)(pip|pip3)\s+(install|uninstall|download)\b/, why: "pip install/remove" },
  { re: /(^|[;&|]\s*)(apt|apt-get|dnf|yum|zypper|brew)\s+(install|remove|uninstall|purge|update|upgrade)\b/, why: "system package manager" },
  { re: /(^|[;&|]\s*)(cargo|go)\s+(install|add)\b/, why: "language package manager" },
  { re: /\b(kill|pkill|killall|systemctl|service|reboot|shutdown|halt|poweroff|init|swapoff|mkswap)\b/, why: "process/system control" },
  { re: /(^|[;&|]\s*)sudo\b/, why: "sudo" },
  { re: /\s(>|>>|2>)\s*/, why: "output redirection writes a file" },
  { re: /\btee\s+-?a?\s+/, why: "tee writes to a file" },
];

function bannedReason(command: string): string | null {
  const c = command.trim();
  for (const { re, why } of PLAN_MODE_BANNED) {
    if (re.test("\n" + c + "\n")) return why;
  }
  return null;
}
export { bannedReason };

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
    if (ctx.planPhase) {
      const why = bannedReason(command);
      if (why)
        return `BLOCKED IN PLAN MODE (read-only): ${why}. Use read-only commands (ls, grep, cat, git status/diff/log, running tests) to investigate, and describe any changes you would make in your PLAN instead.`;
    }
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

      if (output.length > MAX_OUTPUT) {
        // Keep the tail where errors/exit codes live; trim the head (build logs).
        const keep = MAX_OUTPUT - 200;
        const trimmed = output.length - keep;
        output = `...[trimmed ${trimmed} chars from beginning]\n` + output.slice(output.length - keep);
      }

      return output;
    } finally {
      if (timer) clearTimeout(timer);
      ctx.signal?.removeEventListener("abort", onAbort);
    }
  },
});
