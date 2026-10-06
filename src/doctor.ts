// `vibecoder doctor` — local diagnostics. Runs without starting the agent loop
// or needing any LLM, so anyone can confirm their install, config, keys, and
// providers from a terminal before (or after) using vibecoder.
import { existsSync } from "node:fs";
import { loadConfigInfo, userConfigFile, validateConfig } from "./config";
import { installMode, ledgerPath } from "./self-edit";
import { readPackageJson } from "./paths";
import { ollamaBinary, ollamaIsUp, ollamaModels, ollamaBaseUrl } from "./ollama";
import { createProvider } from "./llm/client";
import { resolvePermissions } from "./permissions";
import { changeLogPath } from "./changelog";
import { indexPath } from "./checkpoint";

function maskKey(v?: string): string {
  if (!v) return "not set";
  if (v.length <= 8) return "set (" + "*".repeat(v.length) + ")";
  return `set (${v.slice(0, 4)}…${v.slice(-4)})`;
}

async function probeReachable(url: string, timeoutMs = 3000): Promise<string> {
  try {
    const res = await fetch(url, { method: "GET", signal: AbortSignal.timeout(timeoutMs) });
    return res.ok || res.status < 500 ? "reachable" : `unreachable (HTTP ${res.status})`;
  } catch {
    return "unreachable";
  }
}

export async function runDoctor(): Promise<number> {
  const out: string[] = [];
  const say = (s = "") => out.push(s);
  const pkg = readPackageJson();
  const version = pkg?.version ?? "dev";
  const runtime = process.versions.bun ? `bun ${process.versions.bun}` : `node ${process.version}`;

  // Gate on the platform first. existsSync("/data/data/com.termux") is true on
  // Windows whenever a stray C:\data\data\com.termux happens to exist, because
  // Node resolves a leading "/" against the current drive there.
  const isTermux =
    process.platform === "android" &&
    (existsSync("/data/data/com.termux") ||
      process.env.ANDROID_DATA !== undefined ||
      process.env.EXTERNAL_STORAGE !== undefined);

  say("vibecoder doctor");
  say(`  version:   ${version}`);
  say(`  runtime:   ${runtime} (${process.platform}/${process.arch})${isTermux ? " · Android (Termux)" : ""}`);
  say(`  install:   ${installMode()} mode`);

  // ── config ──────────────────────────────────────────────────────────────────
  let cfg;
  let paths;
  try {
    ({ config: cfg, paths } = await loadConfigInfo());
  } catch (err: any) {
    out.push("");
    out.push(`  config:    ERROR — ${err?.message ?? String(err)}`);
    out.push("             run: vibecoder setup");
    out.push("");
    process.stdout.write(out.join("\n") + "\n");
    return 1;
  }
  // Validate the merged config explicitly so doctor reports problems even when
  // loadConfigInfo would throw later (in the agent loop) with the same info.
  const validationErrors = validateConfig(cfg);
  if (validationErrors.length) {
    out.push("");
    out.push("  config:    INVALID — these problems would crash vibecoder:");
    for (const e of validationErrors) out.push(`             - ${e}`);
    out.push("             fix config.json and re-run doctor");
    out.push("");
  }

  out.push("");
  say("config");
  say(`  built-in defaults: ${paths.builtin ?? "not found"}`);
  say(`  your overrides:    ${paths.userFile ?? "(none — creating one is optional; see 'vibecoder setup')"}`);
  say(`  live config file:  ${paths.effectiveFile}${paths.merged ? "  (defaults + your overrides)" : ""}`);
  const active = createProvider(cfg, cfg.provider);
  say(`  default:           ${active.name}/${active.model}`);
  if (cfg.routing) {
    say(`  router:            chat ${cfg.routing.chatProvider}/${cfg.routing.chatModel}  ·  heavy ${cfg.routing.heavyProvider}/${cfg.routing.heavyModel}${cfg.routing.offlineProvider ? `  ·  offline ${cfg.routing.offlineProvider}/${cfg.routing.offlineModel ?? cfg.routing.chatModel}` : ""}`);
  }

  // ── providers ───────────────────────────────────────────────────────────────
  out.push("");
  say("providers");
  for (const name of Object.keys(cfg.providers ?? {})) {
    const p = cfg.providers[name];
    const key = p.apiKeyEnv ? process.env[p.apiKeyEnv] : undefined;
    say(`  ${name}`);
    say(`    type:      ${p.type} · baseURL: ${p.baseURL}`);
    say(`    api key:   ${p.apiKeyEnv ? `${p.apiKeyEnv} → ${maskKey(key)}` : "(none — local)"}`);
    say(`    models:    ${(p.models ?? []).join(", ")}`);
  }

  // ── ollama ──────────────────────────────────────────────────────────────────
  out.push("");
  say("ollama (local, no cost)");
  const bin = ollamaBinary();
  const up = ollamaIsUp(ollamaBaseUrl());
  say(`  binary:    ${bin ? "found (" + bin + ")" : "not installed — offline chat unavailable"}`);
  if (await up) {
    const models = await ollamaModels(ollamaBaseUrl());
    say(`  server:    running on ${ollamaBaseUrl()}`);
    say(`  models:    ${models.length ? models.join(", ") : "(none pulled yet — try: ollama pull qwen2.5:1.5b)"}`);
  } else {
    say(`  server:    not running`);
  }

  // ── connectivity ────────────────────────────────────────────────────────────
  const probeUrl = (() => {
    try {
      const c = cfg.connectivity;
      return c?.probeUrl ?? "https://api.groq.com/openai/v1/models";
    } catch {
      return "https://api.groq.com/openai/v1/models";
    }
  })();
  out.push("");
  say("connectivity");
  say(`  probe:   ${probeUrl} → ${await probeReachable(probeUrl)}`);
  say(`  note:    offline is fine — chat falls back to your local ollama, and heavy tasks queue until online`);

  // ── data dirs ───────────────────────────────────────────────────────────────
  out.push("");
  say("data");
  say(`  sessions:  ~/.vibecoder/sessions/  (saved conversations)`);
  say(`  queue:     ~/.vibecoder/queue.json (offline task queue)`);
  say(`  ledger:    ${ledgerPath()}`);
  say(`  changes:   ${changeLogPath()}  (every file the agent writes, with pre-images)`);
  say(`  checkpoints: ${indexPath()}  (restore points for /restore)`);
  say(`  user env:  ~/.vibecoder/.env      (optional API keys, e.g. GROQ_API_KEY=...)`);

  // ── effective permission model ──────────────────────────────────────────────
  // This check had been missing. `permissions` in config.json used to be
  // unreadable from doctor, so there was no way to confirm what the agent was
  // actually allowed to do without starting a session and running /permissions.
  // Reporting the *resolved* numbers here — not the raw config — matters because
  // the guards read the resolved model, which depends on the workspace root and
  // the CLI overrides. doctor and the live session therefore cannot disagree.
  const resolvedPerms = resolvePermissions(cfg, process.cwd());
  out.push("");
  say(`permissions (in force for ${process.cwd()})`);
  say(
    `  destructive: ${resolvedPerms.destructive}` +
      (resolvedPerms.destructive === "deny"
        ? "  (rm, git reset, redirects and friends are refused)"
        : resolvedPerms.destructive === "ask"
          ? "  (you are prompted for each one)"
          : "  (unrestricted — rm and force-push run with no confirmation)"),
  );
  say(`  network:     ${resolvedPerms.network}`);
  say(`  filesystem:  ${resolvedPerms.filesystem}`);
  say(`  secrets:     ${resolvedPerms.exposeSecrets ? "EXPOSED to child processes" : "withheld from child processes"}`);
  if (resolvedPerms.destructive === "allow" && resolvedPerms.filesystem === "full") {
    say(`  note:        permissive defaults. --sandbox, or "permissions" in config.json, tightens this.`);
  }

  // ── verdict ─────────────────────────────────────────────────────────────────
  const userCfgExists = existsSync(userConfigFile());
  const keysPresent = Object.keys(cfg.providers ?? {})
    .map((n) => cfg.providers[n].apiKeyEnv)
    .filter(Boolean)
    .some((k) => process.env[k]);
  out.push("");
  say("next steps");
  if (!userCfgExists) say("  - customize:   vibecoder setup   (generates ~/.vibecoder/config.json)");
  if (!keysPresent) say("  - free online:  get a free GROQ_API_KEY (console.groq.com) and add it to ~/.vibecoder/.env");
  say("  - run it:      vibecoder        (or: vibecoder --prompt \"your task\")");

  process.stdout.write(out.join("\n") + "\n");
  return 0;
}