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

export interface SessionData extends SessionMeta {
  cwd: string;
  systemPrompt: string;
  messages: Message[];
  routerMode?: "auto" | "chat" | "heavy";
  planMode?: boolean;
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