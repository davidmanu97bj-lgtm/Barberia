# Informe de revisión · Explora 3.0.0

Fecha: 15 de septiembre de 2026. Base: ZIP `santander-main (2).zip`. Alcance: cambios locales, sin publicar en el repositorio ni en Firebase.

## Ejecutado

**164 pruebas automatizadas aprobadas, cero fallos**, con Node 22.16.0, usando `bash explora.sh check-offline`. Incluyen validación de recursos, build de Hosting y sintaxis de 53 archivos JavaScript/MJS y del gestor SH.

Se verificaron el resultado exacto del ejemplo ($15.150 a favor del chofer), coherencia entre pantalla del chofer, administrador y cálculo del backend/Telegram, efectivo/digital/Uber/gastos, cierres y cortes históricos, pagos, deudas, adelantos, gastos superiores a ingresos, centavos y 2.000 escenarios de conservación de fondos. Las pruebas financieras ejecutan funciones reales, con datos sintéticos.

Hashes SHA-256 cotejados contra el ZIP original: ambos archivos del logo intactos; funciones `sortUnifiedReceipts`, `visibleReceiptRows`, `receiptGroupKey` y `receiptBalanceSnapshot` intactas. No se reordenaron ni modificaron registros en una base real.

Se ejecutaron `index.html` y `app.js` reales en Chromium, **con Firebase/Auth/Storage y funciones remotas simuladas**. El extracto dio el saldo esperado, el botón de factura abrió el circuito de un PDF válido y la función real de carga guardó primero un JPEG y luego un PDF, con rutas y tipos MIME distintos. Sin errores JavaScript; la navegación externa del navegador de pruebas está bloqueada, por lo que los recursos locales se inyectaron sin cambiar la fuente entregada.

Se verificaron anchos de 320, 390, 768 y 1280 píxeles: sin desbordamiento horizontal y con los cinco botones de navegación dentro de la pantalla. La reproducción visual y las conversiones no prueban permisos reales de Firebase.

Se convirtieron imágenes de prueba JPG, PNG y WebP mediante el conversor real. Los PDFs resultantes abrieron con un lector independiente, tenían una página y una imagen embebida, y se renderizaron para comprobar legibilidad y ausencia de recortes. La conversión PNG/WebP usó Sharp 0.34.1 disponible en el entorno de prueba. Las pruebas de migración comprobaron idempotencia, bucket/titular, rutas inválidas y conservación de importe, fecha y objeto original.

Los avisos Telegram se probaron con una API simulada: envío como foto, actualización de leyenda tras autorización, reintento y prevención de duplicados. **No se enviaron imágenes ni mensajes reales.**

Se comprobó la coherencia del lockfile: todas las dependencias y dependencias opcionales tienen entradas compatibles. Se revisó `git diff --check`. El build contiene solo la lista explícita de archivos web; no publica los secretos ni el código privado del backend. No se encontraron claves privadas, archivos de cuenta de servicio ni tokens de bot incrustados en el paquete.

## No ejecutado en este entorno

La descarga de dependencias npm no estaba disponible en el entorno de trabajo. Por ese motivo no se ejecutaron estas cuatro suites, que requieren los SDKs/librerías externos:

- `functions/tests/arca-integration.test.js`
- `functions/tests/uber-proof-ocr.test.js`
- `functions/tests/uber-submission.test.js`
- `tests/uber-schedule-proof.test.mjs`

No se ocultaron: el modo offline imprime expresamente la exclusión. **`bash explora.sh check`, `deploy` y GitHub Actions ejecutan las suites completas después de instalar el lockfile.** Un fallo detiene la publicación.

No se ejecutaron emuladores de reglas, autenticación con cuentas reales, despliegue en Cloud Functions, emisión/consulta contra ARCA, llamadas a Telegram ni conversión masiva de Storage real. La configuración de credenciales y los servicios habilitados del Firebase elegido deben verificarse allí. No es una certificación fiscal ni una garantía de ausencia absoluta de errores.

## Cambio de reglas y pruebas históricas

Las pruebas que exigían conservar el esquema viejo 100% + 5%, o prohibían cualquier cambio de cálculo, no corresponden a esta solicitud. Se conservaron como texto en `tests/legacy-v2` y se sustituyeron por pruebas de la nueva fórmula y de preservación de históricos. El resto de las regresiones permanece activo. Los cambios nuevos no alteran las imágenes originales del logo.

## Comprobación final en destino

Primero instalar dependencias y correr `check`. Luego comprobar `doctor`, el usuario administrador, un chofer, el acceso a PDF propio/ajeno y los estados pendientes. En homologación, registrar un efectivo, un digital y un gasto con imagen; comprobar el saldo y las fotos de Telegram contra sus importes. Confirmar también un pago de liquidación para que no sea contado como venta. Solo después habilitar la emisión fiscal real que corresponda.
