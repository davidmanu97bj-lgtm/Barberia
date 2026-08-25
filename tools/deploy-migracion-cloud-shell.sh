#!/usr/bin/env bash
set -euo pipefail

readonly FIREBASE_PROJECT_ID="explora-control-operativo"

cd "$(dirname "$0")/.."

for required in firebase.json firestore.rules storage.rules functions/index.js firebase-config.js app.js; do
  if [[ ! -f "$required" ]]; then
    echo "Error: falta $required. Ejecuta este script dentro del proyecto migrado."
    exit 1
  fi
done

if ! command -v node >/dev/null 2>&1; then
  echo "Error: Node.js no está disponible."
  exit 1
fi

if ! command -v npm >/dev/null 2>&1; then
  echo "Error: npm no está disponible."
  exit 1
fi

if ! command -v firebase >/dev/null 2>&1; then
  echo "Instalando Firebase CLI..."
  npm install -g firebase-tools
fi

echo "1/5 · Validando frontend..."
node --check app.js

echo "2/5 · Instalando dependencias de Functions..."
(
  cd functions
  npm ci
)

echo "3/5 · Validando Functions y Telegram..."
node --check functions/index.js
node --check functions/telegram-billing-balance.js
node --check functions/telegram-debt-payment.js
node --check functions/telegram-driver-debt.js
(
  cd functions
  npm test
)

echo "4/5 · Proyecto destino: ${FIREBASE_PROJECT_ID}"
if command -v gcloud >/dev/null 2>&1; then
  gcloud config set project "${FIREBASE_PROJECT_ID}" >/dev/null
fi

echo "5/5 · Desplegando reglas y todas las Cloud Functions..."
firebase deploy \
  --project "${FIREBASE_PROJECT_ID}" \
  --only firestore:rules,storage,functions

echo "Listo: backend de Barbería Main actualizado en ${FIREBASE_PROJECT_ID}."
