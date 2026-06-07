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
info "snapshot: pruning old backups (keeping 10 most recent)"
mapfile -t OLD_SNAPS < <(
  ls -1t "$BACKUP_DIR"/journal-pre-v*.sqlite 2>/dev/null | tail -n +11 || true
)
for snap in "${OLD_SNAPS[@]:-}"; do
  [[ -z "$snap" ]] && continue
  rm -f "$snap" "${snap}-wal" "${snap}-shm"
  ok "pruned: $(basename "$snap")"
done

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
# 3. Package
# ---------------------------------------------------------------------------

info "package: $VSIX_PATH"
mkdir -p "$VSIX_DIR"
# vsce honors -o but won't overwrite an existing file; guard for re-runs.
rm -f "$VSIX_PATH"
npx --no-install vsce package --allow-missing-repository -o "$VSIX_PATH"
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
  1. Reload VS Code: Cmd+Shift+P → 'Developer: Reload Window'
  2. Test the new build.
  3. Only if it works, commit the in-flight changes and tag the release.
     Principle: we don't commit until we've tested. No git work happens
     in this script — that step is intentionally left to a human/agent
     decision after verification.

ROLLBACK (if testing fails):
  $PROJECT_ROOT/scripts/rollback.sh $VERSION

  That command will:
    - restore the snapshot at ${SNAP_BASE}.sqlite[-wal|-shm]
      over $DB_PATH
    - reinstall the previous .vsix from $VSIX_DIR/
    - require VS Code to be closed before it runs

EOF
