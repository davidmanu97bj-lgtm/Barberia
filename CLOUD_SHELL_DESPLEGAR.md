# Explora: configuración y publicación

Proyecto de producción: `explora-control-operativo`.

Las instrucciones vigentes están en [README.md](README.md). Usar Node 22.
`npm run deploy` solo valida; publicar requiere `--deploy <SHA_COMPLETO_DE_MAIN>`.
Todos los scripts históricos invocan ahora ese mismo procedimiento.

No cambiar de proyecto Firebase para migrar de Codex a Work. La configuración del
cliente y las Functions conservan el backend histórico; los secretos de Telegram
permanecen en Secret Manager. Las pruebas deben aislarse de los datos de producción.
