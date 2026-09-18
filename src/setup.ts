// `vibecoder setup` — interactive first-run setup. Generates
// ~/.vibecoder/config.json (customization file), optionally records free-tier
// API keys into ~/.vibecoder/.env, and runs without needing any model. With
// --yes it applies sensible free defaults non-interactively.
import { createInterface } from "node:readline/promises";
import { stdin as stdinInput, stdout as stdoutOutput } from "node:process";
import { appendFileSync, existsSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { deepMerge, loadJsonFile, writeUserConfig, userConfigFile } from "./config";
import { resolvePackageFile } from "./paths";
import { readPackageJson } from "./paths";
import { ollamaBinary, ollamaIsUp, ollamaModels, ollamaBaseUrl } from "./ollama";
import { hasControllingTty } from "./ui/terminal";
import type { RootConfig } from "./llm/client";
import type { RoutingConfig } from "./llm/router";

const LOCAL_MODEL = "qwen2.5:1.5b";

async function prompt(question: string, fallback: string, interactive: boolean): Promise<string> {
  if (!interactive) return fallback;
  const rl = createInterface({ input: stdinInput, output: stdoutOutput });
  try {
    const answer = await rl.question(question);
    return answer.trim();
  } finally {
    rl.close();
  }
}

async function confirm(question: string, fallback: boolean, interactive: boolean): Promise<boolean> {
  const suffix = fallback ? " [Y/n] " : " [y/N] ";
  const answer = await prompt(question + suffix, fallback ? "y" : "n", interactive);
  return /^y(es)?$/i.test(answer);
}

export async function runSetup(argv: string[]): Promise<number> {
  const yes = argv.includes("--yes") || argv.includes("-y");
  const interactive = hasControllingTty() && !yes;

  const line = (s = "") => process.stdout.write(s + "\n");
  const pkg = readPackageJson();
  line(`vibecoder setup — make vibecoder yours (free, no limitations)`);
  line(`  runtime: ${process.versions.bun ? "bun " + process.versions.bun : "node " + process.version} · package v${pkg?.version ?? "dev"}`);
  line();

  const builtinPath = resolvePackageFile("config.json");
  const builtin = builtinPath ? loadJsonFile(builtinPath) : null;

  if (existsSync(userConfigFile())) {
    line(`An existing customization file exists: ${userConfigFile()}`);
    if (!(await confirm("Overwrite it? (n keeps your current config)", false, interactive))) {
      line("OK — leaving your config untouched. Run `vibecoder doctor` to inspect it.");
      return 0;
    }
  }

  // ── local ollama ────────────────────────────────────────────────────────────
  line("Local mode (free, offline-capable): Ollama runs models on YOUR machine.");
  const useOllama = await confirm("Use a local Ollama model as the default?", true, interactive);
  const model = LOCAL_MODEL;
  if (useOllama) {
    const bin = ollamaBinary();
    if (!bin) {
      line("  note: ollama is not installed yet.");
      line(`        install:  curl -fsSL https://ollama.com/install.sh | sh`);
      line(`        then pull the default model:  ollama pull ${model}`);
    } else {
      const up = await ollamaIsUp(ollamaBaseUrl());
      if (!up) line(`  note: ollama is installed but not running — vibecoder will start it automatically.`);
      else {
        const models = await ollamaModels(ollamaBaseUrl());
        line(`  server running, local models: ${models.length ? models.join(", ") : "(none — run: ollama pull " + model + ")"}`);
      }
    }
  } else {
    line("  using cloud providers only — set an API key below (or later in ~/.vibecoder/.env).");
  }

  // ── free-tier keys ──────────────────────────────────────────────────────────
  line();
  line("Free cloud options (no payment): a GROQ key unlocks fast online chat; an");
  line("NVIDIA NIM key unlocks the big reasoning model. Both are free tiers.");
  const groqKey = await prompt("GROQ API key (enter or leave empty to skip): ", "", interactive);
  const nvidiaKey = await prompt("NVIDIA API key (enter or leave empty to skip): ", "", interactive);

  // ── build & write config ────────────────────────────────────────────────────
  const overrides: Record<string, unknown> = {};
  if (useOllama) {
    overrides.provider = "ollama";
    overrides.model = model;
  }
  const base = (builtin ?? {}) as RootConfig;
  const cfg = deepMerge<RootConfig>(base, overrides);

  // Keep routing offline-fallback pointing at the local model so vibecoder
  // stays useful with zero keys and no network.
  if (useOllama) {
    const routing: RoutingConfig = cfg.routing
      ? { ...cfg.routing, offlineProvider: "ollama", offlineModel: model }
      : { chatProvider: "ollama", chatModel: model, heavyProvider: "ollama", heavyModel: model, strategy: "hybrid", offlineProvider: "ollama", offlineModel: model };
    cfg.routing = routing;
  }

  const written = writeUserConfig(cfg);

  // ── keys file ───────────────────────────────────────────────────────────────
  if (groqKey || nvidiaKey) {
    const envFile = join(homedir(), ".vibecoder", ".env");
    mkdirSync(join(homedir(), ".vibecoder"), { recursive: true });
    if (groqKey) appendFileSync(envFile, `GROQ_API_KEY=${groqKey}\n`);
    if (nvidiaKey) appendFileSync(envFile, `NVIDIA_API_KEY=${nvidiaKey}\n`);
    line(`  keys written to ${envFile} (chmod 600 recommended).`);
  }

  line();
  line("Done. Your customization file:");
  line(`  ${written}`);
  line();
  line("Next:");
  line(`  vibecoder doctor                  # verify install + providers`);
  line(`  vibecoder                         # start the interactive agent`);
  line(`  vibecoder --prompt "your task"     # one-shot run`);
  if (useOllama && !(await ollamaIsUp(ollamaBaseUrl()))) line(`  ollama pull ${model}               # make sure the local model is downloaded`);
  line();
  return 0;
}