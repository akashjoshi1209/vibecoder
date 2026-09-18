import { registerTool, type ToolContext } from "./registry";
import { spawnCollect } from "./proc";

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

    const res = await spawnCollect({
      cmd: ["bash", "-lc", command],
      cwd,
      env: { ...process.env, NO_COLOR: "1" } as Record<string, string>,
      timeoutMs: timeout,
      signal: ctx.signal,
    });

    let output = "";
    if (res.stdout) output += res.stdout;
    if (res.stderr) output += res.stderr ? (output ? "\n" : "") + res.stderr : "";
    if (res.exitCode !== 0) output += (output ? "\n" : "") + `[exit code: ${res.exitCode}]`;
    if (res.timedOut) output += (output ? "\n" : "") + `[killed: timed out after ${timeout}ms]`;
    if (res.aborted) output += (output ? "\n" : "") + "[killed: interrupted]";
    if (!output) output = "(no output)";

    if (output.length > MAX_OUTPUT) {
      // Keep the tail where errors/exit codes live; trim the head (build logs).
      const keep = MAX_OUTPUT - 200;
      const trimmed = output.length - keep;
      output = `...[trimmed ${trimmed} chars from beginning]\n` + output.slice(output.length - keep);
    }

    return output;
  },
});
