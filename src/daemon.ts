// Standalone queue daemon: polls connectivity in the background, drains the
// task queue whenever the network is reachable. Runs without any TUI/stdin.
// Usage: `bun run src/daemon.ts [start|status|stop]` (start is default).
// Terminates cleanly on SIGINT / SIGTERM / process.kill for pid tracking.
import { mkdirSync, readFileSync, writeFileSync, unlinkSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "./llm/client";
import { loadDotEnv } from "./env";
import { ModelRouter } from "./llm/router";
import { createConnectivityPoller, type ConnectivityPoller } from "./llm/connectivity";
import { drainQueue, type QueueRunnerDeps } from "./queue-runner";
import { resetStale, nextQueued, queueFile, setQueueFileOverride } from "./queue";

function expandHome(p: string): string {
  if (p === "~") return homedir();
  if (p.startsWith("~/")) return join(homedir(), p.slice(2));
  return p;
}

// ── pid lock ───────────────────────────────────────────────────────────────────
const PID_FILE = join(homedir(), ".vibecoder", "queue-daemon.pid");

function readPid(): number | null {
  try {
    const s = readFileSync(PID_FILE, "utf8").trim();
    const pid = Number(s);
    return Number.isFinite(pid) ? pid : null;
  } catch {
    return null;
  }
}

function writePid(): void {
  mkdirSync(join(homedir(), ".vibecoder"), { recursive: true });
  writeFileSync(PID_FILE, String(process.pid));
}

function removePid(): void {
  try { unlinkSync(PID_FILE); } catch {}
}

function alive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

function lock(): boolean {
  const existing = readPid();
  if (existing !== null && existing !== process.pid && alive(existing)) {
    console.error(`[vibecoder-queue] daemon already running (pid ${existing}); exiting.`);
    return false;
  }
  writePid();
  return true;
}

// ── logger ────────────────────────────────────────────────────────────────────
function logger(logPath?: string): (line: string) => void {
  const ts = () => new Date().toISOString();
  if (!logPath) return (line) => console.log(`[${ts()}] ${line}`);
  mkdirSync(logPath.replace(/[/\\][^/\\]+$/, ""), { recursive: true });
  return (line) => {
    const text = `[${ts()}] ${line}\n`;
    writeFileSync(logPath, text, { flag: "a" });
  };
}

// ── main loop ─────────────────────────────────────────────────────────────────
async function main() {
  loadDotEnv();
  if (!lock()) { process.exit(1); }
  process.on("exit", removePid);
  process.on("SIGINT", () => { removePid(); process.exit(0); });
  process.on("SIGTERM", () => { removePid(); process.exit(0); });

  const cfg = await loadConfig().catch((e: Error) => {
    console.error(`[queue] config load failed: ${e.message}`);
    process.exit(1);
  });

  const rawLogFile = (cfg as any).queue?.daemonLog;
  const logFile = rawLogFile ? expandHome(rawLogFile) : join(homedir(), ".vibecoder", "queue-daemon.log");
  setQueueFileOverride((cfg as any).queue?.file);
  const onLog = logger(logFile);
  const onLogToConsole = (line: string) => { console.log(line); onLog(line); };

  // Ensure stale "running" tasks (from a previous crashed daemon) go back to queued.
  const reset = resetStale();
  if (reset) onLog(`[queue] reset ${reset} stale running task(s) from previous crash`);

  // Build router for the heavy route used by drainQueue.
  const limits = {
    maxInputTokens: cfg.maxInputTokens ?? (cfg.provider === "groq" ? 5000 : undefined),
    maxInputTokensPerMinute: cfg.maxInputTokensPerMinute ?? (cfg.provider === "groq" ? 6500 : undefined),
  };
  const router = new ModelRouter(cfg, limits);

  const runnerDeps: QueueRunnerDeps = {
    config: cfg,
    router,
    onLog: onLogToConsole,
    autoApproveExceptDestructive: (cfg as any).queue?.autoApproveExceptDestructive ?? true,
  };

  // Connectivity polling (using groq as the "online" indicator).
  const probeCfg = (cfg as any).connectivity ?? {};
  const probeUrl = probeCfg.probeUrl ?? "https://api.groq.com/openai/v1/models";
  const pollMs = probeCfg.pollMs ?? 15_000;
  const timeoutMs = probeCfg.timeoutMs ?? 8_000;
  onLog(`[queue] daemon started — probing ${probeUrl} every ${pollMs}ms`);

  // Initial drain attempt (maybe queue has items from a previous session while connectivity was online).
  let inFlight = false;
  const tryDrain = async (poller: ConnectivityPoller) => {
    if (inFlight) return;
    inFlight = true;
    try {
      if (poller.online) {
        const { ran, failed } = await drainQueue(runnerDeps);
        if (ran) onLog(`[queue] drained ${ran} task(s) (${failed} failed)`);
      }
    } finally {
      inFlight = false;
    }
  };

  const poller = createConnectivityPoller(
    { probeUrl, timeoutMs, pollMs },
    (online) => {
      onLog(online ? `[queue] online — attempting queue drain` : `[queue] offline — tasks will queue`);
      void tryDrain(poller);
    },
  );
  await poller.start();
  await tryDrain(poller);

  // Idle: sleep indefinitely — connectivity poller handles work.
  await new Promise((res) => { setInterval(() => {}, 10000); process.on("SIGTERM", () => res(undefined)); });
}

// ── subcommands ────────────────────────────────────────────────────────────────
function cmdStatus(): void {
  const pid = readPid();
  if (pid === null || !alive(pid)) {
    console.log("[queue] daemon not running");
    process.exit(0);
  }
  let queued = 0;
  try {
    const tasks = JSON.parse(readFileSync(queueFile(), "utf8"));
    queued = tasks.filter((t: any) => t.status === "queued" || t.status === "running").length;
  } catch {}
  console.log(`[queue] daemon running (pid ${pid}) — ${queued} queued/running task(s)`);
  process.exit(0);
}

function cmdStop(): void {
  const pid = readPid();
  if (pid === null || !alive(pid)) {
    console.log("[queue] daemon not running");
    process.exit(0);
  }
  try { process.kill(pid, "SIGTERM"); } catch {}
  console.log(`[queue] stop signal sent to pid ${pid}`);
  process.exit(0);
}

const cmd = process.argv[2] ?? "start";

if (cmd === "--version" || cmd === "-v" || cmd === "version") {
  console.log("1.0.0");
  process.exit(0);
}
if (cmd === "--help" || cmd === "-h" || cmd === "help") {
  console.log(
    "vibecoder-queue — task-queue daemon (part of vibecoder).\n" +
      "Usage: vibecoder-queue [start|status|stop]   (start is default)\n" +
      "Also:  vibecoder-queue --version | --help\n",
  );
  process.exit(0);
}
if (cmd !== "start" && cmd !== "status" && cmd !== "stop") {
  console.error(`[vibecoder-queue] unknown argument: ${cmd} (try 'status' or 'stop')`);
  process.exit(2);
}

if (cmd === "status") cmdStatus();
else if (cmd === "stop") cmdStop();

main();