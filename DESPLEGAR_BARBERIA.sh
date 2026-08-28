#!/usr/bin/env bash
set -euo pipefail

BARBERIA_PROJECT_ID="barberia-c25a1"
TELEGRAM_SECRET="BARBERIA_TELEGRAM_BOT_TOKEN"
TELEGRAM_CHAT_ID="-5393018000"
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

echo "Telegram Barbería: grupo ${TELEGRAM_CHAT_ID}"
if firebase functions:secrets:get "$TELEGRAM_SECRET" >/dev/null 2>&1; then
  echo "El token de Telegram ya está guardado de forma segura en Firebase."
else
  echo "Primera configuración de Telegram."
  echo "Cuando Firebase lo pida, pega el TOKEN NUEVO completo de @Explora_notificaciones_bot."
  echo "El token no se guarda dentro de los archivos del proyecto."
  firebase functions:secrets:set "$TELEGRAM_SECRET"
fi

npm ci --prefix functions
npm test --prefix functions
node --test tests/*.test.mjs

firebase deploy \
  --project "$BARBERIA_PROJECT_ID" \
  --only "firestore:rules,storage,hosting,functions:barberia"

echo "Barbería República Argentina desplegada correctamente."
echo "Telegram configurado para el grupo Barbería: ${TELEGRAM_CHAT_ID}"
echo "Sitio: https://${BARBERIA_PROJECT_ID}.web.app"

