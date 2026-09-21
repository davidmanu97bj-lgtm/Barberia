#!/usr/bin/env bash
set -Eeuo pipefail

# Compatibility entry point. With no arguments this only validates.
SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
exec node "$SCRIPT_DIR/deploy.mjs" "$@"
