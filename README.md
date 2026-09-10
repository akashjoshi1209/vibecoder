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

`bun run dev` on a terminal launches a full-screen TUI: scrollback + input line, streaming responses, status bar.

Keys

- type a message and press Enter to run it
- `ctrl-c` — interrupt a running task · clear the input line · exit when idle
- arrows / Home / End / `ctrl-left` / `ctrl-right` — move the cursor
- `Up` / `Down` — history; `Tab` — command completion
- `PageUp` / `PageDown` — scroll through the conversation scrollback (`↑N/M` indicator in the status bar)
- `ctrl-w` kill word · `ctrl-u` clear line · `ctrl-l` redraw

Input and commands

- `/provider <name>` — switch provider (groq, ollama, openai, anthropic…)
- `/model <id>` — switch model
- `/approve [on|off]` — toggle per-tool approval prompts. Default **off** = no limits (agents act freely). With it on, each tool call asks `[y/n/a]` — `a` approves the rest of the run.
- `/save [name]` — save this conversation (auto-saved snapshots kept in `~/.vibecoder/last.json`)
- `/resume [name]` — resume a saved conversation (or the last one)
- `/list` — list saved conversations (saved to `~/.vibecoder/sessions/`)
- `/delete <name>` — delete a saved conversation
- `/new` — start a fresh conversation (keeps provider/model)
- `/clear` — clear the conversation and screen
- `/help` — command help
- `exit` or `quit` — leave the REPL outside the TUI; `ctrl-c` when idle inside the TUI

## Configuration (`config.json`)

- `provider` / `model` — defaults
- `temperature` — model sampling temperature (optional; passed through on every request)
- `providers` — add any OpenAI-compatible endpoint (GROQ, Ollama, OpenAI, NVIDIA NIM, local vLLM, etc.) or Anthropic. One entry per provider.
- `systemPrompt` — your agent's system instructions. Change it to change behavior entirely.

For OpenAI-compatible providers, the API key is read from the `apiKeyEnv` variable (e.g. `GROQ_API_KEY`). If left empty, requests go out keyless (works for local Ollama/vLLM).

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
- GROQ default model: `qwen/qwen3.8-27b`. Check `curl -s https://api.groq.com/openai/v1/models` (with your key) for the current catalog.