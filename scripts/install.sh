#!/usr/bin/env bash
# Install vibecoder — a free, open-source AI coding agent for your terminal.
# Works on desktop Linux/macOS and on Android (Termux). Installs straight from
# GitHub, so you don't need npm publishing, accounts, or build tools.
#
#   curl -fsSL https://raw.githubusercontent.com/akashjoshi1209/vibecoder/master/scripts/install.sh | bash
set -euo pipefail

REPO="${VIBECODER_INSTALL_REPO:-https://raw.githubusercontent.com/akashjoshi1209/vibecoder/master}"
MIN_NODE="18.17"

say()  { printf '\033[1;32m%s\033[0m\n' "$*"; }
warn() { printf '\033[1;33m%s\033[0m\n' "$*" >&2; }
die()  { printf '\033[1;31m%s\033[0m\n' "$*" >&2; exit 1; }

fancy_ver() { # "v1.2.3" (or "1.2.3") -> 10203
  printf '%s' "$1" | tr -d 'v' | awk -F. '{printf "%d%02d%02d", $1, $2, $3}'
}

is_termux() {
  [ -d /data/data/com.termux ] || [ -n "${ANDROID_DATA:-}" ] || command -v termux-setup-storage >/dev/null 2>&1
}

# ── 1. node present? ──────────────────────────────────────────────────────────
node_ok() { command -v node >/dev/null 2>&1 && [ "$(fancy_ver "$(node --version)")" -ge "$(fancy_ver "$MIN_NODE")" ]; }

if node_ok; then
  NODE_VER="$(node --version)"
  say "==> found node ${NODE_VER}"
elif is_termux; then
  warn "==> node not found — installing nodejs-lts via pkg (Termux/Android)…"
  if command -v pkg >/dev/null 2>&1; then
    pkg install -y nodejs-lts || die "pkg install nodejs-lts failed."
  else
    die "expected Termux package manager (pkg) but it isn't on PATH. Install node: pkg install nodejs-lts"
  fi
  hash -r
  node_ok || die "node installed but not working. Run: pkg install nodejs-lts"
else
  die "vibecoder needs Node.js >= $MIN_NODE. Install it first, then re-run this script.
  Linux:  curl -fsSL https://deb.nodesource.com/setup_lts.x | sudo -E bash - && sudo apt-get install -y nodejs
  macOS:  brew install node
  Then re-run the vibecoder one-liner."
fi

# ── 2. pick an install/bin directory ──────────────────────────────────────────
VIBECODER_HOME="${VIBECODER_HOME:-$HOME/.vibecoder}"
CLI_DIR="$VIBECODER_HOME/cli"

if is_termux && [ -n "${PREFIX:-}" ] && [ -w "$PREFIX/bin" ]; then
  BIN_DIR="$PREFIX/bin"
elif [ -w /usr/local/bin ]; then
  BIN_DIR="/usr/local/bin"
else
  BIN_DIR="$HOME/.local/bin"
fi
BIN_DIR="${VIBECODER_BIN_DIR:-$BIN_DIR}"

say "==> installing vibecoder into $CLI_DIR (bin → $BIN_DIR)"

mkdir -p "$CLI_DIR" "$BIN_DIR"

fetch() { # fetch <url> <dest>
  if command -v curl >/dev/null 2>&1; then curl -fsSL "$1" -o "$2"
  elif command -v wget >/dev/null 2>&1; then wget -qO "$2" "$1"
  else die "need curl or wget to download vibecoder"; fi
}

for f in vibecoder.js vibecoder-queue.js version.json config.json; do
  say "==> downloading ${f}…"
  fetch "$REPO/dist/$f" "$CLI_DIR/$f"
  [ -s "$CLI_DIR/$f" ] || die "download of $f came back empty — check your network."
done

chmod +x "$CLI_DIR/vibecoder.js" "$CLI_DIR/vibecoder-queue.js"

# ── 3. expose the commands on PATH (symlinks) ────────────────────────────────
ln -sf "$CLI_DIR/vibecoder.js"      "$BIN_DIR/vibecoder"
ln -sf "$CLI_DIR/vibecoder-queue.js" "$BIN_DIR/vibecoder-queue"

echo "$BIN_DIR" >>"$VIBECODER_HOME/install-path.keep" 2>/dev/null || true

# ── 4. verify ─────────────────────────────────────────────────────────────────
hash -r 2>/dev/null || true
if command -v vibecoder >/dev/null 2>&1; then
  VER="$(vibecoder --version 2>/dev/null || echo "?")"
  say ""
  say "vibecoder ${VER} installed ✓"
  say "  run:          vibecoder               (interactive agent)"
  say "  one-off:      vibecoder --prompt \"your task\""
  say "  customize:    vibecoder setup   ·   health: vibecoder doctor"
else
  warn "installed to $BIN_DIR but that path isn't on your PATH."
  echo "Add it, then run: vibecoder"
  echo "  export PATH=\"\$PATH:$BIN_DIR\""
fi

say ""
say "Zero-cost fully-offline: install Ollama, pull a small model, done."
if is_termux; then
  say "  Android/Termux: pkg install -y ollama && ollama pull qwen2.5:1.5b"
else
  say "  curl -fsSL https://ollama.com/install.sh | sh && ollama pull qwen2.5:1.5b"
fi
if ! command -v ollama >/dev/null 2>&1; then
  warn "  (you can skip Ollama and use GROQ's free tier instead: vibecoder setup)"
fi