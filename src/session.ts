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

function lastFile(): string {
  return join(root(), "last.json");
}

function sessionFile(id: string): string {
  return join(root(), "sessions", `${sanitizeId(id)}.json`);
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
    const id = name.slice(0, -5);
    const s = loadSession(id);
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