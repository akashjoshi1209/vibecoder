// Approval signalling for tools.
//
// The permission model has three states for destructive commands:
//   "allow"  run freely
//   "ask"    ask the human first
//   "deny"   refuse outright
//
// "ask" used to be a no-op. `checkDestructiveCommand` returned the string
// "PENDING (ask) — awaiting approval" and bash.ts handed that straight back as
// the tool result, so nothing ever prompted: the model received a sentence that
// looked like a soft denial and typically retried with something sneakier.
// Meanwhile the only real prompt in the system was `/approve on`, driven by
// tui.approveMode, which knew nothing about permissions. Two approval mechanisms
// that could not see each other.
//
// This module is the fix. A tool that needs consent throws ApprovalRequiredError
// instead of returning a string. The agent loop catches it, asks the human via
// confirmTool, and re-runs the tool if approved. "ask" now actually asks.

export class ApprovalRequiredError extends Error {
  /** Tool that wanted to run, e.g. "bash". */
  readonly tool: string;
  /** Human-readable justification, e.g. "file/directory removal (rm)". */
  readonly reason: string;
  /** The arguments as the model supplied them, for display. */
  readonly args: Record<string, unknown>;

  constructor(tool: string, reason: string, args: Record<string, unknown> = {}) {
    super(`approval required: ${tool} — ${reason}`);
    this.name = "ApprovalRequiredError";
    this.tool = tool;
    this.reason = reason;
    this.args = args;
  }
}

/** True for ApprovalRequiredError without relying on instanceof across module
 *  instances (bundlers can duplicate classes; the name check is stable). */
export function isApprovalRequired(err: unknown): err is ApprovalRequiredError {
  return (
    err instanceof ApprovalRequiredError ||
    (typeof err === "object" &&
      err !== null &&
      (err as { name?: string }).name === "ApprovalRequiredError" &&
      typeof (err as { reason?: unknown }).reason === "string")
  );
}

/** Stable signature of one approval request (tool + exact arguments).
 *
 *  The loop records this on the ToolContext after confirmTool says yes, so the
 *  immediate re-run can prove the human's consent covers exactly this call —
 *  without it, a tool whose `ask` check is a pure function of the command
 *  would ask forever: approve, re-run, ask again, end in "no approver". */
export function approvalSig(tool: string, args: Record<string, unknown>): string {
  return `${tool} ${JSON.stringify(args)}`;
}

/** Message handed back to the model when a human declines. */
export function rejectedMessage(tool: string, reason: string): string {
  return (
    `BLOCKED: the human declined to run ${tool} (${reason}). ` +
    `Do not retry this action or find a workaround for it. ` +
    `Either pick a different approach that avoids it, or finish and tell the user ` +
    `what you needed and why.`
  );
}

/** Message handed back when nothing can prompt. */
export function noPrompterMessage(tool: string, reason: string): string {
  return (
    `BLOCKED: ${tool} needs approval (${reason}) but no approver is attached to this run. ` +
    `Unattended runs cannot ask. Either run with destructive:"allow" in config.json, ` +
    `or set destructive:"deny" so this fails fast and loudly rather than looking approved.`
  );
}