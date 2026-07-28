#!/usr/bin/env bash
# Build, ad-hoc codesign, and install the local altimate binary into ~/.altimate/bin.
#
# Usage (from repo root or anywhere):
#   ./script/ship-local.sh
#   ./script/ship-local.sh --skip-build   # reinstall existing dist binary only
#
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
PKG_DIR="$ROOT/packages/opencode"
INSTALL_DIR="${HOME}/.altimate/bin"

SKIP_BUILD=false
while [[ $# -gt 0 ]]; do
  case "$1" in
    --skip-build) SKIP_BUILD=true; shift ;;
    -h|--help)
      sed -n '2,8p' "$0"
      exit 0
      ;;
    *)
      echo "error: unknown flag: $1" >&2
      exit 1
      ;;
  esac
done

OS="$(uname -s | tr '[:upper:]' '[:lower:]')"
ARCH="$(uname -m)"

# Rosetta 2 on Apple Silicon: uname -m is x86_64 but bun builds arm64.
if [ "$OS" = "darwin" ] && [ "$ARCH" = "x86_64" ]; then
  if sysctl -n sysctl.proc_translated 2>/dev/null | grep -q 1; then
    ARCH="arm64"
  fi
fi

case "$ARCH" in
  aarch64|arm64) ARCH="arm64" ;;
  x86_64)        ARCH="x64" ;;
esac

BINARY="$PKG_DIR/dist/@altimateai/altimate-code-${OS}-${ARCH}/bin/altimate"

codesign_macos() {
  local path=$1
  if [ "$OS" != "darwin" ]; then
    return 0
  fi
  if ! command -v codesign >/dev/null 2>&1; then
    echo "warning: codesign not found; binary may be killed by Gatekeeper" >&2
    return 0
  fi
  xattr -cr "$path" 2>/dev/null || true
  codesign --force --sign - "$path"
  echo "codesigned: $path"
}

if [ "$SKIP_BUILD" = false ]; then
  echo "Building single-platform binary…"
  (
    cd "$PKG_DIR"
    export PATH="${HOME}/.bun/bin:${PATH}"
    bun run build:local
  )
else
  echo "Skipping build (--skip-build)"
fi

if [ ! -f "$BINARY" ]; then
  echo "error: binary not found at $BINARY" >&2
  echo "Available builds:" >&2
  ls "$PKG_DIR/dist/@altimateai/" 2>/dev/null || echo "  (none)" >&2
  exit 1
fi

echo "Codesigning build output…"
codesign_macos "$BINARY"

echo "Installing into ${INSTALL_DIR}/altimate…"
"$ROOT/install" --binary "$BINARY" --no-modify-path

# install already ad-hoc signs on Darwin; re-sign + clear xattrs for Gatekeeper
DEST="${INSTALL_DIR}/altimate"
if [ -f "$DEST" ]; then
  codesign_macos "$DEST"
fi

# Ensure PATH entry exists (symlink-friendly: keep install layout, just remind)
mkdir -p "$INSTALL_DIR"
if ! command -v altimate >/dev/null 2>&1; then
  echo "note: add to PATH if needed:"
  echo "  export PATH=\"${INSTALL_DIR}:\$PATH\""
fi

echo
"${DEST}" --version
echo "Installed: ${DEST}"
echo "Done. Restart any running altimate serve / TUI to pick up the new binary."
