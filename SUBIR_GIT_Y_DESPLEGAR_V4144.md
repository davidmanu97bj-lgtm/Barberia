# EXPLORA v4144: subir a Git y desplegar

Este ZIP es incremental: contiene solamente los archivos nuevos o modificados de v4144 y dos archivos auxiliares. Debe aplicarse sobre la raiz del repositorio existente; no es un repositorio completo.

## 1. Aplicar el paquete

Comprobar primero que no haya trabajo local pendiente:

```bash
cd /ruta/al/repositorio
git status --short
```

Si el comando muestra cambios, guardarlos o confirmarlos antes de continuar. Luego extraer el paquete sobre la raiz del repositorio:

```bash
unzip -o /ruta/al/explora-v4144-archivos-modificados-para-git.zip -d .
```

El ZIP no crea una carpeta superior: `index.html`, `functions/`, `js/`, `css/`, `tests/` y `tools/` quedan directamente en sus ubicaciones correctas.

## 2. Validar

```bash
git diff --check
node tests/financial-receipt-actions.test.mjs
node tests/admin-debt-ledger.test.mjs
node tests/admin-debt-payment.test.mjs
node tests/admin-debt-menu-release.test.mjs
node tests/billing-driver-payment.test.mjs
node --test functions/test/*.test.js
```

Todos los comandos deben terminar sin errores.

## 3. Subir a Git

Revisar el cambio antes de confirmarlo:

```bash
git status --short
git diff --stat
```

Agregar los archivos de esta version:

```bash
git add \
  ARCHIVOS_MODIFICADOS_V4144_PARA_GIT.txt \
  MODIFIED_FILES_V4144_RECEIPTS_EDIT_DELETE.txt \
  SUBIR_GIT_Y_DESPLEGAR_V4144.md \
  css/segments/53-style.css \
  functions/index.js \
  functions/package.json \
  functions/package-lock.json \
  index.html \
  js/core/financial-receipt-actions-core.mjs \
  js/pwa-register.js \
  js/segments/09-script.js \
  js/segments/11-script.mjs \
  js/segments/13-script.mjs \
  js/segments/52-script.mjs \
  package.json \
  service-worker.js \
  tests/admin-debt-menu-release.test.mjs \
  tests/financial-receipt-actions.test.mjs \
  tools/deploy-v4144-cloud-shell.sh

git commit -m "v4144 editar y eliminar comprobantes"
git push
```

Si es una rama nueva sin upstream, usar:

```bash
git push -u origin "$(git branch --show-current)"
```

## 4. Desplegar desde Cloud Shell

La version modifica el frontend y una Cloud Function callable. Por eso se deben publicar **Hosting y Functions**. No cambiaron `firestore.rules` ni `storage.rules`, por lo que no hace falta desplegar reglas.

Desde la raiz del repositorio:

```bash
./tools/deploy-v4144-cloud-shell.sh
```

El script vuelve a ejecutar las validaciones y luego usa exactamente:

```bash
firebase deploy --project explora-control-operativo --only functions,hosting
```

Si Firebase CLI no esta disponible en Cloud Shell, instalarla y volver a ejecutar el script:

```bash
npm install -g firebase-tools
```

Al finalizar, abrir la URL de Hosting mostrada por Firebase y comprobar como administrador que un comprobante de efectivo, uno digital y uno de gasto muestren las acciones **Editar** y **Eliminar**. Comprobar tambien que una cuenta de chofer continue en modo de solo lectura.
