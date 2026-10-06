import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { Message } from "./llm/types";

export interface SessionMeta {
  id: string;
  title: string;
  createdAt: number;
  updatedAt: number;
  provider: string;
  model: string;
  messageCount: number;
}

/**
 * A turn that ended without finishing its task.
 *
 * The gap this closes: `--resume` used to replay the conversation and nothing
 * more. The model came back into a transcript ending mid-`edit_file` — a tool
 * result it never saw, or a "I'll now run the tests" with no test output — and
 * had to infer from prose whether the work had landed. On a 40-step task that is
 * guesswork, and the usual outcome is either duplicated edits or a false claim
 * that the work is done.
 *
 * So the reason a turn stopped is recorded alongside the transcript, and
 * `/resume` says it out loud.
 */
export interface PendingTask {
  /** The user message that started the unfinished work. */
  request: string;
  /** Why the turn ended. */
  reason: "max_steps" | "aborted" | "error" | "cost_cap" | "interrupted";
  /** Tool calls made during the turn — a proxy for how far it got. */
  toolCalls: number;
  /** Checkpoint id taken at the start of this turn, if one was auto-taken. */
  checkpointId?: string;
  at: number;
}

export interface SessionData extends SessionMeta {
  cwd: string;
  systemPrompt: string;
  messages: Message[];
  routerMode?: "auto" | "chat" | "heavy";
  planMode?: boolean;
  /** Set while a turn is in flight and at most one, so an interrupted run is
   *  visibly unfinished. Cleared when a turn completes normally. */
  pending?: PendingTask;
  /** Compaction digest from the last turn (see AgentResult.compactionSummary).
   *  Older findings live here once their messages are folded away, so a
   *  resumed session starts with them instead of re-discovering the context
   *  it already paid to learn. */
  compaction?: string;
}

let _root: string | null = null;
function root(): string {
  if (_root) return _root;
  const envDir = process.env.VIBECODER_SESSION_DIR;
  _root = envDir || join(homedir(), ".vibecoder");
  mkdirSync(_root, { recursive: true });
  mkdirSync(join(_root, "sessions"), { recursive: true });
  return _root;
}

export function resetSessionRoot(): void {
  _root = null;
}

export function sanitizeId(id: string): string {
  return id.replace(/[^a-zA-Z0-9_-]/g, "_");
}

/** Short deterministic hash so distinct ids that sanitize to the same string
 *  (e.g. "a/b" and "a:b" → "a_b") never collide on disk. */
function shortHash(s: string): string {
  let h = 0;
  for (const ch of s) h = ((h << 5) - h + ch.codePointAt(0)!) | 0;
  return Math.abs(h).toString(36).slice(0, 6);
}

export interface ResumeArg {
  resume: boolean;
  name: string | null;
}

/**
 * Parses process argv for a `--resume [name]` value. The value is only treated
 * as a session name when it does not start with `-` (so flags like `--prompt`
 * are never swallowed as a name).
 */
export function resolveResumeArg(argv: string[]): ResumeArg {
  const idx = argv.indexOf("--resume");
  if (idx === -1) return { resume: false, name: null };
  const raw = argv[idx + 1];
  const name = raw && !raw.startsWith("-") ? raw : null;
  return { resume: true, name };
}

function lastFile(): string {
  return join(root(), "last.json");
}

function sessionFile(id: string): string {
  const clean = sanitizeId(id);
  const fname = clean === id ? clean : `${clean}--${shortHash(id)}`;
  return join(root(), "sessions", `${fname}.json`);
}

export function saveSession(s: SessionData): string {
  s.updatedAt = Date.now();
  if (!s.createdAt) s.createdAt = s.updatedAt;
  const f = sessionFile(s.id);
  writeFileSync(f, JSON.stringify(s, null, 2));
  return f;
}

export function loadSession(id: string): SessionData | null {
  if (!id) return null;
  const f = sessionFile(id);
  if (!existsSync(f)) return null;
  try {
    return JSON.parse(readFileSync(f, "utf8")) as SessionData;
  } catch {
    return null;
  }
}

export function deleteSession(id: string): boolean {
  const f = sessionFile(id);
  if (!existsSync(f)) return false;
  try {
    rmSync(f, { force: true });
    return true;
  } catch {
    return false;
  }
}

export function listSessions(): SessionMeta[] {
  const out: SessionMeta[] = [];
  const dir = join(root(), "sessions");
  if (!existsSync(dir)) return out;
  for (const name of readdirSync(dir)) {
    if (!name.endsWith(".json")) continue;
    // Read the id from the file rather than deriving it from the filename:
    // filenames carry a hash suffix for non-clean ids and must not be
    // re-sanitized.
    let s: SessionData | null = null;
    try {
      const parsed = JSON.parse(readFileSync(join(dir, name), "utf8")) as SessionData;
      if (parsed && typeof parsed.id === "string" && Array.isArray(parsed.messages)) s = parsed;
    } catch {
      // corrupt / partial file — skip it
    }
    if (!s) continue;
    out.push({
      id: s.id,
      title: s.title,
      createdAt: s.createdAt,
      updatedAt: s.updatedAt,
      provider: s.provider,
      model: s.model,
      messageCount: s.messages.length,
    });
  }
  out.sort((a, b) => b.updatedAt - a.updatedAt);
  return out;
}

export function saveLast(s: SessionData): void {
  writeFileSync(lastFile(), JSON.stringify(s, null, 2));
}

export function loadLast(): SessionData | null {
  if (!existsSync(lastFile())) return null;
  try {
    return JSON.parse(readFileSync(lastFile(), "utf8")) as SessionData;
  } catch {
    return null;
  }
}