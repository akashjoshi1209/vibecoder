// Project context loading: reads AGENTS.md from the workspace and injects it
// into the system prompt so the agent knows project conventions.
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

const PROJECT_CONTEXT_FILES = [
  "AGENTS.md",
  ".vibecoder/AGENTS.md",
  ".claude/agents.md",
  ".agents.md",
];

export interface ProjectContext {
  dir: string;
  content: string;
  source: string;
}

export function loadProjectContext(workspace: string): ProjectContext {
  for (const relPath of PROJECT_CONTEXT_FILES) {
    const fullPath = join(workspace, relPath);
    if (existsSync(fullPath)) {
      const content = readFileSync(fullPath, "utf8");
      if (content.trim()) {
        return { dir: workspace, content, source: fullPath };
      }
    }
  }
  return { dir: "", content: "", source: "" };
}

export function buildProjectPrompt(ctx: ProjectContext): string {
  if (!ctx.content) return "";
  return `\n\n## Project Instructions (from ${ctx.source})\n\n${ctx.content}\n`;
}

/** Load personal fallback AGENTS.md from ~/.vibecoder/AGENTS.md. */
export function loadPersonalContext(): ProjectContext {
  const p = join(homedir(), ".vibecoder", "AGENTS.md");
  if (existsSync(p)) {
    const content = readFileSync(p, "utf8");
    if (content.trim()) return { dir: p, content, source: p };
  }
  return { dir: "", content: "", source: "" };
}
