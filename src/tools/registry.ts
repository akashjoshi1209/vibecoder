import type { ToolDefinition } from "../llm/types";
import { isApprovalRequired } from "./approval";
import { validateTool, TOOL_SCHEMA_VERSION, type ToolCostMeta, type ToolTraceEvent } from "./schema";

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
  /** Run trace for this run (--trace); tools may append their own records, and
   *  fan-out children get sibling files via trace.subTrace(). */
  trace?: import("../trace").RunTrace;
  /** Isolated child-loop runner, injected by the REPL. Absent in contexts with
   *  no model access (tests, daemon), where the `task` tool refuses. Type-only
   *  import: queue-runner pulls in this module at runtime, so keep it erased. */
  runChild?: (spec: import("../queue-runner").ChildLoopSpec) => Promise<
    import("../queue-runner").ChildLoopResult
  >;
}

export interface Tool {
  /** Locked schema (TOOL_SCHEMA_VERSION): name + JSON-schema inputs. */
  definition: ToolDefinition;
  /** Declared cost hints — the cost hook, read by the host, never computed here. */
  cost?: ToolCostMeta;
  /** Trace hook: called after every execution with wall time and outcome, so a
   *  tool can attribute internal cost or append domain context to the run
   *  trace. Must not throw (exceptions are swallowed). */
  onTrace?: (event: ToolTraceEvent) => void;
  /** Typed output: resolves the tool's string result (see schema.ts). */
  run(args: Record<string, unknown>, ctx: ToolContext): Promise<string>;
}

const registry = new Map<string, Tool>();

export function registerTool(tool: Tool): void {
  // The schema lock: every registration path (built-ins, plugins, MCP proxies)
  // validates here, so a malformed tool can never reach a provider.
  const errors = validateTool(tool);
  if (errors.length) {
    throw new Error(`Tool fails the schema lock (v${TOOL_SCHEMA_VERSION}):\n  - ${errors.join("\n  - ")}`);
  }
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
  const startedAt = Date.now();
  const emitTrace = (ok: boolean) => {
    if (!tool.onTrace) return;
    try {
      tool.onTrace({ tool: name, args, ms: Date.now() - startedAt, ok });
    } catch {
      // A tracing hook must never take down the call it is tracing.
    }
  };
  try {
    const out = await tool.run(args, ctx);
    emitTrace(!/^(ERROR|BLOCKED)/.test(out));
    return out;
  } catch (err: any) {
    emitTrace(false);
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
