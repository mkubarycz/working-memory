#!/usr/bin/env bash
# release.sh — rollbackable build+deploy for the Working Memory extension.
#
# Steps, in order:
#   1. Snapshot the journal DB to <hub>/memory/.backups/
#   2. Compile  (npm run compile)
#   3. Package  (npx vsce package -o dist/working-memory-<v>.vsix)
#   4. Install  (code --install-extension <vsix> --force)
#   5. Print next-steps (reload + test, then commit/tag if it works)
#
# Intentionally does NO git work. Working tree is expected to be dirty —
# the in-flight change is what's being released. Committing and tagging
# happen AFTER the build has been verified in the running VS Code, not
# before. That's a human/agent decision, not the script's.
#
# Any failure aborts non-zero. No silent skips.
#
# Usage:
#   ./scripts/release.sh
#
# Rollback:
#   ./scripts/rollback.sh <version>

set -euo pipefail

# ---------------------------------------------------------------------------
# Setup
# ---------------------------------------------------------------------------

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
HUB_ROOT="$(cd "$PROJECT_ROOT/../.." && pwd)"

cd "$PROJECT_ROOT"

die() { printf '\033[31merror:\033[0m %s\n' "$*" >&2; exit 1; }
info() { printf '\033[36m==>\033[0m %s\n' "$*"; }
ok() { printf '\033[32mok:\033[0m %s\n' "$*"; }

[[ -f "$HUB_ROOT/AGENTS.md" && -d "$HUB_ROOT/memory" ]] \
  || die "could not locate hub workspace (expected AGENTS.md + memory/ at $HUB_ROOT)"

# Read version from package.json without pulling in jq.
VERSION="$(node -p "require('$PROJECT_ROOT/package.json').version")"
[[ -n "$VERSION" ]] || die "could not read version from package.json"

EXT_ID="kubarycz.working-memory"
VSIX_DIR="$PROJECT_ROOT/dist"
VSIX_PATH="$VSIX_DIR/working-memory-$VERSION.vsix"
BACKUP_DIR="$HUB_ROOT/memory/.backups"
DB_PATH="$HUB_ROOT/memory/journal.sqlite"

info "project:  $PROJECT_ROOT"
info "hub:      $HUB_ROOT"
info "version:  $VERSION"

# ---------------------------------------------------------------------------
# 1. Snapshot the journal DB
# ---------------------------------------------------------------------------

info "snapshot: journal DB"
mkdir -p "$BACKUP_DIR"

# Self-ignore the backups dir so it never gets tracked if a git repo materializes
# at the hub root later.
if [[ ! -f "$BACKUP_DIR/.gitignore" ]]; then
  cat > "$BACKUP_DIR/.gitignore" <<'EOF'
*
!.gitignore
EOF
fi

STAMP="$(date +%Y%m%d-%H%M%S)"
SNAP_BASE="$BACKUP_DIR/journal-pre-v${VERSION}-${STAMP}"

if [[ -f "$DB_PATH" ]]; then
  cp "$DB_PATH" "${SNAP_BASE}.sqlite"
  ok "snapshot: ${SNAP_BASE}.sqlite"
else
  info "no live DB at $DB_PATH — skipping snapshot (first run?)"
fi
[[ -f "${DB_PATH}-wal" ]] && cp "${DB_PATH}-wal" "${SNAP_BASE}.sqlite-wal" \
  && ok "snapshot: ${SNAP_BASE}.sqlite-wal" || true
[[ -f "${DB_PATH}-shm" ]] && cp "${DB_PATH}-shm" "${SNAP_BASE}.sqlite-shm" \
  && ok "snapshot: ${SNAP_BASE}.sqlite-shm" || true

# Prune snapshots older than the 10 most recent (by .sqlite file mtime).
# Use a while-read loop (not `mapfile`) so this works on macOS's stock bash 3.2.
info "snapshot: pruning old backups (keeping 10 most recent)"
while IFS= read -r snap; do
  [[ -z "$snap" ]] && continue
  rm -f "$snap" "${snap}-wal" "${snap}-shm"
  ok "pruned: $(basename "$snap")"
done < <(ls -1t "$BACKUP_DIR"/journal-pre-v*.sqlite 2>/dev/null | tail -n +11 || true)

# ---------------------------------------------------------------------------
# 2. Compile
# ---------------------------------------------------------------------------

info "compile"
if node -e "process.exit(require('$PROJECT_ROOT/package.json').scripts && require('$PROJECT_ROOT/package.json').scripts.compile ? 0 : 1)"; then
  npm run --silent compile
else
  npx --no-install tsc -p .
fi
ok "compiled."

# ---------------------------------------------------------------------------
# 2b. Stage codicon assets
#
# Copy the VS Code codicon font + stylesheet from the npm package into
# media/codicons/ so the webview can load them as static resources. Kept
# as a build artifact (gitignored) — the npm package is the source of truth.
# ---------------------------------------------------------------------------

info "codicons: stage from node_modules/@vscode/codicons/dist"
CODICONS_SRC="$PROJECT_ROOT/node_modules/@vscode/codicons/dist"
CODICONS_DST="$PROJECT_ROOT/media/codicons"
[[ -f "$CODICONS_SRC/codicon.css" && -f "$CODICONS_SRC/codicon.ttf" ]] \
  || die "missing $CODICONS_SRC/codicon.{css,ttf} — run 'npm install' first"
mkdir -p "$CODICONS_DST"
cp "$CODICONS_SRC/codicon.css" "$CODICONS_DST/codicon.css"
cp "$CODICONS_SRC/codicon.ttf" "$CODICONS_DST/codicon.ttf"
ok "codicons: $CODICONS_DST/codicon.{css,ttf}"

# ---------------------------------------------------------------------------
# 3. Package
# ---------------------------------------------------------------------------

info "package: $VSIX_PATH"
mkdir -p "$VSIX_DIR"
# vsce honors -o but won't overwrite an existing file; guard for re-runs.
rm -f "$VSIX_PATH"
# --no-yarn: don't try to use yarn even if a yarn.lock is around.
# --no-dependencies: skip vsce's dependency-tree walk; we ship node_modules verbatim,
#                    so the walk is wasted work and emits warnings that prompt y/N.
# printf 'y' feed: auto-confirm the LICENSE-missing prompt. We avoid `yes |`
# because under `set -o pipefail` SIGPIPE from `yes` after vsce exits trips
# the whole script (exit 141). A finite feed works around that.
printf 'y\ny\ny\n' | npx --no-install vsce package --allow-missing-repository --no-yarn --no-dependencies -o "$VSIX_PATH"
[[ -f "$VSIX_PATH" ]] || die "vsce did not produce $VSIX_PATH"
ok "packaged."

# ---------------------------------------------------------------------------
# 4. Install
# ---------------------------------------------------------------------------

info "install: code --install-extension $VSIX_PATH --force"
code --install-extension "$VSIX_PATH" --force
ok "installed."

# ---------------------------------------------------------------------------
# 5. Next steps
# ---------------------------------------------------------------------------

cat <<EOF

\033[32m✓ build installed: v$VERSION\033[0m

NEXT:
  1. Reload VS Code: Cmd+Shift+P -> Developer: Reload Window
  2. Test the new build.
  3. Only if it works, commit the in-flight changes and tag the release.
     Principle: do not commit until tested. No git work happens
     in this script -- that step is intentionally left to a human/agent
     decision after verification.

ROLLBACK (if testing fails):
  $PROJECT_ROOT/scripts/rollback.sh $VERSION

  That command will:
    - restore the snapshot at ${SNAP_BASE}.sqlite[-wal|-shm]
      over $DB_PATH
    - reinstall the previous .vsix from $VSIX_DIR/
    - require VS Code to be closed before it runs

EOF
