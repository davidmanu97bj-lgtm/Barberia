# Explora — SOLO colores y arranque del login

Base: ZIP original `santander-main (79).zip`, árbol Git
`3c7ecd8c11f84dc3766cada83329c57412bde961`. La consulta del repositorio durante
esta entrega confirmó `main=63a3ba1a7711f925fa7771956288abafe4ccd78a` con ese árbol.
No se utiliza el paquete de saldos confirmados como base.

## Cambios

| Operación | Color |
|---|---|
| Cobro digital | Verde |
| Caja digital | Rojo |
| Cobro efectivo | Rojo |
| Caja efectivo | Rojo |
| Gasto 50/50 | Rojo |
| Reintegro | Verde |
| Gasto 100% Explora | Verde |
| Gasto 100% chofer | Rojo |
| Pagar a Explora | Verde |
| Cobrar a Explora | Rojo |

Se aplican a iconos, importes, impactos, acentos de las acciones, formularios,
confirmaciones, historial y revisión administrativa de la entrada actual.
El saldo general y Antes/Después conservan su criterio original. Los archivos
históricos que index.html no carga se conservan sin modificar. No se cambia
Telegram ni otros servicios externos; esta entrega es exclusivamente del navegador.

Los importes, signos, porcentajes, comprobantes, orden del historial y fórmulas NO
cambian. Tampoco se introduce el sistema Saldos seguros, activación, nuevas cuentas,
colecciones, ni una transacción financiera diferente. Los cuatro handlers de
login/cobro/gasto/Gestión y 272 declaraciones de funciones conservan sus textos.
Toda la carpeta functions, Rules, índices, firebase.json, firebase-config.js,
styles.css, service-worker.js y package.json permanecen idénticos al original.

Auth comienza en un módulo pequeño antes de que termine de cargar el panel. Se
elimina la inicialización de popups/redirecciones no usados y la segunda selección
de persistencia. Mantiene recuperación local, IndexedDB, sesión y memoria como
alternativas. Se solapan las consultas heredadas UID/email cuando faltan los dos
perfiles directos, manteniendo prioridad de UID, roles y desactivación. Las
conexiones a Auth/Firestore se preparan antes mediante preconnect. El bloqueo de
operaciones hasta sincronizar el historial permanece EXACTAMENTE como antes.

Esto reduce trabajo evitable. No es una medición de velocidad en un iPhone o Android
físico ni garantiza una cantidad de segundos; una red lenta, consultas de datos o
latencia del servidor pueden seguir afectando el tiempo de ingreso.
Fundamento: https://firebase.google.com/docs/auth/web/custom-dependencies

## Actualizar con un solo archivo

El archivo `EXPLORA_SOLO_COLORES_LOGIN.sh` contiene el parche y su verificación de
integridad. Subir SOLAMENTE ese .sh a la carpeta principal de Cloud Shell y ejecutar:

```bash
cd ~
bash EXPLORA_SOLO_COLORES_LOGIN.sh
```

Cuando solicite confirmación, escribir `ACTUALIZAR WEB`.
Trabaja en una copia nueva en /tmp, compara el árbol de main con la base original o
esta misma entrega, aplica solo la lista autorizada de archivos, ejecuta las 85
pruebas seleccionadas y compila. Prepara un respaldo de código, hace commit/push
sin forzar y publica ÚNICAMENTE Hosting. Reutiliza Node 22 y Firebase CLI 15.30.0
ya instalados. No instala módulos de npm, Java ni emuladores; no usa gcloud.

Los accesos ya autorizados de GitHub y Firebase deben seguir vigentes. Si no puede
leer el repo, usar la CLI o acceder al proyecto, explica el problema y se detiene.
No otorga IAM, no escribe Firestore ni exige activar cuentas. Si main tiene otros
cambios, se detiene en lugar de pisarlos. No ejecutar los instaladores anteriores.

Si GitHub se actualiza pero Hosting falla, repetir este mismo archivo: reconoce el
árbol de esta entrega y no crea otro commit innecesario. No supone que subir Git
publique Firebase. No hay garantía de rapidez de red para clonar/publicar Hosting.

Un deploy de Hosting cambia la web pública. Coordinar que no se estén confirmando
formularios al recargar. Al terminar, cerrar y volver a abrir Explora. Comprobar
login, colores y los valores existentes; no crear movimientos ficticios en cuentas
reales. No es necesario revisar/activar cuentas: esta versión NO las incorpora.

## Deshacer únicamente esta entrega

El mismo archivo permite regresar el frontend y GitHub a la base original de esta
entrega, sin desplegar Functions ni Rules:

```bash
bash EXPLORA_SOLO_COLORES_LOGIN.sh --volver
```

Pide `VOLVER WEB ORIGINAL`. Solo acepta una copia remota con el árbol original o
con el árbol de esta entrega: si hubo modificaciones posteriores, no las borra.
Conserva un nuevo commit y el historial; no usa --force. La reversión elimina solo
los archivos frontend/pruebas/documentación añadidos por esta entrega.

## ZIP completo

`EXPLORA_ORIGINAL_MAS_COLORES_LOGIN.zip` conserva el proyecto entero original y estos
cambios. Sirve de respaldo o para edición; no hace falta subirlo además del .sh.
No subir el ZIP como único archivo a GitHub. La raíz del repo es el contenido de
`santander-main/`, no una carpeta anidada. No usar `npm run deploy` para esta entrega:
ese comando original despliega otros servicios. La actualización manual del
frontend es `npm run build` y `firebase deploy --project explora-control-operativo
--config firebase.json --only hosting`, desde la copia correcta y revisada.
Referencia: https://firebase.google.com/docs/hosting/quickstart

## Pruebas y límites

85 pruebas seleccionadas de login, colores, regresión financiera, carga, historial,
cálculo original y empaquetado de Hosting: aprobadas. Pruebas visuales de los diez
colores y formularios en Chromium con 390, 412 y 1280 píxeles: aprobadas. Cuatro
recorridos de arranque en navegador con SDK simulado y red externa bloqueada:
login por clave, sesión existente, usuario inactivo y administrador; aprobados.
No equivalen a usar Firebase real ni Safari/Android físico.

La instalación de dependencias del backend no pudo completarse en el entorno de
entrega por conectividad EAI_AGAIN. No se presenta la suite completa del backend
como aprobada. El backend no se modifica ni se despliega en esta entrega. El
instalador exige las pruebas seleccionadas sin red, pero no descarga el emulador.
No se publicaron cambios en tu GitHub ni Firebase al preparar estos archivos.
