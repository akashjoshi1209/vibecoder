import type { ToolDefinition } from "../llm/types";
import { isApprovalRequired } from "./approval";

export interface ToolContext {
  cwd: string;
  signal?: AbortSignal;
  /** Plan mode: the agent is investigating and planning only — mutating tools are blocked. */
  planPhase?: boolean;
  /** Effective permissions from config. */
  permissions?: import("../permissions").Permissions;
  /** One-shot human consent, recorded by the approval flow after confirmTool
   *  says yes and cleared as soon as that re-run returns. A tool's `ask`
   *  check matches it (see approvalSig) so an approved call runs exactly once
   *  instead of asking again on its own re-run. */
  approval?: { tool: string; sig: string; at: number };
}

export interface Tool {
  definition: ToolDefinition;
  run(args: Record<string, unknown>, ctx: ToolContext): Promise<string>;
}

const registry = new Map<string, Tool>();

export function registerTool(tool: Tool): void {
  const name = tool.definition.function.name;
  const prior = registry.get(name);
  if (prior) {
    // A silent Map.set would let a duplicate name quietly replace the original
    // tool with no trace. That was live: repl.ts imports both tools/tailscale.ts
    // and tools/network.ts, which both register "tailscale_status", so whichever
    // was imported second was being discarded without a word. Two registrations
    // of the same name is always a bug.
    throw new Error(
      `Duplicate tool name "${name}". Refusing to overwrite an already-registered tool. ` +
      `Rename one of them, or make sure the old module is no longer imported.`,
    );
  }
  registry.set(name, tool);
}

export function listTools(): ToolDefinition[] {
  return [...registry.values()].map((t) => t.definition);
}

export async function executeTool(name: string, args: Record<string, unknown>, ctx: ToolContext): Promise<string> {
  const tool = registry.get(name);
  if (!tool) {
    throw new Error(`Unknown tool "${name}". Available: ${[...registry.keys()].join(", ")}`);
  }
  try {
    return await tool.run(args, ctx);
  } catch (err: any) {
    // An approval request is control flow, not an error to flatten into a
    // string. Swallowing it here is exactly what made permissions.destructive
    // "ask" a silent no-op — the loop never saw a request, so nothing prompted.
    if (isApprovalRequired(err)) throw err;
    return `ERROR: ${err?.message ?? String(err)}`;
  }
}

/** True when the active permission model may require a human decision mid-run.
 *  The agent loop uses this to avoid fanning tool calls out in parallel, since
 *  approvals have to be asked one at a time. */
export function needsApproval(ctx: ToolContext): boolean {
  return ctx.permissions?.destructive === "ask";
}
