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
  };
}

export function resolvePermissions(config: PermissionsConfig, workspaceRoot: string): Permissions {
  const p = config.permissions ?? {};
  return {
    destructive: p.destructive ?? "allow",
    network: p.network ?? "allow",
    filesystem: p.filesystem ?? "full",
    workspaceRoot,
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

export function checkDestructiveCommand(command: string, perms: Permissions): string | null {
  if (perms.destructive === "allow") return null;
  const c = command.trim();
  const segments = c.split(/([;&|]|&&|\|\|)/).map((s) => s.trim()).filter(Boolean);
  for (const seg of segments) {
    const reason = checkSingleSegment(seg);
    if (reason) {
      return perms.destructive === "deny"
        ? `BLOCKED (${perms.destructive}): ${reason}`
        : `PENDING (${perms.destructive}): ${reason} — awaiting approval`;
    }
  }
  return null;
}

function checkSingleSegment(seg: string): string | null {
  const destructiveFileOps = [
    { re: /^(rm|rmdir)\s/, why: "file/directory removal (rm/rmdir)" },
    { re: /^\s*dd\s/, why: "low-level data copying (dd)" },
    { re: /^(mkfs|mkswap)\s/, why: "filesystem creation/destruction (mkfs/mkswap)" },
    { re: /^(truncate|fdisk|parted)\s/, why: "disk/partition manipulation" },
    { re: /\b(kill|pkill|killall|systemctl|reboot|shutdown|halt|poweroff)\b/, why: "process/system control" },
    { re: /\b(sudo|doas)\b/, why: "privilege escalation (sudo/doas)" },
  ];
  for (const { re, why } of destructiveFileOps) {
    if (re.test(seg)) return why;
  }
  if (/\s[>|]\s*\S/.test(seg) || /\s>>\s*\S/.test(seg)) {
    const redirectTarget = seg.match(/[>|]\s*(\S+)/);
    if (redirectTarget) {
      const target = redirectTarget[1];
      if (target === "/dev/null" || target.startsWith("/tmp/") || target.startsWith("/var/tmp/")) return null;
    }
    return "output redirection (may overwrite files)";
  }
  return null;
}

export function checkNetworkCommand(command: string, perms: Permissions): string | null {
  if (perms.network === "allow") return null;
  const c = command.trim();
  const networkCommands = [
    { re: /\b(curl|wget|fetch|nc|ncat|netcat|telnet|scp|ssh|rsync)\b/, why: "network client (curl/wget/ssh/etc.)" },
    { re: /\b(dig|nslookup|host|ping|traceroute|mtr)\b/, why: "network diagnostic" },
    { re: /\b(sock|netstat|lsof\s+-i)\b/, why: "network inspection" },
  ];
  for (const { re, why } of networkCommands) {
    if (re.test(c)) return `BLOCKED (${perms.network}): ${why}`;
  }
  return null;
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
