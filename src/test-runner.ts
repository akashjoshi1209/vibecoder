// Auto-test runner: runs project tests after file edits and reports results.
// Detects project type from common config files and runs the appropriate
// test command. Integrates with the agent loop to optionally auto-run after
// batches of file edits.
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { spawnCollect } from "./tools/proc";
import { registerTool, type ToolContext } from "./tools/registry";

export interface TestConfig {
  /** Command to run tests. Auto-detected if not set. */
  command?: string;
  /** Working directory to run tests in. Defaults to workspace root. */
  cwd?: string;
  /** Whether to auto-run tests after file edits. */
  autoRun?: boolean;
  /** Maximum number of test iterations when auto-running after failures. */
  maxIterations?: number;
  /** Timeout per test run in ms. */
  timeoutMs?: number;
}

export interface TestResult {
  /** The command that was run. */
  command: string;
  /** Exit code (0 = pass, non-zero = fail). */
  exitCode: number;
  /** stdout from the test run. */
  stdout: string;
  /** stderr from the test run. */
  stderr: string;
  /** Total time in ms. */
  durationMs: number;
  /** Whether the test run passed (exit code 0). */
  passed: boolean;
}

/**
 * Detect the project type and suggest a test command.
 * Checks common project config files in order.
 */
export function detectTestCommand(workspace: string): string | null {
  // Node.js / Bun
  const packageJson = join(workspace, "package.json");
  if (existsSync(packageJson)) {
    try {
      const pkg = JSON.parse(readFileSync(packageJson, "utf8"));
      if (pkg.scripts?.test) return pkg.scripts.test;
      if (pkg.scripts?.pretest) return pkg.scripts.pretest;
      // Common defaults
      if (pkg.dependencies?.jest || pkg.devDependencies?.jest) return "npx jest";
      if (pkg.dependencies?.["@playwright/test"] || pkg.devDependencies?.["@playwright/test"]) return "npx playwright test";
      if (pkg.dependencies?.vitest || pkg.devDependencies?.vitest) return "npx vitest";
      return "npm test";
    } catch {
      // fall through
    }
  }

  // Python
  if (existsSync(join(workspace, "pytest.ini")) || existsSync(join(workspace, "pyproject.toml"))) {
    return "python -m pytest";
  }
  if (existsSync(join(workspace, "unittest")) || existsSync(join(workspace, "setup.py"))) {
    return "python -m unittest discover";
  }

  // Rust
  if (existsSync(join(workspace, "Cargo.toml"))) {
    return "cargo test";
  }

  // Go
  if (existsSync(join(workspace, "go.mod"))) {
    return "go test ./...";
  }

  // Ruby
  if (existsSync(join(workspace, "Gemfile"))) {
    return "bundle exec rake test";
  }

  // Elixir
  if (existsSync(join(workspace, "mix.exs"))) {
    return "mix test";
  }

  // PHP
  if (existsSync(join(workspace, "phpunit.xml"))) {
    return "./vendor/bin/phpunit";
  }

  // Generic Make
  if (existsSync(join(workspace, "Makefile")) || existsSync(join(workspace, "makefile"))) {
    return "make test";
  }

  return null;
}

/**
 * Run the test command and return the result.
 */
export async function runTests(cfg: TestConfig, workspace: string): Promise<TestResult> {
  const command = cfg.command ?? detectTestCommand(workspace);
  if (!command) {
    return {
      command: "(no test command detected)",
      exitCode: -1,
      stdout: "",
      stderr: "Could not auto-detect a test command. Set test.command in config or create a package.json/Makefile/etc.",
      durationMs: 0,
      passed: false,
    };
  }

  const cwd = cfg.cwd ?? workspace;
  const timeoutMs = cfg.timeoutMs ?? 120000;

  const start = Date.now();
  const res = await spawnCollect({
    cmd: ["bash", "-lc", command],
    cwd,
    env: { ...process.env, NO_COLOR: "1" },
    timeoutMs,
  });
  const durationMs = Date.now() - start;

  let stdout = res.stdout || "";
  let stderr = res.stderr || "";
  if (res.exitCode !== 0 && !stdout && !stderr) {
    stdout = `(exit code ${res.exitCode})`;
  }

  return {
    command,
    exitCode: res.exitCode,
    stdout,
    stderr: res.timedOut ? (stderr + (stderr ? "\n" : "") + "[killed: timed out after " + timeoutMs + "ms]") : stderr,
    durationMs,
    passed: res.exitCode === 0 && !res.timedOut,
  };
}

/**
 * Format a test result for display to the user/agent.
 */
export function formatTestResult(result: TestResult): string {
  const status = result.passed ? "PASSED" : "FAILED";
  const icon = result.passed ? "✅" : "❌";
  const lines = [
    `${icon} Test ${status} (${result.durationMs}ms)`,
    `Command: ${result.command}`,
  ];
  if (result.stdout) {
    lines.push("");
    lines.push("--- stdout ---");
    lines.push(result.stdout.length > 2000 ? result.stdout.slice(0, 2000) + "\n...[truncated]" : result.stdout);
  }
  if (result.stderr && !result.passed) {
    lines.push("");
    lines.push("--- stderr ---");
    lines.push(result.stderr.length > 1000 ? result.stderr.slice(0, 1000) + "\n...[truncated]" : result.stderr);
  }
  return lines.join("\n");
}

// ── self-register as a tool ─────────────────────────────────────────────────────
registerTool({
  definition: {
    type: "function",
    function: {
      name: "run_tests",
      description: "Run the project's test suite. Detects the test command from package.json, Makefile, Cargo.toml, go.mod, pytest.ini, etc.",
      parameters: {
        type: "object",
        properties: {
          command: { type: "string", description: "Optional test command override (auto-detected if omitted)" },
          cwd: { type: "string", description: "Working directory to run tests in" },
        },
      },
    },
  },
  run: async (args: { command?: string; cwd?: string }, ctx: ToolContext) => {
    const result = await runTests(
      { command: args.command, cwd: args.cwd, timeoutMs: 120000 },
      ctx.cwd,
    );
    return formatTestResult(result);
  },
});
