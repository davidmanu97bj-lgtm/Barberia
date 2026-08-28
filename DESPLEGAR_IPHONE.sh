#!/usr/bin/env bash
set -Eeuo pipefail

PROJECT_ID="barberia-c25a1"
SECRET_NAME="BARBERIA_TELEGRAM_BOT_TOKEN"
CHAT_ID="-5393018000"
BASE_DIR="$(pwd)"
WORK_DIR="${HOME}/barberia_despliegue_iphone"

fail() {
  echo ""
  echo "❌ $1"
  exit 1
}

trap 'code=$?; echo ""; echo "❌ El despliegue se detuvo en la línea $LINENO (código $code)."; echo "Mira el mensaje inmediatamente anterior para saber qué falló."; exit $code' ERR

echo "======================================================"
echo " BARBERÍA · DESPLIEGUE COMPLETO AUTOMÁTICO · IPHONE"
echo "======================================================"
echo "Proyecto Firebase: ${PROJECT_ID}"
echo ""

# 1) Buscar el ZIP automáticamente. Si se pasa una ruta como primer argumento, la usa.
ZIP_FILE="${1:-}"
if [[ -z "$ZIP_FILE" ]]; then
  for preferred in \
    "$BASE_DIR/Barberia-iPhone-FINAL-5PORCIENTO.zip" \
    "$BASE_DIR/Barberia-iPhone-V5.zip" \
    "$BASE_DIR/Barberia-iPhone-Corregido.zip" \
    "$BASE_DIR/Barberia-iPhone-Actualizado.zip"; do
    if [[ -f "$preferred" ]]; then
      ZIP_FILE="$preferred"
      break
    fi
  done
fi

if [[ -z "$ZIP_FILE" ]]; then
  ZIP_FILE="$(find "$BASE_DIR" -maxdepth 1 -type f \( -iname 'Barberia*.zip' -o -iname '*barberia*.zip' \) -printf '%T@|%p\n' 2>/dev/null | sort -t'|' -k1,1nr | head -n 1 | cut -d'|' -f2- || true)"
fi

# 2) Descomprimir sin pedir comandos adicionales.
if [[ -n "$ZIP_FILE" && -f "$ZIP_FILE" ]]; then
  echo "📦 ZIP encontrado: $(basename "$ZIP_FILE")"
  rm -rf "$WORK_DIR"
  mkdir -p "$WORK_DIR"
  if command -v unzip >/dev/null 2>&1; then
    unzip -oq "$ZIP_FILE" -d "$WORK_DIR"
  elif command -v python3 >/dev/null 2>&1; then
    python3 -m zipfile -e "$ZIP_FILE" "$WORK_DIR"
  else
    fail "Cloud Shell no tiene unzip ni python3 para descomprimir el proyecto."
  fi
  echo "✅ ZIP descomprimido automáticamente."
  PROJECT_DIR="$(find "$WORK_DIR" -type f -name firebase.json -print -quit | xargs -r dirname)"
else
  # También funciona si el usuario ya está parado dentro de la carpeta extraída.
  if [[ -f "$BASE_DIR/firebase.json" ]]; then
    PROJECT_DIR="$BASE_DIR"
  elif [[ -f "$BASE_DIR/Barberia-main/firebase.json" ]]; then
    PROJECT_DIR="$BASE_DIR/Barberia-main"
  else
    fail "No encontré el ZIP ni una carpeta de proyecto. Sube este .sh junto con Barberia-iPhone-FINAL-5PORCIENTO.zip y ejecútalo otra vez."
  fi
fi

[[ -n "${PROJECT_DIR:-}" && -f "$PROJECT_DIR/firebase.json" ]] || fail "No pude localizar firebase.json dentro del paquete."
cd "$PROJECT_DIR"
echo "📁 Proyecto localizado en: $PROJECT_DIR"

# 3) Validar que el paquete esté completo.
for required in \
  .firebaserc firebase.json firebase-config.js index.html app.js styles.css \
  service-worker.js barberia-core.mjs firestore.rules storage.rules \
  functions/package.json functions/index.js; do
  [[ -f "$required" ]] || fail "Falta $required dentro del proyecto."
done

command -v node >/dev/null 2>&1 || fail "Cloud Shell no tiene Node.js disponible."
command -v npm >/dev/null 2>&1 || fail "Cloud Shell no tiene npm disponible."

# 4) Reparación preventiva de la incompatibilidad de Firestore Rules ya detectada.
if grep -q 'data\.service is string' firestore.rules || grep -q 'data\.service\.size()' firestore.rules; then
  echo "🛠️ Corrigiendo compatibilidad del campo service en firestore.rules..."
  sed -i "s/data\\.service is string/data['service'] is string/g" firestore.rules
  sed -i "s/data\\.service\\.size()/data['service'].size()/g" firestore.rules
fi

grep -Fq "data['service'] is string" firestore.rules || fail "No pude verificar la regla corregida del campo service."
grep -Fq "request.resource.data.rate == 0.05" firestore.rules || fail "Las reglas no contienen el nuevo 5% de publicidad."
if grep -q 'data\.service is string\|data\.service\.size()' firestore.rules; then
  fail "Quedó una referencia incompatible a data.service en firestore.rules."
fi
echo "✅ Firestore Rules verificadas: service compatible + publicidad 5%."

# 5) Firebase CLI y autorización. Reutiliza la sesión ya autorizada de Cloud Shell.
if ! command -v firebase >/dev/null 2>&1; then
  echo "⬇️ Instalando Firebase CLI..."
  npm install -g firebase-tools
fi

echo "Firebase CLI: $(firebase --version)"
if firebase projects:list --json >/dev/null 2>&1; then
  echo "✅ Firebase ya está autorizado en este Cloud Shell."
else
  echo "🔐 Firebase necesita autorización por única vez."
  firebase login --no-localhost
fi

firebase use "$PROJECT_ID"

# 6) Telegram. No muestra ni reemplaza el token si ya existe.
echo "📨 Telegram: grupo ${CHAT_ID}"
if firebase functions:secrets:get "$SECRET_NAME" --project "$PROJECT_ID" >/dev/null 2>&1; then
  echo "✅ Token de Telegram ya configurado."
else
  echo "⚠️ Falta el token de Telegram en Firebase."
  echo "Firebase lo pedirá una sola vez; pega el token completo del bot."
  firebase functions:secrets:set "$SECRET_NAME" --project "$PROJECT_ID"
fi

# 7) Instalar dependencias y probar TODO antes de tocar producción.
echo "🧪 Instalando dependencias y ejecutando pruebas..."
npm ci --prefix functions
npm test --prefix functions
node --test tests/*.test.mjs
node --check app.js
node --check functions/index.js

echo "✅ Todas las pruebas locales pasaron."

# 8) Despliegue completo por etapas para saber exactamente dónde falla si Firebase rechaza algo.
echo ""
echo "🔥 1/4 Desplegando Firestore Rules..."
firebase deploy --project "$PROJECT_ID" --only "firestore:rules"

echo ""
echo "🗂️ 2/4 Desplegando Storage Rules..."
firebase deploy --project "$PROJECT_ID" --only "storage"

echo ""
echo "⚙️ 3/4 Desplegando TODAS las Functions de Barbería..."
firebase deploy --project "$PROJECT_ID" --only "functions:barberia"

echo ""
echo "📱 4/4 Desplegando Hosting/PWA..."
firebase deploy --project "$PROJECT_ID" --only "hosting"

# 9) Verificación final del sitio.
if command -v curl >/dev/null 2>&1; then
  if curl -fsS --max-time 20 "https://${PROJECT_ID}.web.app/" >/dev/null; then
    echo "✅ Hosting responde correctamente."
  else
    echo "⚠️ Firebase terminó el deploy, pero Cloud Shell no pudo comprobar el sitio por HTTP."
  fi
fi

echo ""
echo "======================================================"
echo " ✅ BARBERÍA DESPLEGADA COMPLETA"
echo "======================================================"
echo "Sitio: https://${PROJECT_ID}.web.app"
echo "Telegram: grupo ${CHAT_ID}"
echo ""
echo "En iPhone: cierra por completo la PWA/pestaña y vuelve a abrirla para cargar la nueva caché."
