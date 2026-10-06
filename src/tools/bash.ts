import { registerTool, type ToolContext } from "./registry";
import { spawnCollect } from "./proc";
import {
  destructiveReason,
  checkNetworkCommand,
  isPathAllowed,
  parseCommands,
  filterEnv,
  type Permissions,
} from "../permissions";
import { ApprovalRequiredError } from "./approval";
import { numberSetting } from "../runtime";

/**
 * Hard cap on how much command output comes back to the model.
 *
 * Overridable because the right value depends entirely on the task: a monorepo
 * `tsc` run or a full test suite needs far more than a one-line `git status`,
 * and 30k silently amputated the interesting part. Env var first (per-run),
 * then config.json (persistent), then this default.
 */
function resolveMaxOutput(): number {
  const fromEnv = Number(process.env.VIBECODER_MAX_OUTPUT);
  if (Number.isFinite(fromEnv) && fromEnv >= 2000) return Math.floor(fromEnv);
  return numberSetting("maxToolOutputChars", 30_000, 2000);
}

/**
 * Trim long output while keeping BOTH ends.
 *
 * The previous version kept only the tail, on the reasoning that errors and exit
 * codes live at the end. That is true and it is not sufficient: the head of a
 * `tsc` or `bun test` run is where the first error and the failing file list
 * are, while the tail is just "12 passed, 88 failed". Dropping the head left the
 * model with a summary and no diagnosis, and it had no way to ask for the rest.
 *
 * So we keep a head slice (first errors, file lists) and a longer tail (the
 * summary), and say exactly how much was dropped from the middle so the model
 * knows to re-run with a narrower filter rather than concluding the output was
 * short.
 */
export function capOutput(output: string, max: number): string {
  if (output.length <= max) return output;
  // 30/70 head/tail: the head carries the first failure, the tail the summary.
  const headLen = Math.max(2000, Math.floor(max * 0.3));
  const tailLen = Math.max(2000, max - headLen - 160);
  const head = output.slice(0, headLen);
  const tail = output.slice(output.length - tailLen);
  const dropped = output.length - headLen - tailLen;
  return (
    `${head}\n` +
    `[... ${dropped} characters omitted from the middle — this output was ${output.length} chars, ` +
    `the cap is ${max}. Raise it with VIBECODER_MAX_OUTPUT=<n> or config.json maxToolOutputChars, ` +
    `or re-run narrowed to what you need. ...]\n` +
    `${tail}`
  );
}

/** Commands that mutate state, independent of permissions.destructive. Plan mode
 *  is a read-only *investigation* phase, so these are refused outright even when
 *  destructive === "allow". Keyed on the parsed argv, not a raw regex, so
 *  `$(rm -rf x)`, `sh -c "rm -rf x"` and newline-separated commands are caught. */
const PLAN_MODE_BANNED: Record<string, string> = {
  rm: "file/directory-destroying command",
  rmdir: "directory removal",
  del: "file removal (del)",
  erase: "file removal (erase)",
  rd: "directory removal (rd)",
  shred: "secure file overwrite",
  mv: "moving/overwriting files",
  dd: "low-level data copying (dd)",
  mkfs: "filesystem creation",
  truncate: "file truncation",
  fdisk: "partition manipulation",
  parted: "partition manipulation",
  npm: "package manager",
  pnpm: "package manager",
  yarn: "package manager",
  bun: "runtime/package manager",
  deno: "runtime/package manager",
  pip: "pip install/remove",
  pip3: "pip install/remove",
  apt: "system package manager",
  "apt-get": "system package manager",
  dnf: "system package manager",
  yum: "system package manager",
  zypper: "system package manager",
  brew: "system package manager",
  cargo: "language package manager",
  go: "language package manager",
  kill: "process termination",
  pkill: "process termination",
  killall: "process termination",
  taskkill: "process termination",
  systemctl: "process/system control",
  service: "process/system control",
  reboot: "process/system control",
  shutdown: "process/system control",
  halt: "process/system control",
  poweroff: "process/system control",
  sudo: "sudo",
  doas: "privilege escalation",
  git: "git state mutation",
  gh: "GitHub CLI mutation",
};

const PLAN_MODE_GIT_ALLOWED = new Set([
  "status", "log", "diff", "show", "branch", "remote", "tag", "blame",
  "rev-parse", "ls-files", "describe", "shortlog", "config", "stash",
]);

/** git subcommands that are read-only even in plan mode. `git` itself is banned,
 *  so this is an allowlist of exceptions rather than a denylist. */
const PLAN_MODE_GIT_READONLY = new Set([
  "status", "log", "diff", "show", "blame", "rev-parse", "ls-files", "describe",
]);

const HELP_FLAGS = new Set(["-h", "--help", "-help", "/?", "/h", "-v", "--version"]);

/** The most reliable signal that a `find` invocation is destructive. Checking
 *  argv directly avoids relying on the raw-text regex, which missed nested
 *  forms. */
function findIsDestructive(argv: string[]): boolean {
  for (const a of argv) {
    if (a === "-delete" || a === "-exec" || a === "-execdir" || a === "-ok" || a === "-okdir") return true;
  }
  return false;
}

function planBannedReason(command: string): string | null {
  for (const cmd of parseCommands(command)) {
    const name = (cmd.argv[0] ?? "").toLowerCase().replace(/\.(exe|cmd|bat)$/, "");
    // `rm --help` is introspection, not a deletion.
    if (cmd.argv.slice(1).some((a) => HELP_FLAGS.has(a.toLowerCase()))) continue;
    // `find` is not in the ban table (plain `find .` is inspection), so its
    // deleting/exec flags are the signal. Checked before the table lookup.
    if (name === "find") {
      if (findIsDestructive(cmd.argv)) return "find deleting or executing on matches";
      continue;
    }
    const why = PLAN_MODE_BANNED[name];
    if (!why) continue;
    if (name === "git") {
      const sub = (cmd.argv[1] ?? "").toLowerCase();
      if (PLAN_MODE_GIT_READONLY.has(sub)) continue;
      // `git branch`/`git remote`/`git tag` are read-only without a mutating
      // flag, which is the common inspection case.
      if ((sub === "branch" || sub === "remote" || sub === "tag") &&
          !cmd.argv.slice(2).some((a) => /^-/.test(a) && !/^(--list|-l|-v|-a|--get|get)$/i.test(a))) {
        continue;
      }
      if (sub === "stash" && (cmd.argv[2] ?? "") === "list") continue;
      if (sub === "config" && (cmd.argv[2] ?? "") === "--get") continue;
      return `git ${sub || "state mutation"}`;
    }
    if (name === "bun" || name === "go") {
      // `bun test` / `go build` are read-only-ish; only package ops are banned.
      const sub = (cmd.argv[1] ?? "").toLowerCase();
      if (sub === "test" || sub === "build" || sub === "run" || sub === "vet") continue;
    }
    if (name === "cargo") {
      if (["test", "build", "check", "clippy"].includes((cmd.argv[1] ?? "").toLowerCase())) continue;
    }
    if (name === "python" || name === "python3" || name === "py" || name === "node") {
      continue; // running a script is an inspection action
    }
    if (name === "mv") {
      // Moving a file inside the workspace is still a write; keep it banned.
      return why;
    }
    return why;
  }
  // Output redirection and tee write files, so they are refused in plan mode
  // regardless of where they point.
  for (const cmd of parseCommands(command)) {
    if (/(^|[^0-9<>])>{1,2}|\d>&/.test(cmd.raw)) {
      const t = cmd.raw.match(/>{1,2}\s*"?([^\s"';|&]+)"?/)?.[1] ?? "";
      if (t !== "/dev/null" && t !== "NUL" && !t.startsWith("/tmp/") && !t.startsWith("/var/tmp/")) {
        return "output redirection writes a file";
      }
    }
    if ((cmd.argv[0] ?? "").toLowerCase() === "tee") return "tee writes to a file";
  }
  return null;
}

/** Back-compat alias: the plan-mode refusal reason for a command. */
export function bannedReason(command: string): string | null {
  return planBannedReason(command);
}

/** Filenames that hold live credentials and must not be dumped through bash. */
const SECRET_FILE = /(^|[\s"'=/\\])\.env(\.[A-Za-z0-9_-]+)?($|[\s"';|&])/;

/** True when any argv token of any parsed command names a dotenv file.
 *
 *  Matching on argv tokens rather than the raw string matters: quoted paths
 *  (`cat "./.env"`) and prefixed paths (`cat ../.env`, `cat /abs/.env`) all
 *  arrive as single tokens, and a raw-text scan would miss quoting and could
 *  false-positive on a filename like `environment`. */
function secretFileInvolved(command: string): string | null {
  for (const cmd of parseCommands(command)) {
    for (const tok of cmd.argv) {
      if (SECRET_FILE.test(tok)) return tok.replace(/["']/g, "");
    }
  }
  return null;
}

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
    const permissions = ctx.permissions;
    const command = String(args.command ?? "");
    if (ctx.planPhase) {
      const why = planBannedReason(command);
      if (why)
        return `BLOCKED IN PLAN MODE (read-only): ${why}. Use read-only commands (ls, grep, cat, git status/diff/log, running tests) to investigate, and describe any changes you would make in your PLAN instead.`;
    }

    // ── secret-file reads ──────────────────────────────────────────────────────
    // A dotenv holds live credentials. `cat .env` is the obvious way to lift
    // one, and env_get exists precisely so the agent never has to do that.
    if (!permissions?.exposeSecrets) {
      const secret = secretFileInvolved(command);
      if (secret) {
        return `BLOCKED: refusing to read ${secret} through bash — it holds live credentials. Use env_get("<KEY>") to read a single value (it masks), or run with --expose-secrets if you truly need the raw file.`;
      }
    }

    // ── permission checks ──────────────────────────────────────────────────────
    if (permissions) {
      // 1. Destructive command check.
      //
      // "deny" returns a refusal. "ask" throws ApprovalRequiredError so the
      // agent loop can prompt a human and re-run on approval — previously this
      // returned the string "PENDING ... awaiting approval" as the tool result,
      // so nothing ever prompted and the model just saw a soft denial it would
      // try to route around.
      if (permissions.destructive !== "allow") {
        const reason = destructiveReason(command);
        if (reason) {
          if (permissions.destructive === "deny") {
            return `BLOCKED (deny): ${reason}`;
          }
          throw new ApprovalRequiredError("bash", reason, args);
        }
      }

      // 2. Network command check. network has no "ask" state, so this is
      //    allow-or-refuse only.
      const networkCheck = checkNetworkCommand(command, permissions);
      if (networkCheck) {
        return networkCheck;
      }

      // 3. Filesystem scope check (when workdir is set, check it's within workspace)
      if (permissions.filesystem === "workspace" && args.workdir) {
        const workdir = String(args.workdir);
        if (!isPathAllowed(workdir, permissions)) {
          return `BLOCKED: workdir "${workdir}" is outside the allowed workspace (${permissions.workspaceRoot}). Use a path within the workspace.`;
        }
      }
    }
    // ──────────────────────────────────────────────────────────────────────────────

    const cwd = args.workdir ? String(args.workdir) : ctx.cwd;
    const timeout = Math.max(0, Number(args.timeout ?? 120000));

    let res;
    try {
      res = await spawnCollect({
        cmd: ["bash", "-lc", command],
        cwd,
        // Withhold API-key-shaped vars unless explicitly opted in, so
        // `printenv GROQ_API_KEY` inside bash cannot exfiltrate them.
        env: { ...filterEnv(process.env as Record<string, string | undefined>, permissions), NO_COLOR: "1" } as Record<string, string>,
        timeoutMs: timeout,
        signal: ctx.signal,
      });
    } catch (err: unknown) {
      const msg = err && typeof err === "object" && "message" in err ? String((err as Record<string, unknown>).message) : String(err);
      return `ERROR: cannot run command: ${msg}`;
    }

    let output = "";
    if (res.stdout) output += res.stdout;
    if (res.stderr) output += res.stderr ? (output ? "\n" : "") + res.stderr : "";
    if (res.exitCode !== 0) output += (output ? "\n" : "") + `[exit code: ${res.exitCode}]`;
    if (res.timedOut) output += (output ? "\n" : "") + `[killed: timed out after ${timeout}ms]`;
    if (res.aborted) output += (output ? "\n" : "") + "[killed: interrupted]";
    if (!output) output = "(no output)";

    const limit = resolveMaxOutput();
    if (output.length > limit) {
      output = capOutput(output, limit);
    }

    return output;
  },
});
