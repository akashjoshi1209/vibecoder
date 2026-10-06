import { createProvider, loadConfig, type RootConfig } from "../llm/client";
import { ModelRouter, classifyMessage, classifyMessageWhy, type RoutingMode } from "../llm/router";
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
// tools/tailscale.ts was deleted: it also registered "tailscale_status" and was
// shadowing network.ts, which is the better implementation.
import "../tools/network";
import "../tools/env";
import "../tools/git";
import "../tools/connectivity";
import { saveSession, saveLast, loadSession, loadLast, listSessions, deleteSession, resolveResumeArg, type SessionData, type PendingTask } from "../session";
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
import { resolvePermissions, type Permissions } from "../permissions";
import { setRootConfig } from "../runtime";
import { recordCost, costSummary, costReportText, ratesPerMillion } from "../cost";
import {
  describeDiff,
  revertSession,
  sessionDiff,
  setChangeSession,
} from "../changelog";
import {
  createCheckpoint,
  deleteCheckpoint,
  describeCheckpoint,
  diffAgainstCheckpoint,
  getCheckpoint,
  listCheckpoints,
  restoreCheckpoint,
} from "../checkpoint";

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
let connectivityPoller: ConnectivityPoller | null = null;
let online = false;
let nowDraining = false;
let tuiRef: TUI | null = null;
let permissions: Permissions = resolvePermissions({}, process.cwd());
/** The directory the agent is scoped to. Set from --cwd before init() runs so
 *  the permission model is resolved against the right root. */
let sessionCwd = process.cwd();
/** Plan mode: the next task turn investigates and plans only. */
let planPhase = false;
/** Plan mode is a one-turn gate; the phase applies to the turn that follows a
 *  /plan command, then clears so the next message can execute the plan. */
let planPhaseNextTurn = false;
/** Set while a task is unfinished, cleared when a turn completes normally.
 *  Persisted with the session so `--resume` can see the task never landed. */
let pendingTask: PendingTask | undefined;

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
    pending: pendingTask,
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
  // Carry the unfinished marker across so /resume can say why the transcript
  // stops where it does, instead of leaving the model to guess.
  pendingTask = s.pending;
  setChangeSession(sessionId);
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
  // Publish the live config so tools can read config-derived tuning (the shell
  // output cap, search result limits) without ToolContext having to carry it.
  setRootConfig(config);
  setQueueFileOverride((config as any).queue?.file);
  // Resolve the permission model once and thread it into every tool call.
  // Previously ctx.permissions was never set at runtime, so a config with
  // permissions.filesystem = "workspace" or destructive = "deny" was inert.
  permissions = resolvePermissions(config, sessionCwd);
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
  // The change log and checkpoints are keyed by session id. Set it before any
  // resume so a resumed session keeps appending to its own trail rather than
  // starting a fresh one that would leave the restored session's edits
  // unattributed.
  setChangeSession(sessionId || "startup");

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
  // Re-resolve permissions against the final working directory, since --cwd
  // can move the session after the first resolution in init().
  sessionCwd = cwd;
  permissions = resolvePermissions(config, sessionCwd);

  const stepsIdx = process.argv.indexOf("--max-steps");
  if (stepsIdx !== -1 && process.argv[stepsIdx + 1]) {
    const n = parseInt(process.argv[stepsIdx + 1], 10);
    if (Number.isFinite(n) && n > 0) maxSteps = n;
  }

  // CLI overrides for the permission model, so a run can be locked down without
  // editing config.json: --no-network, --sandbox, --no-secrets, --deny-destructive
  if (process.argv.includes("--deny-destructive")) permissions.destructive = "deny";
  if (process.argv.includes("--ask-destructive")) permissions.destructive = "ask";
  if (process.argv.includes("--no-network")) permissions.network = "deny";
  if (process.argv.includes("--sandbox")) permissions.filesystem = "workspace";
  if (process.argv.includes("--expose-secrets")) permissions.exposeSecrets = true;
  if (process.argv.includes("--plan")) {
    planPhase = true;
    planPhaseNextTurn = true;
  }
}

function onlineStatus(): string {
  if (online) return "";
  const off = router?.offlineIdentity();
  return off ? `offline (${off.provider}/${off.model}) · ` : "offline · ";
}

function planTag(): string {
  return planPhaseNextTurn ? "plan · " : "";
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
    print(`  ${colors.green}/approve [on|off]${colors.reset} ${colors.dim}toggle tool approval prompts (default off = no limits)${colors.reset}`);
  print(`  ${colors.green}/plan [on|off]${colors.reset}     ${colors.dim}next turn plans only, then clears — no writes, installs, or git changes${colors.reset}`);
  print(`  ${colors.green}/permissions${colors.reset}         ${colors.dim}show the active permission model${colors.reset}`);
    print(`  ${colors.green}/diff${colors.reset}             ${colors.dim}files this session changed, plus its restore points${colors.reset}`);
    print(`  ${colors.green}/revert [path…|all]${colors.reset}  ${colors.dim}undo those changes from pre-images${colors.reset}`);
    print(`  ${colors.green}/checkpoint [label]${colors.reset}  ${colors.dim}take a restore point · list · drop <id>${colors.reset}`);
    print(`  ${colors.green}/restore <id>${colors.reset}     ${colors.dim}put the workspace back to a restore point${colors.reset}`);
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
      // Say plainly that the last task never finished. Without this the model
      // resumes into a transcript that simply stops mid-thought and has to infer
      // from prose which edits landed — the failure mode this exists to remove.
      if (resumed.pending) printUnfinishedNote(resumed.pending, print);
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
    pendingTask = undefined;
    // A fresh conversation gets a fresh trail: /diff and /revert are scoped to
    // the current session, and silently mixing the old session's writes into the
    // new one would make /revert undo files the user never saw changed.
    setChangeSession("");
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
    if (arg === "on") planPhase = true;
    else if (arg === "off") {
      planPhase = false;
      planPhaseNextTurn = false;
    } else if (!arg) planPhase = !planPhase;
    else {
      print(`${colors.red}usage: /plan [on|off]${colors.reset}`);
      return true;
    }
    setStatus();
    print(
      planPhase
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
  if (line.startsWith("/permissions")) {
    const p = permissions;
    print(`${colors.bold}permissions${colors.reset}  (workspace root: ${p.workspaceRoot})`);
    print(`  destructive : ${p.destructive}${p.destructive === "ask" ? ` ${colors.dim}(you are prompted for each guarded command)${colors.reset}` : ""}`);
    print(`  network     : ${p.network}`);
    print(`  filesystem  : ${p.filesystem}`);
    print(`  secrets     : ${p.exposeSecrets ? "exposed to child processes" : "withheld from child processes"}`);
    print(`${colors.dim}  set in config.json under "permissions", or per-run: --sandbox --deny-destructive --no-network${colors.reset}`);
    return true;
  }

  // ── change log: what did this run actually touch, and how do I undo it ──────
  if (line.startsWith("/diff")) {
    const id = sessionId || currentSession().id;
    const diff = sessionDiff(id);
    const cps = listCheckpoints(id);
    print(`${colors.bold}changes in this session${colors.reset} ${colors.dim}(${id})${colors.reset}`);
    print(`  ${describeDiff(diff)}`);
    if (cps.length) {
      print(`\n  ${colors.dim}restore points: ${cps.map((c) => "#" + c.id).join(" ")} — /restore <id>${colors.reset}`);
    }
    print(`${colors.dim}  /revert [path…] undoes these; /revert all undoes everything. Untracked by git, so this works with no commits.${colors.reset}`);
    return true;
  }

  if (line.startsWith("/revert")) {
    const arg = line.slice(7).trim();
    const id = sessionId || currentSession().id;
    const all = !arg || arg === "all";
    const paths = all ? [] : arg.split(/\s+/);
    const res = revertSession(id, paths);
    if (!res.ok) {
      print(`${colors.red}${res.error}${colors.reset}`);
      return true;
    }
    for (const r of res.restored) print(`${colors.green}restored${colors.reset} ${r}`);
    for (const d of res.deleted) print(`${colors.green}deleted${colors.reset} ${d} ${colors.dim}(it did not exist before)${colors.reset}`);
    for (const s of res.skipped) print(`${colors.yellow}skipped${colors.reset} ${s}`);
    print(
      res.restored.length || res.deleted.length
        ? `${colors.dim}reverted ${res.restored.length} modified and ${res.deleted.length} created file(s)${colors.reset}`
        : `${colors.yellow}nothing was reverted${colors.reset}`,
    );
    if (res.skipped.length) print(`${colors.dim}  the change log still lists these — /diff shows what remains${colors.reset}`);
    return true;
  }

  if (line.startsWith("/checkpoint")) {
    const arg = line.slice(11).trim();
    if (arg === "list") {
      const cps = listCheckpoints(sessionId || undefined);
      if (!cps.length) {
        print(`${colors.dim}no restore points yet — /checkpoint [label] takes one${colors.reset}`);
        return true;
      }
      print(`${colors.bold}restore points${colors.reset}`);
      for (const c of cps) print(describeCheckpoint(c));
      print(`${colors.dim}  /restore <id> applies one back · /checkpoint drop <id> forgets it${colors.reset}`);
      return true;
    }
    if (arg.startsWith("drop ")) {
      const target = arg.slice(5).trim();
      const cp = getCheckpoint(target, sessionId || undefined);
      if (!cp) {
        print(`${colors.red}no restore point #${target}${colors.reset}`);
        return true;
      }
      deleteCheckpoint(cp.id, sessionId || undefined);
      print(`${colors.green}forgot restore point #${cp.id}${colors.reset}${cp.gitSha ? ` ${colors.dim}(git object ${cp.gitSha.slice(0, 10)} left for gc)${colors.reset}` : ""}`);
      return true;
    }
    const cp = await createCheckpoint({ sessionId: sessionId || currentSession().id, cwd, label: arg });
    print(`${colors.green}✓ checkpoint #${cp.id}${colors.reset}${cp.label ? ` ${colors.dim}${cp.label}${colors.reset}` : ""}`);
    print(`  ${cp.files.length} dirty file${cp.files.length === 1 ? "" : "s"} recorded`);
    if (cp.gitSha) {
      print(`  ${colors.dim}git object ${cp.gitSha.slice(0, 10)} — /restore #${cp.id} puts the whole tree back, including shell-made changes${colors.reset}`);
    } else {
      print(`  ${colors.dim}not a git repo, or the tree was clean — /revert still covers everything the agent wrote${colors.reset}`);
    }
    if (pendingTask) pendingTask.checkpointId = cp.id;
    return true;
  }

  if (line.startsWith("/restore")) {
    // Strip the confirmation word before parsing the id, so `/restore 2 yes`
    // and `/restore 2` resolve the same checkpoint.
    const rawArg = line.slice(8).trim();
    const arg = rawArg.replace(/\byes\b/gi, "").trim() || rawArg.split(/\s+/)[0];
    if (!arg) {
      print(`${colors.red}usage: /restore <checkpoint-id>${colors.reset} ${colors.dim}— /checkpoint list to see them${colors.reset}`);
      return true;
    }
    const cp = getCheckpoint(arg, sessionId || undefined);
    if (!cp) {
      print(`${colors.red}no restore point #${arg}${colors.reset}`);
      return true;
    }
    // Report drift before touching anything. Restoring over unsaved work is
    // exactly the situation where the user needs to see what they are about to
    // lose, and "nothing changed" vs "9 files drifted" is the whole difference.
    const drift = diffAgainstCheckpoint(cp);
    print(`${colors.bold}restore point #${cp.id}${colors.reset}${cp.label ? ` ${colors.dim}${cp.label}${colors.reset}` : ""} ${colors.dim}${cp.ts}${colors.reset}`);
    if (drift.clean) {
      print(`  ${colors.dim}workspace already matches this checkpoint — nothing to restore${colors.reset}`);
      return true;
    }
    if (drift.drifted.length) {
      print(`  ${colors.yellow}${drift.drifted.length} file(s) changed since this checkpoint — restoring discards those edits:${colors.reset}`);
      for (const f of drift.drifted.slice(0, 15)) print(`      ${f.slice(cp.cwd.length + 1)}`);
      if (drift.drifted.length > 15) print(`      ${colors.dim}… and ${drift.drifted.length - 15} more${colors.reset}`);
    }
    if (drift.added.length) print(`  ${drift.added.length} file(s) created since — they will remain`);
    if (drift.removed.length) print(`  ${drift.removed.length} file(s) deleted since — restoring recreates them`);

    // Confirmation gate.
    //
    // With a TUI, ask. Without one — a pipe, a script, a CI step — there is no
    // human to answer, and the alternative is the worst possible default for a
    // command that discards work: restore anyway, silently. So non-TTY requires
    // the user to say `yes` in the command itself, which is a deliberate act
    // rather than an absent one.
    // Tested against rawArg, not arg: arg has already had the word stripped out
    // so the id can be parsed, which would leave nothing to match.
    const forced = /\byes\b/i.test(rawArg);
    if (tui === undefined && !forced) {
      print(`${colors.red}refusing to restore without confirmation${colors.reset} ${colors.dim}— stdin is not a terminal, so there is nobody to ask${colors.reset}`);
      print(`  ${colors.dim}run ${colors.reset}/restore ${cp.id} yes${colors.dim} to go ahead, after reading the file list above${colors.reset}`);
      return true;
    }
    const proceed =
      tui !== undefined
        ? await tui.askConfirm(`restore the tree to #${cp.id}? this overwrites the changes above`)
        : true;
    if (!proceed) {
      print(`${colors.dim}left the workspace alone${colors.reset}`);
      return true;
    }
    const res = await restoreCheckpoint(cp);
    if (res.ok) {
      for (const f of res.restored.slice(0, 20)) print(`${colors.green}restored${colors.reset} ${f.slice(cp.cwd.length + 1)}`);
      if (res.restored.length > 20) print(`${colors.dim}  … and ${res.restored.length - 20} more${colors.reset}`);
      if (res.unrecoverable.length) {
        print(`${colors.yellow}not restorable${colors.reset} ${res.unrecoverable.length} file(s) — too large or unreadable when the checkpoint was taken:`);
        for (const f of res.unrecoverable.slice(0, 10)) print(`      ${f.slice(cp.cwd.length + 1)}`);
      }
      print(`${colors.dim}restored ${res.restored.length} file(s) to #${cp.id}. HEAD, the index and unrelated files were not touched.${colors.reset}`);
    } else {
      print(`${colors.red}restore failed${colors.reset} ${colors.dim}${res.error}${colors.reset}`);
      print(`  ${colors.dim}${res.hint}${colors.reset}`);
    }
    return true;
  }
  if (line.trim() === "/about") {
    print(await buildSelfReport());
    const cs = costSummary();
    print(
      cs.turnCount
        ? `\n  ${colors.bold}cost this session${colors.reset}\n${costReportText()}`
        : `\n  ${colors.dim}cost this session: no usage reported by the provider yet${colors.reset}`,
    );
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
  // Mark the task pending *before* the agent starts, so a turn killed by a
  // closed terminal or a killed process still leaves the session marked
  // unfinished. Without this, the only surviving evidence is a transcript that
  // simply stops, which is exactly what `--resume` could not interpret before.
  pendingTask = { request: userInput, reason: "interrupted", toolCalls: 0, at: Date.now() };

  let turnProvider = providerStream;
  let turnModel = llmModel;
  // The provider name has to travel with the turn: cost rates are per-provider,
  // and a heavy-route turn runs on a different (usually dearer) model than the
  // chat default, so pricing the turn with the global provider name would
  // misreport it.
  let turnProviderName = providerName;
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
      turnProviderName = off.providerName;
      turnMaxInput = off.maxInputTokens;
      turnMaxInputPerMinute = off.maxInputTokensPerMinute;
      setRuntimeIdentity(off.providerName, off.model);
      routeNote = `→ offline local: ${off.providerName}/${off.model}`;
    } else {
      const route = await router.resolve(userInput, routerMode, taskActive);
      turnProvider = route.provider.streamChat.bind(route.provider);
      turnModel = route.model;
      turnProviderName = route.providerName;
      turnMaxInput = route.maxInputTokens;
      turnMaxInputPerMinute = route.maxInputTokensPerMinute;
      heavyRoute = router.isHeavy(route);
      setRuntimeIdentity(route.providerName, route.model);
      routeNote = `→ ${heavyRoute ? "heavy" : "chat"}: ${route.providerName}/${route.model}`;
      // Why this route. The classifier is a blunt keyword matcher, so a misroute
      // is otherwise invisible: the user sees the wrong model and no reason for
      // it. One clause, and only when the verdict came from the fallback (task
      // continuation) rather than from the classifier.
      if (!heavyRoute) {
        const why = classifyMessageWhy(userInput);
        if (why.intent === "heavy") routeNote += ` ${colors.yellow}(classifier said heavy: ${why.reason})${colors.reset}`;
      }
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

  // Plan mode applies to this turn only; consume the pending request so the
  // following turn can execute whatever plan the human approved.
  const thisTurnIsPlan = planPhaseNextTurn;
  planPhaseNextTurn = false;
  const turnSystemPrompt = thisTurnIsPlan ? systemPrompt + "\n\n" + PLAN_MODE_PROMPT : systemPrompt;

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
    const result = await runAgent(
      {
        provider: turnProvider,
        systemPrompt: turnSystemPrompt,
        model: turnModel,
        initialMessages: messages,
        toolCtx: { cwd, signal: ac.signal, permissions, planPhase: thisTurnIsPlan },
        signal: ac.signal,
        chatOptions: {
          temperature: chatTemperature,
          max_tokens: chatMaxTokens,
        },
        maxInputTokens: turnMaxInput,
        maxInputTokensPerMinute: turnMaxInputPerMinute,
        // maxCostUsd was validated in config and then never read by anything, so
        // setting a cap had no effect whatsoever. Hand the loop the limit and the
        // rates it needs to evaluate it.
        maxCostUsd: rootConfig?.maxCostUsd,
        costRates: ratesPerMillion(turnProviderName, turnModel),
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
        confirmTool: async (name, args, reason) => {
          // A permission-model request (destructive: "ask") prompts even when
          // blanket approval is off. The user opted into being consulted for
          // destructive commands, so honouring that means actually consulting
          // them — otherwise "ask" is a no-op, which is what it used to be.
          if (!tui) return true;
          if (tui.approveMode === "off" && !reason) return true;
          const why = reason ? ` ${colors.dim}— ${reason}${colors.reset}` : "";
          const ans = await tui.askConfirm(
            `${colors.yellow}${name}${colors.reset} ${colors.gray}${brief(args)}${colors.reset}${why}`,
          );
          if (ans === "all") tui.approveMode = "off";
          return ans !== "no";
        },
        onDone: (res) => {
          if (tui) tui.endStream();
          aborted = res.finishReason === "aborted";
        },
      },
    );

    const isPlan = thisTurnIsPlan && isPlanOutput(result.finalText);
    messages.push({ role: "assistant", content: isPlan ? stripPlanEnvelope(result.finalText) : result.finalText });
    if (result.aborted) taskActive = false;
    else taskActive = heavyRoute && result.toolCalls > 0;
    void aborted;
    // Fold the turn's tokens into the session ledger. This was never called, so
    // every turn looked free and /about reported nothing.
    if (result.usage) {
      recordCost({
        provider: turnProviderName,
        model: turnModel,
        inputTokens: result.usage.promptTokens,
        outputTokens: result.usage.completionTokens,
        reasoningTokens: result.usage.reasoningTokens,
      });
    }
    // Distinguish "the model finished" from "we ran out of road". Only the
    // former should clear the pending marker, and only when the model actually
    // said something - a silent step-limit stop is not a finished task.
    if (!result.aborted && result.finalText.trim()) {
      pendingTask = undefined;
    } else {
      pendingTask = {
        request: userInput,
        reason: result.aborted ? "aborted" : "max_steps",
        toolCalls: result.toolCalls,
        at: Date.now(),
      };
    }
    if (result.toolCalls > 0 && pendingTask) reportUnfinished(result, tui);
    // Per-turn cost line. A heavy turn can be dozens of provider calls, so seeing
    // only a cumulative figure at /about left no way to tell an expensive turn
    // from a cheap one until the fact.
    if (result.usage) {
      printTurnCost(result.usage, result.toolCalls, { provider: turnProviderName, model: turnModel }, tui);
    }
    // Say when a plan is ready for review. This came from the Node-porting branch,
    // as did the plan-envelope stripping just above: the model wraps a plan in a
    // fenced <plan> envelope that is stripped before the transcript keeps it, so
    // without an explicit marker a plan reply reads like an ordinary answer and
    // nobody gets told the agent can now go execute it.
    if (isPlan) {
      const note = "plan ready - review it, then ask for the work (plan mode cleared itself, so the next turn can execute)";
      if (tui) tui.printToScrollback(`${colors.dim}${note}${colors.reset}`);
      else process.stdout.write(`\n${colors.dim}${note}${colors.reset}\n`);
    }
  } catch (err: any) {
    const msg = err?.message ?? String(err);
    pendingTask = { request: userInput, reason: "error", toolCalls: 0, at: Date.now() };
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

/** One dim line under a finished turn: what it cost, and the running total. */
function printTurnCost(
  usage: { promptTokens: number; completionTokens: number; reasoningTokens: number },
  toolCalls: number,
  pricedAs: { provider: string; model: string },
  tui?: TUI,
): void {
  const rates = ratesPerMillion(pricedAs.provider, pricedAs.model);
  const thisTurn =
    (usage.promptTokens * rates.input +
      usage.completionTokens * rates.output +
      usage.reasoningTokens * (rates.reasoning ?? rates.output)) /
    1e6;
  const s = costSummary();
  const total = s.totalCostUsd;
  const parts = [
    `in ${usage.promptTokens.toLocaleString()}`,
    `out ${usage.completionTokens.toLocaleString()}`,
  ];
  if (usage.reasoningTokens) parts.push(`reason ${usage.reasoningTokens.toLocaleString()}`);
  if (toolCalls) parts.push(`${toolCalls} tool call${toolCalls === 1 ? "" : "s"}`);
  const msg =
    `${colors.dim}~$${thisTurn.toFixed(4)} this turn (${parts.join(" · ")}) · ` +
    `session $${total.toFixed(4)} over ${s.turnCount} turn${s.turnCount === 1 ? "" : "s"} · estimate${colors.reset}`;
  if (tui) tui.printToScrollback(msg);
  else process.stdout.write(msg + "\n");
}

/** Tell the user the turn stopped short, and what they can do about it. */
function reportUnfinished(result: { toolCalls: number; aborted: boolean }, tui?: TUI): void {
  if (!pendingTask) return;
  const why =
    pendingTask.reason === "aborted"
      ? "was interrupted"
      : `hit the ${maxSteps}-step limit`;
  const msg =
    `${colors.yellow}⚠ task ${why}${colors.reset} ${colors.dim}after ${result.toolCalls} tool call${result.toolCalls === 1 ? "" : "s"}. ` +
    `The session is saved as unfinished — /diff shows what changed, /revert undoes it, /checkpoint takes a restore point.${colors.reset}`;
  if (tui) tui.printToScrollback(msg);
  else process.stdout.write(msg + "\n");
}

/** The same warning, for a session loaded back from disk. */
function printUnfinishedNote(p: PendingTask, print: (s: string) => void): void {
  const why =
    p.reason === "max_steps"
      ? `hit the step limit after ${p.toolCalls} tool call${p.toolCalls === 1 ? "" : "s"}`
      : p.reason === "aborted"
        ? "was interrupted"
        : p.reason === "error"
          ? "ended on an error"
          : p.reason === "cost_cap"
            ? "stopped at the cost cap"
            : "ended before finishing";
  print(`  ${colors.yellow}⚠ unfinished${colors.reset} ${colors.dim}the last task ${why}. Nothing after it ran.${colors.reset}`);
  print(`      ${colors.dim}request: ${p.request.slice(0, 120)}${colors.reset}`);
  const changed = sessionDiff(sessionId).files.length;
  print(
    `      ${colors.dim}/${changed ? `diff — ${changed} file(s) changed · ` : "diff — "}/checkpoint takes a restore point before you retry${colors.reset}`,
  );
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
  console.log("  --sandbox           restrict file tools + bash to --cwd");
  console.log("  --deny-destructive  block rm/mkfs/force-push/etc. outright");
  console.log("  --ask-destructive   require approval for destructive commands");
  console.log("  --no-network        block curl/wget/ssh and inline network code");
  console.log("  --expose-secrets    pass API-key env vars into child processes");
  console.log("  --plan              run the first turn in plan mode (investigate + propose, no changes)");
  console.log("  --version, -v       print version");
  console.log("  --help, -h          this help");
  console.log("");
  console.log("Environment:");
  console.log("  VIBECODER_CONFIG     exact config file to use (skips merge); otherwise ~/.vibecoder/config.json overrides defaults");
  console.log("  VIBECODER_SESSION_DIR  where sessions/, changes.jsonl and checkpoints live (default ~/.vibecoder)");
  console.log("  VIBECODER_ENV_FILE   exact .env to read and write; otherwise <cwd>/.env, then ~/.vibecoder/.env");
  console.log("  VIBECODER_MAX_OUTPUT  max chars of shell output per call (default 30000; excess is dropped from the middle)");
  console.log("  VIBECODER_NO_DOTENV=1   disable .env loading");
  console.log("  GROQ_API_KEY / NVIDIA_API_KEY / OPENAI_API_KEY / ANTHROPIC_API_KEY");
  console.log("      a real shell variable always wins. Otherwise read from, in order:");
  console.log("      $VIBECODER_ENV_FILE, <cwd>/.env (where `env_set` writes), ~/.vibecoder/.env");
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