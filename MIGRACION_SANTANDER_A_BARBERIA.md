# Migración Santander Main → Barbería Main

## Estado final

**Barbería Main es ahora el frontend principal**, pero utiliza el backend histórico de Santander Main:

- Proyecto Firebase: `explora-control-operativo`
- Authentication: se conservan los usuarios y contraseñas existentes.
- Firestore: se conservan los documentos e IDs existentes.
- Storage: se reutilizan los comprobantes ya cargados.
- Cloud Functions: se incorporó al repositorio nuevo el código completo de Functions de Santander.
- Telegram: se mantienen los mismos triggers, secrets y colecciones del backend histórico.

No se hace una copia destructiva de Firestore a otro proyecto. El frontend nuevo apunta directamente al backend histórico. De esta forma no se pierden IDs, referencias, usuarios ni comprobantes.

## Colecciones operativas utilizadas

La interfaz nueva lee y escribe en las colecciones históricas de EXPLORA:

- `billing_records`
- `gastos`
- `cierres_semanales`
- `uber_weekly_closures`
- `deudas_choferes`
- `prestamos_operativos`
- `usuarios`
- `choferes`
- `login_aliases`

Las demás colecciones del proyecto permanecen intactas y siguen disponibles para las Cloud Functions históricas.

## Compatibilidad añadida

Barbería Main normaliza los distintos nombres de campos utilizados por versiones anteriores (monto, fecha, comprobante, UID y nombre del chofer). Los movimientos nuevos se guardan con los campos modernos y también con los aliases que necesitan las funciones históricas.

Los cobros digitales nuevos usan el método genérico `digital`. Las Functions fueron adaptadas para reconocerlo como cobro digital y exigir/usar comprobante en Telegram.

Los movimientos internos de compensación/cierre quedan marcados para que no se contabilicen dos veces ni generen caja chica o avisos de Telegram incorrectos.

## Telegram

Se conservan, entre otras, estas funciones:

- `notifyBillingRecordV2`
- `notifyExpenseV2`
- `notifyAdminDebtPaymentTelegramV1`
- `notifyAdminDriverDebtTelegramV1`
- `notifyClosureTelegramGroupV1`
- `notifyUberClosureTelegramGroupV1`

Los secrets siguen siendo:

- `TELEGRAM_BOT_TOKEN`
- `TELEGRAM_CHAT_ID`

No se incluye el token del bot dentro del código ni dentro del ZIP.

## Importante antes de retirar Santander Main

No borres el proyecto Firebase `explora-control-operativo`. Lo que se retira es el frontend/código viejo de Santander Main. Ese proyecto Firebase pasa a ser también el backend permanente de Barbería Main.

Si se borrara `explora-control-operativo`, se perderían justamente los datos históricos que esta migración está preservando.
