// Local plugin loading: tools from packages that opt in, validated against the
// schema lock before they can register.
//
// Discovery (all three are explicit human decisions — nothing is auto-loaded
// from the workspace just because it exists):
//   1. `plugins: [...]` in config.json — paths, absolute or cwd-relative
//   2. a `"vibecoder.extension"` field in the *project's* package.json
//      (string or array of strings: entry files, or package dirs to resolve)
//   3. files and package dirs under `<configDir>/plugins/` (default
//      ~/.vibecoder/plugins/)
//
// Plugins are ordinary local code running with this process's full privileges.
// They are trusted exactly like config.json is; see THREAT_MODEL.md. Set
// VIBECODER_NO_PLUGINS=1 (or pass --no-plugins) to load none.
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join, resolve as pathResolve, isAbsolute } from "node:path";
import { homedir } from "node:os";
import { pathToFileURL } from "node:url";
import { registerTool } from "./registry";
import { validateTool } from "./schema";

export interface PluginReport {
  /** One entry per plugin module that was imported (tools may still have failed). */
  loaded: Array<{ source: string; entry: string; tools: string[] }>;
  /** Per-tool or per-plugin failures. Loading never throws — a broken plugin
   *  degrades to an error line, never a dead startup. */
  errors: Array<{ source: string; error: string }>;
}

export interface LoadPluginsOptions {
  /** Working directory (for cwd-relative entries and the project package.json). */
  cwd?: string;
  /** Config dir holding `plugins/`. Default ~/.vibecoder. */
  configDir?: string;
  /** Explicit entries from config.plugins. */
  plugins?: string[];
  /** Environment to inspect (VIBECODER_NO_PLUGINS). Defaults to process.env. */
  env?: Record<string, string | undefined>;
}

function isDir(p: string): boolean {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
}

/** Resolve a source to an importable file: a file is itself; a package dir
 *  resolves `vibecoder.extension` (the plugin's own entry marker), then
 *  `main`, then `module`. */
function resolveEntry(path: string): { entry: string | null; error?: string } {
  if (!isDir(path)) return { entry: path };
  if (!existsSync(join(path, "package.json"))) {
    return { entry: null, error: "directory has no package.json" };
  }
  try {
    const pkg = JSON.parse(readFileSync(join(path, "package.json"), "utf8"));
    for (const key of ["vibecoder.extension", "main", "module"]) {
      const v = pkg[key];
      if (typeof v === "string" && v) return { entry: pathResolve(path, v) };
    }
    return { entry: null, error: 'package.json has no "vibecoder.extension", "main" or "module" entry' };
  } catch (err) {
    return { entry: null, error: `unreadable package.json: ${err instanceof Error ? err.message : String(err)}` };
  }
}

/** Pull the tool array out of a plugin module's export shapes:
 *  `export const tools = [...]`, `export default [...]`,
 *  `export default { tools: [...] }`, or `export register(fn)`. */
function extractTools(mod: Record<string, unknown>): unknown[] | { register?: unknown } | null {
  if (Array.isArray(mod.tools)) return mod.tools;
  const d = mod.default;
  if (Array.isArray(d)) return d;
  if (d && typeof d === "object" && Array.isArray((d as Record<string, unknown>).tools)) {
    return (d as { tools: unknown[] }).tools;
  }
  if (typeof mod.register === "function" || (d && typeof d === "object" && typeof (d as Record<string, unknown>).register === "function")) {
    return { register: typeof mod.register === "function" ? mod.register : (d as Record<string, unknown>).register };
  }
  return null;
}

/**
 * Discover and load local plugins. Never throws: every failure lands in
 * `report.errors`. Tools are validated against the schema lock and registered
 * one at a time, so one bad tool does not discard its siblings (and a name
 * collision with a built-in is reported, not overwritten — registerTool
 * refuses duplicates by design).
 */
export async function loadPlugins(opts: LoadPluginsOptions = {}): Promise<PluginReport> {
  const report: PluginReport = { loaded: [], errors: [] };
  if ((opts.env ?? process.env).VIBECODER_NO_PLUGINS === "1") return report;
  const cwd = opts.cwd ?? process.cwd();
  const configDir = opts.configDir ?? join(homedir(), ".vibecoder");

  const sources: Array<{ source: string; path: string }> = [];
  for (const p of opts.plugins ?? []) {
    if (typeof p !== "string" || !p) {
      report.errors.push({ source: "config.plugins", error: "entries must be non-empty strings" });
      continue;
    }
    sources.push({ source: `config.plugins ${p}`, path: isAbsolute(p) ? p : pathResolve(cwd, p) });
  }

  const pkgFile = join(cwd, "package.json");
  if (existsSync(pkgFile)) {
    try {
      const pkg = JSON.parse(readFileSync(pkgFile, "utf8")) as Record<string, unknown>;
      const ext = pkg["vibecoder.extension"];
      const list = Array.isArray(ext) ? ext : ext === undefined ? [] : [ext];
      for (const p of list) {
        if (typeof p === "string" && p) sources.push({ source: `package.json vibecoder.extension (${p})`, path: pathResolve(cwd, p) });
        else report.errors.push({ source: "package.json", error: '"vibecoder.extension" entries must be non-empty strings' });
      }
    } catch (err) {
      report.errors.push({ source: pkgFile, error: `unreadable package.json: ${err instanceof Error ? err.message : String(err)}` });
    }
  }

  const pluginsDir = join(configDir, "plugins");
  if (isDir(pluginsDir)) {
    for (const entry of readdirSync(pluginsDir).sort()) {
      const full = join(pluginsDir, entry);
      if (/\.(m|c)?js$/.test(entry) || isDir(full)) sources.push({ source: `plugins/${entry}`, path: full });
    }
  }

  for (const src of sources) {
    const resolved = resolveEntry(src.path);
    if (!resolved.entry) {
      report.errors.push({ source: src.source, error: resolved.error ?? "no entry point" });
      continue;
    }
    let mod: Record<string, unknown>;
    try {
      mod = (await import(pathToFileURL(resolved.entry).href)) as Record<string, unknown>;
    } catch (err) {
      report.errors.push({ source: src.source, error: `import failed: ${err instanceof Error ? err.message : String(err)}` });
      continue;
    }
    const extracted = extractTools(mod);
    if (extracted === null) {
      report.errors.push({
        source: src.source,
        error: "exports no tools — export `tools: Tool[]`, a default array, or a `register(fn)`",
      });
      continue;
    }

    const names: string[] = [];
    if ("register" in extracted) {
      // register(fn) plugins own their registration; the callback funnels
      // through registerTool, so the schema lock still applies.
      try {
        await (extracted.register as (fn: typeof registerTool) => void | Promise<void>)(registerTool);
      } catch (err) {
        report.errors.push({ source: src.source, error: `register() failed: ${err instanceof Error ? err.message : String(err)}` });
        continue;
      }
      report.loaded.push({ source: src.source, entry: resolved.entry, tools: names });
      continue;
    }

    for (const t of extracted as unknown[]) {
      const errors = validateTool(t);
      if (errors.length) {
        const badName = (t as { definition?: { function?: { name?: string } } })?.definition?.function?.name;
        report.errors.push({ source: src.source, error: `tool ${JSON.stringify(badName ?? "?")} fails the schema lock: ${errors.join("; ")}` });
        continue;
      }
      const toolName = (t as { definition: { function: { name: string } } }).definition.function.name;
      try {
        registerTool(t as Parameters<typeof registerTool>[0]);
        names.push(toolName);
      } catch (err) {
        report.errors.push({ source: src.source, error: err instanceof Error ? err.message : String(err) });
      }
    }
    report.loaded.push({ source: src.source, entry: resolved.entry, tools: names });
  }
  return report;
}
