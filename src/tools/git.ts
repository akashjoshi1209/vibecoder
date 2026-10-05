import { registerTool, type ToolContext } from "./registry";
import { spawnCollect } from "./proc";
import { pathDenied } from "./fs-utils";

// ── read-only git operations ────────────────────────────────────────────────────

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
    if (ctx.planPhase) return gitPlanBlocked("push")!;
    // A push reaches a remote and can publish or overwrite someone else's work.
    // With destructive=deny the policy layer is only consulted for shell
    // commands, so a mutating git tool has to ask the gate itself.
    if (ctx.permissions?.destructive === "deny") {
      return "BLOCKED (deny): git push publishes to a remote. Set permissions.destructive to \"ask\" or \"allow\" to permit it.";
    }
    // Determine current branch.
    const branchOut = await runGit(["rev-parse", "--abbrev-ref", "HEAD"], "git rev-parse --abbrev-ref HEAD", ctx);
    const branch = branchOut.trim();
    if (!branch || branch === "HEAD") return "NOTE: not on a named branch (detached HEAD) — nothing to push";
    const push = await runGit(["push", "--force-with-lease", remote, branch], `git push --force-with-lease ${remote} ${branch}`, ctx);
    if (push.includes("Everything up-to-date")) return `up to date on ${remote}/${branch}`;
    return push;
  },
});

// ── helpers ───────────────────────────────────────────────────────────────────

/** Git subcommands that change repository state. Plan mode is a read-only
 *  investigation phase, so these are refused there — git_commit,
 *  git_checkout_branch and git_push_ff had no planPhase check and could
 *  commit, switch branches and push while reporting nothing was touched. */
const PLAN_MODE_BANNED_GIT = new Set([
  "commit", "add", "rm", "mv", "reset", "restore", "checkout", "switch", "merge",
  "rebase", "cherry-pick", "revert", "tag", "push", "pull", "fetch", "clone",
  "init", "stash", "clean", "apply", "am", "worktree", "submodule", "filter-branch",
]);

function gitPlanBlocked(sub: string): string | null {
  if (!PLAN_MODE_BANNED_GIT.has(sub)) return null;
  return `BLOCKED IN PLAN MODE (read-only): git ${sub} changes repository state and is disabled while investigating. Record what you would commit/change in your PLAN instead; the human approves before any git state is touched.`;
}

async function runGit(args: string[], label: string, ctx: ToolContext): Promise<string> {
  // Every git tool runs in ctx.cwd, so gate that one directory centrally
  // instead of repeating the check in each tool.
  const denied = pathDenied(ctx.cwd, ctx);
  if (denied) return denied;
  if (ctx.planPhase) {
    const blocked = gitPlanBlocked(args[0] ?? "");
    if (blocked) return blocked;
  }
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

// ── git commit & branch tools (mutating) ───────────────────────────────────────

registerTool({
  definition: {
    type: "function",
    function: {
      name: "git_commit",
      description:
        "Create a commit with the given message. Stages the named files then commits. `files` is required — an unscoped `git add -A` would sweep up build artifacts and scratch files. Returns the commit hash and message.",
      parameters: {
        type: "object",
        properties: {
          message: { type: "string", description: "The commit message" },
          files: { type: "string", description: "Space-separated paths to stage (required). List exactly the files you changed." },
        },
        required: ["message", "files"],
      },
    },
  },
  async run(args: Record<string, unknown>, ctx: ToolContext): Promise<string> {
    const message = String(args.message ?? "").trim();
    if (!message) return "ERROR: commit message is required";
    const files = args.files ? String(args.files).trim() : "";
    if (ctx.planPhase) return gitPlanBlocked("commit")!;
    // `git add -A` with no explicit file list sweeps up ignored-but-present
    // artifacts and every scratch file. Require the caller to name the files.
    if (!files) {
      return "NOTE: refusing an unscoped `git add -A`. Pass `files` with a space-separated list of the exact paths to stage (e.g. files: \"src/a.ts src/b.ts\").";
    }

    // Stage
    const stageOut = await runGit(
      ["add", ...files.split(/\s+/).filter(Boolean)],
      "git add",
      ctx,
    );

    // Status after staging
    const status = await runGit(["status", "--short"], "git status --short", ctx);

    // Commit
    const commit = await runGit(["commit", "-m", message], `git commit -m "${message}"`, ctx);
    const hashMatch = commit.match(/\[(\w+\s+\d+\s+[a-f0-9]+)\]/);
    const summary = hashMatch ? hashMatch[1] : commit;

    return `Committed as:\n${summary}\n\nStaged changes:\n${status || "(none)"}`;
  },
});

registerTool({
  definition: {
    type: "function",
    function: {
      name: "git_checkout_branch",
      description:
        "Create and switch to a new branch. If the branch exists, just switches to it. Returns the new/current branch name.",
      parameters: {
        type: "object",
        properties: {
          name: { type: "string", description: "The branch name to create/switch to" },
          base: { type: "string", description: "Optional base branch to create from (default: current branch)" },
          branch: { type: "string", description: "Alias for `name`" },
        },
        required: ["name"],
      },
    },
  },
  async run(args: Record<string, unknown>, ctx: ToolContext): Promise<string> {
    // `branch` is accepted as an alias: the model reaches for either name.
    const name = String(args.name ?? args.branch ?? "").trim();
    if (!name) return 'ERROR: branch name is required (pass `name`)';
    const base = args.base ? String(args.base).trim() : "";
    if (ctx.planPhase) return gitPlanBlocked("checkout")!;
    // Guard against a branch name that shell-expands into something else.
    if (!/^[A-Za-z0-9._\/-]+$/.test(name) || name.includes("..")) {
      return `ERROR: invalid branch name "${name}". Use letters, digits, . _ / and - only.`;
    }

    let branch: string;
    if (base) {
      branch = await runGit(["checkout", "-b", name, base], `git checkout -b ${name} ${base}`, ctx);
    } else {
      branch = await runGit(["checkout", "-b", name], `git checkout -b ${name}`, ctx);
    }
    const hashMatch = branch.match(/Switched to a new branch '([^']+)'/);
    const result = hashMatch ? hashMatch[1] : branch;
    return `On branch: ${result}`;
  },
});
