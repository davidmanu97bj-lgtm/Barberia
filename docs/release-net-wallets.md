# Publicación de billeteras netas

Proyecto existente: `explora-control-operativo`. Mantener Firebase Auth y los perfiles existentes.

## Saldo inicial

`functions/balance-migration.js` crea una fotografía firmada por el proceso administrativo en `billing_records` y su auditoría en `balance_migrations`, con identificador determinista. No modifica ni elimina registros anteriores. Usa el mecanismo histórico de saldo anclado para conservar el signo: positivo significa deuda del chofer; negativo significa deuda de Explora.

La fotografía excluye las deudas administrativas aún abiertas porque estas siguen en `deudas_choferes`. Así se conservan sus comprobantes, pagos parciales y condiciones, sin sumarlas dos veces. El importe trasladado aparece en Deudas como saldo anterior. No genera factura, caja chica ni aviso de pago.

Cada migración relee los documentos en una transacción, exige que el saldo coincida con el saldo verificado y comprueba que el resultado no cambie. Los reintentos no crean duplicados. Si entró un movimiento nuevo, se debe volver a revisar ese chofer.

## Secuencia

1. Guardar copia privada de perfiles, aliases, documentos financieros, configuración fiscal, usuarios de autenticación y versión de Hosting.
2. Comparar los saldos calculados con `team_realtime_balances.settlementBalance` y ensayar migración/cierre sobre la copia.
3. Ejecutar `node tools/check.mjs` y validar reglas en Firebase.
4. Publicar Functions y reglas; mantener los secretos existentes de Telegram y ARCA, y configurar Google Maps en Secret Manager.
5. Ejecutar la migración administrativa sobre los saldos recién verificados, antes de publicar Hosting.
6. Publicar Hosting y comprobar login, consulta de billeteras, estado fiscal, Maps, Telegram, usuarios y saldos.

No emitir facturas fiscales ni registrar pagos ficticios durante la verificación en producción. Las pruebas de cierres y concurrencia usan un almacén aislado.

## Recuperación

La versión anterior de Hosting se registra antes de publicar. Si falla la web, volver a publicar esa versión. No borrar comprobantes ni movimientos posteriores al lanzamiento.

La fotografía inicial mantiene el formato que ya entiende la aplicación anterior. Una reversión de la web no debe invertir ni duplicar saldos. Para deshacer una migración de datos se requiere comprobar primero que no existan operaciones posteriores y conservar su auditoría; no hacerlo automáticamente después de que los choferes hayan comenzado a operar.

El rediseño del administrador y el control mensual de patente, seguro y canon quedan fuera de esta publicación.
