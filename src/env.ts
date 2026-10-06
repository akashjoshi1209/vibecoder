// Minimal .env loader for runtimes that don't load it automatically (Node).
// Never overwrites a variable that is already set in the environment; loading
// is best-effort and slips through errors.
//
// Loaded files, in order (first wins per key):
//   1. $VIBECODER_ENV_FILE            (explicit override, if set)
//   2. <cwd>/.env                      (the project the agent is scoped to)
//   3. <packageRoot>/.env              (repo dev: the gitignored secret file)
//   4. <packageRoot>/../.env           (source layout: src/../.env)
//   5. ~/.vibecoder/.env               (user-owned keys, works in every install mode)
//
// Entry 2 is the important one, and it was missing. tools/env.ts writes via
// envPath(), which resolves to <cwd>/.env — so `env_set` had been writing
// credentials to a file this loader never read. The agent set a key, was told
// it was set, and the next run started without it. Whichever directory the
// writer and the reader pick has to be the same directory, so the cwd the agent
// is scoped to is now consulted by both.
//
// Precedence note: a real shell environment always wins. Nothing here overrides
// a variable that is already set.
//
// Opt out with VIBECODER_NO_DOTENV=1.
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { packageRoot } from "./paths";

const loaded = new Set<string>();

function envLine(line: string): [string, string] | null {
  const m = line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/);
  if (!m) return null;
  const key = m[1];
  if (!key) return null;
  let value = m[2];
  // Tolerate CRLF: split(/\r?\n/) already removed the \n, but a stray \r can
  // survive on the last line of a file with no trailing newline.
  value = value.replace(/\r$/, "");
  value = value.replace(/^"|"$/g, "").replace(/^'|'$/g, "");
  return [key, value];
}

export function loadDotEnv(): void {
  if (process.env.VIBECODER_NO_DOTENV === "1") return;
  const candidates = [
    process.env.VIBECODER_ENV_FILE,
    join(process.cwd(), ".env"),
    join(packageRoot(), ".env"),
    join(dirname(packageRoot()), ".env"),
    join(homedir(), ".vibecoder", ".env"),
  ].filter((f): f is string => !!f);
  const seen = new Set<string>();
  for (const raw of candidates) {
    // The override, the cwd and the package root can coincide (running from a
    // checkout). Dedupe on the resolved path so a key is not parsed twice from
    // the same file, which would be harmless but misleading in any trace.
    const file = resolve(raw);
    if (seen.has(file)) continue;
    seen.add(file);
    if (loaded.has(file)) continue;
    loaded.add(file);
    if (!existsSync(file)) continue;
    const text = readFileSync(file, "utf8");
    for (const rawLine of text.split(/\r?\n/)) {
      if (!rawLine.trim() || rawLine.trim().startsWith("#")) continue;
      const kv = envLine(rawLine);
      if (!kv) continue;
      const [key, value] = kv;
      if (!(key in process.env) || !process.env[key]) process.env[key] = value;
    }
  }
}