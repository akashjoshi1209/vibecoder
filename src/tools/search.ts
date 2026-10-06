import { registerTool, type ToolContext } from "./registry";
import { spawnCollect } from "./proc";
import { globScan } from "./glob";
import { pathDenied } from "./fs-utils";
import { numberSetting } from "../runtime";
import { grepFallback } from "./grep-fallback";

/**
 * Results returned per call.
 *
 * This used to be a fixed 50 with no way to see the rest: a repo with 400
 * matches got the first 50 and a "...(350 more)" note, and the model — having
 * no way to ask for more — would reason as though the match set were small.
 * Both tools below now take an `offset` so a truncated result set can be paged,
 * and they state the total and the next offset explicitly.
 */
const MAX_RESULTS = 50;
const MAX_SCANNED = 2000;
const DEFAULT_TIMEOUT_MS = 60_000;

/** Page size for search results, configurable like the output cap. */
function pageSize(): number {
  return numberSetting("maxSearchResults", MAX_RESULTS, 1);
}

registerTool({
  definition: {
    type: "function",
    function: {
      name: "glob",
      description:
        "List files matching a glob pattern (e.g. **/*.ts, src/**). Returns matching file paths, sorted. Results are paged: when more than `limit` match, the output says so and gives the `offset` to pass for the next page.",
      parameters: {
        type: "object",
        properties: {
          pattern: { type: "string", description: "Glob pattern to search" },
          cwd: { type: "string", description: "Directory to search in (optional, defaults to workspace)" },
          limit: { type: "number", description: `Max results to return (optional, default ${MAX_RESULTS})` },
          offset: { type: "number", description: "Skip this many matches before returning results (optional, default 0). Use it to page through a truncated result set." },
        },
        required: ["pattern"],
      },
    },
  },
  async run(args: Record<string, unknown>, ctx: ToolContext): Promise<string> {
    const pattern = String(args.pattern ?? "");
    const dir = args.cwd ? String(args.cwd) : ctx.cwd;
    // Scanning an arbitrary directory is a read outside the workspace.
    const denied = pathDenied(dir, ctx);
    if (denied) return denied;
    const limit = Math.max(1, Number(args.limit ?? pageSize()) || pageSize());
    const offset = Math.max(0, Number(args.offset ?? 0) || 0);
    let matches: string[];
    try {
      matches = await globScan(pattern, { cwd: dir, onlyFiles: true, maxResults: MAX_SCANNED });
    } catch (err: any) {
      return `ERROR: glob failed: ${err?.message ?? String(err)}`;
    }
    matches.sort();
    const total = matches.length;
    const sliced = matches.slice(offset, offset + limit);
    if (!sliced.length) {
      return total === 0
        ? "(no matches)"
        : `(no matches at offset ${offset}; ${total} total match${total === 1 ? "" : "es"} — you paged past the end)`;
    }
    let out = sliced.join("\n");
    const next = offset + sliced.length;
    if (next < total) {
      out += `\n[${next} of ${total} matches shown — pass offset: ${next} for the next page]`;
    } else {
      out += `\n[${total} match${total === 1 ? "" : "es"} total]`;
    }
    return out;
  },
});

registerTool({
  definition: {
    type: "function",
    function: {
      name: "grep",
      description:
        "Search file contents with a regex. Returns file paths and line numbers of matches. Results are paged: when more than `limit` match, the output says so and gives the `offset` to pass for the next page. Narrow the pattern or `include` glob instead of paging when you can.",
      parameters: {
        type: "object",
        properties: {
          pattern: { type: "string", description: "Regex pattern to search for" },
          include: { type: "string", description: "File glob to filter (e.g. *.ts) (optional)" },
          path: { type: "string", description: "Directory to search (optional, defaults to workspace)" },
          timeout: { type: "number", description: "Timeout in milliseconds (optional, default 60000)" },
          limit: { type: "number", description: `Max results to return (optional, default ${MAX_RESULTS})` },
          offset: { type: "number", description: "Skip this many matches before returning results (optional, default 0). Use it to page through a truncated result set." },
        },
        required: ["pattern"],
      },
    },
  },
  async run(args: Record<string, unknown>, ctx: ToolContext): Promise<string> {
    const pattern = String(args.pattern ?? "");
    const dir = args.path ? String(args.path) : ctx.cwd;
    const denied = pathDenied(dir, ctx);
    if (denied) return denied;
    const include = args.include ? String(args.include) : "*";
    const timeout = Math.max(0, Number(args.timeout ?? DEFAULT_TIMEOUT_MS) || DEFAULT_TIMEOUT_MS);
    const limit = Math.max(1, Number(args.limit ?? pageSize()) || pageSize());
    const offset = Math.max(0, Number(args.offset ?? 0) || 0);

    // Engine selection: the shell grep (fast, same paging contract) when it
    // exists; the bounded in-process fallback when it does not, or when
    // --no-grep / VIBECODER_NO_GREP=1 forces it. Every result states which
    // engine ran — a degraded (capped) search must never be silent.
    let engine: "grep" | "fallback" = process.env.VIBECODER_NO_GREP === "1" ? "fallback" : "grep";
    let lines: string[] = [];
    let timedOut = false;
    let aborted = false;
    let fallbackTruncated = false;
    let stderr = "";

    if (engine === "grep") {
      const res = await spawnCollect({
        cmd: [
          "grep",
          "-rn",
          "-E",
          "-e",
          pattern,
          `--include=${include}`,
          "--exclude-dir=node_modules",
          "--exclude-dir=.git",
          "--",
          dir,
        ],
        env: { ...process.env, NO_COLOR: "1" } as Record<string, string>,
        timeoutMs: timeout,
        signal: ctx.signal,
      });
      if (res.stderr.includes("spawn error")) {
        engine = "fallback"; // grep is not on this box at all
      } else {
        timedOut = res.timedOut;
        aborted = res.aborted;
        stderr = res.stderr.trim();
        lines = res.stdout.split("\n").filter(Boolean);
      }
    }

    if (engine === "fallback") {
      let re: RegExp;
      try {
        re = new RegExp(pattern);
      } catch (err: any) {
        return `ERROR: invalid pattern: ${err?.message ?? String(err)}\n[engine: in-process fallback]`;
      }
      const r = grepFallback(dir, re, { include, signal: ctx.signal });
      if ("error" in r) return `ERROR: in-process search failed: ${r.error}\n[engine: in-process fallback]`;
      lines = r.lines;
      fallbackTruncated = r.truncated;
      aborted = !!ctx.signal?.aborted;
    }

    const engineTag =
      engine === "grep" ? "[engine: grep]" : "[engine: in-process fallback — grep missing or disabled]";
    const capNote = fallbackTruncated
      ? "[in-process engine hit its file/match cap — result set may be incomplete; narrow with include or path]"
      : "";
    const tail = [capNote, engineTag].filter(Boolean).join("\n");
    const total = lines.length;
    const sliced = lines.slice(offset, offset + limit);

    if (timedOut) {
      // A timed-out search has an unknown total, so do not claim completeness.
      return (
        sliced.join("\n") +
        `\n[killed: timed out after ${timeout} ms — this is a partial result set, not the whole match list]\n${tail}`
      );
    }
    if (aborted) return sliced.join("\n") + `\n[aborted]\n${tail}`;
    if (total === 0) {
      return stderr ? `ERROR: ${stderr}\n${tail}` : `(no matches)\n${tail}`;
    }
    if (!sliced.length) {
      return `(no matches at offset ${offset}; ${total} total match${total === 1 ? "" : "es"} — you paged past the end)\n${tail}`;
    }
    let out = sliced.join("\n");
    const next = offset + sliced.length;
    out += next < total
      ? `\n[${next} of ${total} matches shown — pass offset: ${next} for the next page, or narrow the pattern]`
      : `\n[${total} match${total === 1 ? "" : "es"} total]`;
    return `${out}\n${tail}`;
  },
});