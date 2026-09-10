import type { ToolDefinition } from "../llm/types";

export interface ToolContext {
  cwd: string;
  signal?: AbortSignal;
}

export interface Tool {
  definition: ToolDefinition;
  run(args: Record<string, unknown>, ctx: ToolContext): Promise<string>;
}

const registry = new Map<string, Tool>();

export function registerTool(tool: Tool): void {
  registry.set(tool.definition.function.name, tool);
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
