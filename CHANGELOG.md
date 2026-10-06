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

### Permission model consolidation
- Policy-free parsing/classification in `src/permissions/parse.ts`, a single
  `decide()` core with a bounded audit ring in `src/permissions.ts`, and a
  `/permissions` command that shows recent decisions (domain + rule).

### Replayable run trace
- `--trace <file>` records provider steps, tool calls, approvals, permission
  decisions, trims and compactions as JSONL; `--trace-replay <file>` prints
  the timeline offline (no model needed); `--trace-anon` scrubs cwd/home paths
  and secret-shaped tokens for bug reports.

### Summarizing compaction
- Old context is folded into a digest that is re-fed to the model (watermark
  and ContextTooLarge triggers) instead of being deleted; the digest persists
  with the session.
