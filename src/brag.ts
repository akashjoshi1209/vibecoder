import { registerSlashCommand } from "./slash";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));

/** dispatchSlashCommand hands the handler a loosely typed `tui`. Narrow it to the
 *  one method we actually use so printToScrollback is callable. */
interface TuiLike {
  printToScrollback?: (msg: string) => void;
}

function toTui(tui: unknown): TuiLike | null {
  return tui && typeof (tui as TuiLike).printToScrollback === "function" ? (tui as TuiLike) : null;
}

function emit(tui: unknown, msg: string): void {
  const t = toTui(tui);
  if (t) t.printToScrollback?.(msg);
  else process.stdout.write(msg + "\n");
}

function findBragSkillDir(): string {
  const candidates = [
    join(__dirname, "..", "..", "brag", "skills", "brag"),
    join(__dirname, "..", "..", "..", "..", "brag", "skills", "brag"),
    join(__dirname, "..", "..", "..", "..", "..", "brag", "skills", "brag"),
    join(process.cwd(), "brag", "skills", "brag"),
    join(process.env.HOME ?? process.env.USERPROFILE ?? "", ".claude", "skills", "brag"),
  ];
  for (const c of candidates) {
    if (c && existsSync(join(c, "SKILL.md"))) return c;
  }
  return "";
}

export function registerBragCommand() {
  registerSlashCommand({
    name: "brag",
    label: "brag",
    description: "turn the project into a launch video (reads brag skill if available)",
    async handler(argv: string, tui?: unknown): Promise<boolean> {
      const bragDir = findBragSkillDir();
      let skillContent = "";

      if (bragDir) {
        try {
          skillContent = readFileSync(join(bragDir, "SKILL.md"), "utf8");
        } catch {
          // fall through
        }
      }

      if (!skillContent) {
        // No brag skill found — give the user a helpful error
        emit(
          tui,
          toTui(tui)
            ? `no /brag skill found — clone https://github.com/latent-spaces/brag into the project or ~/.claude/skills/brag/`
            : `no /brag skill found. Clone https://github.com/latent-spaces/brag into this project or install it globally.`,
        );
        return true;
      }

      // Strip YAML frontmatter if present
      let body = skillContent;
      if (body.startsWith("---\n")) {
        const end = body.indexOf("---\n", 3);
        if (end !== -1) body = body.slice(end + 4);
      }

      // Push the brag instruction into the conversation
      const instruction = `Follow these /brag instructions for this task:\n\n${body}\n\nThe user's request: ${argv || "let's /brag"}`;

      // The slash-command API has no channel for returning text into the live
      // conversation, so stage the instruction in a temp file and point the main
      // flow at it via BRAG_INJECT_FILE.
      const { tmpdir } = await import("node:os");
      const tmpFile = join(tmpdir(), `brag-inject-${Date.now()}.md`);
      writeFileSync(tmpFile, instruction, "utf8");
      process.env.BRAG_INJECT_FILE = tmpFile;

      emit(tui, "🤖 reading /brag skill — instructions injected.");
      return true;
    },
  });
}
