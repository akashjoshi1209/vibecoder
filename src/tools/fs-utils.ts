import * as path from "path";
import type { ToolContext } from "./registry";
import { auditDecision, decide, type PermissionDomain } from "../permissions";

export function resolve(p: string, ctx: ToolContext): string {
  // isAbsolute() handles drive letters, UNC and POSIX roots. A bare "/x" is
  // absolute on POSIX but drive-relative on Windows (C:\x), so the old
  // startsWith("/") check mis-resolved Android/Termux paths on Windows.
  if (path.isAbsolute(p)) return path.resolve(p);
  return path.resolve(ctx.cwd, p);
}

/**
 * Workspace boundary check for file tools.
 *
 * Returns an error string when the path is outside the configured workspace
 * (permissions.filesystem === "workspace"), or null when access is fine.
 * Tools should call this before any read/write.
 *
 * Routed through decide() so the audit ring records which domain and rule
 * stopped the call; `domain` defaults to fs.read because that is what
 * search/glob-style callers do — write tools pass fs.write.
 */
export function pathDenied(p: string, ctx: ToolContext, domain: PermissionDomain = "fs.read"): string | null {
  const perms = ctx.permissions;
  // No permissions on the context means no sandbox was requested.
  if (!perms) return null;
  const abs = resolve(p, ctx);
  const d = auditDecision({ ...decide({ domain, perms, path: abs }), tool: domain });
  if (d.action === "allow") return null;
  return `BLOCKED: ${abs} is outside the allowed workspace (${perms.workspaceRoot}). Set permissions.filesystem to "full" to allow it.`;
}
