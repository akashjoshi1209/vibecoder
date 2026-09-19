import { createProvider, loadConfig, type RootConfig } from "../llm/client";
import { ModelRouter, classifyMessage, type RoutingMode } from "../llm/router";
import { createConnectivityPoller, type ConnectivityPoller } from "../llm/connectivity";
import { draftPlanNote, drainQueue, type QueueRunnerDeps } from "../queue-runner";
import { enqueueTask, listTasks, setQueueFileOverride, type QueuedTask } from "../queue";
import { ensureOllamaServe } from "../ollama";
import type { Message, ChatOptions, ChatChunk, StreamResult } from "../llm/types";
import { runAgent } from "../agent/loop";
import { PLAN_MODE_PROMPT, isPlanOutput, stripPlanEnvelope } from "../agent/plan-mode";
import "../tools/bash";
import "../tools/files";
import "../tools/search";
import "../tools/net";
import "../tools/termux";
import "../tools/network";
import "../tools/env";
import "../tools/git";
import "../tools/connectivity";
import { saveSession, saveLast, loadSession, loadLast, listSessions, deleteSession, resolveResumeArg, type SessionData } from "../session";
import { resolve } from "../tools/fs-utils";
import { hasControllingTty } from "./terminal";
import { TUI } from "./tui";
import { setRuntimeIdentity, buildSelfReport, SELF_EDIT_PROTOCOL } from "../self-knowledge";
import { appendLedger, restoreSelfFiles, selfFileDiffStat, ledgerSummary } from "../self-edit";
import "../self-knowledge";
import { createInterface } from "node:readline";
import { loadDotEnv } from "../env";
import { runDoctor } from "../doctor";
import { runSetup } from "../setup";
import { readPackageJson } from "../paths";

const colors = {
  dim: "\x1b[2m",
  green: "\x1b[32m",
  cyan: "\x1b[36m",
  yellow: "\x1b[33m",
  magenta: "\x1b[35m",
  red: "\x1b[31m",
  gray: "\x1b[90m",
  reset: "\x1b[0m",
  bold: "\x1b[1m",
};

let messages: Message[] = [];
let systemPrompt = "";
let providerStream: (opts: ChatOptions, onChunk: (c: ChatChunk) => void) => Promise<StreamResult>;
let llmModel = "";
let providerName = "";
let cwd = process.cwd();
let activeAbort: AbortController | null = null;
let chatTemperature: number | undefined;
let chatMaxTokens: number | undefined;
let maxSteps = 40;
let maxInputTokens: number | undefined;
let maxInputTokensPerMinute: number | undefined;
let sessionId = "";
let rootConfig: RootConfig | null = null;
let router: ModelRouter | null = null;
let routerMode: RoutingMode = "auto";
let taskActive = false;
let planMode = false;
let connectivityPoller: ConnectivityPoller | null = null;
let online = false;
let nowDraining = false;
let tuiRef: TUI | null = null;

function limitsFor(cfg: RootConfig): { maxInputTokens?: number; maxInputTokensPerMinute?: number } {
  return {
    maxInputTokens: cfg.maxInputTokens ?? (cfg.provider === "groq" ? 5000 : undefined),
    maxInputTokensPerMinute: cfg.maxInputTokensPerMinute ?? (cfg.provider === "groq" ? 6500 : undefined),
  };
}

function shortId(provider: string, model: string): string {
  return model.startsWith(provider + "/") ? model.slice(provider.length + 1) : model;
}

function routeLabel(): string {
  if (!router) return "";
  const { chat, heavy } = router.names();
  const c = router.chatIdentity();
  const h = router.heavyIdentity();
  if (chat === heavy) return `router ${routerMode} · ${chat}/${shortId(chat, c.model)}`;
  return `router ${routerMode} · chat ${chat}/${shortId(chat, c.model)} ↔ heavy ${heavy}/${shortId(heavy, h.model)}`;
}

function currentSession(): SessionData {
  return {
    id: sessionId || `session-${new Date().toISOString().slice(0, 10)}-${Date.now().toString(36)}`,
    title: sessionTitleFromMessages(),
    createdAt: Date.now(),
    updatedAt: Date.now(),
    provider: providerName,
    model: llmModel,
    cwd,
    systemPrompt,
    messages,
    routerMode,
    messageCount: messages.length,
  };
}

function sessionTitleFromMessages(): string {
  const firstUser = messages.find((m) => m.role === "user");
  const base = firstUser?.content?.trim() ?? "(empty conversation)";
  return base.length > 46 ? base.slice(0, 46) + "…" : base;
}

function persistLast(): void {
  try {
    saveLast(currentSession());
  } catch {
    /* saving is best-effort */
  }
}

function applySession(s: SessionData | null): boolean {
  if (!s || !Array.isArray(s.messages)) return false;
  messages = s.messages.filter((m) => m && typeof m.role === "string");
  sessionId = s.id;
  taskActive = false;
  if (s.routerMode) routerMode = s.routerMode;
  if (s.systemPrompt) systemPrompt = s.systemPrompt;
  if (s.cwd) cwd = s.cwd;
  if (s.provider && rootConfig) {
    try {
      const r = createProvider(rootConfig, s.provider);
      providerName = r.name;
      llmModel = s.model || r.model;
      providerStream = r.provider.streamChat.bind(r.provider);
      router?.setChat(providerName, llmModel);
    } catch {
      /* keep current provider */
    }
  }
  return true;
}

function banner(_provider: string, _model: string, _dir: string): string[] {
  return [];
}

async function init() {
  const config = await loadConfig();
  rootConfig = config;
  setQueueFileOverride((config as any).queue?.file);
  const resolved = createProvider(config);
  providerName = resolved.name;
  llmModel = resolved.model;
  systemPrompt = (config.systemPrompt ?? "You are Vibecoder.") + SELF_EDIT_PROTOCOL;
  setRuntimeIdentity(providerName, llmModel);
  chatTemperature = config.temperature;
  chatMaxTokens = config.maxTokens;
  const limits = limitsFor(config);
  maxInputTokens = limits.maxInputTokens;
  maxInputTokensPerMinute = limits.maxInputTokensPerMinute;
  providerStream = resolved.provider.streamChat.bind(resolved.provider);
  router = new ModelRouter(config, limits);

  // ── local ollama autostart ─────────────────────────────────────────────────
  if (router.offlineIdentity()) {
    const oll = await ensureOllamaServe({
      readyTimeoutMs: 6000,
      onLog: (line) => process.stdout.write(`${colors.dim}${line}${colors.reset}\n`),
    });
    if (oll && !oll.running && !(oll.error ?? "").includes("autostart disabled")) {
      process.stdout.write(`${colors.dim}note: offline chat needs a local model (ollama pull qwen2.5:1.5b); meanwhile set GROQ_API_KEY so online routes keep working.${colors.reset}\n`);
    }
  }
  // ──────────────────────────────────────────────────────────────────────────

  // ── connectivity ──────────────────────────────────────────────────────────
  const probeCfg = config.connectivity ?? {};
  const probeUrl = probeCfg.probeUrl ?? "https://api.groq.com/openai/v1/models";
  const pollMs = probeCfg.pollMs ?? 15_000;
  const timeoutMs = probeCfg.timeoutMs ?? 8_000;
  connectivityPoller = createConnectivityPoller(
    { probeUrl, timeoutMs, pollMs },
    (now) => {
      online = now;
      if (tuiRef) {
        const rl = routeLabel();
        tuiRef.setStatus(
          `${onlineStatus()}${planTag()}${rl ? rl + " · " : ""}approve ${tuiRef.approveMode === "on" ? "on" : "off"}${taskActive ? " · task in progress" : ""} · PgUp/PgDn scroll`,
          8,
        );
      }
      if (online) void inAppDrain();
    },
  );
  await connectivityPoller.checkNow();
  online = connectivityPoller.online;
  // ──────────────────────────────────────────────────────────────────────────

  const pIdx = process.argv.indexOf("--provider");
  if (pIdx !== -1 && process.argv[pIdx + 1]) {
    const r = createProvider(config, process.argv[pIdx + 1]);
    providerName = r.name;
    providerStream = r.provider.streamChat.bind(r.provider);
    const mIdx = process.argv.indexOf("--model");
    if (mIdx !== -1 && process.argv[mIdx + 1]) llmModel = process.argv[mIdx + 1];
    else llmModel = r.model;
    router?.setChat(providerName, llmModel);
  }
  setRuntimeIdentity(providerName, llmModel);

  const dirArg = process.argv.indexOf("--cwd");
  if (dirArg !== -1 && process.argv[dirArg + 1]) {
    cwd = resolve(process.argv[dirArg + 1], { cwd: process.cwd() });
  }

  const stepsIdx = process.argv.indexOf("--max-steps");
  if (stepsIdx !== -1 && process.argv[stepsIdx + 1]) {
    const n = parseInt(process.argv[stepsIdx + 1], 10);
    if (Number.isFinite(n) && n > 0) maxSteps = n;
  }

  if (process.argv.includes("--plan")) planMode = true;
}

function onlineStatus(): string {
  if (online) return "";
  const off = router?.offlineIdentity();
  return off ? `offline (${off.provider}/${off.model}) · ` : "offline · ";
}

function planTag(): string {
  return planMode ? "plan · " : "";
}

/** Queue a task that was given while offline. Draft a plan note with the local
 *  model and print a preview to the TUI/REPL. */
async function queueOfflineTask(userInput: string, tui?: TUI): Promise<void> {
  if (!router || !rootConfig) return;
  const offRoute = router.resolveOffline(userInput);
  let planNote: string | undefined;
  try {
    planNote = await draftPlanNote(offRoute, userInput, 120_000);
  } catch { /* best-effort */ }

  const task = enqueueTask({
    userMessage: userInput,
    cwd,
    sessionId: sessionId || `session-${Date.now().toString(36)}`,
    systemPrompt,
    planNote,
  });

  const print = (s: string) => { if (tui) tui.printToScrollback(s); else process.stdout.write(s + "\n"); };
  print(`${colors.green}✓ queued${colors.reset} ${colors.dim}${task.id}${colors.reset} — will run automatically when connectivity returns`);
  if (planNote) print(`${colors.dim}${planNote.slice(0, 600)}${colors.reset}`);
  else print(`${colors.dim}(offline plan draft unavailable — the task is still queued)`);

  persistLast();
}

/** Drain the task queue now, streaming activity to the active TUI. */
async function inAppDrain(): Promise<void> {
  if (nowDraining || !router || !rootConfig) return;
  nowDraining = true;
  try {
    const cfg = rootConfig.queue ?? {};
    const deps: QueueRunnerDeps = {
      config: rootConfig,
      router,
      maxSteps: maxSteps,
      autoApproveExceptDestructive: cfg.autoApproveExceptDestructive ?? true,
      onLog: (line) => tuiRef?.printToScrollback(line),
    };
    const { ran, failed } = await drainQueue(deps);
    if (tuiRef && ran) tuiRef.printToScrollback(`${colors.green}[queue] drained ${ran} task(s)${failed ? `, ${failed} failed` : ""}${colors.reset}`);
  } finally {
    nowDraining = false;
  }
}

function brief(args: Record<string, unknown>): string {
  const s = JSON.stringify(args);
  return s.length > 120 ? s.slice(0, 120) + "…" : s;
}

async function handleCommand(line: string, tui?: TUI): Promise<boolean> {
  const print = (s: string) => {
    if (tui) tui.printToScrollback(s);
    else console.log(s);
  };
  const setStatus = () => {
    if (tui) {
      const rl = routeLabel();
      tui.setStatus(`${onlineStatus()}${planTag()}${rl ? `provider ${providerName} · model ${llmModel} · ${rl}` : `provider ${providerName} · model ${llmModel}`}`, 8);
    }
  };

  if (["exit", "quit", "/exit", "/quit"].includes(line.trim())) {
    if (tui) tui.close();
    process.exit(0);
    return true;
  }
  if (line.trim() === "/help" || line.trim() === "help") {
    print(`\n${colors.bold}Commands${colors.reset}`);
    print(`  ${colors.green}/provider <name>${colors.reset}  switch provider (groq, ollama, openai, anthropic…)`);
    print(`  ${colors.green}/model <id>${colors.reset}       switch model`);
    print(`  ${colors.green}/route [auto|chat|heavy]${colors.reset} ${colors.dim}model routing: auto-classify, or force chat/heavy model${colors.reset}`);
    print(`  ${colors.green}/plan [on|off]${colors.reset}     ${colors.dim}plan mode: investigate + return a plan, change nothing${colors.reset}`);
    print(`  ${colors.green}/approve [on|off]${colors.reset} ${colors.dim}toggle tool approval prompts (default off = no limits)${colors.reset}`);
    print(`  ${colors.green}/save [name]${colors.reset}      save this conversation`);
    print(`  ${colors.green}/resume [name]${colors.reset}    resume a saved conversation (or the last one)`);
    print(`  ${colors.green}/list${colors.reset}             list saved conversations`);
    print(`  ${colors.green}/delete <name>${colors.reset}    delete a saved conversation`);
    print(`  ${colors.green}/about${colors.reset}             self-knowledge report (model, config, tools)`);
    print(`  ${colors.green}/reload-config${colors.reset}     approve staged config edits — make them live`);
    print(`  ${colors.green}/review-self-edits${colors.reset} show audit ledger + pending config diff`);
    print(`  ${colors.green}/undo-self-edits${colors.reset}   reset config.json to last approved state (git)`);
    print(`  ${colors.green}/new${colors.reset}              start a fresh conversation (keeps provider/model)`);
    print(`  ${colors.green}/clear${colors.reset}            clear conversation + screen`);
    print(`  ${colors.green}/queue${colors.reset}            list queued offline tasks (auto-run when online)`);
    print(`  ${colors.green}/run-now${colors.reset}          drain the task queue now`);
    print(`  ${colors.green}/help${colors.reset}             this help`);
    print(`  ${colors.dim}PageUp/PageDown${colors.reset}       scroll back through the conversation`);
    print(`  ${colors.green}ctrl-c${colors.reset}            interrupt running task · clear input · exit\n`);
    return true;
  }
  if (line.startsWith("/save")) {
    const arg = line.slice(5).trim().replace(/^\/+/, "");
    try {
      const s = currentSession();
      if (arg) s.id = arg;
      sessionId = s.id;
      const f = saveSession(s);
      persistLast();
      print(`${colors.green}saved${colors.reset} ${colors.dim}${f}${colors.reset}`);
    } catch (err: any) {
      print(`${colors.red}save failed: ${err?.message ?? String(err)}${colors.reset}`);
    }
    return true;
  }
  if (line.startsWith("/resume")) {
    const arg = line.slice(7).trim();
    let resumed: SessionData | null = null;
    if (arg) {
      resumed = loadSession(arg);
    } else {
      resumed = loadLast();
    }
    if (!resumed) {
      print(`${colors.red}no previous conversation${arg ? ` named "${arg}"` : ""} found — use /save to keep one, or /list to browse${colors.reset}`);
    } else if (!applySession(resumed)) {
      print(`${colors.red}could not load the saved conversation${colors.reset}`);
    } else {
      setStatus();
      print(`${colors.green}resumed "${resumed.id}"${colors.reset} ${colors.dim}· ${resumed.messages.length} messages · ${resumed.provider}/${resumed.model}${colors.reset}`);
      print(`  ${colors.dim}${resumed.title}${colors.reset}`);
    }
    return true;
  }
  if (line.trim() === "/list") {
    const sessions = listSessions();
    if (!sessions.length) {
      print(`${colors.dim}no saved conversations yet — use /save${colors.reset}`);
      return true;
    }
    print(`\n${colors.bold}Saved conversations${colors.reset}`);
    for (const s of sessions) {
      const when = new Date(s.updatedAt).toLocaleString();
      const tag = s.id === sessionId ? colors.green + "•" + colors.reset + " " : "  ";
      print(`  ${tag}${colors.green}${s.id}${colors.reset} ${colors.dim}${s.messageCount} msgs · ${s.provider}/${s.model} · ${when}${colors.reset}`);
      print(`      ${colors.dim}${s.title}${colors.reset}`);
    }
    return true;
  }
  if (line.startsWith("/delete")) {
    const arg = line.slice(7).trim();
    if (!arg) {
      print(`${colors.red}usage: /delete <name>${colors.reset}`);
      return true;
    }
    if (!deleteSession(arg)) print(`${colors.red}no saved conversation named "${arg}"${colors.reset}`);
    else print(`${colors.green}deleted ${arg}${colors.reset}`);
    return true;
  }
  if (line.trim() === "/new") {
    messages = [];
    sessionId = "";
    taskActive = false;
    const config = await loadConfig();
    if (config.systemPrompt) systemPrompt = config.systemPrompt + SELF_EDIT_PROTOCOL;
    tui?.clearScrollback();
    if (tui) {
      // presentation-only: wordmark is owned by tui.ts centered idle choke; banner() stays, but must NOT be re-emitted to scrollback (accumulates per refresh/keyboard cycle)
      const rl = routeLabel();
      tui.setStatus(`${onlineStatus()}${rl ? `provider ${providerName} · model ${llmModel} · ${rl}` : `provider ${providerName} · model ${llmModel}`}`, 8);
    }
    print(`${colors.dim}fresh conversation started${colors.reset}`);
    return true;
  }
  if (line.startsWith("/model ")) {
    llmModel = line.slice(7).trim();
    if (!llmModel) return true;
    router?.setChat(providerName, llmModel);
    taskActive = false;
    setRuntimeIdentity(providerName, llmModel);
    setStatus();
    print(`${colors.dim}model set to ${llmModel}${colors.reset}`);
    return true;
  }
  if (line.startsWith("/provider ")) {
    const config = await loadConfig();
    const r = createProvider(config, line.slice(10).trim());
    providerName = r.name;
    llmModel = r.model;
    providerStream = r.provider.streamChat.bind(r.provider);
    router?.setChat(providerName, llmModel);
    taskActive = false;
    setRuntimeIdentity(providerName, llmModel);
    setStatus();
    print(`${colors.dim}provider set to ${providerName}, model ${llmModel}${colors.reset}`);
    return true;
  }
  if (line.startsWith("/route")) {
    const arg = line.slice(6).trim().toLowerCase();
    if (!arg) {
      print(`${colors.dim}mode: ${routerMode} · ${routeLabel() || `provider ${providerName}/${llmModel}`}${colors.reset}`);
      return true;
    }
    if (arg === "auto" || arg === "chat" || arg === "heavy") {
      routerMode = arg;
      taskActive = false;
      setStatus();
      print(`${colors.dim}router mode: ${routerMode}  (chat = ${routeLabel()})${colors.reset}`);
    } else {
      print(`${colors.red}usage: /route [auto|chat|heavy]${colors.reset}`);
    }
    return true;
  }
  if (line === "/plan" || line.startsWith("/plan ")) {
    const arg = line.slice(5).trim().toLowerCase();
    if (arg === "on") planMode = true;
    else if (arg === "off") planMode = false;
    else if (!arg) planMode = !planMode;
    else {
      print(`${colors.red}usage: /plan [on|off]${colors.reset}`);
      return true;
    }
    setStatus();
    print(
      planMode
        ? `${colors.green}plan mode on${colors.reset} ${colors.dim}— read-only: the agent investigates and returns a plan; write_file, edit_file, and destructive bash are blocked${colors.reset}`
        : `${colors.dim}plan mode off — the agent may execute changes again${colors.reset}`,
    );
    return true;
  }
  if (line.startsWith("/approve")) {
    const arg = line.slice(8).trim().toLowerCase();
    if (tui) {
      if (arg === "on") tui.approveMode = "on";
      else if (arg === "off") tui.approveMode = "off";
      else tui.approveMode = tui.approveMode === "on" ? "off" : "on";
      setStatus();
      print(`${colors.dim}tool approval: ${tui.approveMode === "on" ? "on (you approve each tool call)" : "off (agents act freely)"}${colors.reset}`);
    }
    return true;
  }
  if (line.trim() === "/about") {
    print(await buildSelfReport());
    const staged = selfFileDiffStat();
    print(
      staged
        ? `\n  pending config diff (not yet live):\n${staged}`
        : `\n  ${colors.dim}pending config diff: none${colors.reset}`,
    );
    if (staged) print(`  ${colors.dim}→ run /reload-config to approve and make live, or /undo-self-edits to revert${colors.reset}`);
    return true;
  }
  if (line.startsWith("/reload-config")) {
    const cfg = await loadConfig().catch(() => null);
    if (!cfg) {
      print(`${colors.red}config.json is not valid JSON right now — fix it first.${colors.reset}`);
      return true;
    }
    systemPrompt = (cfg.systemPrompt ?? "You are Vibecoder.") + SELF_EDIT_PROTOCOL;
    chatTemperature = cfg.temperature;
    chatMaxTokens = cfg.maxTokens;
    const limits = limitsFor(cfg);
    maxInputTokens = limits.maxInputTokens;
    maxInputTokensPerMinute = limits.maxInputTokensPerMinute;
    rootConfig = cfg;
    router = new ModelRouter(cfg, limits);
    appendLedger({ tool: "/reload-config", file: "config.json", beforeSha: "", afterSha: "", note: "staged config edits approved and applied by human" });
    setStatus();
    print(`${colors.green}approved & applied${colors.reset} — config is now live (${cfg.model ?? "model from config"}).${colors.dim} Consider ${colors.reset}${colors.green}git add config.json && git commit${colors.reset}${colors.dim} to mark this as the new approved baseline.${colors.reset}`);
    return true;
  }
  if (line.startsWith("/undo-self-edits")) {
    const res = restoreSelfFiles();
    if (res.ok) {
      appendLedger({ tool: "/undo-self-edits", file: "config.json", beforeSha: "", afterSha: "", note: "config.json reset to last approved (git HEAD) state by human" });
      const cfg = await loadConfig().catch(() => null);
      if (cfg) {
        systemPrompt = (cfg.systemPrompt ?? "You are Vibecoder.") + SELF_EDIT_PROTOCOL;
        rootConfig = cfg;
        const limits = limitsFor(cfg);
        maxInputTokens = limits.maxInputTokens;
        maxInputTokensPerMinute = limits.maxInputTokensPerMinute;
        router = new ModelRouter(cfg, limits);
      }
      print(`${colors.green}config.json reset to the last approved state.${colors.reset}${res.out ? ` (${res.out})` : ""}`);
      print(`  ${colors.dim}run /reload-config to reload the restored values.${colors.reset}`);
    } else {
      print(`${colors.red}reset failed:${colors.reset} ${res.out || "git restore errored"}`);
    }
    return true;
  }
  if (line.trim() === "/review-self-edits") {
    print(`\n${colors.bold}Self-edit audit ledger${colors.reset}${ledgerSummary(10).length ? "" : ` ${colors.dim}(empty)${colors.reset}`}`);
    for (const l of ledgerSummary(10)) print(l);
    const staged = selfFileDiffStat();
    print(`\n${colors.bold}Pending config changes (staged, not live)${colors.reset}:${staged ? "\n" + staged : ` ${colors.dim}none${colors.reset}`}`);
    if (staged) print(`  ${colors.dim}/reload-config to approve · /undo-self-edits to revert${colors.reset}`);
    return true;
  }
  if (line.trim() === "/clear") {
    messages = [];
    taskActive = false;
    tui?.clearScrollback();
    if (tui) {
      // presentation-only: wordmark is owned by tui.ts centered idle choke; banner() stays, but must NOT be re-emitted to scrollback (accumulates per refresh/keyboard cycle)
      const rl = routeLabel();
      tui.setStatus(`${onlineStatus()}${rl ? `provider ${providerName} · model ${llmModel} · ${rl}` : `provider ${providerName} · model ${llmModel}`}`, 8);
    }
    return true;
  }
  if (line.trim() === "/queue") {
    const tasks = listTasks();
    if (!tasks.length) {
      print(`${colors.dim}task queue is empty — offline tasks will be queued here automatically${colors.reset}`);
      return true;
    }
    print(`\n${colors.bold}Task queue (${tasks.length})${colors.reset}${online ? "" : `${colors.dim} — offline; will drain when online${colors.reset}`}`);
    for (const t of tasks) {
      const when = new Date(t.createdAt).toLocaleTimeString();
      const badge =
        t.status === "done" ? colors.green + "done" : t.status === "failed" ? colors.red + "failed" : t.status === "running" ? colors.yellow + "running" : colors.cyan + "queued";
      print(`  ${colors.gray}${t.id}${colors.reset} ${badge}${colors.reset} ${colors.dim}${when} · ${String(t.userMessage).slice(0, 70)}${colors.reset}`);
    }
    return true;
  }
  if (line.trim() === "/run-now" || line.trim() === "/drain") {
    if (!router || !rootConfig) {
      print(`${colors.red}router not initialised — try again in a moment${colors.reset}`);
      return true;
    }
    print(online ? `${colors.dim}draining queued tasks… (destination: router heavy model)${colors.reset}` : `${colors.dim}terminal is offline — /run-now attempts the queue anyway; it will retry when online${colors.reset}`);
    await inAppDrain();
    print(`${colors.green}drain complete${colors.reset}`);
    return true;
  }
  if (line.startsWith("/")) {
    print(`${colors.red}unknown command: ${line} — try /help${colors.reset}`);
    return true;
  }
  return false;
}

async function runPrompt(userInput: string, tui?: TUI): Promise<void> {
  messages.push({ role: "user", content: userInput });

  let turnProvider = providerStream;
  let turnModel = llmModel;
  let turnMaxInput = maxInputTokens;
  let turnMaxInputPerMinute = maxInputTokensPerMinute;
  let heavyRoute = false;
  let routeNote = "";
  if (router) {
    // Offline: tasks are queued for later; everything else chats on the local model.
    if (!online) {
      const c = classifyMessage(userInput);
      if (c === "heavy") {
        await queueOfflineTask(userInput, tui);
        // The turn is queued, not answered here — don't leave an unanswered
        // user turn lingering in the conversation history.
        messages.pop();
        return;
      }
      const off = router.resolveOffline(userInput);
      turnProvider = off.provider.streamChat.bind(off.provider);
      turnModel = off.model;
      turnMaxInput = off.maxInputTokens;
      turnMaxInputPerMinute = off.maxInputTokensPerMinute;
      setRuntimeIdentity(off.providerName, off.model);
      routeNote = `→ offline local: ${off.providerName}/${off.model}`;
    } else {
      const route = await router.resolve(userInput, routerMode, taskActive);
      turnProvider = route.provider.streamChat.bind(route.provider);
      turnModel = route.model;
      turnMaxInput = route.maxInputTokens;
      turnMaxInputPerMinute = route.maxInputTokensPerMinute;
      heavyRoute = router.isHeavy(route);
      setRuntimeIdentity(route.providerName, route.model);
      routeNote = `→ ${heavyRoute ? "heavy" : "chat"}: ${route.providerName}/${route.model}`;
    }
  }

  if (!tui) {
    process.stdout.write(`${colors.cyan}● ${turnModel}${colors.reset}${routeNote ? ` ${colors.dim}${routeNote}${colors.reset}` : ""}\n`);
  } else {
    tui.printToScrollback("");
    tui.separator();
    tui.printToScrollback(`${colors.bold}${colors.cyan}❯ ${userInput}${colors.reset}`);
    if (routeNote) tui.printToScrollback(`${colors.dim}${routeNote}${colors.reset}`);
    tui.busy = true;
    tui.setStatus(`router ${routerMode}${taskActive ? " · task" : ""}${heavyRoute ? " · heavy" : ""} — thinking…  (ctrl-c to interrupt)`, 8);
  }

  let aborted = false;
  const ac = new AbortController();
  activeAbort = ac;
  const startedAt = Date.now();
  let streaming = false;
  let reasoningShown = false;
  const spinnerFrames = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
  let spin = 0;
  const statusTimer = tui
    ? setInterval(() => {
        const secs = Math.round((Date.now() - startedAt) / 1000);
        const label = streaming ? "thinking" : "connecting";
        tui?.setStatus(`${spinnerFrames[spin++ % spinnerFrames.length]} ${label}… ${secs}s (ctrl-c to interrupt)`, 8);
      }, 120)
    : null;

  try {
    const turnSystemPrompt = planMode ? `${PLAN_MODE_PROMPT}\n\n${systemPrompt}` : systemPrompt;
    const result = await runAgent(
      {
        provider: turnProvider,
        systemPrompt: turnSystemPrompt,
        model: turnModel,
        initialMessages: messages,
        toolCtx: { cwd, signal: ac.signal, planPhase: planMode },
        signal: ac.signal,
        chatOptions: {
          temperature: chatTemperature,
          max_tokens: chatMaxTokens,
        },
        maxInputTokens: turnMaxInput,
        maxInputTokensPerMinute: turnMaxInputPerMinute,
      },
      {
        maxSteps,
        onModelText: (t) => {
          streaming = true;
          if (tui) tui.streamText(t, 7);
          else process.stdout.write(t);
        },
        onReasoning: (t) => {
          if (tui) {
            if (!reasoningShown) {
              tui.printToScrollback(`${colors.dim}[reasoning]${colors.reset}`);
              reasoningShown = true;
            }
            tui.streamText(t, 8);
          }
        },
        onToolStart: (name, args) => {
          streaming = true;
          if (tui) tui.printToScrollback(`${colors.yellow}⚡ ${name}${colors.reset} ${colors.gray}${brief(args)}${colors.reset}`);
          else process.stdout.write(`\n${colors.yellow}⚡ ${name}${colors.reset} ${colors.gray}${brief(args)}${colors.reset}\n`);
        },
        onToolEnd: (name, resultText) => {
          const firstLine = resultText.split("\n")[0].slice(0, 90);
          if (tui) tui.printToScrollback(`${colors.gray}  └ ${firstLine}${resultText.includes("\n") ? "…" : ""}${colors.reset}`);
          else process.stdout.write(`${colors.gray}[${name} → ${firstLine}${resultText.includes("\n") ? "…" : ""}]${colors.reset}\n`);
        },
        onTrimmed: (trimmed, truncatedChars) => {
          const note = `(trimmed ${trimmed} message(s)${truncatedChars ? `, truncated ${truncatedChars} chars` : ""} to fit the input token budget)`;
          if (tui) tui.printToScrollback(`${colors.dim}${note}${colors.reset}`);
          else process.stdout.write(`${colors.dim}${note}${colors.reset}\n`);
        },
        confirmTool: async (name, args) => {
          if (!tui || tui.approveMode === "off") return true;
          const ans = await tui.askConfirm(`${colors.yellow}${name}${colors.reset} ${colors.gray}${brief(args)}${colors.reset}`);
          if (ans === "all") tui.approveMode = "off";
          return ans !== "no";
        },
        onDone: (res) => {
          if (tui) tui.endStream();
          aborted = res.finishReason === "aborted";
        },
      },
    );

    const isPlan = planMode && isPlanOutput(result.finalText);
    messages.push({ role: "assistant", content: isPlan ? stripPlanEnvelope(result.finalText) : result.finalText });
    if (result.aborted) taskActive = false;
    else taskActive = heavyRoute && result.toolCalls > 0;
    void aborted;
    if (isPlan) {
      const note = "plan ready — review it, then /plan off to let the agent execute (or paste it into a new prompt)";
      if (tui) tui.printToScrollback(`${colors.dim}${note}${colors.reset}`);
      else process.stdout.write(`\n${colors.dim}${note}${colors.reset}\n`);
    }
  } catch (err: any) {
    const msg = err?.message ?? String(err);
    if (tui) tui.printToScrollback(`${colors.red}${msg}${colors.reset}`);
    else process.stdout.write(`\n${colors.red}${msg}${colors.reset}\n`);
  } finally {
    if (statusTimer) clearInterval(statusTimer);
    activeAbort = null;
    reasoningShown = false;
    persistLast();
    if (tui) {
      tui.busy = false;
      const rl = routeLabel();
      tui.setStatus(`${onlineStatus()}${planTag()}${rl ? rl + " · " : ""}approve ${tui.approveMode === "on" ? "on" : "off"}${taskActive ? " · task in progress" : ""} · PgUp/PgDn scroll`, 8);
    } else {
      process.stdout.write("\n");
    }
  }
}

function mainTUI(): void {
  const tui = new TUI(24, 80, {
    onSubmit: (line) => {
      void (async () => {
        try {
          if (await handleCommand(line, tui)) return;
          if (tui.busy) return;
          await runPrompt(line, tui);
        } catch (err: any) {
          tui.printToScrollback(`${colors.red}${err?.message ?? String(err)}${colors.reset}`);
        }
      })();
    },
    onAbort: () => {
      activeAbort?.abort();
      tui.setStatus("interrupting…", 3);
    },
  });

  process.on("exit", () => tui.close());

  process.on("SIGINT", () => {
    persistLast();
    tui.close();
    process.exit(0);
  });

  tui.start();
  const rl0 = routeLabel();
  tui.setStatus(`${onlineStatus()}${planTag()}${rl0 ? `provider ${providerName} · model ${llmModel} · ${rl0} · approve off · PgUp/PgDn scroll` : `provider ${providerName} · model ${llmModel} · approve off · PgUp/PgDn scroll`}`, 0);
}

function mainLine(): void {
  console.log(banner(providerName, llmModel, cwd).join("\n"));
}

function mainLineInteractive(): void {
  console.log(banner(providerName, llmModel, cwd).join("\n"));
  const rl = createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  const ask = () =>
    rl.question(`${colors.green}❯${colors.reset} `, async (input) => {
      const line = input.trim();
      if (!line) return ask();
      try {
        if (await handleCommand(line)) return ask();
        await runPrompt(line);
      } catch (err: any) {
        console.error(`${colors.red}${err?.message ?? String(err)}${colors.reset}`);
      }
      ask();
    });
  rl.on("close", () => {
    process.stdout.write("\n");
    process.exit(0);
  });
  ask();
}

function printUsage(): void {
  const v = readPackageJson()?.version ?? "dev";
  console.log(`vibecoder v${v} — a free, custom AI coding agent for your terminal`);
  console.log("");
  console.log("Usage:");
  console.log("  vibecoder                    interactive TUI REPL");
  console.log("  vibecoder \"task message\"      one-shot prompt");
  console.log("  vibecoder --prompt \"task\"     one-shot prompt (same as above)");
  console.log("  vibecoder setup              generate ~/.vibecoder/config.json (customize it!)");
  console.log("  vibecoder setup --yes        same, without prompts");
  console.log("  vibecoder doctor             check install, config, providers, connectivity");
  console.log("  vibecoder queue [start|status|stop]   run the queue daemon (vibecoder-queue)");
  console.log("");
  console.log("Options:");
  console.log("  --provider <name>   pick provider (groq, ollama, openai, anthropic, nvidia…)");
  console.log("  --model <id>        pick model");
  console.log("  --resume [name]     resume last (or named) conversation");
  console.log("  --plan              plan mode: investigate and return a plan without changing anything");
  console.log("  --max-steps <n>     cap the agent loop (default 40)");
  console.log("  --cwd <path>        work from another directory");
  console.log("  --version, -v       print version");
  console.log("  --help, -h          this help");
  console.log("");
  console.log("Environment:");
  console.log("  VIBECODER_CONFIG     exact config file to use (skips merge); otherwise ~/.vibecoder/config.json overrides defaults");
  console.log("  VIBECODER_SESSION_DIR  where sessions/ and queue.json live (default ~/.vibecoder)");
  console.log("  VIBECODER_NO_DOTENV=1   disable .env loading");
  console.log("  GROQ_API_KEY / NVIDIA_API_KEY / OPENAI_API_KEY / ANTHROPIC_API_KEY  (in ~/.vibecoder/.env or your shell)");
}

async function main() {
  loadDotEnv();

  const first = process.argv[2];
  if (first === "setup") {
    process.exitCode = await runSetup(process.argv);
    return;
  }
  if (first === "doctor") {
    process.exitCode = await runDoctor();
    return;
  }
  if (first === "--version" || first === "-v" || first === "version") {
    console.log(readPackageJson()?.version ?? "dev");
    return;
  }
  if (first === "--help" || first === "-h" || first === "help") {
    printUsage();
    return;
  }

  await init();

  const resume = resolveResumeArg(process.argv);
  if (resume.resume) {
    const resumed = resume.name ? loadSession(resume.name) : loadLast();
    if (resumed) {
      if (!applySession(resumed)) {
        console.log(`could not load the saved session${resumed.id ? ` "${resumed.id}"` : ""}`);
      }
    } else {
      console.log(`no previous conversation${resume.name ? ` named "${resume.name}"` : ""} found — use /save to keep one, or /list to browse`);
    }
  }

  const promptIdx = process.argv.indexOf("--prompt");
  let prompt = promptIdx !== -1 ? process.argv[promptIdx + 1] : undefined;
  // `vibecoder "some task"` is sugar for `vibecoder --prompt "some task"`.
  if (prompt === undefined && process.argv.length === 3 && process.argv[2] && !process.argv[2].startsWith("-")) {
    prompt = process.argv[2];
  }

  if (prompt) {
    mainLine();
    await runPrompt(prompt);
    return;
  }

  if (hasControllingTty()) {
    mainTUI();
  } else {
    mainLineInteractive();
  }
}

main().catch((err) => {
  process.stderr.write(`${colors.red}${err?.message ?? err}${colors.reset}\n`);
  process.exit(1);
});