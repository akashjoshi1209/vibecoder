# Vibecoder

A custom AI coding agent — fully yours, no artificial limitations. Built framework-agnostic on TypeScript + Bun, so you own every layer: the prompt, the loop, the tools, the providers.

## Install

```bash
bun install
bun link   # puts the `vibecoder` command on your PATH (re-run after changes to apply)
```

## Run

```bash
vibecoder                        # interactive TUI REPL
vibecoder --prompt "task"        # single-shot (auto-falls back to line REPL when no TTY)
vibecoder --provider ollama --model qwen2.5:1.5b --prompt "task"
vibecoder --resume               # resume your most recent conversation
vibecoder --resume mysession     # resume a named saved session
vibecoder --max-steps 10         # cap the agent loop (default 40)
vibecoder --cwd /some/path
bun run dev                      # equivalent to `vibecoder` from the repo dir
```

Config is found relative to the installed script (override with `VIBECODER_CONFIG=/path/to/config.json`), so `vibecoder` works from any directory.

## Interactive mode

`bun run dev` on a terminal launches a full-screen TUI: scrollback + input, streaming responses, status bar.

Keys

- type a message and press Enter to run it — the prompt area auto-wraps to multiple rows so a long message stays fully visible while you type
- `ctrl-c` — interrupt a running task · clear the input line · exit when idle
- arrows / Home / End / `ctrl-left` / `ctrl-right` — move the cursor
- `Up` / `Down` — history; `Tab` — command completion
- `PageUp` / `PageDown` or the mouse wheel — scroll through the conversation scrollback (`↑N/M` indicator in the status bar)
- `ctrl-w` kill word · `ctrl-u` clear line · `ctrl-l` redraw

Each exchange is visually separated: a divider row and a bold `❯` header mark your message, tool calls appear as `⚡ name … └ result` lines, and the assistant's reply streams in the area below.

Input and commands

- `/provider <name>` — switch provider (groq, ollama, openai, anthropic…)
- `/model <id>` — switch model
- `/route [auto|chat|heavy]` — model routing mode: `auto` classifies each message, `chat` forces the light model, `heavy` forces the task model (see Model routing below)
- `/approve [on|off]` — toggle per-tool approval prompts. Default **off** = no limits (agents act freely). With it on, each tool call asks `[y/n/a]` — `a` approves the rest of the run.
- `/save [name]` — save this conversation (auto-saved snapshots kept in `~/.vibecoder/last.json`)
- `/resume [name]` — resume a saved conversation (or the last one)
- `/list` — list saved conversations (saved to `~/.vibecoder/sessions/`)
- `/delete <name>` — delete a saved conversation
- `/new` — start a fresh conversation (keeps provider/model)
- `/clear` — clear the conversation and screen
- `/about` — self-knowledge report: who vibecoder is, the model card (architecture, params, context, cutoff, license, limits), runtime config, and its tools
- `/reload-config` — **human approval step**: apply staged `config.json` edits made by the agent so they go live
- `/review-self-edits` — show the append-only audit ledger and the pending `config.json` diff
- `/undo-self-edits` — reset `config.json` to the last approved state (git HEAD restore)
- `/help` — command help

## Self-knowledge & self-editing

Vibecoder knows what it is and can answer "who/what are you?" factually — the `self_about` tool (model-facing) and `/about` (human-facing) report the actual runtime provider, model ID, model card from `src/llm/model-cards.ts`, config values, and tool list. The same honest caveat applies: vibecoder cannot change its own weights. "Self-edits" mean changes to `config.json`, its tools, or its source — all of which live in this repo.

Self-edits to `config.json` / `.env` are **staged, audited, and revertible**, never silently live:

- Every write/edit to a self-file is recorded in `SELF_EDITS.jsonl` (append-only, git-tracked) with before/after SHA-256 hashes, tool, and timestamp.
- A `config.json` edit only takes effect after the human runs `/reload-config` — that is the explicit approve-before-live step.
- `/undo-self-edits` restores `config.json` from git (the last commit = last approved state).
- The audit ledger cannot be modified or deleted through the file tools; the reset/reload commands live in code that is itself git-tracked, so any attempt to remove them shows up in `git diff` and is revertible. (An agent with free `bash` access can still bypass file-tool blocking — that residual risk is documented here.)
- The SEP is also injected into every system prompt as an immutable preamble (`SELF_EDIT_PROTOCOL`) that config edits can't remove.

## Commands

- `exit` or `quit` — leave the REPL outside the TUI; `ctrl-c` when idle inside the TUI
- `/about` — print who/what Vibecoder is (model card, provider, config, tools)
- `/route auto|chat|heavy` — set the routing mode for the current session
- `/reload-config` — approve staged `config.json` / `.env` self-edits and apply them
- `/undo-self-edits` — revert `config.json` to the last committed (approved) state
- `/save` — save the current conversation to a timestamped JSONL file under `vibecoder/sessions/`
- `/load <file>` — load a saved conversation (bare filename is resolved against `vibecoder/sessions/`)
- `/sessions` — list saved conversations (newest first)

## Configuration (`config.json`)

- `provider` / `model` — defaults
- `temperature` — model sampling temperature (optional; passed through on every request)
- `maxInputTokens` — input token budget per request (optional). When set, the agent trims the conversation history (keeping your first task message and the most recent turns) to fit within this budget, and if the provider still returns a "context too large" (HTTP 413) error it trims harder and retries once. Defaults to `5000` on GROQ. Trimming preserves whole tool-call/tool-result pairs so the provider never sees a broken tool sequence, and a safety factor keeps the real request comfortably under the provider's hard cap.
- `maxInputTokensPerMinute` — optional per-minute input-token cap (e.g. GROQ's free-tier 7000 ITPM). When set, requests are paced with a free delay so the rolling-minute total stays under the cap instead of burning requests on 429 rate-limit errors. Defaults to `6500` on GROQ. Remove it (set to `null`) and the agent instead relies on the existing rate-limit backoff.
- `providers` — add any OpenAI-compatible endpoint (GROQ, NVIDIA NIM, Ollama, OpenAI, local vLLM, etc.) or Anthropic. One entry per provider.
- `systemPrompt` — your agent's system instructions. Change it to change behavior entirely.

For OpenAI-compatible providers, the API key is read from the `apiKeyEnv` variable (e.g. `GROQ_API_KEY`, `NVIDIA_API_KEY`). If left empty, requests go out keyless (works for local Ollama/vLLM). Put keys in a gitignored `.env` file (e.g. `NVIDIA_API_KEY=nvapi-…`) — Bun loads it automatically and it never gets committed.

The bundled config also ships the NVIDIA provider with `nvidia/nemotron-3-ultra-550b-a55b` (1M context) and `nvidia/nemotron-3-super-120b-a12b`. Switch with `--provider nvidia --model "nvidia/nemotron-3-ultra-550b-a55b"` or by setting `provider` in `config.json`.

## Model routing

Vibecoder can route between **two** models: a fast/cheap one for chat & simple queries, and a big reasoning model for coding and complex tasks. This is what lets you talk to the free GROQ model all day without ever spending Nemotron credits on small talk, while still getting the heavy model when a real task starts.

Configure a `routing` block in `config.json`:

```json
"routing": {
  "chatProvider": "groq",
  "chatModel": "qwen/qwen3.8-27b",
  "heavyProvider": "nvidia",
  "heavyModel": "nvidia/nemotron-3-ultra-550b-a55b",
  "strategy": "hybrid"
}
```

How it works per message:

1. **Keyword rules** classify the message instantly as *chat*, *heavy* (coding verbs, file paths, code blocks, bug/error language, analysis terms), or *ambiguous*.
2. `strategy: "hybrid"` — an ambiguous message is asked to the cheap model to decide (a ~1s one-word query, capped at 10s). `"keyword"` skips that call and treats ambiguous as chat.
3. **Sticky tasking** — once a turn runs on the heavy model and actually used tools, follow-ups like "fix the bug" or "now make it faster" stay on the heavy model so the task keeps its context; a clearly-chat message resets it.

`/route auto|chat|heavy` overrides the mode for the current session (persisted with saved conversations). While a message is processed, the status bar shows which model is handling it (`chat`/`heavy`). The heavy model's per-request limits come from its provider block; the `nvidia` entry ships with generous `timeoutMs`/`timeoutIdleMs` because Nemotron's hosted tier can take a while to produce its first token.

If no `routing` block exists, vibecoder uses the top-level `provider`/`model` for everything (previous single-model behavior).

Timeouts (optional, per provider):

```json
"groq": {
  "type": "openai-compatible",
  "baseURL": "https://api.groq.com/openai/v1",
  "apiKeyEnv": "GROQ_API_KEY",
  "models": ["qwen/qwen3.8-27b"],
  "timeoutMs": 120000,
  "timeoutIdleMs": 60000,
  "maxRateLimitRetries": 2
}
```

- `timeoutMs` — hard ceiling for the whole request (default 120s).
- `timeoutIdleMs` — abort if no streaming data arrives for this long (default 60s). Great for catching stalled connections.
- `maxRateLimitRetries` — how many extra attempts on `429`/transient `5xx` (default 2). Each retry waits for the provider's suggested delay (`Retry-After` or the `try again in Ns` message, clamped to 60s), respecting the running idle/total timeouts and `ctrl-c` abort. So rate limits like GROQ's ITPM get waited out instead of killing the task.
- While a task runs, the status bar shows live progress like `thinking… 12s` (with time ticking up); timeouts surface as a clear red error instead of hanging forever. `ctrl-c` continues to abort.

## Architecture

```
src/
├── cli.ts          entry point
├── agent/
│   ├── loop.ts     the agentic loop: reason → act → observe → repeat
│   └── tool-call.ts parses + JSON-parses model tool calls
├── llm/
│   ├── client.ts   config → provider factory
│   ├── router.ts   dual-model router: keyword classifier + cheap-model fallback, sticky tasking
│   ├── timeout.ts  total/idle request timeouts for providers
│   ├── retry.ts    rate-limit (429/5xx) retry helper
│   ├── types.ts    shared LLM types
│   └── providers/  openai-compatible.ts, anthropic.ts
├── tools/
│   ├── registry.ts tool registry (this is the extension point)
│   ├── bash.ts     shell commands (timeout + process-group kill)
│   ├── files.ts    read_file / write_file / edit_file / list_dir
│   ├── search.ts   glob / grep
│   ├── net.ts      fetch_url (read web pages/docs, capped output)
│   └── fs-utils.ts
├── session.ts      conversation persistence (~/.vibecoder/sessions/)
└── ui/
    ├── tui.ts      full-screen terminal UI (render, keys, scrolling, streaming, approvals)
    ├── terminal.ts low-level terminal layer (raw mode, keys, ANSI-aware wrapping)
    └── repl.ts     TUI ⇄ line-mode dispatch, slash commands, session mgmt, agent wiring
```

## Extension points (no-limitation design)

### Add a tool
Drop a file in `src/tools/` that calls `registerTool({ definition, run })`, and import it once in `src/ui/repl.ts`. Tools can be written in any language by making `run` shell out to a subprocess — the TS core stays lean.

```ts
import { registerTool } from "./registry";

registerTool({
  definition: {
    type: "function",
    function: {
      name: "my_tool",
      description: "What it does",
      parameters: { type: "object", properties: { arg: { type: "string" } }, required: ["arg"] },
    },
  },
  async run(args, ctx) {
    return "result string the model sees";
  },
});
```

### Add a provider
Add an entry in `config.json`. Any OpenAI-compatible URL works (Ollama, vLLM, NVIDIA NIM, anything). For a different API shape, implement the `LLMProvider` interface in `src/llm/providers/` and wire it in `createProvider` in `src/llm/client.ts`.

### Change behavior
Edit `systemPrompt` in `config.json`, or dive into `src/agent/loop.ts` — you own the full reasoning loop, so nothing is opaque.

## Notes

- Tool outputs are capped (30k chars for bash) to protect context; adjust constants in `src/tools/`.
- Default model: `qwen2.5:1.5b` on Ollama. Check `ollama list` for locally available models. GROQ models (`qwen/qwen3.8-27b`, `openai/gpt-oss-120b`) are also configured as providers.