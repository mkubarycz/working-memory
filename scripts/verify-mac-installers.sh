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
images=("$output"/*.dmg)
if [[ ${#images[@]} -eq 0 ]]; then
  echo "Expected a DMG installer in $output" >&2
  exit 1
fi

for image in "${images[@]}"; do
  echo "Verifying DMG: $image"
  hdiutil verify "$image"
  hdiutil attach -readonly -nobrowse -mountpoint "$scratch/mount" "$image"
  mounted=true
  codesign --verify --deep --strict --verbose=2 "$scratch/mount/Working Memory.app"
  hdiutil detach "$scratch/mount"
  mounted=false
done
