#!/usr/bin/env bash
# Build Mac + Linux binaries, install the host binary into ~/.altimate/bin,
# and sync both into the portable bundle (Mac gitignored; Linux is what gets pushed).
#
# Usage (from repo root or anywhere):
#   ./script/ship-local.sh
#   ./script/ship-local.sh --skip-build   # reinstall / sync existing dist only
#   PORTABLE_DIR=/path/to/portable_altimate ./script/ship-local.sh
#
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
PKG_DIR="$ROOT/packages/opencode"
INSTALL_DIR="${HOME}/.altimate/bin"
# Sibling portable bundle (override with PORTABLE_DIR)
PORTABLE_DIR="${PORTABLE_DIR:-$(cd "$ROOT/../portable_altimate" 2>/dev/null && pwd || true)}"

SKIP_BUILD=false
while [[ $# -gt 0 ]]; do
  case "$1" in
    --skip-build) SKIP_BUILD=true; shift ;;
    -h|--help)
      sed -n '2,10p' "$0"
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

# Indices must match allTargets order in packages/opencode/script/build.ts
#   0 linux-arm64 | 1 linux-x64 | 2 linux-x64-baseline
#   3 darwin-arm64 | 4 darwin-x64 | 5 darwin-x64-baseline
HOST_INDEX=""
case "${OS}-${ARCH}" in
  darwin-arm64) HOST_INDEX=3 ;;
  darwin-x64)   HOST_INDEX=4 ;;
  linux-arm64)  HOST_INDEX=0 ;;
  linux-x64)    HOST_INDEX=1 ;;
  *)
    echo "error: unsupported host ${OS}-${ARCH}" >&2
    exit 1
    ;;
esac

LINUX_X64_INDEX=1
if [ "$HOST_INDEX" = "$LINUX_X64_INDEX" ]; then
  TARGET_INDEX="$HOST_INDEX"
else
  TARGET_INDEX="${HOST_INDEX},${LINUX_X64_INDEX}"
fi

HOST_BINARY="$PKG_DIR/dist/@altimateai/altimate-code-${OS}-${ARCH}/bin/altimate"
LINUX_BINARY="$PKG_DIR/dist/@altimateai/altimate-code-linux-x64/bin/altimate"

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
  echo "Building binaries for target-index=${TARGET_INDEX} (host + linux-x64)…"
  (
    cd "$PKG_DIR"
    export PATH="${HOME}/.bun/bin:${PATH}"
    # No --skip-install: linux cross-compile needs platform-specific native deps.
    bun run script/build.ts --target-index="$TARGET_INDEX"
  )
else
  echo "Skipping build (--skip-build)"
fi

if [ ! -f "$HOST_BINARY" ]; then
  echo "error: host binary not found at $HOST_BINARY" >&2
  echo "Available builds:" >&2
  ls "$PKG_DIR/dist/@altimateai/" 2>/dev/null || echo "  (none)" >&2
  exit 1
fi

if [ ! -f "$LINUX_BINARY" ]; then
  echo "error: linux-x64 binary not found at $LINUX_BINARY" >&2
  echo "Available builds:" >&2
  ls "$PKG_DIR/dist/@altimateai/" 2>/dev/null || echo "  (none)" >&2
  exit 1
fi

echo "Codesigning host build output…"
codesign_macos "$HOST_BINARY"

echo "Installing host binary into ${INSTALL_DIR}/altimate…"
"$ROOT/install" --binary "$HOST_BINARY" --no-modify-path

DEST="${INSTALL_DIR}/altimate"
if [ -f "$DEST" ]; then
  codesign_macos "$DEST"
fi

mkdir -p "$INSTALL_DIR"
if ! command -v altimate >/dev/null 2>&1; then
  echo "note: add to PATH if needed:"
  echo "  export PATH=\"${INSTALL_DIR}:\$PATH\""
fi

# Sync into portable bundle: Linux is pushed; Mac stays local (gitignored).
if [ -n "${PORTABLE_DIR:-}" ] && [ -d "$PORTABLE_DIR" ]; then
  echo "Syncing binaries → $PORTABLE_DIR/bin …"
  mkdir -p "$PORTABLE_DIR/bin"
  # Linux ELF for remote deploy (tracked). Do not copy bare bin/altimate —
  # run.sh uses altimate-linux-x64 / altimate-darwin-* only.
  cp "$LINUX_BINARY" "$PORTABLE_DIR/bin/altimate-linux-x64"
  chmod +x "$PORTABLE_DIR/bin/altimate-linux-x64"
  rm -f "$PORTABLE_DIR/bin/altimate"
  # Local Mac binary — gitignored; not for remote deploy
  if [ "$OS" = "darwin" ]; then
    MAC_NAME="altimate-darwin-${ARCH}"
    cp "$HOST_BINARY" "$PORTABLE_DIR/bin/$MAC_NAME"
    chmod +x "$PORTABLE_DIR/bin/$MAC_NAME"
    codesign_macos "$PORTABLE_DIR/bin/$MAC_NAME"
    echo "  portable: bin/altimate-linux-x64  (push)"
    echo "  portable: bin/$MAC_NAME  (local only, gitignored)"
  else
    echo "  portable: bin/altimate-linux-x64  (push)"
  fi
else
  echo "note: portable bundle not found (set PORTABLE_DIR to sync binaries)"
fi

echo
"${DEST}" --version
echo "Installed: ${DEST}"
file "$LINUX_BINARY" | sed 's|^|linux-x64: |'
echo "Done. Restart any running altimate serve / TUI to pick up the new binary."
