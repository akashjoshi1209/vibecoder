import type { ToolDefinition } from "../llm/types";

export interface ToolContext {
  cwd: string;
  signal?: AbortSignal;
  /** Plan mode: the agent is investigating and planning only — mutating tools are blocked. */
  planPhase?: boolean;
  /** Effective permissions from config. */
  permissions?: import("../permissions").Permissions;
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
    return `ERROR: ${err?.message ?? String(err)}`;
  }
}
