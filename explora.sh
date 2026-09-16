#!/usr/bin/env bash
# EXPLORA · Gestor de entrega 3.0.0. Sin eval, tokens en argumentos ni git push/reset.
set -Eeuo pipefail
IFS=$'\n\t'
umask 077
ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
cd "$ROOT"
LOCAL="$ROOT/.explora-local"
FIREBASE_VERSION="15.30.0"
mkdir -p "$LOCAL"
chmod 700 "$LOCAL"
PRIVATE_FILE=""
cleanup() { [[ -z "$PRIVATE_FILE" ]] || rm -f -- "$PRIVATE_FILE"; }
trap cleanup EXIT
trap 'code=$?; printf "\nOperación detenida en la línea %s (código %s). No se continuará publicando.\n" "$LINENO" "$code" >&2; exit "$code"' ERR
say() { printf '\n%s\n' "$*"; }
fail() { printf '\nERROR: %s\n' "$*" >&2; exit 1; }
ask() { [[ -t 0 ]] || fail "Este paso requiere una terminal interactiva."; read -r -p "$1" REPLY; }
confirm() { ask "$1 Escribí exactamente '$2': "; [[ "$REPLY" == "$2" ]] || fail "Confirmación no recibida; no se hizo el cambio."; }
node22() {
  if ! command -v node >/dev/null 2>&1 || [[ "$(node -p 'process.versions.node.split(".")[0]')" != 22 ]]; then
    if [[ -s "${NVM_DIR:-$HOME/.nvm}/nvm.sh" ]]; then
      set +u
      # shellcheck disable=SC1091
      source "${NVM_DIR:-$HOME/.nvm}/nvm.sh"
      nvm install 22
      nvm use 22
      set -u
    else fail "Se requiere Node 22. En Cloud Shell habilitá Node 22 con nvm y repetí el comando."; fi
  fi
}
project_id() { node --input-type=module -e 'import {PROJECT_ID} from "./tools/project.mjs"; console.log(PROJECT_ID)'; }
fb() { npx --yes "firebase-tools@$FIREBASE_VERSION" "$@"; }
dependencies() {
  node22
  [[ -f functions/package-lock.json ]] || fail "Falta functions/package-lock.json."
  npm ci --prefix functions --ignore-scripts --no-audit --no-fund
}
need_dependencies() { [[ -d functions/node_modules/firebase-admin && -d functions/node_modules/sharp ]] || dependencies; }
login_firebase() {
  if ! fb projects:list --json >"$LOCAL/projects.json"; then
    say "Autorizá Firebase con la misma cuenta de Google que administra el destino."
    fb login --no-localhost
    fb projects:list --json >"$LOCAL/projects.json"
  fi
}
credentials() {
  command -v gcloud >/dev/null 2>&1 || fail "Se requiere Google Cloud CLI (incluido en Cloud Shell)."
  if ! gcloud auth application-default print-access-token >/dev/null 2>&1; then
    say "Autorización de Google para administrar este proyecto. No compartas los tokens."
    gcloud auth application-default login --no-launch-browser
  fi
}
backup() {
  local destination="$LOCAL/backup-$(date -u +%Y%m%dT%H%M%SZ)-$$.tar.gz"
  tar --exclude='./.git' --exclude='./.explora-local' --exclude='./.explora-tools' --exclude='./node_modules' \
      --exclude='./functions/node_modules' --exclude='./dist' --exclude='./.deploy' -czf "$destination" .
  say "Copia local creada: $destination. No es una copia de Firestore/Auth/Storage."
}
options_set() {
  node --input-type=module - "$1" "$2" <<'JS'
import fs from 'node:fs';
const [key,value]=process.argv.slice(2);
if(!['telegramEnabled','arcaEnabled','routesEnabled'].includes(key)||!['true','false'].includes(value))throw new Error('Opción inválida.');
const p='functions/deployment-options.json',data=JSON.parse(fs.readFileSync(p,'utf8'));
data[key]=value==='true';fs.writeFileSync(p,JSON.stringify(data,null,2)+'\n');
JS
}
configure() {
  node22; login_firebase
  node --input-type=module - "$LOCAL/projects.json" <<'JS'
import fs from 'node:fs';const r=JSON.parse(fs.readFileSync(process.argv[2],'utf8'));
for(const p of (Array.isArray(r.result)?r.result:r.result?.projects||[]))console.log(`${p.projectId} — ${p.displayName||p.projectId}`);
JS
  ask "ID de proyecto Firebase destino [$(project_id)]: "
  local selected="${REPLY:-$(project_id)}"
  [[ "$selected" =~ ^[a-z][a-z0-9-]{4,61}[a-z0-9]$ ]] || fail "ID de proyecto inválido."
  confirm "Destino $selected. Un repositorio GitHub no selecciona automáticamente un proyecto Firebase." "$selected"
  backup
  fb apps:list WEB --project "$selected" --json >"$LOCAL/apps.json"
  node --input-type=module - "$LOCAL/apps.json" <<'JS'
import fs from 'node:fs';const r=JSON.parse(fs.readFileSync(process.argv[2],'utf8'));for(const a of (Array.isArray(r.result)?r.result:r.result?.apps||[]))console.log(`${a.appId} — ${a.displayName||'Web'}`);
JS
  ask "App ID WEB de la lista (vacío para crear una app Web EXPLORA): "
  local appid="$REPLY"
  if [[ -z "$appid" ]]; then
    confirm "Se creará una aplicación WEB, no un proyecto nuevo ni una copia de datos." "CREAR"
    fb apps:create WEB "Explora" --project "$selected" --json >"$LOCAL/app-created.json"
    appid="$(node --input-type=module - "$LOCAL/app-created.json" <<'JS'
import fs from 'node:fs';const r=JSON.parse(fs.readFileSync(process.argv[2],'utf8'));const id=r.result?.appId;if(!id)throw new Error('No se obtuvo appId');console.log(id);
JS
)"
  fi
  fb apps:sdkconfig WEB "$appid" --project "$selected" --json >"$LOCAL/sdkconfig.json"
  node tools/configure-target.mjs "$selected" "$LOCAL/sdkconfig.json"
  node tools/validate-project.mjs
}
secret_value() {
  local name="$1" project="$2"
  if command -v gcloud >/dev/null 2>&1 && gcloud secrets describe "$name" --project "$project" >/dev/null 2>&1; then
    ask "$name ya existe en $project. ¿Conservarlo? [S/n]: "
    if [[ "${REPLY:-S}" =~ ^[sS]$ ]]; then return; fi
  fi
  PRIVATE_FILE="$(mktemp "$LOCAL/secret.XXXXXX")"
  if [[ "$name" == ARCA_CERTIFICATE || "$name" == ARCA_PRIVATE_KEY ]]; then
    ask "Ruta al archivo PEM $name (no pegues el contenido en el chat): "
    [[ -f "$REPLY" && -s "$REPLY" ]] || fail "No existe el archivo PEM."
    cat -- "$REPLY" >"$PRIVATE_FILE"
    grep -q -- '-----BEGIN ' "$PRIVATE_FILE" || fail "El archivo no parece PEM."
  else
    [[ -t 0 ]] || fail "Los secretos requieren una terminal."
    read -r -s -p "Valor de $name (oculto): " value; printf '\n'
    [[ -n "$value" ]] || fail "No se admite un secreto vacío."
    printf '%s' "$value" >"$PRIVATE_FILE"; unset value
  fi
  fb functions:secrets:set "$name" --project "$project" --data-file "$PRIVATE_FILE" --non-interactive
  rm -f -- "$PRIVATE_FILE"; PRIVATE_FILE=""
}
telegram() {
  node22; login_firebase
  local project;project="$(project_id)"
  confirm "Se configurará Telegram en $project. No se enviará un mensaje de prueba." "$project"
  secret_value TELEGRAM_BOT_TOKEN "$project"
  secret_value TELEGRAM_CHAT_ID "$project"
  options_set telegramEnabled true
  say "Telegram habilitado para el próximo despliegue. Digital y gastos requieren foto; los fallos quedan para reintento, nunca se declaran enviados sin imagen."
}
routes() {
  node22;login_firebase
  local project;project="$(project_id)"
  confirm "Configurar rutas opcionales en $project." "$project"
  secret_value OPENROUTESERVICE_API_KEY "$project"
  options_set routesEnabled true
  say "Rutas habilitadas para el próximo despliegue."
}
admin() {
  node22; need_dependencies; credentials
  local project;project="$(project_id)"
  confirm "Se concederá rol administrador a la cuenta indicada, únicamente en $project." "$project"
  ask "Correo del administrador (cuenta nueva o existente): ";export EXPLORA_ADMIN_EMAIL="$REPLY"
  ask "Alias de acceso [david]: ";export EXPLORA_ADMIN_ALIAS="${REPLY:-david}"
  ask "Nombre [David]: ";export EXPLORA_ADMIN_NAME="${REPLY:-David}"
  read -r -s -p "Contraseña SOLO para cuenta nueva (12+ caracteres; vacío para existente): " EXPLORA_ADMIN_PASSWORD;printf '\n';export EXPLORA_ADMIN_PASSWORD
  PRIVATE_FILE="$(mktemp "$LOCAL/admin.XXXXXX")"
  node - "$PRIVATE_FILE" <<'JS'
const fs=require('fs');fs.writeFileSync(process.argv[2],JSON.stringify({email:process.env.EXPLORA_ADMIN_EMAIL,alias:process.env.EXPLORA_ADMIN_ALIAS,name:process.env.EXPLORA_ADMIN_NAME,password:process.env.EXPLORA_ADMIN_PASSWORD}),{mode:0o600});
JS
  unset EXPLORA_ADMIN_EMAIL EXPLORA_ADMIN_ALIAS EXPLORA_ADMIN_NAME EXPLORA_ADMIN_PASSWORD
  node tools/cloud-admin.mjs admin "$project" "$PRIVATE_FILE"
  rm -f -- "$PRIVATE_FILE"; PRIVATE_FILE=""
}
arca() {
  node22;need_dependencies;credentials;login_firebase
  local project;project="$(project_id)"
  say "ARCA conserva la integración original de factura C de monotributo. No habilita por sí sola otro régimen fiscal."
  confirm "Se configurará la facturación en $project. No se emitirán comprobantes históricos ni ficticios." "$project"
  ask "Archivo JSON fiscal existente (vacío para completar el asistente paso a paso): ";local cfg="$REPLY"
  if [[ -z "$cfg" ]]; then
    cfg="$LOCAL/arca-config.local.json"
    node tools/arca-config-prompt.mjs "$cfg"
  fi
  [[ -s "$cfg" ]] || fail "Falta el archivo JSON fiscal."
  local mode;mode="$(node -e 'const f=require("fs");console.log(JSON.parse(f.readFileSync(process.argv[1],"utf8")).environment)' "$cfg")"
  if [[ "$mode" == production ]]; then confirm "PRODUCCIÓN: los nuevos viajes podrán emitir facturas reales tras desplegar. Requiere homologación y situación fiscal verificadas." "ACTIVAR PRODUCCION"; fi
  secret_value ARCA_CERTIFICATE "$project"
  secret_value ARCA_PRIVATE_KEY "$project"
  node tools/cloud-admin.mjs arca "$project" "$cfg"
  options_set arcaEnabled true
  say "Configuración fiscal guardada. Ejecutá deploy para activar las funciones."
}
check() { node22;need_dependencies;npm test;npm run build;bash -n explora.sh;say "Validaciones locales completas. No hubo despliegue ni llamada a ARCA/Telegram."; }
deploy() {
  node22;need_dependencies;login_firebase
  local project;project="$(project_id)"
  node tools/validate-project.mjs
  say "DESTINO: $project. El Hosting y las reglas de ese proyecto serán actualizados.\nNo se migran usuarios ni datos desde Explora anterior. No se borran datos ni funciones ajenas.\nSi $project contiene la barbería real, elegí otro Firebase antes de continuar."
  cat functions/deployment-options.json
  say "Una integración marcada false permanece inactiva. Configurala con telegram/arca/routes antes de publicar."
  confirm "Publicar EXPLORA en este destino." "PUBLICAR $project"
  backup
  check
  local functions;functions="$(node tools/functions-manifest.mjs)"
  local log="$LOCAL/deploy-$(date -u +%Y%m%dT%H%M%SZ).log"
  # Explicit function names prevent Firebase from offering to delete unrelated functions.
  fb deploy --project "$project" --config firebase.json --only firestore:rules,firestore:indexes,storage --non-interactive 2>&1 | tee -a "$log"
  fb deploy --project "$project" --config firebase.json --only "$functions" --interactive 2>&1 | tee -a "$log"
  fb deploy --project "$project" --config firebase.json --only hosting --non-interactive 2>&1 | tee -a "$log"
  say "Despliegue terminado: https://$project.web.app\nRegistro: $log. Verificá un cobro y un gasto de prueba en homologación antes de operar."
}
migrate() {
  node22;need_dependencies;credentials
  local project;project="$(project_id)"
  if [[ "${1:-}" == --apply ]]; then
    confirm "Convertir comprobantes históricos en $project. Se conservan originales, importes y fechas." "CONVERTIR $project"
    node tools/cloud-admin.mjs migrate-pdfs "$project" --apply "${2:-}"
  elif [[ -n "${1:-}" ]]; then fail "Uso: bash explora.sh migrate-pdfs [--apply [--restart]]"
  else node tools/cloud-admin.mjs migrate-pdfs "$project"; fi
}
help_text() {
cat <<'HELP'
EXPLORA — Gestor Cloud Shell
  bash explora.sh                    Menú interactivo
  bash explora.sh install            Node 22 + dependencias del lockfile
  bash explora.sh configure          Seleccionar Firebase y configuración web
  bash explora.sh admin              Crear/habilitar administrador y alias
  bash explora.sh telegram           Configurar secretos Telegram
  bash explora.sh arca               Configurar ARCA y certificado/clave
  bash explora.sh routes             Configurar rutas automáticas (opcional)
  bash explora.sh check              Pruebas completas + build (requiere npm)
  bash explora.sh check-offline      Pruebas sin servicios ni dependencias cloud
  bash explora.sh preview            Vista local sin autenticación real
  bash explora.sh deploy             Publicación con confirmación explícita
  bash explora.sh doctor             Diagnóstico de acceso (solo lectura)
  bash explora.sh migrate-pdfs       Simulación de conversión histórica
  bash explora.sh migrate-pdfs --apply [--restart]  Conversión confirmada
  bash explora.sh backup             Copia LOCAL del código; no de la base
  bash explora.sh help               Esta ayuda
No hace git push, no borra colecciones y no reutiliza credenciales del proyecto anterior.
HELP
}
main() {
  case "${1:-menu}" in
    install) dependencies;node tools/validate-project.mjs;;
    configure) configure;; admin) admin;; telegram) telegram;; arca) arca;; routes) routes;;
    check) check;; check-offline) node22;npm run syntax;npm run test:offline;npm run build;;
    preview) node22;npm run build;say "Vista: http://localhost:8080/preview.html (datos ficticios, no escribe en Firebase). Ctrl+C para salir.";python3 -m http.server 8080 --bind 0.0.0.0;;
    deploy) deploy;;
    doctor) node22;need_dependencies;credentials;node tools/cloud-admin.mjs doctor "$(project_id)";;
    migrate-pdfs) shift;migrate "$@";; backup) backup;; help|--help|-h) help_text;;
    menu)
      while true; do
        help_text
        ask $'\nAcción (install/configure/admin/telegram/arca/check/preview/deploy/doctor/migrate-pdfs/backup/salir): '
        [[ "$REPLY" == salir || -z "$REPLY" ]] && return
        [[ "$REPLY" =~ ^(install|configure|admin|telegram|arca|routes|check|check-offline|preview|deploy|doctor|migrate-pdfs|backup)$ ]] || { say "Acción desconocida.";continue; }
        bash "$ROOT/explora.sh" "$REPLY" || say "Revisá el mensaje anterior. No se continuó automáticamente."
      done;;
    *) help_text;fail "Acción desconocida: $1";;
  esac
}
main "$@"
