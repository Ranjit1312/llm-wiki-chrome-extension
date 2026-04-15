#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# LLM Wiki — macOS / Linux installer
# Usage:  bash install.sh
# ─────────────────────────────────────────────────────────────────────────────
set -e

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DIST_DIR="$REPO_DIR/dist"

# ── Colours ──────────────────────────────────────────────────────────────────
RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'
CYAN='\033[0;36m'; BOLD='\033[1m'; RESET='\033[0m'

info()    { echo -e "${CYAN}▸ $*${RESET}"; }
success() { echo -e "${GREEN}✔ $*${RESET}"; }
warn()    { echo -e "${YELLOW}⚠ $*${RESET}"; }
error()   { echo -e "${RED}✗ $*${RESET}"; exit 1; }

echo -e "${BOLD}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo -e "  ⬡  LLM Wiki — Local GraphRAG Extension"
echo -e "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${RESET}"
echo ""

# ── 1. Check Node.js ─────────────────────────────────────────────────────────
info "Checking Node.js..."
if ! command -v node &>/dev/null; then
  warn "Node.js not found. Attempting install via Homebrew..."
  if ! command -v brew &>/dev/null; then
    info "Installing Homebrew first..."
    /bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"
    # Add brew to PATH for Apple Silicon
    eval "$(/opt/homebrew/bin/brew shellenv)" 2>/dev/null || true
  fi
  brew install node
fi

NODE_VER=$(node -v)
NPM_VER=$(npm -v)
success "Node $NODE_VER / npm $NPM_VER"

# ── 2. Install dependencies ──────────────────────────────────────────────────
info "Installing npm dependencies..."
cd "$REPO_DIR"
npm ci --prefer-offline 2>/dev/null || npm install
success "Dependencies installed"

# ── 3. Build ─────────────────────────────────────────────────────────────────
info "Building extension (webpack)..."
npm run build
success "Build complete → dist/"

# ── 4. Verify dist ───────────────────────────────────────────────────────────
if [ ! -f "$DIST_DIR/manifest.json" ]; then
  error "Build failed — dist/manifest.json not found"
fi

DIST_SIZE=$(du -sh "$DIST_DIR" | cut -f1)
success "dist/ folder ready ($DIST_SIZE)"

# ── 5. Open Chrome ───────────────────────────────────────────────────────────
echo ""
echo -e "${BOLD}Next steps:${RESET}"
echo -e "  1. Open Chrome → ${CYAN}chrome://extensions${RESET}"
echo -e "  2. Enable ${BOLD}Developer mode${RESET} (top-right toggle)"
echo -e "  3. Click ${BOLD}Load unpacked${RESET}"
echo -e "  4. Select: ${CYAN}$DIST_DIR${RESET}"
echo ""

# Try to open Chrome automatically
CHROME_PATHS=(
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
  "/Applications/Chromium.app/Contents/MacOS/Chromium"
)
for CHROME in "${CHROME_PATHS[@]}"; do
  if [ -f "$CHROME" ]; then
    info "Opening Chrome extensions page..."
    "$CHROME" "chrome://extensions" &>/dev/null &
    break
  fi
done

echo -e "${GREEN}${BOLD}✔ Installation complete!${RESET}"
echo -e "  See ${CYAN}SETUP.md${RESET} for model download instructions."
