// Minimal .env loader for runtimes that don't load it automatically (Node).
// Never overwrites a variable that is already set in the environment; loading
// is best-effort and slips through errors.
//
// Loaded files, in order (first wins per key):
//   1. <packageRoot>/.env            (repo dev: the gitignored secret file)
//   2. <packageRoot>/../.env         (source layout: src/../.env)
//   3. ~/.vibecoder/.env             (user-owned keys, works in every install mode)
//
// Opt out with VIBECODER_NO_DOTENV=1.
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { packageRoot } from "./paths";

const loaded = new Set<string>();

function envLine(line: string): [string, string] | null {
  const m = line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/);
  if (!m) return null;
  const key = m[1];
  if (!key) return null;
  let value = m[2];
  value = value.replace(/^"|"$/g, "").replace(/^'|'$/g, "");
  return [key, value];
}

export function loadDotEnv(): void {
  if (process.env.VIBECODER_NO_DOTENV === "1") return;
  const candidates = [
    join(packageRoot(), ".env"),
    join(dirname(packageRoot()), ".env"),
    join(homedir(), ".vibecoder", ".env"),
  ];
  for (const file of candidates) {
    if (loaded.has(file)) continue;
    loaded.add(file);
    if (!existsSync(file)) continue;
    const text = readFileSync(file, "utf8");
    for (const raw of text.split("\n")) {
      if (!raw.trim() || raw.trim().startsWith("#")) continue;
      const kv = envLine(raw);
      if (!kv) continue;
      const [key, value] = kv;
      if (!(key in process.env)) process.env[key] = value;
    }
  }
}