# Factura C automática: implementación y activación

Estado al 13/09/2026: integración desplegada y activada para cobros nacionales,
con comprobantes autorizados en producción. Antes de activar se probaron dos
Facturas C en homologación, con certificado separado y autorización WSFE.
La extensión a internacionales se controla con una fecha de activación propia;
ver [la definición y configuración internacional](viajes-internacionales.md).

## Alcance

Los cobros nuevos `arca_c_v1`, en efectivo o digital, solicitan Factura C (11) por
el **importe completo del servicio**, sin discriminar IVA. La caja chica del 5%
es interna y no modifica la factura. Gastos y operaciones de Gestión no emiten
comprobantes de venta. Los cobros históricos no se facturan retroactivamente.

Están implementados servicios nacionales e internacionales en pesos y emisor
monotributista. Los internacionales requieren `internationalInvoiceType: 11` y
`internationalActiveFrom`, según la definición C indicada por el titular.
Sin esa configuración se guardan para revisión. No se convierten en nacionales.
Pasar a régimen general requiere implementar y verificar el tratamiento fiscal
correspondiente; cambiar una etiqueta no basta.

El servicio WSFE autoriza importes y datos fiscales, pero no recibe el texto del
recorrido como renglón de la factura. El detalle del viaje se conserva en el
registro inmutable y en el PDF entregado al pasajero. No se afirma que ARCA haya
recibido ese detalle textual. La distancia guardada no acredita por sí sola
una exención tributaria.

## Flujo y protección contra duplicados

1. Confirmar el cobro guarda una operación con identificador persistente.
2. `queueArcaInvoice` crea una solicitud inmutable con ese mismo identificador.
3. `issueArcaInvoice` valida el punto de venta, consulta el último número y guarda
   el número asignado antes de enviar `FECAESolicitar`.
4. Una transacción de Firestore bloquea la serie CUIT/ambiente/punto/tipo.
5. Una respuesta autorizada guarda CAE y vencimiento. Solo entonces se permite PDF.
6. Si se pierde la respuesta, se consulta ese mismo número con `FECompConsultar`.
   Nunca se vuelve a emitir automáticamente una solicitud incierta.

Un rechazo explícito y completo libera la serie. Una respuesta ambigua, un número
con otros datos o una caída entre reservar y enviar mantienen la serie bloqueada
para evitar duplicados. El proceso programado intenta conciliar cada cinco minutos.
**Un bloqueo que no se resuelve consultando requiere revisión operativa**; no hay
botón de reenvío ni emisión automática de notas de crédito en esta versión.

El punto de venta debe ser exclusivo de esta integración. Compartirlo con otro
facturador invalida la garantía de numeración. Los campos fiscales de cobros nuevos
quedan protegidos contra modificación/borrado desde la app. Los registros fiscales
y sus credenciales quedan excluidos del borrado masivo de choferes.

En Perfil → Facturas de viajes se ve el estado y se descarga el PDF autorizado.
El cobro guardado y la factura autorizada son estados diferentes. Los estados
`disabled`, `review`, `rejected` y `uncertain` no representan una factura emitida.

## Configuración privada

Documento Firestore `arca_settings/current`, accesible exclusivamente por servidor:

```json
{
  "enabled": false,
  "environment": "homologation",
  "regime": "monotributo",
  "cuit": "CUIT_VERIFICADO_SIN_GUIONES",
  "legalName": "NOMBRE_LEGAL_VERIFICADO",
  "pointOfSale": 2,
  "address": "DOMICILIO_FISCAL_VERIFICADO",
  "grossIncomeId": "INSCRIPCION_O_CONDICION_IIBB_VERIFICADA",
  "activityStart": "AAAA-MM-DD",
  "activeFrom": "FECHA_HORA_ISO_DE_ACTIVACION",
  "exclusivePointOfSale": false,
  "homologationPassed": false,
  "registrationVerified": false,
  "consumerIdentificationLimit": 10000000
}
```

Completar datos con respaldo fiscal. El inicio de actividades y la inscripción
o condición de Ingresos Brutos son datos para el comprobante; no se inventan.
`enabled` y `exclusivePointOfSale` deben ser verdaderos para trabajar. Producción
además exige `homologationPassed` y `registrationVerified`. La fecha de activación
debe estar definida; se compara con `createdAt` del servidor, no con el reloj del teléfono.
Configurar primero con `enabled: false`; el estado inicial nunca activa emisión.

Secret Manager, solo para las funciones emisoras:

- `ARCA_CERTIFICATE`: certificado público PEM del ambiente seleccionado.
- `ARCA_PRIVATE_KEY`: clave privada PEM que corresponde al certificado.

Usar `firebase functions:secrets:set NOMBRE --data-file RUTA_PRIVADA` con la cuenta
autorizada; no pegar secretos en comandos, logs o chat. Nunca guardar credenciales
en Git, Hosting, variables del navegador o documentos que el cliente pueda leer.
`arca_tickets` guarda tickets de corta duración, únicamente en el servidor.

Homologación y producción usan certificados distintos. Para homologación utilizar
un proyecto Firebase de pruebas aislado con datos sintéticos. No probar cargos
ficticios contra producción. El PDF de homologación dice SIN VALIDEZ FISCAL y no
incluye un QR de consulta de producción.

## Procedimiento de activación y recuperación

1. Confirmar uso exclusivo del punto de venta 2 para esta integración. Los datos
   del emisor se obtuvieron de RUT y de Datos Adicionales del Comprobante en ARCA;
   la configuración preparada permanece privada, fuera del repositorio.
2. Revisar y publicar el commit validado con el flujo del repositorio. El despliegue
   incluye reglas, índices de Firestore, funciones y Hosting. Verificar que el índice
   de la cola está listo y que los secretos están vinculados a las funciones.
3. Configurar producción desactivada, verificar conexión y luego fijar `activeFrom`
   y activar. No volver a encolar en bloque los registros anteriores a esa fecha.
4. Verificar el primer viaje real autorizado. Mantener visibles y atender las
   solicitudes pendientes/rechazadas; si se desactiva, los cobros siguen guardándose
   pero deben tratarse por el procedimiento fiscal de contingencia del titular.

No usar la clave fiscal personal en el código. No emitir notas de crédito ni
anular facturas mediante eliminación del cobro: esas operaciones requieren una
implementación específica o el procedimiento autorizado por el titular.

## Validación local

Con Node 22: `npm ci --prefix functions --ignore-scripts`, luego `npm test`.
Pruebas de autorización simulada, bruto fiscal, receptor, rechazos, concurrencia,
respuesta perdida, conciliación, XML, separación de ambientes y PDF autorizado.
Además se verificaron 21 controles de permisos y funciones contra emuladores.

## Homologación comprobada

Con certificado emitido por WSASS y autorizado para WSFE se autenticó por WSAA,
se emitió una Factura C sintética en efectivo por $1 y se recuperó por consulta.
Después el procesador real, usando un proyecto Firestore de emulador separado,
emitió una Factura C digital sintética por $7,50. Se simuló la pérdida de la
respuesta: el siguiente intento recuperó el mismo CAE por consulta, y un tercer
intento no volvió a emitir. Hubo una sola llamada de autorización para ese cobro.
Se generaron los PDF de ambos comprobantes con la leyenda SIN VALIDEZ FISCAL.

En este ambiente, `FEParamGetPtosVenta` devolvió exclusivamente el error 602
(Sin Resultados), aunque ARCA autorizó los comprobantes del punto 2. El procesador
tolera esa respuesta concreta solo en homologación. En producción sigue siendo
obligatorio verificar que el punto exista y esté habilitado; una prueba automatizada
comprueba que el mismo error no permita emitir en producción. Los rechazos se
cubren con pruebas simuladas, no con una emisión rechazada deliberadamente en ARCA.

Las evidencias completas y credenciales permanecen en almacenamiento local privado,
fuera de Git y Hosting. Ningún comprobante de estas pruebas tiene validez fiscal.

## Fuentes oficiales verificadas

- [Facturación de monotributistas](https://www.afip.gob.ar/facturacion/monotributo/)
- [WSAA y ambientes](https://www.afip.gob.ar/ws/documentacion/wsaa.asp)
- [Manual WSFE v4.7](https://www.afip.gob.ar/ws/documentacion/manuales/manual-desarrollador-ARCA-COMPG.pdf)
- [Datos del receptor](https://www.afip.gob.ar/fe/emision-autorizacion/datos-comprobantes.asp)
- [Especificación QR](https://www.afip.gob.ar/fe/qr/documentos/QRespecificaciones.pdf)
