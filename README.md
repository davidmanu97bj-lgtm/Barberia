# Explora

Fuente del código: https://github.com/davidmanu97bj-lgtm/santander.
Backend y Hosting de producción: `explora-control-operativo`.

La aplicación actual empieza en `index.html`, carga `app.js` y `styles.css`, y usa
`manifest.json` y `service-worker.js`. El código segmentado antiguo se conserva;
sus pruebas de contrato no significan que esos archivos estén en la web publicada.

## Trabajar desde Codex o Work

Usar Node.js 22 (`nvm use` donde nvm esté instalado). Crear una rama por cambio desde
`main`; al pasar a otra herramienta, guardar y subir los cambios e indicar URL,
rama y commit completo. La siguiente sesión debe obtener esa misma rama.
Los ZIP son exportaciones, no el origen desde el cual resolver diferencias de Git.

```sh
npm ci --prefix functions --ignore-scripts
npm test
npm run build
```

`npm test` valida recursos y configuración, comprueba sintaxis y ejecuta todas las
pruebas de `tests/` y `functions/tests/`. Cualquier fallo devuelve un código distinto
de cero. El proyecto raíz no necesita dependencias npm para estas comprobaciones.
`npm run test:unit` ejecuta solamente las pruebas; `npm run test:release` usa las
mismas comprobaciones completas que `npm test`.

Se consolidaron las pruebas de Functions en `functions/tests/`: las dos copias
idénticas y la suite antigua de saldo en `functions/test/` fueron reemplazadas por
los contratos actuales (50% + 5% de caja chica, sin reiniciar el histórico al cerrar).
Los cálculos de la aplicación y el backend no se cambiaron. La vista previa se
prueba ejecutando sus funciones puras reales, sin conectar Firebase.

Los antiguos comandos `test:mileage` y `test:admin-production` apuntaban a archivos
inexistentes y ya no se ofrecen. Las pruebas automáticas no certifican por sí solas
el login, permisos de Firebase o una operación real de negocio.

## Revisar e integrar

Abrir un pull request a `main`. El workflow **Validar Explora** usa Node 22 y no
despliega. Configurar posteriormente protección de `main` y exigir el check
**Node 22 · pruebas y Hosting** antes de integrar. Esa protección es una opción
del repositorio: este cambio de código no la activa por sí mismo.

Antes de producción, comprobar los flujos de negocio con emuladores o un entorno
de pruebas. Los identificadores actuales apuntan a producción; una URL de preview
por sí sola no aísla los datos.

## Desplegar una versión revisada

Desde una copia Git limpia y actualizada, con Node 22, npm, Git, tar y acceso
autorizado al proyecto Firebase:

```sh
# Solo comprueba. No publica ni modifica Git.
npm run deploy

# Después de revisar e integrar el cambio en main:
npm run deploy -- --deploy <SHA_COMPLETO_DE_MAIN>
```

El segundo comando exige que el commit solicitado sea tanto `HEAD` como `main`
en GitHub, comprueba el remoto y rechaza cambios locales sin confirmar. Exporta
ese commit a una carpeta temporal y valida, prepara y publica esa copia fija.
Nunca crea commits, hace push ni fusiona historiales. Si no puede comprobar GitHub,
si falla una prueba o una etapa de Firebase, se detiene.

El CLI está fijado a `firebase-tools@15.30.0` y se ejecuta mediante npm exec. No se
actualiza automáticamente a `latest`. No se usa `--force`; si se requiere eliminar
una Function, se debe revisar como una operación separada. Se reutiliza la sesión
o identidad autorizada de Firebase, sin pedir ni guardar tokens en el repositorio.

Para el primer despliegue de funciones con reintentos, añadir `--interactive` al
comando de publicación permite confirmar esa política en la terminal. Solo la
etapa de Functions admite esas preguntas; se mantienen las comprobaciones de Git,
pruebas y copia fija. No aceptar borrados ni migraciones de eventos sin revisarlos.
Si la carga local de Functions supera 10 segundos, establecer
`FUNCTIONS_DISCOVERY_TIMEOUT=60` en el entorno de esa ejecución.

Por defecto publica reglas, Functions y Hosting, en ese orden. Los alcances
opcionales `--only hosting` y `--only backend` permiten una entrega parcial explícita.
Firebase no publica todos los servicios de forma atómica: `.deploy/release-*.json`
registra el commit y cada etapa completada, incluso cuando falla una posterior.
Hosting incluye `release.json` con el commit y las huellas de sus recursos.

Todos los accesos históricos (`DESPLEGAR_EXPLORA_COMPLETO.sh`, `He.sh` y los tres
scripts de `tools/`) invocan este mismo procedimiento. **Sin argumentos ahora solo
validan**, incluidos los scripts antiguos de migración y v4144. Para publicar hay
que pasar expresamente `--deploy <SHA>`. Las notas de entregas antiguas son históricas;
este documento reemplaza sus instrucciones de publicación.

`firebase.json` publica exclusivamente `dist/`, generado por `npm run build`; ya no
publica toda la raíz. El procedimiento de despliegue lo reconstruye dentro de la
copia fija. No usar `firebase deploy` directamente como sustituto del procedimiento,
pues omitiría sus comprobaciones de Git y de pruebas.

GitHub Pages continúa configurado como antes. Elegir una dirección oficial y migrar
los accesos existentes requiere un paso posterior. Este cambio no modifica Pages,
los permisos de GitHub, la base de datos ni las reglas o Functions en producción.
