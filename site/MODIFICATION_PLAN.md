# Vibecoder Site — Opencode.ai-Inspired Modifications: Plan

## Context
The user wants vibecoder's landing page modified to mirror the structure, clarity, and conversion focus of opencode.ai — while keeping vibecoder's own identity (open-source AI software development system, Android-first, autonomous specialist vision).

## What opencode.ai does well (to borrow)
1. **Headline + subheadline in first viewport** — clear H1 + one-line value prop
2. **Prominent install command** — `curl -fsSL ... | bash` in a code block, copyable, no friction
3. **Keyboard-hint row** — `curlnpmbunbrewparuyay` above the install command (shortcut hints)
4. **Feature grid** — bullet list with bold lead-ins, not vague marketing language
5. **Social proof stats** — stars, contributors, monthly users (3 figures, clean)
6. **Privacy-first block** — short, clear, addresses the #1 concern
7. **FAQ** — covers obvious objections
8. **Product upsell** — Zen (optimized models) as a secondary CTA
9. **Waitlist** — captures early access for future products
10. **Footer** — GitHub + legal links + language selector

## What vibecoder already has (keep)
- Dark theme, terminal aesthetic, grain texture, ambient glows ✓
- Nav with GitHub + Try it CTAs ✓
- Hero with Terminal mock + Web mock visual ✓
- Interactive flow demo (understand→plan→execute→test→verify→fix→repeat) ✓
- Barriers section (knowledge/hardware/accessibility) ✓
- Capabilities grid (what it does today) ✓
- How-it-works diagram ✓
- Providers section ✓
- Vision section ✓
- Control panel (human control) ✓
- Multi-device vision ✓
- Open source philosophy ✓
- Roadmap ✓
- Install steps ✓
- Use cases ✓
- CTA section ✓
- Footer with GitHub + Apache-2.0 ✓

## Planned modifications (in priority order)

### P1 — Headline area (hero)
- **H1**: Simplify from the current long two-line heading to something closer to opencode's crisp "The open source AI coding agent" style. Suggested: **"The open-source AI software development system"** (keep vibecoder's fuller identity but make it punchier). The current H1 is good but the `<span class="vision">` sub-line is very long — shorten it.
- **Subheadline**: Replace the current long paragraph with a tighter one-liner like opencode's *"Free models included or connect any model from any provider, including Claude, GPT, Gemini and more."* Suggested: *"Free models included, or connect any model — Claude, GPT, Gemini, Ollama, and more. Runs on your device, offline-resilient, built toward an autonomous software specialist."*
- **Badge**: Keep the open-source badge but shorten the text (it's currently very long).

### P2 — Prominent install CTA (like opencode's curl | bash)
- Add a new section right after the hero (before the interactive demo) that shows the install command prominently, like opencode's `curl -fsSL https://opencode.ai/v2/install | bash`.
- Vibecoder's install is multi-step (clone, npm install, set key, run). The opencode-style block should show the quickest path: `git clone && cd && npm install && bun run build && ./vibecoder` — or a condensed version.
- Add the keyboard-hint row above it: `gitnpmbunvibecoder` or similar (matching opencode's `curlnpmbunbrewparuyay` style — shortcuts for the install journey).
- This section should have: command in a code block, a "Copy" affordance (or just clear visual), and a short line about free providers.

### P3 — Feature grid (opencode-style bullet list)
- Add a section after the install block (or merge into "What it does today") with opencode's bullet-list style: bold lead-in + short description.
- Current vibecoder has a cap-grid (cards). Keep the cards but ALSO add a compact bullet list near the top for quick scanning — like opencode's "What is OpenCode?" list.
- Suggested bullets (vibecoder-flavored):
  - **LSP-aware** — automatically loads the right LSPs for the LLM, so the agent understands your language server
  - **Multi-session** — start multiple agents in parallel on the same project
  - **Share links** — share a link to any session for reference or debugging
  - **GitHub Copilot** — log in with your Copilot account (when available)
  - **Any model** — 75+ providers through Models.dev, including local models
  - **Any editor** — terminal, desktop, IDE extension
  - (Adapt these to vibecoder's actual features — LSP, multi-session, share links may not all exist yet. Use vibecoder's real features: model routing, queue system, Tailscale, local Ollama, etc.)

### P4 — Social proof (adapt to vibecoder's reality)
- opencode has 208K stars, 950 contributors, 16M devs. Vibecoder is newer/smaller.
- Options: (a) use vibecoder's actual GitHub stats when available, (b) use a "used by developers on Android, Windows, Linux, macOS" line, (c) omit and let the install CTA carry conversion.
- Recommended: a modest stats row — e.g., "Open source · Apache-2.0 · Runs on Android, Windows, Linux, macOS" as a meta line (already exists in hero-meta). Add a "Built with Bun + TypeScript" line. If vibecoder has GitHub stars, add them. Otherwise, keep it honest and skip inflated numbers.

### P5 — Privacy-first block
- Add a short "Built for privacy first" block (like opencode's) near the install or hero area.
- Vibecoder's angle: *"Your code, your context, your device. VibeCoder does not store your code or conversation data — it runs locally on your machine and only sends what you explicitly tell it to send to a model provider."*
- This is partly covered by the open-source section, but a dedicated short block near the install CTA would help.

### P6 — FAQ section
- Add a FAQ section (like opencode's) covering the obvious objections:
  - What is VibeCoder?
  - How do I use it?
  - Do I need extra AI subscriptions?
  - Can I use my existing AI subscriptions?
  - Can I only use it in the terminal?
  - How much does it cost?
  - What about data and privacy?
  - Is it open source?
- Vibecoder already answers most of these in its existing sections, but a compact FAQ block improves scannability and conversion.

### P7 — Product upsell / Zen-style section
- opencode has "Zen" for optimized models. Vibecoder could have a similar "providers" or "model gateway" upsell.
- Vibecoder already has a providers section. The upsell could be: *"Zen-like: access reliable optimized models for coding agents"* — but vibecoder's angle is model-agnostic + free providers. So the upsell might be: *"Add any model — free or paid — through one config."* Or a "Zen" equivalent called something vibecoder-flavored.
- Recommended: add a short "Providers" highlight block that points to the existing providers section and emphasizes the free-tier + BYOM story. Keep it brief.

### P8 — Waitlist / early access
- Add a small waitlist/early-access section for future products (like opencode's).
- Vibecoder's "future" vision section already covers where it's going. A waitlist could capture people who want to follow along.
- Keep it minimal: email input + "Be the first to know when we release new products" + subscribe button.

### P9 — Footer
- Add GitHub link (already exists), Anomaly/Brand link (if applicable), Privacy, Terms.
- Vibecoder currently has GitHub + Apache-2.0 + "Built with Bun + TypeScript". Add Privacy/Terms if those pages exist, or add placeholders.
- Add a language selector if the site plans to support multiple languages (opencode has "English").

### P10 — Visual / UX polish (from opencode observations)
- Fix the "curlnpmbunbrewparuyay" equivalent — make the keyboard-hint row clear (what keys map to what).
- If vibecoder has a video, ensure it renders. If not, add a GIF/screenshot demo.
- Ensure the install command is copyable and prominent.
- Add a GitHub link in the footer (already exists — keep it prominent).

## What NOT to change
- The interactive flow demo (it's vibecoder's signature) — keep it, maybe improve its appearance to match opencode's cleaner style.
- The hero visual (terminal mock + web mock) — keep it, it's a strong demonstration.
- The barriers section — it's vibecoder's unique story (Android phone, low-end hardware).
- The vision section — vibecoder's autonomous specialist vision is the differentiator.
- Dark theme, grain texture, ambient glows — already match opencode's aesthetic.

## Implementation order (recommended)
1. Read the current index.html and animations.js fully (done above).
2. Plan each change as a discrete edit (one section at a time).
3. Implement P1 (headline) first — highest impact on first impression.
4. Implement P2 (install CTA block) — highest impact on conversion.
5. Implement P3 (feature bullet list) + P4 (social proof) + P5 (privacy block) together — these are complementary.
6. Implement P6 (FAQ) + P7 (upsell) + P8 (waitlist) — secondary conversion elements.
7. Implement P9 (footer) + P10 (polish).
8. Test the page in the browser, verify all sections render, check for broken links.

## Files to modify
- `site/index.html` — all content/structure changes
- `site/animations.js` — any JS changes (likely minimal — the flow demo and scroll reveal stay)
- `site/package.json` — no changes needed (GSAP already installed)

## Out of scope (for now)
- Rewriting the entire site from scratch — we're modifying, not replacing.
- Adding a backend or new features — this is a landing page change only.
- Changing the color scheme — vibecoder's dark theme is good and matches opencode's aesthetic.
- Changing the logo — keep the lightning bolt mark.

## Questions for the user before implementing
1. Do you want the install CTA to show the full multi-step install (clone, npm, key, run) or a condensed one-liner?
2. Should we use vibecoder's actual GitHub stats (stars, contributors) or keep the social proof modest/honest?
3. Do you have a Privacy Policy and Terms of Service page to link to in the footer?
4. Do you want a waitlist email input (and where should it send emails — is there a backend)?
5. Should the "Zen" upsell be a separate product page or just a section on the landing page?
