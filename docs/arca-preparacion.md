# Preparación de facturación ARCA

Este documento describe la preparación histórica `arca_preparation_v1`.
Para la integración actual `arca_c_v1`, su estado y los pasos de activación,
consultar [arca-integracion.md](arca-integracion.md).

Los nuevos cobros guardan `invoiceRequest` con fecha, recorrido real, kilómetros,
trayecto nacional/internacional y medio de pago. El formulario habitual no pide
nombre, documento ni condición de IVA del pasajero salvo que se active
«El pasajero pide factura a su nombre». Al activarla se guardan esos datos
en el borrador; al desactivarla no se incluyen. Antes de emitir, la futura
integración deberá evaluar si corresponde identificar al receptor según importe
y tipo de comprobante; no se presupone que todos los clientes sean consumidores
finales. Los datos históricos del cliente se conservan. El servidor
genera un único borrador en `arca_invoice_drafts/{paymentId}`. Relee el cobro
actual en una transacción para tolerar eventos repetidos o fuera de orden;
actualiza correcciones y cancela borradores de cobros eliminados. No modifica
documentos con un estado posterior a preparación. Los cobros anteriores sin
solicitud fiscal no generan borradores.

El escenario actual es monotributo, según lo informado por el titular. Para nuevos
borradores nacionales se propone Factura C (11), sin IVA discriminado. Los
internacionales conservan revisión pendiente: no se asimilan automáticamente a
una factura C ni a una exportación E. No se supone inscripción verificada.
Los kilómetros orientan la revisión, nunca autorizan una exención. El total
fiscal propuesto es el importe completo del servicio: no se suma ni descuenta
la caja chica interna. Efectivo: +100% y +5%; digital: −100% y +5%.

No se generan números fiscales, CAE, PDF fiscal ni códigos QR ficticios.
Los borradores son consultables solo por Admin y escribibles solo por servidor.
No hay envío externo ni facturación automática de los gastos o de los choferes.

## Datos del emisor

Configurar exclusivamente en el entorno privado de Functions:

- `ARCA_ISSUER_REGIME` (`monotributo` por defecto; `general` para futura migración)
- `ARCA_ISSUER_CUIT`
- `ARCA_ISSUER_LEGAL_NAME` (nombre legal, no solo nombre comercial)
- `ARCA_POINT_OF_SALE`

No incluir CUIT personal, certificados, claves privadas o clave fiscal en Git,
en el frontend ni en archivos públicos. Estos valores no habilitan la emisión:
`emissionEnabled` permanece false incluso si se completa el emisor.

## Trabajo pendiente para emitir

1. Confirmar inscripción fiscal, habilitación municipal y relación contractual
   con los taxistas. Definir tratamiento nacional, internacional y operaciones
   gravadas/exentas con respaldo profesional.
2. Seleccionar tipos de comprobante, requisitos actuales del receptor, fechas,
   moneda, punto de venta y demás datos exigidos por ARCA según el caso.
3. Implementar WSAA y el servicio de facturación que corresponda, con claves en
   Secret Manager y certificados separados para homologación y producción.
4. Validar CUIT y condición fiscal; gestionar numeración concurrente por punto
   de venta y tipo, consulta de comprobantes ante respuestas inciertas y
   reintentos idempotentes. Un timeout nunca equivale a rechazo confirmado.
5. Probar autorización y rechazo en homologación. Generar PDF y QR desde datos
   autorizados. Definir contingencias y notas de crédito; nunca borrar o editar
   una factura ya autorizada como si fuese solo un cobro interno.
6. Habilitar producción únicamente tras verificar inscripción, credenciales,
   pruebas, operación y autorización del titular.

Documentación oficial consultada:

- https://www.afip.gob.ar/ws/documentacion/ws-factura-electronica.asp
- https://www.afip.gob.ar/ws/documentacion/wsaa.asp
- https://www.afip.gob.ar/fe/emision-autorizacion/solicitud-autorizacion.asp
- https://www.argentina.gob.ar/normativa/nacional/decreto-280-1997-42701/actualizacion

Requisitos del receptor: https://www.afip.gob.ar/fe/emision-autorizacion/datos-comprobantes.asp

## Gestión interna

El acceso del conductor «Gestión» ofrece Pagar a Explora (impacto −100%) y
Cobrar a Explora (impacto +100%). Se registra el dinero efectivamente entregado
o recibido, con importe, nota opcional y Antes/Impacto/Después. No solicita una
transferencia bancaria ni representa un pedido pendiente de aprobación.
Los movimientos usan `settlement_adjustment`, conservan el historial y no generan
caja chica, ingresos por viajes ni solicitud fiscal. La confirmación es única y
reutiliza el identificador de operación ante reintentos. Los cierres históricos
y la gestión de cierres del administrador conservan su tratamiento anterior.

## Gastos nuevos: regla de saldo confirmada

Los gastos con `receiptFlowVersion: gross_expense_driver_debit_50_v2` suman
el 100% al saldo del chofer; el reintegro resta el 50%. Por ejemplo, desde cero,
50.000 de gasto y −25.000 de reintegro dejan 25.000 a pagar a Explora.
El gasto conserva el color rojo y el reintegro verde, independientemente del signo.
Los registros anteriores conservan su versión y los cierres no se recalculan.

## Activación pendiente (monotributo)

No hay cliente WSAA/WSFE ni credenciales ARCA configuradas en esta aplicación.
El cambio de régimen prepara borradores, no activa facturación real. Se necesita
confirmar nombre legal, CUIT, punto de venta Web Services de monotributo y
certificado asociado al servicio wsfe. Las claves privadas se guardarán solo en
Secret Manager. No se usa la clave fiscal del titular dentro de la aplicación.

Los borradores existentes conservan su régimen al actualizarse. Cambiar
ARCA_ISSUER_REGIME no migra facturas ni valida el tratamiento de IVA del régimen
general: también deberán revisarse tipos de comprobante y configuración fiscal.

Fuente: https://www.afip.gob.ar/facturacion/monotributo/
