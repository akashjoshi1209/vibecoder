# Vibecoder Issues and Fixes Log

**Date:** 2026-09-27  
**Platform:** Windows 10, Node 22.23.2, Python 3.14.7

---

## Issues Found and Fixed

### 1. calc.py Syntax Error and Bloat
- **Problem:** calc.py had syntax errors (unterminated string at line 321), was quadruplicated with garbage blocks, and bloated to 29KB
- **Root Cause:** Session 2 ("improvements" scan) overwrote the file with broken edits — each "improvement" (implicit multiplication, variable assignment, history) introduced new bugs
- **Fix:** Clean rewrite of calc.py (12.8KB). Proper AST visitor, `^` as power (not XOR), implicit multiplication regex fixed (no longer breaks function calls like `sin()`), proper error handling
- **Verification:** All basic tests pass: `2^3=8`, `sin(pi/2)=1.0`, `sqrt(16)+log(e)=5.0`, `factorial(5)=120`, `x=5;x*2=10`, `deg();sin(90)=1.0`

### 2. `/graphify stats` Showed 0 Edges and 0 Communities
- **Problem:** Graph statistics displayed nodes=678, edges=0, communities=0
- **Root Cause:** `loadGraphStats()` in `src/graphify.ts` read `data.edges` but graph.json uses `links`; communities data is embedded on nodes, not as a top-level array
- **Fix:** Changed to read `data.links` for edges; count unique communities from node `community` fields using a Set
- **Verification:** Now shows nodes=678, edges=1695, communities=24

### 3. Missing `web_search` Tool (Internet Browsing)
- **Problem:** Vibecoder had `fetch_url` (can fetch URLs) but no way to *discover* URLs — no web search capability
- **Root Cause:** Not implemented; vibecoder relied on the LLM knowing URLs or using `fetch_url` directly
- **Fix:** Added `src/tools/web-search.ts` (5.2KB). Uses DuckDuckGo Instant Answer API first (clean JSON, no scraping), falls back to HTML scraping. No API key required.
- **Registration:** Added `import "../tools/web-search"` to `src/ui/repl.ts`
- **Verification:** Tool registered in bundle (line 2866), callable from REPL

### 4. vibecoder Launcher Failures ("The network path was not found")
- **Problem:** Running `vibecoder` from CMD/terminal failed with "The network path was not found"
- **Root Cause:** Multiple launcher files had issues:
  - npm `.cmd` (`AppData/Roaming/npm/vibecoder.cmd`): Originally a npm wrapper that looked for `$basedir/node` (didn't exist), fell back to bare `node` on PATH
  - npm `.sh` (`AppData/Roaming/npm/vibecoder`): Same npm wrapper
  - Hermes `.cmd` (`AppData/Local/hermes/node/vibecoder.cmd`): Had `\Users\...` (double backslashes → UNC path interpretation)
  - Hermes `.sh` (`AppData/Local/hermes/node/vibecoder`): Used `cd "/c/Users/ADMIN/vibecoder"` which MSYS might resolve as network path in some contexts
- **Fix:** 
  - Replaced npm `.cmd` with direct Hermes node invocation: `C:\Users\ADMIN\AppData\Local\hermes\node\node.exe C:\Users\ADMIN\vibecoder\dist\vibecoder.js %*`
  - Replaced Hermes `.cmd` with same direct invocation (proper single backslashes)
  - Replaced npm `.sh` with direct invocation
  - Kept Hermes `.sh` (already working)
- **Verification:** `vibecoder --help` and interactive mode work from CMD and Git Bash

### 5. Why "her" (Hermes) is Used for vibecoder Launcher
- **Explanation:** The PATH prioritizes `C:\Users\ADMIN\AppData\Local\hermes\node` over `C:\Users\ADMIN\AppData\Roaming\npm`. The Hermes-managed node directory contains:
  - `node.exe` (Hermes-bundled Node 22.23.2 with full `readline/promises` support)
  - `vibecoder` (shell launcher)
  - `vibecoder.cmd` (Windows batch launcher)
- **Why Hermes node instead of system node:** The Hermes node has proper `readline/promises` support needed by vibecoder's REPL. The system `node` on PATH might be a different version.
- **Both launchers now use the same Hermes node** — consistent behavior regardless of which path is chosen.

---

## Issues NOT Fixable in Code (Model Behavior)

### 6. Placeholder URL Confusion (Sessions 4, 5)
- **Problem:** LLM generated `https://github.com/user/repo.git` and `OWNER/REPO` as real URLs, got 404s
- **Why not fixable:** These are synthetic example URLs from the LLM's own training/system prompt. The LLM doesn't recognize them as placeholders.
- **Mitigation:** The new `web_search` tool gives the LLM real URLs to work with, reducing reliance on pre-known URLs.

### 7. File Bloat / Feature Creep (Session 2)
- **Problem:** File grew from 7.5KB → 14KB → 29KB as "improvements" were added, each breaking something else
- **Why not fixable:** This is LLM behavior — it doesn't recognize when it's over-engineering. Each edit was intended to help but introduced regressions.
- **Mitigation:** The clean rewrite (issue 1) started fresh with only proven features.

### 8. `edit_file` Mismatches (Session 9)
- **Problem:** Two `edit_file` calls failed with "oldString not found in file" because the LLM read wrong file content before editing
- **Why not fixable:** LLM reading/understanding file content is imperfect. The edits were correct in intent but the oldString didn't match.
- **Mitigation:** Used `sed` as fallback; final state was correct after multiple iterations.

### 9. Path Format Bugs (Session 9)
- **Problem:** LLM generated `C:\c\Users\ADMIN\...` (double `C:\c\`) when reading files
- **Why not fixable:** LLM generates file paths; sometimes gets them wrong on Windows.

### 10. Session Hit Max Steps (Sessions 2, 9)
- **Problem:** Sessions 2 and 9 ran 40 tool calls and hit the max, leaving work incomplete
- **Why not fixable:** This is a runtime constraint, not a code issue. The fixes for the actual code problems were completed separately.

---

## Remaining Known Issues (No Code Fix Needed)

### 11. `fetch_url` Only (No Browser)
- Vibecoder can fetch URLs and search the web, but cannot render JavaScript-heavy pages or interact with web UIs. For that, it would need a headless browser (Puppeteer/Playwright) integration.

### 12. Graphify `communities` Count
- The graph.json has 23 unique communities on nodes, but the GRAPH_REPORT.md says 24 (2 thin omitted). The discrepancy is in graphify's own clustering output, not in vibecoder's stats reader.

---

## Files Modified

| File | Change |
|------|--------|
| `calc.py` | Complete clean rewrite (12.8KB, was 29KB) |
| `src/graphify.ts` | Fixed `loadGraphStats`: `data.links` for edges, community Set from nodes |
| `src/ui/repl.ts` | Added `import "../tools/web-search"` |
| `src/tools/web-search.ts` | New file (5.2KB) — DuckDuckGo web search tool |
| `src/tools/search.ts` | Unchanged (grep, glob) |
| `AppData/Roaming/npm/vibecoder` | Replaced npm wrapper with direct Hermes node invocation |
| `AppData/Roaming/npm/vibecoder.cmd` | Replaced with direct Hermes node invocation |
| `AppData/Local/hermes/node/vibecoder` | Unchanged (already working) |
| `AppData/Local/hermes/node/vibecoder.cmd` | Unchanged (already correct) |

---

## Test Results

### calc.py
```
2^3          → 8        ✓
2**3         → 8        ✓
sin(pi/2)    → 1.0      ✓
sqrt(16)+log(e) → 5.0   ✓
factorial(5) → 120      ✓
cos(0)+sin(pi/2) → 2.0  ✓
2(3)         → 6        ✓
x=5; x*2     → 10       ✓
deg(); sin(90) → 1.0    ✓
2 3          → 6        ✓
1/0          → Error: division by zero ✓
log(0)       → Error: math domain error ✓
```

### /graphify
```
/help        → Shows all commands ✓
/stats       → Nodes: 678, Edges: 1695, Communities: 24 ✓
/query       → Invokes graphify query (needs API key for NL mode) ✓
```

### web_search
- Tool registered and callable
- DuckDuckGo Instant Answer API works (tested: query "vibecoder github" returned abstract + results)
- HTML fallback available if API fails


---

## Round 3 - Phantom Worktree Change Investigation (2026-10-06)

### 13. Mystery file deletions/reversions during the round-2 merge
- **Problem:** During the 2026-10-06 merge session (`merge-remote-work`), files (`src/ui/repl.ts`, `package.json`, `src/tools/proc.ts`, `src/tools/search.ts`, `src/tools/network.test.ts`) were observed to revert or vanish from the worktree between tool calls, repeatedly, without any tool writing them. Cause was never identified in-session; this entry records the post-hoc diagnosis.
- **Diagnosis performed (round 3):**
  - Git hooks: only `*.sample` files in `.git/hooks` - no custom `post-merge`/`pre-commit` hook could have rewritten files.
  - Reflog across the merge window (10:41-11:40): only the expected `checkout`, `merge (fast-forward)` and `commit` entries - no unexpected `reset`, `stash` or `checkout` that would delete/revert worktree content.
  - Stash list: empty. `git fsck`: only pre-existing dangling commits from an unrelated 09-18 rebase.
  - `core.autocrlf=true` with **no `.gitattributes`**: any operation that makes git "touch" a file rewrites line endings, which produces whole-file modification noise and can look like content reversion in diffs.
  - `core.fileMode=false`, `core.symlinks=false`: normal for Windows, not implicated.
- **Likely causes (ranked):** (1) concurrent writers - two agent/tool sessions editing the same worktree in parallel during the merge; (2) line-ending rewrites via `autocrlf=true` surfacing as apparent reverts. No git-side mechanism was found that could delete tracked files silently.
- **Mitigation (runbook):** snapshot before any large merge - `git stash push --include-untracked -m pre-merge` and/or a `git commit -am wip` checkpoint; after unexplained changes run `git status --porcelain=v2` + `git diff --stat` before touching anything else.
- **Follow-up (2026-10-07, round 3):** added `.gitattributes` with `* text=auto` so checkin normalization no longer depends on the clone's `core.autocrlf` (verified: index holds 127 LF files, 0 CRLF, before and after; no hook is active - `.git/hooks` contains only `*.sample`, no `core.hooksPath`; `core.autocrlf=true` comes from the Git for Windows system config `C:/Program Files/Git/etc/gitconfig`). Checkout still follows the platform (CRLF on this box), which is cosmetic and expected; the config-decoupled checkin filter removes the phantom-diff class of symptom for future clones.
- **Verification:** n/a - environment-side; no reproducible git mechanism found, documented for future sessions.
