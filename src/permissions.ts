// Permission enforcement for tool execution.
import { isAbsolute, join, resolve, dirname, basename } from "node:path";
import { realpathSync } from "node:fs";
import { homedir } from "node:os";

export type PermissionDestructive = "allow" | "ask" | "deny";
export type PermissionNetwork = "allow" | "deny";
export type PermissionFilesystem = "workspace" | "full";

export interface Permissions {
  destructive: PermissionDestructive;
  network: PermissionNetwork;
  filesystem: PermissionFilesystem;
  workspaceRoot: string;
  /** When false, API-key-shaped env vars are withheld from spawned children. */
  exposeSecrets: boolean;
}

/** Structural shape of the `permissions` block in config.json.
 *  Declared locally instead of importing RootConfig: client.ts re-exports
 *  loadConfig from config.ts, which imports RootConfig back from client.ts, so
 *  importing it here drags that cycle in and TS reports TS2307. */
export interface PermissionsConfig {
  permissions?: {
    destructive?: PermissionDestructive;
    network?: PermissionNetwork;
    filesystem?: PermissionFilesystem;
    exposeSecrets?: boolean;
  };
}

export function resolvePermissions(config: PermissionsConfig, workspaceRoot: string): Permissions {
  const p = config.permissions ?? {};
  return {
    destructive: p.destructive ?? "allow",
    network: p.network ?? "allow",
    filesystem: p.filesystem ?? "full",
    workspaceRoot,
    exposeSecrets: p.exposeSecrets ?? false,
  };
}

export function isPathAllowed(path: string, perms: Permissions): boolean {
  if (perms.filesystem === "full") return true;
  const resolved = resolvePath(path);
  const root = resolvePath(perms.workspaceRoot);
  if (resolved === root) return true;
  // Compare on a separator-normalised, case-folded form so the check works on
  // Windows too, and so a sibling like `<root>-evil` cannot pass as `<root>`.
  const sep = process.platform === "win32" ? "\\" : "/";
  const norm = (p: string) => {
    const n = p.replace(/[\\/]+/g, sep);
    const folded = process.platform === "win32" ? n.toLowerCase() : n;
    // strip a trailing separator (but keep a bare root like "C:\")
    return folded.length > 1 && folded.endsWith(sep) ? folded.slice(0, -1) : folded;
  };
  const nr = norm(resolved);
  const nroot = norm(root);
  return nr.startsWith(nroot + sep);
}


// ── parse & classify (moved to ./permissions/parse) ──────────────────────────
//
// The classifier answers "what would this command do?" and is pure: no
// Permissions, no I/O, no policy. This file keeps only the policy half - "may
// it run?" - plus the audit trail of what was decided. Everything a tool needs
// about a command's intent arrives through the re-exports below.
import { destructiveReason, networkReason, parseCommands } from "./permissions/parse";
export { destructiveReason, networkReason, parseCommands } from "./permissions/parse";
export type { SimpleCommand } from "./permissions/parse";

// ── decision core ────────────────────────────────────────────────────────────
//
// One evaluator for every permission question a tool can ask. A tool hands in
// a domain, its permissions, and the classifier's finding (reason); it gets
// back allow / ask / deny plus the rule that decided - and the decision joins
// a bounded audit ring, so any tool result can be traced to domain + rule.

export type PermissionDomain =
  | "fs.read"
  | "fs.write"
  | "shell.exec"
  | "shell.destructive"
  | "shell.network"
  | "plan.exec"
  | "env.secret"
  | "sandbox.write"
  | "unknown";

export type DecisionAction = "allow" | "ask" | "deny";

export interface PermissionDecision {
  /** Which capability was asked about. */
  domain: PermissionDomain;
  /** The rule that decided, e.g. "destructive=ask" or "fs=outside-workspace". */
  rule: string;
  action: DecisionAction;
  /** Classifier finding the decision rests on, when there is one. */
  reason?: string;
  /** Tool that asked, filled in by callers that know it. */
  tool?: string;
  at: number;
}

/**
 * Answer one permission question.
 *
 * `reason` is the classifier's finding (from ./permissions/parse); null/absent
 * means the action looked innocuous. Domains not handled here fail closed:
 * ask when a human can answer, deny when nobody can - an unlisted domain
 * getting a silent allow is exactly the drift this function exists to stop.
 */
export function decide(input: {
  domain: PermissionDomain;
  perms?: Permissions;
  reason?: string | null;
  path?: string;
  interactive?: boolean;
}): PermissionDecision {
  const reason = input.reason ?? null;
  const perms = input.perms;
  const at = Date.now();
  const d = (rule: string, action: DecisionAction, extra?: Partial<PermissionDecision>): PermissionDecision => ({
    domain: input.domain,
    rule,
    action,
    reason: reason ?? undefined,
    at,
    ...extra,
  });
  switch (input.domain) {
    case "shell.destructive": {
      const mode = perms?.destructive ?? "allow";
      if (!reason) return d("destructive=allow", "allow");
      return d(`destructive=${mode}`, mode === "allow" ? "allow" : mode === "deny" ? "deny" : "ask");
    }
    case "shell.network": {
      const mode = perms?.network ?? "allow";
      if (!reason) return d("network=allow", "allow");
      // network has no "ask" state: allow or refuse.
      return d(`network=${mode}`, mode === "allow" ? "allow" : "deny");
    }
    case "plan.exec":
      // Plan mode is a read-only investigation phase: a banned command is
      // refused outright even when destructive is "allow".
      return d("plan-phase=readonly", reason ? "deny" : "allow");
    case "env.secret": {
      const expose = perms?.exposeSecrets ?? false;
      return d(`exposeSecrets=${expose}`, reason && !expose ? "deny" : "allow");
    }
    case "fs.read":
    case "fs.write": {
      if (!perms || perms.filesystem === "full" || !input.path) {
        return d(`fs=${perms?.filesystem ?? "full"}`, "allow");
      }
      if (isPathAllowed(input.path, perms)) return d("fs=workspace", "allow");
      return d("fs=outside-workspace", "deny", {
        reason: `path outside the workspace (${perms.workspaceRoot})`,
      });
    }
    case "sandbox.write": {
      // Sandbox write-allowlist: with filesystem="workspace" the shell's
      // redirection targets must stay inside the workspace (which contains the
      // sandbox scratch dir, .vibecoder/tmp). Outside → ask when a human can
      // answer ("unless approved"), deny when nobody can.
      if (!perms || perms.filesystem !== "workspace") return d("sandbox=off", "allow");
      if (!input.path) {
        return d("sandbox=write-allowlist", input.interactive ? "ask" : "deny", {
          reason: "no write target given",
        });
      }
      if (isPathAllowed(input.path, perms)) {
        return d("sandbox=write-allowlist", "allow");
      }
      return d("sandbox=write-allowlist", input.interactive ? "ask" : "deny", {
        reason: `write target outside the workspace (${perms.workspaceRoot})`,
      });
    }
    case "shell.exec":
      // Plain execution: destructive and network checks fire separately with
      // their own findings, so there is nothing policy-shaped to decide here.
      return d("shell=default", "allow");
    default:
      return d("policy=unlisted-domain", input.interactive ? "ask" : "deny");
  }
}

/** Live listeners (the run trace) are notified of every audited decision —
 *  the seam that lets a trace record permission outcomes without threading a
 *  tracer through each tool. A listener that throws must not turn a permission
 *  check into a failure, so each call is guarded. */
export type DecisionListener = (d: PermissionDecision) => void;
const decisionListeners = new Set<DecisionListener>();

/** Subscribe to every audited decision; returns an unsubscribe function. */
export function onPermissionDecision(cb: DecisionListener): () => void {
  decisionListeners.add(cb);
  return () => {
    decisionListeners.delete(cb);
  };
}

/** Bounded audit of recent decisions. Ring-buffered: this is a debugging aid,
 *  not a security log, and it must not grow without bound in a long run. */
const AUDIT_MAX = 200;
const auditRing: PermissionDecision[] = [];

/** Record a decision (returns it unchanged, so it can wrap a decide() call). */
export function auditDecision(d: PermissionDecision): PermissionDecision {
  auditRing.push(d);
  if (auditRing.length > AUDIT_MAX) auditRing.shift();
  for (const cb of decisionListeners) {
    try {
      cb(d);
    } catch {
      // A broken listener must never fail the check itself.
    }
  }
  return d;
}

export function permissionAudit(): readonly PermissionDecision[] {
  return auditRing;
}

/** Tests only. */
export function clearPermissionAudit(): void {
  auditRing.length = 0;
}

/**
 * Why a command is destructive under the current policy, or null.
 *
 * Routes through decide() so the answer carries a domain and a rule into the
 * audit ring; the returned strings keep their historical wording because the
 * agent loop and tests match on them.
 */
export function checkDestructiveCommand(command: string, perms: Permissions): string | null {
  const d = auditDecision(decide({ domain: "shell.destructive", perms, reason: destructiveReason(command) }));
  if (d.action === "allow") return null;
  return d.action === "deny"
    ? `BLOCKED (${perms.destructive}): ${d.reason}`
    : `PENDING (${perms.destructive}): ${d.reason} — awaiting approval`;
}

/** Network-policy wrapper over the classifier, same shape as above. */
export function checkNetworkCommand(command: string, perms: Permissions): string | null {
  const d = auditDecision(decide({ domain: "shell.network", perms, reason: networkReason(command) }));
  if (d.action === "allow") return null;
  return `BLOCKED (${perms.network}): ${d.reason}`;
}

function resolvePath(p: string): string {
  let expanded = p;
  if (expanded === "~") expanded = homedir();
  else if (expanded.startsWith("~/") || expanded.startsWith("~\\")) {
    expanded = join(homedir(), expanded.slice(2));
  }
  // isAbsolute() understands drive letters, UNC and POSIX roots. The old
  // `startsWith("/")` check treated "/data/x" as absolute on Windows, where
  // Node resolves it against the current drive instead (C:\data\x).
  if (!isAbsolute(expanded)) expanded = join(process.cwd(), expanded);
  // Resolve before comparing so "..", "." and symlink-style segments cannot
  // escape the workspace root.
  return realPath(resolve(expanded));
}

/**
 * Collapse symlinks/junctions so a link *inside* the workspace cannot point out
 * of it. `path.resolve` is purely lexical and would happily allow
 * `<root>/escape-link/secret.txt`.
 *
 * realpathSync throws when the leaf does not exist yet (normal for a file about
 * to be created), so walk up to the deepest ancestor that does exist, resolve
 * that, then re-append the remaining segments.
 */
function realPath(abs: string): string {
  const tail: string[] = [];
  let current = abs;
  // Bounded walk; the filesystem root always exists, so this terminates.
  for (let i = 0; i < 64; i++) {
    try {
      const real = realpathSync.native(current);
      return tail.length ? join(real, ...tail.reverse()) : real;
    } catch {
      const parent = dirname(current);
      if (parent === current) return abs; // hit the root; give up gracefully
      tail.push(basename(current));
      current = parent;
    }
  }
  return abs;
}

/** Env var names that look like credentials. Withheld from spawned children
 *  unless `permissions.exposeSecrets` is true. */
const SECRET_NAME = /(KEY|TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIAL|API_KEY|ACCESS_KEY|PRIVATE_KEY|SESSION|COOKIE|AUTH)/i;

export function filterEnv(
  env: Record<string, string | undefined>,
  perms: Permissions | undefined,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(env)) {
    if (v === undefined) continue;
    // VIBECODER_* must survive: the CLI's own plumbing reads them.
    if (perms?.exposeSecrets) { out[k] = v; continue; }
    if (SECRET_NAME.test(k) && !k.startsWith("VIBECODER_")) continue;
    out[k] = v;
  }
  return out;
}
