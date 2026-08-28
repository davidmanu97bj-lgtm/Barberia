#!/usr/bin/env bash
set -euo pipefail

BARBERIA_PROJECT_ID="barberia-c25a1"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

for required in firebase.json firebase-config.js index.html app.js firestore.rules storage.rules functions/package.json; do
  if [[ ! -f "$required" ]]; then
    echo "Falta $required. Ejecuta este archivo dentro de la carpeta del proyecto."
    exit 1
  fi
done

if ! command -v firebase >/dev/null 2>&1; then
  npm install -g firebase-tools
fi

firebase login --reauth
firebase use "$BARBERIA_PROJECT_ID"
npm ci --prefix functions
npm test --prefix functions
node --test tests/*.test.mjs

firebase deploy \
  --project "$BARBERIA_PROJECT_ID" \
  --only "firestore:rules,storage,hosting,functions:barberia"

echo "Barbería República Argentina desplegada correctamente."
echo "Sitio: https://${BARBERIA_PROJECT_ID}.web.app"

