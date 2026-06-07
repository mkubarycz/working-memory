#!/usr/bin/env bash
# rollback.sh — undo a release produced by release.sh.
#
# Steps, in order:
#   1. Locate the most recent snapshot matching journal-pre-v<version>-*.sqlite
#   2. Locate the previous .vsix in dist/ (any vsix older than the rolled-back one)
#   3. Confirm with the user
#   4. Warn loudly that VS Code must be closed
#   5. Uninstall the current extension, restore snapshot files, install previous vsix
#   6. Print "reopen VS Code"
#
# Usage:
#   ./scripts/rollback.sh <version>
#     where <version> is the version being undone (the most recent release).

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
HUB_ROOT="$(cd "$PROJECT_ROOT/../.." && pwd)"

die() { printf '\033[31merror:\033[0m %s\n' "$*" >&2; exit 1; }
info() { printf '\033[36m==>\033[0m %s\n' "$*"; }
warn() { printf '\033[33mwarn:\033[0m %s\n' "$*" >&2; }
ok() { printf '\033[32mok:\033[0m %s\n' "$*"; }

[[ $# -eq 1 ]] || die "usage: $0 <version-to-rollback>"
VERSION="$1"

EXT_ID="kubarycz.working-memory"
BACKUP_DIR="$HUB_ROOT/memory/.backups"
VSIX_DIR="$PROJECT_ROOT/dist"
DB_PATH="$HUB_ROOT/memory/journal.sqlite"
CURRENT_VSIX="$VSIX_DIR/working-memory-${VERSION}.vsix"

[[ -d "$BACKUP_DIR" ]] || die "no backup dir at $BACKUP_DIR — nothing to roll back to"

# ---------------------------------------------------------------------------
# 1. Find the snapshot
# ---------------------------------------------------------------------------

info "looking for snapshot: journal-pre-v${VERSION}-*.sqlite"
mapfile -t SNAPS < <(
  ls -1t "$BACKUP_DIR"/journal-pre-v${VERSION}-*.sqlite 2>/dev/null || true
)

if [[ ${#SNAPS[@]} -eq 0 ]]; then
  echo "no snapshot found for v${VERSION}." >&2
  echo "available snapshots:" >&2
  ls -1t "$BACKUP_DIR"/journal-pre-v*.sqlite 2>/dev/null >&2 || echo "  (none)" >&2
  exit 1
fi

SNAP="${SNAPS[0]}"
SNAP_WAL="${SNAP%.sqlite}.sqlite-wal"
SNAP_SHM="${SNAP%.sqlite}.sqlite-shm"
ok "snapshot: $SNAP"

# ---------------------------------------------------------------------------
# 2. Find the previous vsix
# ---------------------------------------------------------------------------

info "looking for previous .vsix in $VSIX_DIR/"
PREV_VSIX=""
if [[ -d "$VSIX_DIR" ]]; then
  while IFS= read -r f; do
    base="$(basename "$f")"
    if [[ "$base" != "working-memory-${VERSION}.vsix" ]]; then
      PREV_VSIX="$f"
      break
    fi
  done < <(ls -1t "$VSIX_DIR"/working-memory-*.vsix 2>/dev/null || true)
fi

if [[ -z "$PREV_VSIX" ]]; then
  die "no previous .vsix found in $VSIX_DIR/ — reinstall the prior release manually:
       code --install-extension <path-to-prior.vsix> --force"
fi
ok "previous vsix: $PREV_VSIX"

# ---------------------------------------------------------------------------
# 3. Confirm
# ---------------------------------------------------------------------------

cat <<EOF

\033[33m─── rollback plan ───\033[0m
  Restore:    $SNAP
              ${SNAP_WAL} (if present)
              ${SNAP_SHM} (if present)
  Over:       $DB_PATH
              ${DB_PATH}-wal
              ${DB_PATH}-shm
  Uninstall:  $EXT_ID (current: v$VERSION)
  Reinstall:  $PREV_VSIX

EOF

read -r -p "Proceed? [y/N] " ANSWER
[[ "$ANSWER" == "y" || "$ANSWER" == "Y" ]] || die "aborted by user"

# ---------------------------------------------------------------------------
# 4. Warn about VS Code being open
# ---------------------------------------------------------------------------

warn "VS Code MUST be fully quit before continuing."
warn "If any window is still open, the WAL is hot and restoring the DB can corrupt state."
read -r -p "Have you fully quit VS Code (Cmd+Q on all windows)? [y/N] " ANSWER
[[ "$ANSWER" == "y" || "$ANSWER" == "Y" ]] || die "aborted — quit VS Code and re-run"

# ---------------------------------------------------------------------------
# 5. Uninstall, restore, install
# ---------------------------------------------------------------------------

info "uninstalling $EXT_ID"
code --uninstall-extension "$EXT_ID" || warn "uninstall returned non-zero (continuing)"

info "restoring snapshot over live DB"
# Wipe live -wal/-shm so the restored DB starts clean.
rm -f "${DB_PATH}-wal" "${DB_PATH}-shm"
cp "$SNAP" "$DB_PATH"
[[ -f "$SNAP_WAL" ]] && cp "$SNAP_WAL" "${DB_PATH}-wal" && ok "restored -wal" || true
[[ -f "$SNAP_SHM" ]] && cp "$SNAP_SHM" "${DB_PATH}-shm" && ok "restored -shm" || true
ok "DB restored from $(basename "$SNAP")"

info "installing $PREV_VSIX"
code --install-extension "$PREV_VSIX" --force

PREV_VERSION="$(basename "$PREV_VSIX" .vsix)"
PREV_VERSION="${PREV_VERSION#working-memory-}"

cat <<EOF

\033[32m✓ rolled back to v$PREV_VERSION\033[0m

Reopen VS Code.

NOTE: in the test-then-commit flow, rollback normally happens BEFORE any
      commit or tag exists for v$VERSION, so there's nothing to clean up.
      If a regression was found AFTER a commit + tag (rare), ask the
      working-memory-developer agent to back the commit/tag out — it's
      safe because nothing has been pushed.

EOF
