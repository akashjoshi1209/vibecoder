# Threat model — vibecoder's permission layer

This document says exactly what vibecoder's ask-mode protects against and what
it does not. The short version: **the permission layer is an advisory,
human-in-the-loop guard — not a kernel sandbox.** It reliably stops the
classified, obvious, and prompt-injected actions it knows about, prompts a
human for the borderline ones, and fails closed on anything it cannot
classify. It cannot stop a determined adversary who controls the model output
and the shell — nothing short of a kernel sandbox can, and vibecoder does not
claim otherwise.

## The risk

Vibecoder gives a language model shell and file access in your workspace.
Risks:

1. **Destruction** — deleting or overwriting files the human did not intend.
2. **Exfiltration** — reading secrets (`.env`, keys) and sending them out.
3. **Scope escape** — writing outside the workspace the human agreed to.
4. **Prompt injection** — content the model reads (a file, a web page, a tool
   result) instructs it to do 1–3.

## What the model enforces

Every tool action flows through one evaluator, `decide()`
(`src/permissions.ts`), which returns `allow` / `ask` / `deny` plus a rule
string. Every decision is recorded in a bounded audit ring (200 entries) and,
when `--trace` is on, appended to the run trace. The `/permissions` command
shows the recent decisions.

| Domain | Protects against | Notes |
| --- | --- | --- |
| `shell.destructive` | classified deletions/overwrites (`rm`, `mv`, `dd`, `shred`, `git reset --hard`, `find -delete`, output redirection, …) | `allow` / `ask` / `deny` per config; `ask` throws `ApprovalRequiredError`, the loop prompts a human and re-runs on yes |
| `shell.network` | classified outbound commands (`curl`, `wget`, `ssh`, `nc`, …) | `allow` / `deny` only — no `ask` |
| `env.secret` | reading dotenv/credential files through bash | denied unless `exposeSecrets`; `filterEnv` withholds API-key-shaped vars from every spawned child by default |
| `fs.read` / `fs.write` | touching paths outside the workspace when `filesystem: "workspace"` (or `--sandbox`) | resolved + symlink-checked (`realpathSync`) before use |
| `sandbox.write` | shell redirections writing outside the workspace in sandbox mode | see spec below |
| `plan.exec` | any mutation while in plan mode | read-only investigation is allowed |
| unlisted domains | anything not in the table | fail closed: `ask` interactively, `deny` unattended |

**Approval semantics.** `ask` means: the tool throws, the agent loop asks the
human (with a reason), and on yes the call is re-run with a *one-shot consent
marker* (`approvalSig` on the tool context) so exactly that call — and no
later one — passes the check. Without a prompter (queue, CI), `ask` produces
an explicit refusal, never a silent run.

## Sandbox mode (`--sandbox` / `filesystem: "workspace"`)

Phase 1 (what exists today, enforced on Linux and Windows):

- file reads/writes outside the workspace are refused (`fs.read`/`fs.write`);
- **redirect allowlist**: in a sandboxed shell, `> file` / `>> file` / `2> file`
  targets must resolve inside the workspace. Outside → `ask` (approved once by
  a human → runs; unattended → refused). Scratch targets are exempt:
  `/dev/null`, `/dev/stdout`, `/tmp/…`, `/var/tmp/…`, `C:\Windows\Temp\…`;
- **temp redirection**: `TMP` / `TEMP` / `TMPDIR` point at
  `<workspace>/.vibecoder/tmp`, so a tool that writes "somewhere temporary"
  writes somewhere inspectable and inside the allowlist. (Both at spawn *and*
  re-exported inside the login shell — Git for Windows' `/etc/profile`
  rewrites these vars unconditionally);
- secrets are withheld from child processes (unless `expose-secrets`);
- sandbox mode alone does **not** block the network — pair it with
  `--no-network` (or `permissions.network: "deny"`) for that.

Phase 2 (roadmap, Linux only): namespace/seccomp sandboxes (`nsjail` or
`bwrap`) around shell and search, with a read-only bind of the workspace.

## What this cannot protect against

These are known, accepted limits — treat the human prompt as the backstop and
read the reason line before approving:

1. **Argv write destinations of unclassified commands.** The sandbox
   allowlist parses *redirections*; `cp payload /etc/something` writes via an
   argv path, and `cp` is not in the destructive table (phase-1 scope).
   Classified commands (`mv`, `rm`, …) are covered by `shell.destructive`.
2. **Obfuscation.** Classification is argv/parse based. `curl $(...)`,
   base64-wrapped payloads, or a script that hides its actions from its own
   text defeat the classifiers. This is why `ask` exists.
3. **Whatever an approved command invokes.** Approving `make` reviews the
   word "make", not the Makefile. Approving `npm test` reviews the script
   name, not the process tree.
4. **No kernel boundary on Windows.** `nsjail`/`bwrap` are Linux-only; on
   Windows the sandbox is the allowlist + temp redirection above, enforced by
   parsing before spawn, not by the OS.
5. **Prompt injection that reaches the human.** A crafted file can convince
   the model to request something dangerous. The prompt (with its reason) is
   the last line of defense — it is only as good as the read it gets.
6. **Out-of-band channels.** Anything not mediated by a tool call (network
   stacks of already-approved programs, other processes on the machine) is
   outside this model entirely.
7. **Extensions are trusted code.** Local plugins (`plugins` in config,
   `"vibecoder.extension"` in a project `package.json`, `~/.vibecoder/plugins/`)
   and MCP servers (`config.mcpServers`) run with this process's full
   privileges and expose tools the model calls like built-ins — they are
   *unlisted* in the permission table, so nothing gates them at decision time
   (proxied MCP tools at least refuse in plan mode). Install them exactly as
   you would a dependency; they are the dependency. `--no-plugins` /
   `--no-mcp`, or `VIBECODER_NO_PLUGINS=1` / `VIBECODER_NO_MCP=1`, disable both
   wholesale.

## How to verify

- `/permissions` — recent decisions with domain and rule.
- `vibecoder --trace run.jsonl` then `vibecoder --trace-replay run.jsonl` —
  every decision, approval and tool call as an offline timeline
  (`--trace-anon` scrubs paths/secrets for bug reports).
- Tests: `src/permissions/decide.test.ts` (the table above),
  `src/tools/sandbox.test.ts` (allowlist + temp redirection),
  `src/agent/approval-rerun.test.ts` (ask → approve → runs, one-shot consent).

Found a hole not listed here? Please open a GitHub issue and say which row of
the table you expected to hold.
