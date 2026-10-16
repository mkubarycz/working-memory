#!/bin/bash
set -euo pipefail

output="${1:?Usage: verify-mac-installers.sh <installer-directory>}"
scratch="$(mktemp -d)"
mounted=false

cleanup() {
  if [[ "$mounted" == true ]]; then
    hdiutil detach "$scratch/mount"
  fi
  rm -r "$scratch"
}
trap cleanup EXIT

shopt -s nullglob
archives=("$output"/*.zip)
images=("$output"/*.dmg)
if [[ ${#archives[@]} -eq 0 || ${#images[@]} -eq 0 ]]; then
  echo "Expected both ZIP and DMG installers in $output" >&2
  exit 1
fi

for archive in "${archives[@]}"; do
  echo "Verifying ZIP: $archive"
  mkdir "$scratch/zip"
  ditto -x -k "$archive" "$scratch/zip"
  codesign --verify --deep --strict --verbose=2 "$scratch/zip/Working Memory.app"
  rm -r "$scratch/zip"
done

for image in "${images[@]}"; do
  echo "Verifying DMG: $image"
  hdiutil verify "$image"
  hdiutil attach -readonly -nobrowse -mountpoint "$scratch/mount" "$image"
  mounted=true
  codesign --verify --deep --strict --verbose=2 "$scratch/mount/Working Memory.app"
  hdiutil detach "$scratch/mount"
  mounted=false
done
