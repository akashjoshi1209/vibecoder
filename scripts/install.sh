#!/usr/bin/env bash
# Install vibecoder: a free, open-source AI coding agent for your terminal.
#   curl -fsSL https://raw.githubusercontent.com/akashjoshi1209/vibecoder/master/scripts/install.sh | bash
set -euo pipefail

say()  { printf '\033[1;32m%s\033[0m\n' "$*"; }
warn() { printf '\033[1;33m%s\033[0m\n' "$*"; >&2; }
die()  { printf '\033[1;31m%s\033[0m\n' "$*" >&2; exit 1; }

HAS_NPM=false; HAS_BUN=false; HAS_NODE=false
command -v npm >/dev/null 2>&1 && HAS_NPM=true
command -v bun >/dev/null 2>&1 && HAS_BUN=true
command -v node >/dev/null 2>&1 && HAS_NODE=true

if $HAS_BUN || $HAS_NPM || $HAS_NODE; then :; else
  die "vibecoder needs Node.js >= 18.17 or Bun. Install one of them first:
  Node: https://nodejs.org   (or: curl -fsSL https://deb.nodesource.com/setup_lts.x | bash - && apt-get install -y nodejs)
  Bun:  https://bun.sh      (or: curl -fsSL https://bun.sh/install | bash)"
fi

say "==> Installing vibecoder (free, open source, MIT)…"

if $HAS_BUN; then
  say "==> bun add -g vibecoder"
  if bun add -g vibecoder; then :; else warn "bun install failed — falling back to npm"; fi
fi

if [ ! "$(command -v vibecoder)" ]; then
  command -v npm >/dev/null 2>&1 || die "npm not available; install Node from https://nodejs.org"
  say "==> npm install -g vibecoder"
  npm install -g vibecoder || die "npm install failed — check your npm registry/network"
fi

if ! command -v vibecoder >/dev/null 2>&1; then
  die "vibecoder was not installed. Try adding your package manager bin dir to PATH."
fi

say ""
say "vibecoder installed ✓"
say "  run:    vibecoder                 (interactive agent)"
say "  one-off: vibecoder --prompt \"your task\""
say ""
say "For a zero-cost, fully-offline setup, install Ollama:"
say "  curl -fsSL https://ollama.com/install.sh | sh && ollama pull qwen2.5:1.5b"
say ""
say "Customize later: vibecoder setup   ·   Health check: vibecoder doctor"