#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CRUFT="$ROOT/scripts/cruft.sh"
WORK="$ROOT/.tmp/cruft-template-smoke"
TEMPLATE_REPO="$WORK/template-repository"
OUTPUT="$WORK/generated"
APP="$OUTPUT/smoke-app"
LINKED_APP="$OUTPUT/linked-app"

cleanup() {
  rm -rf "$WORK"
}
trap cleanup EXIT

rm -rf "$WORK"
mkdir -p "$TEMPLATE_REPO/templates" "$OUTPUT"
cp -R "$ROOT/templates/standalone-app" "$TEMPLATE_REPO/templates/standalone-app"

git -C "$TEMPLATE_REPO" init --quiet
git -C "$TEMPLATE_REPO" config user.name "Cruft Smoke Test"
git -C "$TEMPLATE_REPO" config user.email "cruft-smoke@example.invalid"
git -C "$TEMPLATE_REPO" add templates/standalone-app
git -C "$TEMPLATE_REPO" commit --quiet -m "Template v1"

"$CRUFT" create "file://$TEMPLATE_REPO" \
  --directory templates/standalone-app \
  --output-dir "$OUTPUT" \
  --no-input \
  --extra-context '{
    "app_id":"smoke-app",
    "app_title":"Smoke App",
    "app_description":"Disposable Cruft lifecycle test.",
    "package_name":"smoke-app",
    "port":"9080",
    "enable_http":"true",
    "enable_ui":"false"
  }'

cp -R "$APP" "$LINKED_APP"
rm "$LINKED_APP/.cruft.json"
"$CRUFT" link "file://$TEMPLATE_REPO" \
  --project-dir "$LINKED_APP" \
  --directory templates/standalone-app \
  --no-input \
  --extra-context '{
    "app_id":"smoke-app",
    "app_title":"Smoke App",
    "app_description":"Disposable Cruft lifecycle test.",
    "package_name":"smoke-app",
    "port":"9080",
    "enable_http":"true",
    "enable_ui":"false"
  }'
node -e "const c=require('$LINKED_APP/.cruft.json'); if(c.directory!=='templates/standalone-app') process.exit(1)"

git -C "$APP" init --quiet
git -C "$APP" config user.name "Cruft Smoke Test"
git -C "$APP" config user.email "cruft-smoke@example.invalid"

(
  cd "$APP"
  npm ci --no-audit --no-fund
  npm test
  npm run typecheck
  npm run build
  "$CRUFT" check
)

node - "$APP/.cruft.json" <<'NODE'
const fs = require('node:fs');
const file = process.argv[2];
const value = JSON.parse(fs.readFileSync(file, 'utf8'));
if (value.directory !== 'templates/standalone-app') {
  throw new Error(`unexpected Cruft directory provenance: ${value.directory}`);
}
value.skip = ['src/app/**', 'test/app/**'];
fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
NODE

printf '\n// app-owned smoke customization\n' >> "$APP/src/app/resources/note.ts"
printf 'app-owned-local-file\n' > "$APP/src/app/local-resource.txt"
git -C "$APP" add .
git -C "$APP" commit --quiet -m "App-owned customization"

printf 'template-v2\n' > "$TEMPLATE_REPO/templates/standalone-app/{{cookiecutter.app_id}}/template-version.txt"
git -C "$TEMPLATE_REPO" add templates/standalone-app
git -C "$TEMPLATE_REPO" commit --quiet -m "Template v2"

if (cd "$APP" && "$CRUFT" check); then
  echo "Expected pre-update cruft check to report drift." >&2
  exit 1
fi

(
  cd "$APP"
  "$CRUFT" update --template-path "$TEMPLATE_REPO" --skip-apply-ask
)

grep -qx 'template-v2' "$APP/template-version.txt"
grep -q 'app-owned smoke customization' "$APP/src/app/resources/note.ts"
grep -qx 'app-owned-local-file' "$APP/src/app/local-resource.txt"

node - "$APP/.cruft.json" <<'NODE'
const fs = require('node:fs');
const value = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
if (value.directory !== 'templates/standalone-app') {
  throw new Error('Cruft update lost subdirectory provenance.');
}
NODE

(cd "$APP" && "$CRUFT" check)

echo "Standalone Cruft template smoke test passed."
