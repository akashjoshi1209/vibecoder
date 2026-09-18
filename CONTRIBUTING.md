# Contributing to Vibecoder

Thanks for helping make Vibecoder better. This project is free, open source
(MIT), and runs on plain Node.js (>=18.17) and Bun.

## Getting started

```bash
git clone https://github.com/akashjoshi1209/vibecoder.git
cd vibecoder
bun install          # installs dev deps (typescript, type defs)
bun run typecheck    # tsc --noEmit
bun test             # full suite (unit tests only; they never call an LLM)
```

Run it from source:

```bash
bun run src/cli.ts               # interactive REPL
bun run src/cli.ts --prompt "hi" # one-shot
bun run src/daemon.ts status     # queue daemon status
```

## Project layout

```
src/
  cli.ts / ui/repl.ts      CLI entry + TUI REPL (subcommands: setup, doctor, queue)
  config.ts                config resolution (~/.vibecoder/config.json merged over defaults)
  env.ts                   .env loading
  paths.ts                 package-root probing (src and built dist layouts)
  self-edit.ts             self-edit guardrails: ledger, snapshots, undo
  doctor.ts / setup.ts     `vibecoder doctor` and `vibecoder setup`
  daemon.ts / queue*.ts    queue daemon
  tools/                   agent tools (bash, files, search) — Node-compatible
  llm/                     providers, model routing, connectivity polling
scripts/build.ts           bundles dist/vibecoder.js (Node target) + copies config.json
config.json                built-in defaults (shipped with the package)
```

## Conventions

- **No Bun-only APIs in `src/`.** The shipped CLI must run on plain Node
  (>=18.17). Prefer `node:*` imports. Tests may use `Bun.*` helpers — they only
  run under `bun test`.
- **Portable bundle:** `bun run build` produces single-file Node bundles in
  `dist/`. Don't commit `dist/`; `prepublishOnly` builds it for npm.
- **No secrets.** `.env` holds real API keys and is gitignored. Never commit it.
- Add tests for new logic in `src/*.test.ts`. Keep tests offline (all LLM calls
  are mocked or skipped in tests).

## Making a change

1. Branch or fork with a descriptive name.
2. Make the change small and focused; keep it Node-compatible.
3. Run `bun run typecheck` and `bun test` — both must pass.
4. For user-facing behavior, update `README.md` and the `--help` text in
   `src/ui/repl.ts`.

## Releasing

Version bumps + `npm publish` are done from a maintainer account. CI runs
`prepublishOnly` (build + typecheck + tests) before pack.

## Reporting issues

Report bugs and feature ideas at the
[GitHub issue tracker](https://github.com/akashjoshi1209/vibecoder/issues).