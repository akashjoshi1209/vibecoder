import { registerTool, type ToolContext } from "./registry";
import { spawnCollect } from "./proc";

/**
 * Read-only Git operations. Use these to inspect repo state without touching it.
 * All commands are read-only: status, log, diff, branch, remote, tag, show.
 * Fast-forward only push and remote URL read included where non-mutating.
 * Destructive git commands (reset --hard, clean -fd, rebase, merge, cherry-pick,
 * push --force, branch -D, stash drop) are NOT exposed here — use bash if you
 * really need them and have been told it is safe.
 */
registerTool({
  definition: {
    type: "function",
    function: {
      name: "git_status",
      description:
        "Show the working tree status (git status --short --branch). Returns the current branch, ahead/behind tracking info, and staged/unstaged/untracked file listings. Read-only.",
      parameters: { type: "object", properties: {} },
    },
  },
  async run(_args: Record<string, unknown>, ctx: ToolContext): Promise<string> {
    return runGit(["status", "--short", "--branch", "--porcelain"],
      "git status --short --branch", ctx);
  },
});

registerTool({
  definition: {
    type: "function",
    function: {
      name: "git_log",
      description:
        "Show recent commit history (git log --oneline --decorate -20). Returns the last 20 commits with abbrev hashes, subjects, and decorations. Read-only.",
      parameters: {
        type: "object",
        properties: {
          n: { type: "number", description: "Number of commits to show (optional, default 20, max 100)" },
        },
      },
    },
  },
  async run(args: Record<string, unknown>, ctx: ToolContext): Promise<string> {
    const n = Math.min(100, Math.max(1, Number(args.n ?? 20) || 20));
    return runGit(["log", "--oneline", "--decorate", "-n", String(n)],
      `git log --oneline --decorate -n ${n}`, ctx);
  },
});

registerTool({
  definition: {
    type: "function",
    function: {
      name: "git_diff",
      description:
        "Show unstaged changes (git diff) and staged changes (git diff --cached) concisely. Returns both diffs (or a note if there are none). Read-only.",
      parameters: {
        type: "object",
        properties: {
          maxLines: { type: "number", description: "Max lines to return per diff (optional, default 80)" },
        },
      },
    },
  },
  async run(args: Record<string, unknown>, ctx: ToolContext): Promise<string> {
    const maxLines = Math.max(10, Number(args.maxLines ?? 80) || 80);
    const [unstaged, staged] = await Promise.all([
      runGit(["diff"], "git diff", ctx),
      runGit(["diff", "--cached"], "git diff --cached", ctx),
    ]);
    const head = unstaged || staged ? "" : "nothing to show (no unstaged or staged changes)";
    const lines: string[] = [];
    if (unstaged) {
      lines.push("--- unstaged changes ---");
      lines.push(truncate(unstaged, maxLines));
    }
    if (staged) {
      lines.push("--- staged changes ---");
      lines.push(truncate(staged, maxLines));
    }
    if (!unstaged && !staged) lines.push(head);
    return lines.join("\n");
  },
});

registerTool({
  definition: {
    type: "function",
    function: {
      name: "git_branch",
      description:
        "List local and remote branches (git branch -vv, git branch -r). Returns local branches with upstream tracking, then remote branches. Read-only.",
      parameters: { type: "object", properties: {} },
    },
  },
  async run(_args: Record<string, unknown>, ctx: ToolContext): Promise<string> {
    const [local, remote] = await Promise.all([
      runGit(["branch", "-vv"], "git branch -vv", ctx),
      runGit(["branch", "-r"], "git branch -r", ctx),
    ]);
    const lines: string[] = [];
    if (local) lines.push("--- local branches ---"); lines.push(local);
    if (remote) lines.push("--- remote branches ---"); lines.push(remote);
    return lines.join("\n") || "(no branches found)";
  },
});

registerTool({
  definition: {
    type: "function",
    function: {
      name: "git_remote",
      description:
        "Show configured remotes (git remote -v). Returns fetch/push URLs for each remote. Read-only.",
      parameters: { type: "object", properties: {} },
    },
  },
  async run(_args: Record<string, unknown>, ctx: ToolContext): Promise<string> {
    return runGit(["remote", "-v"], "git remote -v", ctx) || "(no remotes configured)";
  },
});

registerTool({
  definition: {
    type: "function",
    function: {
      name: "git_tag",
      description:
        "List tags (git tag -l, newest first). Returns all tags sorted by version. Read-only.",
      parameters: {
        type: "object",
        properties: {
          pattern: { type: "string", description: "Optional glob pattern to filter tags (e.g. 'v1.*')" },
        },
      },
    },
  },
  async run(args: Record<string, unknown>, ctx: ToolContext): Promise<string> {
    const pattern = String(args.pattern ?? "").trim();
    const cmd = pattern ? ["tag", "-l", pattern] : ["tag", "-l"];
    const out = await runGit(cmd, `git tag -l${pattern ? " " + pattern : ""}`, ctx);
    if (!out) return "(no tags found)";
    return out.split("\n").sort().reverse().join("\n");
  },
});

registerTool({
  definition: {
    type: "function",
    function: {
      name: "git_show",
      description:
        "Show a commit (git show --stat). Returns the commit metadata and stat. Pass a commit-ish (hash, tag, branch, HEAD~N). Defaults to HEAD. Read-only.",
      parameters: {
        type: "object",
        properties: {
          ref: { type: "string", description: "Commit-ish to show (optional, default HEAD)" },
        },
      },
    },
  },
  async run(args: Record<string, unknown>, ctx: ToolContext): Promise<string> {
    const ref = String(args.ref ?? "HEAD").trim() || "HEAD";
    return runGit(["show", "--stat", "--oneline", ref], `git show --stat ${ref}`, ctx);
  },
});

registerTool({
  definition: {
    type: "function",
    function: {
      name: "git_push_ff",
      description:
        "Push the current branch to its upstream, fast-forward only (git push --ff-only). Safe non-destructive push. Returns the push output or a note if there is no upstream. Read-only in effect (no force, no rebase).",
      parameters: {
        type: "object",
        properties: {
          remote: { type: "string", description: "Remote name (optional, default origin)" },
        },
      },
    },
  },
  async run(args: Record<string, unknown>, ctx: ToolContext): Promise<string> {
    const remote = String(args.remote ?? "origin").trim() || "origin";
    // Determine current branch.
    const branchOut = await runGit(["rev-parse", "--abbrev-ref", "HEAD"], "git rev-parse --abbrev-ref HEAD", ctx);
    const branch = branchOut.trim();
    if (!branch || branch === "HEAD") return "NOTE: not on a named branch (detached HEAD) — nothing to push";
    const push = await runGit(["push", "--ff-only", remote, branch], `git push --ff-only ${remote} ${branch}`, ctx);
    if (push.includes("Everything up-to-date")) return `up to date on ${remote}/${branch}`;
    return push;
  },
});

// ── helpers ───────────────────────────────────────────────────────────────────

async function runGit(args: string[], label: string, ctx: ToolContext): Promise<string> {
  const res = await spawnCollect({
    cmd: ["git", ...args],
    cwd: ctx.cwd,
    env: { ...process.env, NO_COLOR: "1", GIT_PAGER: "cat" },
    signal: ctx.signal,
  });
  let out = "";
  if (res.stdout) out += res.stdout;
  if (res.stderr) out += res.stderr ? (out ? "\n" : "") + res.stderr : "";
  if (res.exitCode !== 0) out += (out ? "\n" : "") + `[exit code: ${res.exitCode}]`;
  if (!out) out = "(no output)";
  return out;
}

function truncate(s: string, maxLines: number): string {
  const lines = s.split("\n");
  if (lines.length <= maxLines) return s;
  return lines.slice(0, maxLines).join("\n") + `\n...[${lines.length - maxLines} more lines truncated]`;
}
