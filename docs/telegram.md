# Avisos operativos de Telegram

El resumen muestra tipo de operación, chofer, recorrido o semana cuando corresponde, importes y saldo final: «Chofer debe», «Explora debe» o «Cuenta al día». Se omiten fecha/hora redundantes, explicaciones del reparto y cálculos repetidos.

- Cobros nuevos: bruto y caja chica del 5%, seguidos del saldo final. Se omite la línea «Total con caja»; los cálculos conservan efectivo +105% y digital −95%.
- Gastos: importe completo en rojo y reintegro del 50% en verde.
- Pagar/cobrar a Explora: importe y saldo, sin caja chica ni emisión fiscal.
- Uber directo: ganancia semanal, caja chica y saldo final. Los avisos de revisión históricos mantienen su flujo anterior.
- Calendario: un aviso de viaje agendado con chofer, día y detalle; si ya había otro viaje activo ese día, un segundo aviso de coincidencia en «Todos», con una lista numerada que incluye chofer, día y detalle de cada viaje coincidente, incluido el nuevo. No incluye el campo teléfono. Las listas muy largas se dividen en páginas para respetar el límite de Telegram. Ver `calendario.md`.

Las fotos de gastos, gestión y Uber se adjuntan debajo del resumen usando `show_caption_above_media`. Para cobros con solicitud fiscal, `sendRichMessage` organiza texto, foto (si existe) y PDF como último bloque del mismo mensaje. Si ARCA aún no autorizó, el aviso indica factura pendiente. `notifyArcaInvoiceTelegramV1` edita ese mismo mensaje al autorizarse y añade el PDF generado por `arca-pdf.js`. No emite ni reemite comprobantes y no adjunta documentos de homologación como facturas reales.

El nombre del PDF es corto: `FC-2-123.pdf`, igual en Telegram y en la descarga desde Perfil. Se conserva `PRUEBA-` para descargas de homologación. La caja chica no se suma al importe fiscal.

Ambos eventos comparten la misma clave de operación y un bloqueo temporal en `telegram_notifications`. La autorización reintenta si el primer envío está en curso; un reintento normal conserva el identificador del mensaje. Un error al generar el PDF conserva el aviso y reintenta adjuntarlo. Los mensajes antiguos ya enviados no se reformatean. Como en cualquier envío remoto, una caída después de que Telegram acepte el mensaje pero antes de guardar su ID requiere conciliación; no hay una garantía absoluta de entrega exactamente una vez.

Referencia de la API: [Telegram Bot API](https://core.telegram.org/bots/api#sendrichmessage). Para publicar, usar el flujo de despliegue de `README.md` con backend y hosting del mismo commit; no los ZIP históricos. Se verifican formato, reintentos, carreras entre eventos, generación fallida del PDF, permisos y saldos con pruebas locales, sin mensajes artificiales al grupo ni facturas de prueba en producción.
