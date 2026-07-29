#!/usr/bin/env bash
# Build, ad-hoc codesign, and install the local altimate binary into ~/.altimate/bin.
#
# Usage (from repo root or anywhere):
#   ./script/ship-local.sh
#   ./script/ship-local.sh --skip-build   # reinstall existing dist binary only
#
# MODELS_DEV_API_JSON=/path/to/api.json   build against a local models.dev copy
#                                         instead of fetching it.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
PKG_DIR="$ROOT/packages/opencode"
INSTALL_DIR="${HOME}/.altimate/bin"

SKIP_BUILD=false
while [[ $# -gt 0 ]]; do
  case "$1" in
    --skip-build) SKIP_BUILD=true; shift ;;
    -h|--help)
      sed -n '2,9p' "$0"
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
SNAPSHOT="$PKG_DIR/src/provider/models-snapshot.ts"
MODELS_URL="${OPENCODE_MODELS_URL:-https://models.dev}/api.json"
TMP_MODELS=""

cleanup() {
  if [ -n "$TMP_MODELS" ]; then
    rm -f "$TMP_MODELS"
  fi
}
trap cleanup EXIT

looks_like_json() {
  [ -s "$1" ] && [ "$(head -c 1 "$1")" = "{" ]
}

# build.ts fetches models.dev with bun's fetch, which validates TLS against bun's
# own CA bundle rather than the system trust store — so behind a TLS-inspecting
# proxy it dies with UNABLE_TO_GET_ISSUER_CERT_LOCALLY. curl does trust the
# system store, so fetch the file here and hand it to the build via
# MODELS_DEV_API_JSON. With no network at all, reuse the snapshot in the tree.
resolve_models_json() {
  if [ -n "${MODELS_DEV_API_JSON:-}" ]; then
    echo "Using MODELS_DEV_API_JSON=$MODELS_DEV_API_JSON"
    return 0
  fi

  TMP_MODELS="$(mktemp "${TMPDIR:-/tmp}/models-dev-api.XXXXXX")"

  if curl -fsS --max-time 60 -o "$TMP_MODELS" "$MODELS_URL" && looks_like_json "$TMP_MODELS"; then
    export MODELS_DEV_API_JSON="$TMP_MODELS"
    echo "Fetched $MODELS_URL"
    return 0
  fi

  if [ -f "$SNAPSHOT" ] &&
    sed -n 's/^export const snapshot = \(.*\) as const$/\1/p' "$SNAPSHOT" >"$TMP_MODELS" &&
    looks_like_json "$TMP_MODELS"; then
    export MODELS_DEV_API_JSON="$TMP_MODELS"
    echo "warning: $MODELS_URL unreachable; reusing $SNAPSHOT (model list may be stale)" >&2
    return 0
  fi

  echo "error: could not fetch $MODELS_URL and no usable snapshot at $SNAPSHOT" >&2
  echo "  set MODELS_DEV_API_JSON=/path/to/api.json to build from a local copy" >&2
  return 1
}

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
  resolve_models_json
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
