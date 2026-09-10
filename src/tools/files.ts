import { registerTool, type ToolContext } from "./registry";
import { resolve } from "./fs-utils";

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
    const offset = Number(args.offset ?? 1);
    const limit = Number(args.limit ?? 2000);
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
    const p = resolve(String(args.path), ctx);
    const content = String(args.content ?? "");
    await Bun.write(p, content);
    return `Wrote ${content.length} bytes to ${p}`;
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
    const p = resolve(String(args.path), ctx);
    const oldString = String(args.oldString ?? "");
    const newString = String(args.newString ?? "");
    if (!(await Bun.file(p).exists())) return `ERROR: file not found: ${p}`;
    const text = await Bun.file(p).text();
    if (!oldString) return `ERROR: oldString cannot be empty`;
    const count = text.split(oldString).length - 1;
    if (count === 0) return `ERROR: oldString not found in file`;
    if (count > 1) return `ERROR: found ${count} matches; provide more surrounding context (oldString must be unique)`;
    const updated = text.replace(oldString, newString);
    await Bun.write(p, updated);
    return `Edited ${p}: replaced 1 occurrence`;
  },
});
