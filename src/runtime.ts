// Process-wide runtime state that tools need but which must not be threaded
// through every ToolContext.
//
// ToolContext is built by whoever is driving the agent (the REPL, the queue
// daemon, tests) and each of those constructs it independently. Anything a tool
// needs that comes from config would otherwise have to be added to that
// interface, which means every call site in the codebase has to change.
//
// The live config lives here instead: the REPL sets it once at startup, tools
// read it lazily. Tests that never set it get the built-in defaults, which is
// the right failure mode for a config-derived tuning knob.
import type { RootConfig } from "./llm/client";

let _config: RootConfig | null = null;

/** The live merged config, or null before startup completes. */
export function rootConfig(): RootConfig | null {
  return _config;
}

export function setRootConfig(cfg: RootConfig | null): void {
  _config = cfg;
}

/** Read a numeric config value with a fallback, ignoring anything unusable. */
export function numberSetting(key: string, fallback: number, min = 0): number {
  const v = (_config as Record<string, unknown> | null)?.[key];
  const n = typeof v === "number" ? v : Number(v);
  if (!Number.isFinite(n) || n < min) return fallback;
  return n;
}
