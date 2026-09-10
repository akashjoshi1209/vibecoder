import * as path from "path";
import type { ToolContext } from "./registry";

export function resolve(p: string, ctx: ToolContext): string {
  if (p.startsWith("/")) return path.resolve(p);
  return path.resolve(ctx.cwd, p);
}
