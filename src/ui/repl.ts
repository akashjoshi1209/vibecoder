import { createProvider, loadConfig } from "../llm/client";
import type { Message, ChatOptions, ChatChunk, StreamResult } from "../llm/types";
import { runAgent } from "../agent/loop";
import "../tools/bash";
import "../tools/files";
import "../tools/search";
import { resolve } from "../tools/fs-utils";
import { hasControllingTty } from "./terminal";
import { TUI } from "./tui";

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

function banner(provider: string, model: string, dir: string): string[] {
  return [
    `${colors.bold}${colors.green}vibecoder${colors.reset} ${colors.dim}— your own coding agent, no limitations${colors.reset}`,
    `${colors.dim}provider: ${provider}  model: ${model}  cwd: ${dir}  (type /help)${colors.reset}`,
  ];
}

async function init() {
  const config = await loadConfig();
  const resolved = createProvider(config);
  providerName = resolved.name;
  llmModel = resolved.model;
  systemPrompt = config.systemPrompt ?? "You are Vibecoder.";
  providerStream = resolved.provider.streamChat.bind(resolved.provider);

  const pIdx = process.argv.indexOf("--provider");
  if (pIdx !== -1 && process.argv[pIdx + 1]) {
    const r = createProvider(config, process.argv[pIdx + 1]);
    providerName = r.name;
    providerStream = r.provider.streamChat.bind(r.provider);
    const mIdx = process.argv.indexOf("--model");
    if (mIdx !== -1 && process.argv[mIdx + 1]) llmModel = process.argv[mIdx + 1];
    else llmModel = r.model;
  }

  const dirArg = process.argv.indexOf("--cwd");
  if (dirArg !== -1 && process.argv[dirArg + 1]) {
    cwd = resolve(process.argv[dirArg + 1], { cwd: process.cwd() });
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
    if (tui) tui.setStatus(`provider ${providerName} · model ${llmModel}`, 8);
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
    print(`  ${colors.green}/approve [on|off]${colors.reset} ${colors.dim}toggle tool approval prompts (default off = no limits)${colors.reset}`);
    print(`  ${colors.green}/clear${colors.reset}            clear conversation + screen`);
    print(`  ${colors.green}/help${colors.reset}             this help`);
    print(`  ${colors.dim}PageUp/PageDown${colors.reset}       scroll back through the conversation`);
    print(`  ${colors.green}ctrl-c${colors.reset}            interrupt running task · clear input · exit\n`);
    return true;
  }
  if (line.startsWith("/model ")) {
    llmModel = line.slice(7).trim();
    if (!llmModel) return true;
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
    setStatus();
    print(`${colors.dim}provider set to ${providerName}, model ${llmModel}${colors.reset}`);
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
  if (line.trim() === "/clear") {
    messages = [];
    tui?.clearScrollback();
    if (tui) {
      for (const b of banner(providerName, llmModel, cwd)) tui.printToScrollback(b);
      tui.setStatus(`provider ${providerName} · model ${llmModel}`, 8);
    }
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

  if (!tui) {
    process.stdout.write(`${colors.cyan}● ${providerName}/${llmModel}${colors.reset}\n`);
  } else {
    tui.printToScrollback(`${colors.cyan}❯ ${userInput}${colors.reset}`);
    tui.busy = true;
    tui.setStatus("thinking…  (ctrl-c to interrupt)", 8);
  }

  let aborted = false;
  const ac = new AbortController();
  activeAbort = ac;
  const startedAt = Date.now();
  let streaming = false;
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
        provider: providerStream,
        systemPrompt,
        model: llmModel,
        initialMessages: messages,
        toolCtx: { cwd, signal: ac.signal },
        signal: ac.signal,
      },
      {
        onModelText: (t) => {
          streaming = true;
          if (tui) tui.streamText(t, 7);
          else process.stdout.write(t);
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

    messages.push({ role: "assistant", content: result.finalText });
    void aborted;
  } catch (err: any) {
    const msg = err?.message ?? String(err);
    if (tui) tui.printToScrollback(`${colors.red}${msg}${colors.reset}`);
    else process.stdout.write(`\n${colors.red}${msg}${colors.reset}\n`);
  } finally {
    if (statusTimer) clearInterval(statusTimer);
    activeAbort = null;
    if (tui) {
      tui.busy = false;
      tui.setStatus(`provider ${providerName} · model ${llmModel} · approve ${tui.approveMode === "on" ? "on" : "off"}`, 8);
    } else {
      process.stdout.write("\n");
    }
  }
}

function mainTUI(): void {
  const tui = new TUI(24, 80, {
    onSubmit: (line) => {
      void (async () => {
        if (await handleCommand(line, tui)) return;
        if (tui.busy) return;
        await runPrompt(line, tui);
      })();
    },
    onAbort: () => {
      activeAbort?.abort();
      tui.setStatus("interrupting…", 3);
    },
  });

  process.on("exit", () => tui.close());

  tui.start();
  for (const b of banner(providerName, llmModel, cwd)) tui.printToScrollback(b, true);
  tui.setStatus(`provider ${providerName} · model ${llmModel} · approve off`, 8);
}

function mainLine(): void {
  console.log(banner(providerName, llmModel, cwd).join("\n"));
}

function mainLineInteractive(): void {
  console.log(banner(providerName, llmModel, cwd).join("\n"));
  const readline = require("node:readline") as typeof import("node:readline");
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  const ask = () =>
    rl.question(`${colors.green}❯${colors.reset} `, async (input) => {
      const line = input.trim();
      if (!line) return ask();
      if (await handleCommand(line)) return ask();
      await runPrompt(line);
      ask();
    });
  rl.on("close", () => {
    process.stdout.write("\n");
    process.exit(0);
  });
  ask();
}

async function main() {
  await init();

  const promptIdx = process.argv.indexOf("--prompt");
  const prompt = promptIdx !== -1 ? process.argv[promptIdx + 1] : undefined;

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