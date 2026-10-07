# Changelog

Notable changes to `vibecoder-cli`, newest first. The `v*` tag triggers the
release workflow (`.github/workflows/release.yml`), which gates on
build + typecheck + test, publishes to npm, and attaches the tarball and this
file to the GitHub release.

## Unreleased — round 4 hardening

### dist/ removed from git
- `dist/` was committed, so every merge produced a dist-rebuild commit and the
  checked-in bundles could drift from `src/`. It is now generated: `.gitignore`
  covers it, `prepare` builds it at pack/install time, CI builds it and then
  packs a tarball into a clean project (`npm install <tarball>` +
  `./node_modules/.bin/vibecoder --version`) as an install smoke test.
- Migration notes for anyone with an existing checkout:
  - `git pull` will report `D dist/...` deletions staged — that is intentional
    (the files stay on disk, ignored from now on).
  - `bun run build` still produces `dist/` locally whenever you want it;
    `bun run dev` runs from `src/` and never needed it.
  - Installing from git now builds via `prepare` (requires Bun); installing
    from the npm tarball needs no build — `dist/` ships inside it.

### Release automation
- New `.github/workflows/release.yml`: push a `v*` tag (matching
  `package.json`'s version — there is an explicit integrity check) to publish
  to npm and create the GitHub release with the tarball + this change log
  attached. `workflow_dispatch` runs the gates as a dry run.
- `prepublishOnly` (build + typecheck + test) remains the publish gate.

### Test isolation
- `bun test --isolate` gives every test file a fresh global; CI additionally
  runs the suite in randomized order (fixed seed) so an order-dependent test
  fails in CI instead of in a stranger's checkout.

### Process layer
- Kill-tree tests prove no orphan survives `killProcessTree`; settle grace is
  an opt-in bounded knob (`settleGraceMs`, default off); tool call sites go
  through the spawn seam (enforced by a CI guard); fixed Windows `detached`
  default that silently swallowed PowerShell stdout.

### Extension point: schema lock, local plugins, MCP (plan item 8)
- **Tool schema lock**: `src/tools/schema.ts` — `TOOL_SCHEMA_VERSION` with
  `validateTool()` (lowercase name shape, non-empty description, JSON-schema
  inputs of type `object`, string output contract, optional `cost`/`onTrace`
  hooks). `registerTool()` enforces it, so every path — built-in, plugin, MCP
  proxy — passes the same contract, and `executeTool()` now times each call
  and fires the tool's `onTrace` hook (`{ tool, args, ms, ok }`), isolated so
  a throwing hook cannot break the call.
- **Local plugins** (`src/tools/plugins.ts`): load tools from packages that
  opt in via `plugins: [...]` in config, a `"vibecoder.extension"` field in
  the project `package.json`, or `~/.vibecoder/plugins/`. Validation-gated,
  failure-tolerant (a broken or colliding plugin reports, never crashes
  startup), `--no-plugins` / `VIBECODER_NO_PLUGINS=1` to skip.
- **MCP adapter** (`src/mcp.ts`, zero dependencies): `vibecoder mcp` serves
  the whole registry over MCP stdio (newline-delimited JSON-RPC 2.0:
  initialize / tools/list / tools/call / ping, ordered responses). And
  `config.mcpServers` spawns local MCP servers, registering their tools
  namespaced as `mcp_<server>_<tool>` with `[mcp:<server>]` provenance,
  plan-mode refusal, per-call timeouts and process-tree teardown —
  `--no-mcp` / `VIBECODER_NO_MCP=1` to skip. Both are startup-only;
  `/reload-config` does not re-run them (restart to pick up changes).
- `spawnSession()` joins the process layer (`proc.ts`): a long-lived,
  line-oriented child for MCP stdio — same resolveCommand/killtree rules as
  `spawnCollect`, with pipe-error suppression so a dead server cannot take
  the host down.
- Config: `plugins`, `mcpServers` (+ `validateConfig` checks). Usage,
  README "Extending" and THREAT_MODEL.md document the trust boundary:
  extensions are trusted local code, exactly like a dependency.

### Subagents: `task` fan-out + `/task`
- New `task` tool: run 1–4 independent sub-tasks in **isolated child loops**
  (fresh context, per-child step budget and wall-clock timeout, workspace-scope
  unattended permissions) and join the results. One child failing, timing out
  or demanding human approval is reported in its result — it never takes the
  parent or its siblings down, and never blocks on a prompt.
- Children run through the same routing/compaction/retry/permission pipeline
  as queued tasks (`runChildLoop` in `queue-runner.ts`), record into sibling
  trace files (`…task-N.jsonl` via `RunTrace.subTrace`), and leave one `task`
  record per child in the parent trace (replay reports `N child task(s)`).
- `/task <prompt> ;; <prompt> …` does the same from the REPL; `/task` alone
  documents when parallelism is safe (disjoint files, read-only) versus when
  it must stay serial (shared mutation: same files, git, `.env`, the queue).

### Permission model consolidation
- Policy-free parsing/classification in `src/permissions/parse.ts`, a single
  `decide()` core with a bounded audit ring in `src/permissions.ts`, and a
  `/permissions` command that shows recent decisions (domain + rule).

### Sandbox write-allowlist + threat model
- `--sandbox` now also gates shell *redirections*: in workspace-scope mode a
  `> file` target must resolve inside the workspace (scratch targets —
  `/dev/null`, `/tmp`, `C:\Windows\Temp`, … — are exempt) or the command asks
  for approval and runs once approved; unattended it is refused.
  `TMP`/`TEMP`/`TMPDIR` are pointed at `<workspace>/.vibecoder/tmp` so
  temp-file writers land inside the allowlist (re-exported after
  `/etc/profile`, which on Git for Windows rewrites them unconditionally).
- `THREAT_MODEL.md` documents what ask-mode does and does not protect
  (advisory parsing, argv destinations of unclassified commands, no kernel
  boundary on Windows, …), linked from the README.

### Fixed: an approved `ask` never ran
- Approving a destructive command re-ran it, which re-asked (the check is a
  pure function of the command), and the loop treated the second request as
  "no approver attached" — the human said yes and nothing happened. The
  approval flow now hands the tool a one-shot consent marker
  (`approvalSig`, cleared when the call returns), so the approved call runs
  exactly once and the next identical call asks again. Unattended runs still
  refuse explicitly; approval requests on the parallel path now report as
  unattended refusals instead of generic errors.

### Replayable run trace
- `--trace <file>` records provider steps, tool calls, approvals, permission
  decisions, trims and compactions as JSONL; `--trace-replay <file>` prints
  the timeline offline (no model needed); `--trace-anon` scrubs cwd/home paths
  and secret-shaped tokens for bug reports.

### Summarizing compaction
- Old context is folded into a digest that is re-fed to the model (watermark
  and ContextTooLarge triggers) instead of being deleted; the digest persists
  with the session.
