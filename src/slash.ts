// ── extensible slash command registry ──────────────────────────────────────────
// Any module can register a slash command; the REPL dispatches by name.
// Registered commands appear in /help automatically.

export type SlashCommandFn = (argv: string, tui?: unknown) => Promise<boolean>;

export interface SlashCommand {
  name: string;           // e.g. "plan" → invoked as /plan
  label: string;          // human-readable, one-line
  description: string;    // one-line help text
  handler: SlashCommandFn;
}

const registry: SlashCommand[] = [];

export function registerSlashCommand(cmd: SlashCommand): void {
  registry.push(cmd);
}

export function listSlashCommands(): SlashCommand[] {
  return [...registry].sort((a, b) => a.name.localeCompare(b.name));
}

export async function dispatchSlashCommand(line: string, tui?: unknown): Promise<boolean> {
  const body = line.startsWith("/") ? line.slice(1) : line;
  const parts = body.split(/\s+/);
  const name = parts[0];
  const argv = parts.slice(1).join(" ");
  for (const cmd of registry) {
    if (cmd.name === name) return await cmd.handler(argv, tui);
  }
  return false;
}

// ── help text builder ──────────────────────────────────────────────────────────
export function slashHelpText(): string {
  const cmds = listSlashCommands();
  if (!cmds.length) return "";
  const lines = cmds.map((c) => `  ${c.name.padEnd(14)} ${c.description}`);
  return lines.join("\n");
}
