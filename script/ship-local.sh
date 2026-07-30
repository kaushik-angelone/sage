#!/usr/bin/env bash
# Build Mac + Linux binaries, install the host binary into ~/.altimate/bin,
# and sync both into the portable bundle (Mac gitignored; Linux is what gets pushed).
#
# Usage (from repo root or anywhere):
#   ./script/ship-local.sh
#   ./script/ship-local.sh --skip-build   # reinstall / sync existing dist only
#   PORTABLE_DIR=/path/to/portable_altimate ./script/ship-local.sh
#   SKIP_S3=1 ./script/ship-local.sh     # skip S3 upload + stamp write
#
# MODELS_DEV_API_JSON=/path/to/api.json   build against a local models.dev copy
#                                         instead of fetching it.
# After sync, uploads bin/altimate-linux-x64 to S3 and writes
# portable bin/altimate-linux-x64.s3-stamp (override with SKIP_S3=1).
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
  resolve_models_json
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
  # Linux ELF for remote deploy (gitignored; shipped via S3 + stamp file).
  # Do not copy bare bin/altimate — run.sh uses altimate-linux-x64 / altimate-darwin-* only.
  cp "$LINUX_BINARY" "$PORTABLE_DIR/bin/altimate-linux-x64"
  chmod +x "$PORTABLE_DIR/bin/altimate-linux-x64"
  rm -f "$PORTABLE_DIR/bin/altimate"
  # Local Mac binary — gitignored; not for remote deploy
  if [ "$OS" = "darwin" ]; then
    MAC_NAME="altimate-darwin-${ARCH}"
    cp "$HOST_BINARY" "$PORTABLE_DIR/bin/$MAC_NAME"
    chmod +x "$PORTABLE_DIR/bin/$MAC_NAME"
    codesign_macos "$PORTABLE_DIR/bin/$MAC_NAME"
    echo "  portable: bin/altimate-linux-x64  (gitignored; S3)"
    echo "  portable: bin/$MAC_NAME  (local only, gitignored)"
  else
    echo "  portable: bin/altimate-linux-x64  (gitignored; S3)"
  fi
  # Stage Linux binary on S3 + write stamp for remote pull-bin-s3.sh
  if [ "${SKIP_S3:-}" != "1" ] && [ -x "$PORTABLE_DIR/scripts/push-bin-s3.sh" ]; then
    echo "Uploading Linux binary to S3…"
    "$PORTABLE_DIR/scripts/push-bin-s3.sh" "$PORTABLE_DIR/bin/altimate-linux-x64"
  elif [ "${SKIP_S3:-}" = "1" ]; then
    echo "note: SKIP_S3=1 — skipped S3 upload"
  fi
else
  echo "note: portable bundle not found (set PORTABLE_DIR to sync binaries)"
fi

echo
"${DEST}" --version
echo "Installed: ${DEST}"
file "$LINUX_BINARY" | sed 's|^|linux-x64: |'
echo "Done. Restart any running altimate serve / TUI to pick up the new binary."
