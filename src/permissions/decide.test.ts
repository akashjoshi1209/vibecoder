// Table-driven tests for the extracted classifier (./parse) and
// the decision core (decide/audit in ../permissions).
//
// The split exists so classification is testable without a Permissions object
// or a shell, and so policy (allow/ask/deny per domain) is testable without a
// classifier. These tests hold that line: parse tests never touch Permissions,
// decide tests never parse a command.
import { beforeEach, describe, expect, test } from "bun:test";
import {
  auditDecision,
  checkDestructiveCommand,
  checkNetworkCommand,
  clearPermissionAudit,
  decide,
  permissionAudit,
  resolvePermissions,
} from "../permissions";
import { destructiveReason, networkReason, parseCommands } from "./parse";

describe("parseCommands — table", () => {
  const cases: [command: string, argv0s: string[]][] = [
    ["echo hi", ["echo"]],
    ["rm -rf x", ["rm"]],
    // Substitution, backticks and nesting all flatten into real commands.
    ["echo $(rm -rf x)", ["echo", "rm"]],
    ["echo `rm -rf x`", ["echo", "rm"]],
    ["sh -c 'rm -rf x'", ["sh", "rm"]],
    ["bash -c 'rm -rf x'", ["bash", "rm"]],
    // Variable assignment resolved within the same line.
    ["R=rm; $R -rf x", ["rm"]],
    // Wrapper that executes its argument.
    ["sudo rm -rf x", ["sudo", "rm"]],
    ["env FOO=1 rm -rf x", ["env", "rm"]],
    ["xargs rm", ["xargs", "rm"]],
    // Pipelines and separators split into simple commands.
    ["find . | xargs rm", ["find", "xargs", "rm"]],
    ["echo x | tee f", ["echo", "tee"]],
    ["git status; git diff", ["git", "git"]],
    // Nested subshell recursion.
    ["echo $(sh -c 'rm x')", ["echo", "sh", "rm"]],
    // Windows-native: argv[0] keeps its case until commandName() folds it.
    ["Remove-Item -Recurse C:\\x", ["remove-item"]],
    ["del f", ["del"]],
  ];
  test.each(cases)("%s → argv0s %j", (command, argv0s) => {
    const got = parseCommands(command).map((c) => (c.argv[0] ?? "").toLowerCase().split(/[\\/]/).pop()!);
    for (const want of argv0s) expect(got).toContain(want);
  });

  test("quotes are dropped from argv, kept semantics intact", () => {
    const [cmd] = parseCommands('grep -e "foo bar" file');
    expect(cmd.argv).toEqual(["grep", "-e", "foo bar", "file"]);
  });

  test("comments terminate the segment", () => {
    const [cmd] = parseCommands("echo hi # rm -rf x");
    expect(cmd.argv[0]).toBe("echo");
    expect(parseCommands("echo hi # rm -rf x").some((c) => c.argv[0] === "rm")).toBe(false);
  });

  test("depth guard stops runaway recursion", () => {
    expect(parseCommands("x".repeat(10), 99)).toEqual([]);
  });
});

describe("classifier — destructiveReason / networkReason tables", () => {
  const destructive: [string, boolean][] = [
    ["rm -rf x", true],
    ["git clean -fd", true],
    ["git reset --hard", true],
    ["git push --force", true],
    ["find . -delete", true],
    ["dd if=/dev/zero of=/dev/sda", true],
    ["echo $(rm -rf x)", true],
    ["R=rm; $R -rf x", true],
    ["> somefile.txt", true],
    ["echo x | tee f", true],
    ["rm --help", false],
    ["git status", false],
    ["ls -la", false],
    ["echo hi", false],
  ];
  test.each(destructive)("destructiveReason(%s) → %s", (cmd, want) => {
    expect(destructiveReason(cmd) !== null).toBe(want);
  });

  const network: [string, boolean][] = [
    ["curl https://x", true],
    ["wget x", true],
    ["git clone https://x", true],
    ["python3 -c 'urlopen'", true],
    ["curl${IFS}https://x", true],
    ["ls", false],
    ["cat index.ts", false],
    ["echo done", false],
  ];
  test.each(network)("networkReason(%s) → %s", (cmd, want) => {
    expect(networkReason(cmd) !== null).toBe(want);
  });
});

describe("decide — policy per domain", () => {
  const allow = resolvePermissions({}, "/ws"); // destructive/network/fs defaults
  const ask = resolvePermissions({ permissions: { destructive: "ask" } }, "/ws");
  const deny = resolvePermissions(
    { permissions: { destructive: "deny", network: "deny", filesystem: "workspace" } },
    "/ws",
  );

  test("shell.destructive: no finding → allow, whatever the mode", () => {
    expect(decide({ domain: "shell.destructive", perms: deny, reason: null }).action).toBe("allow");
  });
  test("shell.destructive: allow/ask/deny map straight from policy", () => {
    expect(decide({ domain: "shell.destructive", perms: allow, reason: "rm" }).action).toBe("allow");
    expect(decide({ domain: "shell.destructive", perms: ask, reason: "rm" }).action).toBe("ask");
    expect(decide({ domain: "shell.destructive", perms: deny, reason: "rm" }).action).toBe("deny");
    expect(decide({ domain: "shell.destructive", perms: ask, reason: "rm" }).rule).toBe("destructive=ask");
  });

  test("shell.network: no ask state — allow or deny", () => {
    expect(decide({ domain: "shell.network", perms: allow, reason: "curl" }).action).toBe("allow");
    const d = decide({ domain: "shell.network", perms: deny, reason: "curl" });
    expect(d.action).toBe("deny");
    expect(d.rule).toBe("network=deny");
  });

  test("plan.exec: a banned command is denied outright, even with destructive=allow", () => {
    expect(decide({ domain: "plan.exec", perms: allow, reason: "rm" }).action).toBe("deny");
    expect(decide({ domain: "plan.exec", perms: allow, reason: null }).action).toBe("allow");
  });

  test("env.secret: withheld unless exposeSecrets", () => {
    // exposeSecrets defaults to false, so a classifier finding denies on
    // default permissions — that is the posture: credentials withheld unless
    // explicitly exposed.
    expect(decide({ domain: "env.secret", perms: allow, reason: "dotenv" }).action).toBe("deny");
    expect(decide({ domain: "env.secret", perms: deny, reason: "dotenv" }).action).toBe("deny");
    const exposed = resolvePermissions({ permissions: { exposeSecrets: true } }, "/ws");
    expect(decide({ domain: "env.secret", perms: exposed, reason: "dotenv" }).action).toBe("allow");
    // No finding → nothing to withhold.
    expect(decide({ domain: "env.secret", perms: allow, reason: null }).action).toBe("allow");
  });

  test("fs.*: full allows, workspace allows inside and denies outside", () => {
    const full = resolvePermissions({ permissions: { filesystem: "full" } }, "/ws");
    expect(decide({ domain: "fs.read", perms: full, path: "/etc/passwd" }).action).toBe("allow");
    expect(decide({ domain: "fs.read", perms: deny, path: "/ws/src/a.ts" }).action).toBe("allow");
    expect(decide({ domain: "fs.read", perms: deny, path: "/ws/src/a.ts" }).rule).toBe("fs=workspace");
    const out = decide({ domain: "fs.write", perms: deny, path: "/elsewhere/x" });
    expect(out.action).toBe("deny");
    expect(out.rule).toBe("fs=outside-workspace");
    expect(out.reason).toContain("outside the workspace");
  });

  test("shell.exec: plain execution is allowed — destructive/network fire separately", () => {
    expect(decide({ domain: "shell.exec", perms: deny, reason: null }).action).toBe("allow");
  });

  test("unlisted domains fail closed: ask interactively, deny unattended", () => {
    expect(decide({ domain: "unknown", perms: allow, interactive: true }).action).toBe("ask");
    expect(decide({ domain: "unknown", perms: allow }).action).toBe("deny");
    expect(decide({ domain: "unknown", perms: allow }).rule).toBe("policy=unlisted-domain");
  });
});

describe("audit ring", () => {
  beforeEach(() => clearPermissionAudit());

  test("check* helpers record domain + rule, so results stay traceable", () => {
    const deny = resolvePermissions({ permissions: { destructive: "deny", network: "deny" } }, "/ws");
    expect(checkDestructiveCommand("rm -rf x", deny)).toContain("BLOCKED");
    expect(checkNetworkCommand("curl https://x", deny)).toContain("BLOCKED");
    const log = permissionAudit();
    expect(log.length).toBe(2);
    expect(log[0].domain).toBe("shell.destructive");
    expect(log[0].rule).toBe("destructive=deny");
    expect(log[0].reason).toBeTruthy();
    expect(log[1].domain).toBe("shell.network");
    expect(log[1].rule).toBe("network=deny");
  });

  test("allows are recorded too — /permissions can show what ran, not only what stopped", () => {
    const allow = resolvePermissions({}, "/ws");
    checkDestructiveCommand("ls", allow);
    expect(permissionAudit()[0].action).toBe("allow");
  });

  test("ring is bounded at 200 entries", () => {
    for (let i = 0; i < 250; i++) {
      auditDecision({ domain: "unknown", rule: `r${i}`, action: "allow", at: Date.now() });
    }
    const log = permissionAudit();
    expect(log.length).toBe(200);
    expect(log[log.length - 1].rule).toBe("r249");
    expect(log[0].rule).toBe("r50");
  });
});
