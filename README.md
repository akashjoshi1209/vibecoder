# Vibecoder

A free, open-source AI coding agent that lives in your terminal. Fully yours —
no payments, no accounts, no artificial limitations, and every layer is
customizable: the prompt, the loop, the tools, the providers.

- **Made for phones too** — runs on Android via Termux, right in your pocket. Small screen, light model, full agent.
- **Runs anywhere** — installs in one terminal command; works on plain Node.js ≥ 18.17 (Bun optional), Linux/macOS/Android.
- **Works offline and free** — defaults to local [Ollama](https://ollama.com); no API key required to start.
- **Or brings your own free tier** — GROQ, NVIDIA NIM, OpenAI, Anthropic, any OpenAI-compatible endpoint.
- **Designed to be customized** — `vibecoder setup` generates a config file you can edit; no limits, no paywall.

## Install

One command, from any terminal (desktop **or** Android/Termux):

```bash
curl -fsSL https://raw.githubusercontent.com/akashjoshi1209/vibecoder/master/scripts/install.sh | bash
```

The script downloads the prebuilt CLI straight from GitHub — no npm publishing,
no accounts, no build tools. It installs Node itself on Termux (Android); on a
desktop it verifies you have Node ≥ 18.17 first.

### Android (Termux)

```bash
# once (2 min setup): install Termux from F-Droid at https://f-droid.org/en/packages/com.termux/
pkg install -y curl
curl -fsSL https://raw.githubusercontent.com/akashjoshi1209/vibecoder/master/scripts/install.sh | bash

# free + fully offline on the phone:
pkg install -y ollama && ollama pull qwen2.5:1.5b
vibecoder
```

Termux is fully supported: `vibecoder doctor`, `setup`, the TUI, the queue
daemon, and offline Ollama all work. Feels like a native IDE on a phone.

### Desktop (Linux / macOS)

Same one-liner above. Or, once the npm package is published, with your package
manager:

```bash
npm install -g vibecoder     # requires Node ≥ 18.17
bun add -g vibecoder         # if you prefer Bun
```

Verify:

```bash
vibecoder doctor
```

### Run it free, fully offline (optional but recommended)

```bash
curl -fsSL https://ollama.com/install.sh | sh
ollama pull qwen2.5:1.5b   # a small, fast local model (no account, no cost)
vibecoder
```

## Run

```bash
vibecoder                        # interactive REPL (auto-uses TUI when available)
vibecoder --prompt "task"        # single-shot
vibecoder "add a CLI flag"       # shorthand — same as --prompt
vibecoder --provider groq --model "qwen/qwen3.8-27b" --prompt "task"
vibecoder --resume               # resume your most recent conversation
vibecoder --resume mysession     # resume a named saved session
vibecoder --max-steps 10         # cap the agent loop (default 40)
vibecoder --cwd /some/path
```

### Choose your free model

Vibecoder supports any provider. Leave the API key blank for local models
(Ollama/vLLM); set `apiKeyEnv` for hosted ones.

| Provider | Key (in `~/.vibecoder/.env`) | Free? |
| --- | --- | --- |
| Ollama (local) | none | yes, offline |
| GROQ | `GROQ_API_KEY` | yes (free tier) |
| NVIDIA NIM | `NVIDIA_API_KEY` | yes (NVAI free credits) |
| OpenRouter | `OPENROUTER_API_KEY` | free tier models |
| OpenAI / Anthropic | `OPENAI_API_KEY` / `ANTHROPIC_API_KEY` | trial/paid |

```bash
vibecoder setup          # interactive: writes ~/.vibecoder/config.json + ~/.vibecoder/.env
vibecoder doctor         # checks install, config, providers, connectivity
```

## Customizing vibecoder

Everything is a text file you own:

```bash
vibecoder setup                # generates the config you then edit
~/.vibecoder/config.json       # provider/model, system prompt, routing, timeouts, tools
~/.vibecoder/.env              # your API keys (private, never tracked)
```

`~/.vibecoder/config.json` is **deep-merged** over the built-in defaults, so you
only write the lines you want to change. Set `VIBECODER_CONFIG=/path/to.json` to
take full control (that file is used exactly as-is).

## Interactive mode

A full-screen TUI with scrollback, streaming responses, and a status bar.

- type a message and press Enter to run it — the prompt area auto-wraps
- `ctrl-c` — interrupt a running task · clear the input line · exit when idle
- arrows / Home / End / `ctrl-left` / `ctrl-right` — move the cursor
- `Up` / `Down` — history; `Tab` — command completion
- `PageUp` / `PageDown` or the mouse wheel — scroll through the scrollback (`↑N/M` indicator in the status bar)

Commands:

- `/provider <name>` and `/model <id>` — switch on the fly
- `/route [auto|chat|heavy]` — model routing mode (see below)
- `/approve [on|off]` — toggle per-tool approval prompts. Default **off** = no limits (agents act freely).
- `/save [name]`, `/resume [name]`, `/list`, `/delete <name>`, `/new`, `/clear`
- `/about` — who vibecoder is: model card, provider, config, tools
- `/reload-config` — apply staged `config.json` edits made by the agent
- `/review-self-edits` — audit ledger + pending `config.json` diff
- `/undo-self-edits` — reset `config.json` to the last approved state
- `/help` — command help

## Self-knowledge & self-editing

Vibecoder knows what it is: `/about` (and the `self_about` tool) report the
actual runtime provider, model ID, model card, config values, and tool list.
Honest caveat: vibecoder can't change its own weights. "Self-edits" mean
changes to its own `config.json`, tools, or source — in a **user install**
those live in `~/.vibecoder/`; in a **repo/dev install** they're your git tree.

Self-edits are **staged, audited, and revertible**, never silently live:

- Every write/edit to a self-file lands in the append-only `SELF_EDITS.jsonl` ledger (before/after SHA-256).
- A `config.json` edit only goes live after a human runs `/reload-config`.
- `/undo-self-edits` restores the last approved config — via `git restore` in repo installs, or timestamped snapshots in `~/.vibecoder/backups/` for user installs.
- The ledger cannot be modified or deleted through the file tools.

## Configuration (`config.json`)

Key fields:

- `provider` / `model` — defaults
- `temperature`, `maxInputTokens`, `maxInputTokensPerMinute` — sampling + budget controls
- `providers` — any OpenAI-compatible endpoint or Anthropic, one entry per provider
- `routing` — dual-model routing (fast chat model + heavy task model)
- `systemPrompt` — your agent's system instructions. Change it to change behavior entirely.

```jsonc
{
  "provider": "ollama",
  "model": "qwen2.5:1.5b",
  "providers": {
    "groq": {
      "type": "openai-compatible",
      "baseURL": "https://api.groq.com/openai/v1",
      "apiKeyEnv": "GROQ_API_KEY",
      "models": ["qwen/qwen3.8-27b"]
    }
  }
}
```

## Model routing

Route between a fast/cheap model for chat and a heavy model for coding tasks:

```jsonc
"routing": {
  "chatProvider": "groq",
  "chatModel": "qwen/qwen3.8-27b",
  "heavyProvider": "nvidia",
  "heavyModel": "nvidia/nemotron-3-ultra-550b-a55b",
  "strategy": "hybrid"
}
```

1. Keyword rules classify each message as *chat*, *heavy*, or *ambiguous*.
2. `hybrid` asks the cheap model to decide ambiguous cases (~1s); `keyword` treats them as chat.
3. **Sticky tasking** — once a turn runs on the heavy model and used tools, follow-ups stay heavy until a clearly-chat message.

Per-provider timeouts and rate-limit retries are configurable (`timeoutMs`,
`timeoutIdleMs`, `maxRateLimitRetries`).

## Architecture

```
src/
├── cli.ts / ui/repl.ts   entry, CLI subcommands (setup, doctor, queue), REPL
├── agent/                the agentic loop: reason → act → observe → repeat
├── llm/                  client (provider factory), router, providers, connectivity
├── tools/                agent tools — bash, files, search, net (Node-compatible)
├── config.ts             config resolution & user-merge
├── self-edit.ts          self-edit guardrails: ledger, snapshots, undo
├── doctor.ts / setup.ts  setup wizard + diagnostics
├── daemon.ts / queue*.ts offline task queue daemon
├── session.ts            saved conversations
└── ui/                   TUI (render, keys, scrolling, streaming) + terminal layer
```

## Extending

- **Add a tool:** drop a file in `src/tools/` calling `registerTool({ definition, run })` and import it in `src/ui/repl.ts`. Tools can shell out to any language.
- **Add a provider:** add an entry in `config.json` (any OpenAI-compatible URL works) or implement `LLMProvider` in `src/llm/providers/`.
- **Change behavior:** edit `systemPrompt` in `config.json`, or anywhere under `src/` — you own the loop.

## Development

```bash
git clone https://github.com/akashjoshi1209/vibecoder.git
bun install
bun run typecheck   # tsc --noEmit
bun test            # unit tests (never call an LLM)
bun run dev         # run from source
```

See [CONTRIBUTING.md](CONTRIBUTING.md) (also: the shipped CLI targets plain
Node ≥ 18.17, so `src/` must not use Bun-only APIs).

## License

MIT — see [LICENSE](LICENSE). Free for everyone, forever, no strings.