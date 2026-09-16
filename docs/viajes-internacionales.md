# Facturación de traslados internacionales

Definición operativa indicada por el titular el 13/09/2026: Factura C para los
viajes internacionales de Explora mientras permanece en monotributo. Esta
instrucción reemplaza la espera de definición registrada inicialmente; no se
presenta como una consulta vinculante ni una confirmación individual de ARCA.

## Emisión actual

La integración utiliza WSFE, Factura C (código 11), en pesos, por el importe
completo del servicio, tanto efectivo como digital. La caja chica no forma parte
de la factura. Se conserva la clasificación internacional y el recorrido real
en el registro fiscal inmutable y en el PDF. El PDF solo se habilita cuando ARCA
autoriza el comprobante y devuelve el CAE.

Además de la activación general, el servidor requiere en `arca_settings/current`:

- `internationalInvoiceType: 11`.
- `internationalActiveFrom`: fecha y hora ISO de activación.

Se compara esa fecha con `createdAt` del servidor. Los cobros anteriores, sin
fecha de servidor y las solicitudes que ya estaban en revisión no se reenvían
automáticamente. La cola conserva su protección contra duplicados y la
conciliación por consulta si se pierde la respuesta de ARCA.

Las pruebas cubren efectivo y digital, Brasil y Paraguay, importe bruto, CAE,
PDF, duplicados, activación, registros anteriores y cambio de régimen.

## Futuro cambio a régimen general

El titular prevé usar Factura B para sus pasajeros consumidores finales cuando
se registre como responsable inscripto. Ese cambio todavía no está activado:
requiere actualizar punto de venta, tipo, tratamiento de IVA, datos del receptor,
validaciones, PDF y QR. El servidor detiene la emisión C si cambia el régimen.
Los comprobantes históricos conservarán su tipo y CAE originales.

No corresponde fijar B para todos los receptores: pueden corresponder A u otros
tipos según la operación. La exención de un servicio y el tipo de comprobante
son definiciones diferentes. Las operaciones encuadradas como exportación
requieren E y no están implementadas por este cliente WSFE.

## Fuentes oficiales consultadas

- [ARCA: comprobantes de monotributistas](https://www.arca.gob.ar/facturacion/monotributo/comprobantes.asp).
- [ARCA: clases de comprobantes y receptores](https://www.arca.gob.ar/facturacion/regimen-general/comprobantes.asp).
