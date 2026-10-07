// Structured run trace: append-only JSONL of what a turn actually did —
// provider steps (tokens/finish/cost), tool calls, approvals, permission
// decisions, trims and compactions — plus an offline replayer so a session can
// be debugged without a live model.
//
//   vibecoder --trace run.jsonl              record (appends across resumes)
//   vibecoder --trace run.jsonl --trace-anon record, scrubbed for bug reports
//   vibecoder --trace-replay run.jsonl       print the timeline and exit
//
// A trace must never break the run: every write is best-effort, and fields are
// truncated so a 30k-char tool output cannot fatten the log into uselessness.
import { appendFileSync, mkdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname } from "node:path";

export type TraceKind =
  | "turn.start"
  | "llm.step"
  | "tool"
  | "approve"
  | "permission"
  | "trim"
  | "compact"
  | "turn.end"
  | "task"
  | "note";

export interface TraceRecord {
  /** epoch ms */
  t: number;
  kind: TraceKind;
  [k: string]: unknown;
}

export interface TraceOptions {
  /** Scrub home/cwd paths and secret-looking tokens (for bug reports). */
  anon?: boolean;
  /** Working directory for this run; scrubbed to "<cwd>" when anon. */
  cwd?: string;
  /** Max chars per string field before truncation (default 2000). */
  truncateChars?: number;
}

const DEFAULT_TRUNCATE = 2000;

/** Secret-shaped tokens, scrubbed only in anon mode. Over-matching is fine: a
 *  report that keeps a stray key is far worse than one that hides "monkey". */
const SECRET_PATTERNS: Array<[RegExp, string]> = [
  [/\b(?:sk|pk)-(?:proj-)?[A-Za-z0-9_-]{16,}/g, "<redacted-key>"],
  [/\bghp_[A-Za-z0-9]{20,}/g, "<redacted-key>"],
  [/\bgithub_pat_[A-Za-z0-9_]{20,}/g, "<redacted-key>"],
  [/\bAKIA[0-9A-Z]{16}\b/g, "<redacted-key>"],
  [/\bxox[baprs]-[A-Za-z0-9-]{10,}/g, "<redacted-key>"],
  [/Bearer\s+[A-Za-z0-9._~+/=-]{10,}/gi, "Bearer <redacted>"],
  // The common spellings: KEY=value, KEY: value, and "apiKey": "value".
  [
    /([A-Za-z0-9_]*(?:KEY|TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIAL)[A-Za-z0-9_]*)"?\s*[=:]\s*("[^"]*"|'[^']*'|\S+)/gi,
    "$1=<redacted>",
  ],
];

function scrubString(s: string, opts: TraceOptions): string {
  let out = s;
  // cwd before home (cwd lives under home) so "<cwd>" wins where both match.
  if (opts.cwd && out.includes(opts.cwd)) out = out.split(opts.cwd).join("<cwd>");
  const home = homedir();
  if (home && out.includes(home)) out = out.split(home).join("~");
  for (const [re, rep] of SECRET_PATTERNS) out = out.replace(re, rep);
  return out;
}

function truncateString(s: string, max: number): string {
  return s.length > max ? s.slice(0, max) + `…(+${s.length - max} chars)` : s;
}

function mapStrings(v: unknown, fn: (s: string) => string): unknown {
  if (typeof v === "string") return fn(v);
  if (Array.isArray(v)) return v.map((x) => mapStrings(x, fn));
  if (v && typeof v === "object") {
    const o: Record<string, unknown> = {};
    for (const [k, val] of Object.entries(v)) o[k] = mapStrings(val, fn);
    return o;
  }
  return v;
}

export class RunTrace {
  constructor(
    readonly file: string,
    private opts: TraceOptions = {},
  ) {}

  /** A sibling trace for an isolated child run (a fan-out task): same
   *  options, file `<this-file>.<label>.jsonl`. */
  subTrace(label: string): RunTrace {
    const base = this.file.replace(/\.(jsonl|ndjson|log)$/i, "");
    return new RunTrace(`${base}.${label}.jsonl`, { ...this.opts });
  }

  write(rec: Omit<TraceRecord, "t">): void {
    try {
      const max = this.opts.truncateChars ?? DEFAULT_TRUNCATE;
      let out = mapStrings({ t: Date.now(), ...rec }, (s) => truncateString(s, max));
      if (this.opts.anon) out = mapStrings(out, (s) => scrubString(s, this.opts));
      mkdirSync(dirname(this.file), { recursive: true });
      appendFileSync(this.file, JSON.stringify(out) + "\n");
    } catch {
      // A broken trace must never break the run.
    }
  }
}

export interface ReplaySummary {
  turns: number;
  steps: number;
  tools: number;
  approvals: number;
  denials: number;
  permissions: number;
  permissionDenials: number;
  compactions: number;
  trims: number;
  tasks: number;
  failedTasks: number;
  costUsd: number;
  skipped: number;
}

const clip = (s: string, n: number) => (s.length > n ? s.slice(0, n - 1) + "…" : s);

const argPreview = (input: unknown): string => {
  const s = typeof input === "string" ? input : JSON.stringify(input) ?? "";
  return clip(s, 72);
};

/** Render a recorded trace as a timestamped timeline plus totals — the offline
 *  half of debugging a run: same information, no model, no session. */
export function replayTrace(file: string): { lines: string[]; summary: ReplaySummary } {
  const summary: ReplaySummary = {
    turns: 0,
    steps: 0,
    tools: 0,
    approvals: 0,
    denials: 0,
    permissions: 0,
    permissionDenials: 0,
    compactions: 0,
    trims: 0,
    tasks: 0,
    failedTasks: 0,
    costUsd: 0,
    skipped: 0,
  };
  const text = readFileSync(file, "utf8");
  const recs: TraceRecord[] = [];
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim()) continue;
    try {
      const r = JSON.parse(line);
      if (r && typeof r.t === "number" && typeof r.kind === "string") recs.push(r);
      else summary.skipped++;
    } catch {
      summary.skipped++;
    }
  }
  if (!recs.length) return { lines: [], summary };

  const t0 = recs[0].t;
  const stamp = (t: number) => `+${((t - t0) / 1000).toFixed(1)}s`;
  const lines: string[] = [];
  for (const r of recs) {
    const at = stamp(r.t);
    switch (r.kind) {
      case "turn.start":
        lines.push(`${at} turn start · ${r.model ?? "?"} · cwd=${r.cwd ?? "?"}`);
        break;
      case "llm.step":
        summary.steps++;
        lines.push(
          `${at} llm step ${r.step} · ${r.promptTokens ?? "?"}↑ ${r.completionTokens ?? "?"}↓ tok` +
            `${typeof r.finish === "string" && r.finish ? ` · ${r.finish}` : ""}` +
            `${typeof r.costUsd === "number" ? ` · $${r.costUsd.toFixed(4)}` : ""}`,
        );
        break;
      case "tool":
        summary.tools++;
        lines.push(
          `${at} tool ${String(r.tool)} ${argPreview(r.input)} · ${r.ok === false ? "BLOCKED/failed" : "ok"}` +
            `${typeof r.ms === "number" ? ` · ${r.ms}ms` : ""}`,
        );
        break;
      case "approve":
        if (r.approved) summary.approvals++;
        else summary.denials++;
        lines.push(
          `${at} approve ${String(r.tool)} ${r.approved ? "yes" : "no"}` +
            `${r.reason ? ` · ${r.reason}` : ""}` +
            `${typeof r.source === "string" ? ` (${r.source})` : ""}`,
        );
        break;
      case "permission":
        summary.permissions++;
        if (r.action === "deny") summary.permissionDenials++;
        lines.push(
          `${at} permission ${String(r.action)} ${String(r.domain)} · ${String(r.rule)}` +
            `${r.reason ? ` — ${r.reason}` : ""}`,
        );
        break;
      case "trim":
        summary.trims++;
        lines.push(`${at} trim ${r.messages} msg · ${r.chars} chars dropped`);
        break;
      case "compact":
        summary.compactions++;
        lines.push(
          `${at} compact −${r.foldedMessages} msg (${r.foldedTokens} tok) → ${r.summaryTokens}-tok digest`,
        );
        break;
      case "turn.end":
        summary.turns++;
        if (typeof r.costUsd === "number") summary.costUsd += r.costUsd;
        lines.push(
          `${at} turn end · ${r.steps} steps` +
            `${r.aborted ? " · aborted" : ""}` +
            `${r.costCapHit ? " · cost cap" : ""}` +
            `${typeof r.costUsd === "number" ? ` · $${r.costUsd.toFixed(4)}` : ""}`,
        );
        break;
      case "task":
        summary.tasks++;
        if (!r.ok) summary.failedTasks++;
        lines.push(
          `${at} task ${r.label ?? "?"} ${r.ok ? "ok" : "FAILED"} · ${r.steps ?? 0} steps · ${r.ms ?? 0}ms` +
            `${r.error ? ` — ${r.error}` : ""}`,
        );
        break;
      case "note":
        lines.push(`${at} ${r.text ?? ""}`);
        break;
      default:
        lines.push(`${at} ${r.kind}`);
    }
  }
  return { lines, summary };
}

export function formatReplaySummary(s: ReplaySummary): string {
  return [
    `  ${s.turns} turn(s) · ${s.steps} llm step(s) · ${s.tools} tool call(s)`,
    `  ${s.approvals} approval(s) · ${s.denials} declined · ${s.permissions} permission decision(s) · ${s.permissionDenials} denied`,
    `  ${s.compactions} compaction(s) · ${s.trims} trim(s) · ${s.tasks} child task(s) · ${s.failedTasks} failed · $${s.costUsd.toFixed(4)} · ${s.skipped} malformed line(s)`,
  ].join("\n");
}
