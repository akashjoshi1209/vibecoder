import { registerTool, type ToolContext } from "./registry";
import { resolve } from "./fs-utils";
import { dirname, join } from "node:path";
import { mkdirSync, readdirSync, statSync } from "node:fs";
import { isSelfFile, isProtectedFile, auditSelfEdit } from "../self-edit";

function protectedError(p: string): string {
  return `ERROR: SELF-EDIT PROTECTED — ${p} is the append-only audit ledger. It cannot be modified or deleted; self-edits are recorded there automatically.`;
}

async function preWriteNote(p: string, content: string): Promise<{ ok: boolean; note: string }> {
  if (isProtectedFile(p)) return { ok: false, note: protectedError(p) };
  if (isSelfFile(p)) {
    const before = (await Bun.file(p).exists()) ? await Bun.file(p).text() : "";
    return { ok: true, note: auditSelfEdit("write_file", p, before, content, `wrote ${content.length} bytes`) };
  }
  return { ok: true, note: "" };
}

function formatSize(n: number): string {
  if (n < 1024) return `${n}B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)}K`;
  return `${(n / (1024 * 1024)).toFixed(1)}M`;
}

registerTool({
  definition: {
    type: "function",
    function: {
      name: "list_dir",
      description:
        "List the contents of a directory (non-recursive). Subdirectories are shown first with a trailing slash, then files with their size.",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "Directory to list (optional, defaults to the working directory)" },
        },
        required: [],
      },
    },
  },
  async run(args: Record<string, unknown>, ctx: ToolContext): Promise<string> {
    const p = args.path ? resolve(String(args.path), ctx) : ctx.cwd;
    let entries;
    try {
      entries = readdirSync(p, { withFileTypes: true });
    } catch (err: any) {
      return `ERROR: cannot list directory: ${err?.message ?? String(err)}`;
    }
    const rows: string[] = [];
    for (const e of entries.sort((a, b) => {
      if (a.isDirectory() !== b.isDirectory()) return a.isDirectory() ? -1 : 1;
      return a.name.localeCompare(b.name);
    })) {
      if (e.isDirectory()) {
        rows.push(`${e.name}/`);
      } else if (e.isFile()) {
        let size = "";
        try {
          const st = statSync(join(p, e.name));
          size = formatSize(st.size);
        } catch {
          size = "?";
        }
        rows.push(`${e.name}\t${size}`);
      } else {
        rows.push(`${e.name}  (${e.isSymbolicLink() ? "symlink" : "special"})`);
      }
    }
    return rows.length ? rows.join("\n") : `(empty directory: ${p})`;
  },
});

registerTool({
  definition: {
    type: "function",
    function: {
      name: "read_file",
      description:
        "Read a file from disk. Reads up to 2000 lines from the start, or from the given offset. Use for understanding existing code.",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "Absolute path to the file" },
          offset: { type: "number", description: "Line number to start reading from (optional)" },
          limit: { type: "number", description: "Max lines to read (optional)" },
        },
        required: ["path"],
      },
    },
  },
  async run(args: Record<string, unknown>, ctx: ToolContext): Promise<string> {
    const p = resolve(String(args.path), ctx);
    if (!(await Bun.file(p).exists())) return `ERROR: file not found: ${p}`;
    const text = await Bun.file(p).text();
    const lines = text.split("\n");
    // Offset 0 (or a negative/NaN value) then `lines.slice(-1)` would read the
    // LAST line; clamp so indexes always mean "1-based line number".
    const offset = Math.max(1, Number(args.offset ?? 1) || 1);
    const limit = Math.max(0, Number(args.limit ?? 2000) || 2000);
    const slice = lines.slice(offset - 1, offset - 1 + limit);
    return slice.map((l, i) => `${offset + i}: ${l}`).join("\n");
  },
});

registerTool({
  definition: {
    type: "function",
    function: {
      name: "write_file",
      description:
        "Write content to a file, overwriting it. Creates parent directories. Use for creating new files or complete rewrites. The full file content must be provided.",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "Absolute path to the file" },
          content: { type: "string", description: "Full file content to write" },
        },
        required: ["path", "content"],
      },
    },
  },
  async run(args: Record<string, unknown>, ctx: ToolContext): Promise<string> {
    if (ctx.planPhase)
      return `BLOCKED IN PLAN MODE: write_file is disabled while investigating. Record what you would write in your PLAN (FILES: ...) instead; the human approves before any file is touched.`;
    const p = resolve(String(args.path), ctx);
    const content = String(args.content ?? "");
    const guard = await preWriteNote(p, content);
    if (!guard.ok) return guard.note;
    mkdirSync(dirname(p), { recursive: true });
    await Bun.write(p, content);
    return `Wrote ${content.length} bytes to ${p}${guard.note ? "\n" + guard.note : ""}`;
  },
});

registerTool({
  definition: {
    type: "function",
    function: {
      name: "edit_file",
      description:
        "Perform an exact string replacement in a file. Use to modify part of a file without rewriting the whole thing.",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "Absolute path to the file" },
          oldString: { type: "string", description: "The exact text to find and replace" },
          newString: { type: "string", description: "The replacement text" },
        },
        required: ["path", "oldString", "newString"],
      },
    },
  },
  async run(args: Record<string, unknown>, ctx: ToolContext): Promise<string> {
    if (ctx.planPhase)
      return `BLOCKED IN PLAN MODE: edit_file is disabled while investigating. Describe the exact change in your PLAN instead; the human approves before any file is touched.`;
    const p = resolve(String(args.path), ctx);
    const oldString = String(args.oldString ?? "");
    const newString = String(args.newString ?? "");
    if (!(await Bun.file(p).exists())) return `ERROR: file not found: ${p}`;
    if (isProtectedFile(p)) return protectedError(p);
    const text = await Bun.file(p).text();
    if (!oldString) return `ERROR: oldString cannot be empty`;
    const count = text.split(oldString).length - 1;
    if (count === 0) return `ERROR: oldString not found in file`;
    if (count > 1) return `ERROR: found ${count} matches; provide more surrounding context (oldString must be unique)`;
    const updated = text.replace(oldString, newString);
    await Bun.write(p, updated);
    const note = isSelfFile(p)
      ? auditSelfEdit("edit_file", p, text, updated, "replaced 1 occurrence")
      : "";
    return `Edited ${p}: replaced 1 occurrence${note ? "\n" + note : ""}`;
  },
});
