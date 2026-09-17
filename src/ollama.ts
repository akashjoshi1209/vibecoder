// Auto-start the local ollama server when vibecoder launches, so offline chat
// & task planning work out of the box. Inert when ollama isn't installed or is
// already running. Opt out with VIBECODER_NO_OLLAMA_AUTOSTART=1.
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";

export const OLLAMA_DEFAULT_URL = "http://127.0.0.1:11434";

export interface OllamaEnsureOptions {
  /** Base URL to probe/spawn against. Falls back to OLLAMA_HOST, then default. */
  baseUrl?: string;
  /** How long to wait for the server to become ready after spawning, ms. */
  readyTimeoutMs?: number;
  /** Called with status lines (TUI/console). */
  onLog?: (line: string) => void;
}

export interface OllamaEnsureResult {
  /** Server responds on the API now. */
  running: boolean;
  /** We spawned `ollama serve` this run. */
  started: boolean;
  /** Human-readable failure (missing binary, timeout, …). */
  error?: string;
  /** Model names installed locally, if readable. */
  models?: string[];
}

export function ollamaBaseUrl(explicit?: string): string {
  const raw = explicit ?? process.env.OLLAMA_HOST ?? OLLAMA_DEFAULT_URL;
  const cleaned = raw.replace(/\/+$/, "");
  return cleaned.startsWith("http://") || cleaned.startsWith("https://") ? cleaned : `http://${cleaned}`;
}

export async function ollamaIsUp(baseUrl: string, timeoutMs = 800): Promise<boolean> {
  try {
    const res = await fetch(`${baseUrl}/api/version`, { signal: AbortSignal.timeout(timeoutMs) });
    return res.ok;
  } catch {
    return false;
  }
}

/** Resolve the ollama binary: env override, common absolute paths, then PATH. */
export function ollamaBinary(): string | null {
  const explicit = process.env.OLLAMA_BIN;
  if (explicit && existsSync(explicit)) return explicit;
  const absolutes = [
    "/data/data/com.termux/files/usr/bin/ollama",
    "/usr/local/bin/ollama",
    "/usr/bin/ollama",
    "/usr/local/go/bin/ollama",
  ];
  for (const p of absolutes) if (existsSync(p)) return p;
  const pathDirs = (process.env.PATH ?? "").split(":");
  for (const dir of pathDirs) {
    if (!dir) continue;
    const candidate = `${dir.replace(/\/+$/, "")}/ollama`;
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

export async function ollamaModels(baseUrl: string, timeoutMs = 800): Promise<string[]> {
  try {
    const res = await fetch(`${baseUrl}/api/tags`, { signal: AbortSignal.timeout(timeoutMs) });
    if (!res.ok) return [];
    const data = (await res.json()) as { models?: { name?: string }[] };
    return (data.models ?? []).map((m) => m.name ?? "").filter(Boolean);
  } catch {
    return [];
  }
}

/**
 * Ensure a local ollama server is running. Blocking up to `readyTimeoutMs`
 * after spawning, but returns immediately if a server is already up.
 */
export async function ensureOllamaServe(opts: OllamaEnsureOptions = {}): Promise<OllamaEnsureResult> {
  const log = opts.onLog ?? (() => {});
  if (process.env.VIBECODER_NO_OLLAMA_AUTOSTART === "1") {
    return { running: false, started: false, error: "autostart disabled by env" };
  }

  const baseUrl = ollamaBaseUrl(opts.baseUrl);

  if (await ollamaIsUp(baseUrl)) {
    const models = await ollamaModels(baseUrl);
    return { running: true, started: false, models };
  }

  const bin = ollamaBinary();
  if (!bin) {
    const msg =
      "ollama not found — offline chat/planning unavailable\n" +
      "  → install it:  https://ollama.com  (or run:  curl -fsSL https://ollama.com/install.sh | sh)\n" +
      "  → pull the local model:  ollama pull qwen2.5:1.5b\n" +
      "  → or go online-only: ensure connectivity reaches a provider and GROQ_API_KEY (or another key) is set";
    log(msg);
    return { running: false, started: false, error: msg };
  }

  log(`starting ollama serve (${bin}) …`);
  try {
    const child = spawn(bin, ["serve"], { detached: true, stdio: "ignore" });
    child.unref();
  } catch (err: any) {
    const msg = `failed to start ollama serve: ${err?.message ?? err}`;
    log(msg);
    return { running: false, started: false, error: msg };
  }

  const deadline = Date.now() + (opts.readyTimeoutMs ?? 6000);
  while (Date.now() < deadline) {
    if (await ollamaIsUp(baseUrl, 500)) {
      const models = await ollamaModels(baseUrl);
      log(models.length ? `ollama serve ready (${models.join(", ")})` : "ollama serve ready");
      return { running: true, started: true, models };
    }
    await new Promise((r) => setTimeout(r, 300));
  }

  const msg =
    "ollama serve started but did not respond in time (is it stuck?)\n" +
    "  → check it with:  ollama list\n" +
    "  → pull the configured model:  ollama pull qwen2.5:1.5b\n" +
    "  → or set GROQ_API_KEY so online providers stay available while ollama is down";
  log(msg);
  return { running: false, started: true, error: msg };
}