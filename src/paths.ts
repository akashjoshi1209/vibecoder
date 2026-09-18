// Runtime path helpers. These must work in every install shape:
//  - source layout:  src/*.ts  → package root is one dir up
//  - bundled layout: dist/vibecoder.js  → package root is dist/ itself
// Instead of guessing, resolvePackageFile probes both locations.
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { existsSync, readFileSync } from "node:fs";

export function packageRoot(): string {
  return dirname(fileURLToPath(import.meta.url));
}

/** Locate a package-relative file across source and bundled layouts. */
export function resolvePackageFile(...names: string[]): string | null {
  const name = join(...names);
  const here = join(packageRoot(), name);
  if (existsSync(here)) return here;
  const parent = join(dirname(packageRoot()), name);
  if (existsSync(parent)) return parent;
  return null;
}

export interface PackageMeta {
  name?: string;
  version?: string;
  description?: string;
  [k: string]: unknown;
}

export function readPackageJson(): PackageMeta | null {
  const f = resolvePackageFile("package.json");
  if (f) {
    try {
      return JSON.parse(readFileSync(f, "utf8")) as PackageMeta;
    } catch {
      // fall through to version.json
    }
  }
  // Standalone installs (curl→ ~/.vibecoder/cli) carry dist/version.json.
  const v = resolvePackageFile("version.json");
  if (!v) return null;
  try {
    const m = JSON.parse(readFileSync(v, "utf8")) as PackageMeta;
    return { name: m.name ?? "vibecoder", version: m.version ?? undefined };
  } catch {
    return null;
  }
}