#!/usr/bin/env bash
set -Eeuo pipefail

PROJECT_ID="barberia-c25a1"
SECRET_NAME="BARBERIA_TELEGRAM_BOT_TOKEN"
CHAT_ID="-5393018000"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

trap 'echo ""; echo "❌ El despliegue se detuvo en la línea $LINENO. Revisa el mensaje anterior."' ERR

for required in .firebaserc firebase.json firebase-config.js index.html app.js styles.css service-worker.js firestore.rules storage.rules functions/package.json functions/index.js; do
  [[ -f "$required" ]] || { echo "❌ Falta $required."; exit 1; }
done

if ! command -v firebase >/dev/null 2>&1; then
  npm install -g firebase-tools
fi

if ! firebase projects:list --json >/dev/null 2>&1; then
  firebase login --no-localhost
fi

firebase use "$PROJECT_ID"

if ! firebase functions:secrets:get "$SECRET_NAME" --project "$PROJECT_ID" >/dev/null 2>&1; then
  echo "Configura por única vez el token de Telegram cuando Firebase lo solicite."
  firebase functions:secrets:set "$SECRET_NAME" --project "$PROJECT_ID"
fi

npm ci --prefix functions
npm test --prefix functions
node --test tests/*.test.mjs
node --check app.js
node --check functions/index.js

firebase deploy \
  --project "$PROJECT_ID" \
  --only "firestore:rules,storage,hosting,functions:barberia"

echo "✅ Barbería desplegada correctamente: https://${PROJECT_ID}.web.app"
echo "✅ Telegram configurado para el grupo ${CHAT_ID}."
