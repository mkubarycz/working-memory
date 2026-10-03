#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
VENV="$ROOT/.tools/cruft-venv"
CACHE="$ROOT/.cache/cruft"
REQUIREMENTS="$ROOT/tools/cruft/requirements.txt"
STAMP="$VENV/.requirements.sha256"
COOKIECUTTER_CONFIG="$CACHE/cookiecutter.yaml"

mkdir -p "$ROOT/.tools" "$CACHE"

if [[ ! -x "$VENV/bin/python" ]]; then
  python3 -m venv "$VENV"
fi

EXPECTED="$(shasum -a 256 "$REQUIREMENTS" | awk '{print $1}')"
CURRENT="$(cat "$STAMP" 2>/dev/null || true)"
if [[ "$CURRENT" != "$EXPECTED" ]]; then
  PIP_CACHE_DIR="$CACHE" "$VENV/bin/python" -m pip install --disable-pip-version-check \
    --requirement "$REQUIREMENTS"
  printf '%s\n' "$EXPECTED" > "$STAMP"
fi

export PIP_CACHE_DIR="$CACHE"
cat > "$COOKIECUTTER_CONFIG" <<EOF
cookiecutters_dir: "$CACHE/cookiecutters"
replay_dir: "$CACHE/replay"
EOF
export COOKIECUTTER_CONFIG
exec "$VENV/bin/cruft" "$@"
