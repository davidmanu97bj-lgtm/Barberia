# EXPLORA · Movimientos del período · entrega 3.0.0

Proyecto completo preparado a partir de `santander-main (2).zip`, para que el propietario lo suba a `davidmanu97bj-lgtm/Barberia`. Este paquete no ha sido subido ni desplegado por el asistente.

**Entrada recomendada: `bash explora.sh`.** También se entrega un instalador externo `EXPLORA_CLOUD_SHELL.sh` que contiene el proyecto completo y lo extrae en una carpeta nueva. No es necesario editar código ni pegar certificados dentro de archivos JavaScript.

## Atención al destino

El destino incluido es **`barberia-c25a1`**, obtenido de la configuración del repositorio indicado. Este Firebase no es lo mismo que el repositorio GitHub ni que el proyecto anterior de Explora.

Publicar allí reemplaza el Hosting y las reglas de ese destino. Si la barbería debe seguir funcionando, elegí **otro proyecto Firebase** con `configure` antes de publicar. Las colecciones existentes con los mismos nombres pertenecen a esa base: no hay aislamiento automático por cambiar el nombre de la app. No se copian usuarios, datos, comprobantes ni secretos desde `explora-control-operativo`. No se borran colecciones ni se ordena eliminar funciones ajenas.

## Cloud Shell, paso a paso

Desde la carpeta que contiene este README:

```bash
bash explora.sh
```

El menú ofrece estas acciones; el orden inicial recomendado es:

1. `install`: Node 22 y dependencias exactas de `functions/package-lock.json`.
2. `configure`: elegir Firebase, confirmar su ID y elegir o crear la aplicación web. Hace una copia local del código antes de cambiar la configuración.
3. `admin`: crear la cuenta administradora o habilitar una existente y su alias. La contraseña de una cuenta existente no se cambia. Cerrá y abrí la sesión después de cambiar permisos.
4. `telegram`: ingresar token del bot y chat de destino de forma oculta; se guardan como secretos del proyecto, no dentro del repositorio.
5. `arca`: asistente de datos fiscales o lectura de un JSON existente; solicita las rutas de certificado y clave privada y usa Secret Manager. La integración conservada es de **factura C para monotributo**. No convierte automáticamente Explora a otro régimen. Primero homologación; producción exige confirmaciones expresas.
6. `check`, luego `deploy`: ejecuta todas las pruebas y el build; si falla un paso, se detiene. Para publicar hay que escribir `PUBLICAR <id-del-proyecto>`.

La opción `routes` configura el servicio de rutas opcional. El catálogo de recorridos y la carga manual siguen disponibles sin esa integración.

**Requisitos de la cuenta:** acceso autorizado al Firebase destino, facturación del proyecto habilitada cuando la exijan las funciones/servicios, Firestore y Storage inicializados y el proveedor correo/contraseña habilitado en Authentication. El SH solicita inicio de sesión cuando corresponde; no inventa credenciales, no acepta cargos ni habilita servicios de pago en tu nombre. `doctor` comprueba accesos a Auth, Firestore y Storage sin enviar mensajes ni emitir facturas.

Las integraciones `telegramEnabled`, `arcaEnabled` y `routesEnabled` se entregan en `false`. Los comandos anteriores las habilitan para el siguiente despliegue, una vez configuradas. Un despliegue sin ARCA habilitada no crea PDFs fiscales ficticios: muestra el estado pendiente/desactivado. Configuralas **antes de empezar a registrar viajes reales**; habilitar ARCA después no factura automáticamente los registros históricos.

## Visual y orden

Pantalla blanca con títulos y totales por color, siguiendo la referencia: efectivo → gastos pagados en efectivo → efectivo restante → digital → Uber digital → resultado → distribución → liquidación. El logo original no se redibujó ni se sustituyó.

La función de ordenación original y los snapshots de comprobantes se conservan. El orden cronológico seleccionado —más recientes o más antiguos— se aplica también a las filas del extracto. El historial detallado queda accesible debajo en “Consultar historial detallado y orden de movimientos”. Un Uber recibido por el chofer se muestra en un bloque específico junto al efectivo; no se clasifica como digital ni se cuenta dos veces.

## Cálculo implementado

```text
Disponible = cobros de viajes + Uber − gastos operativos
Caja Explora = 10% del disponible positivo
A dividir = disponible − Caja Explora
Chofer = 50% de lo que queda
Explora = 50% de lo que queda, más la caja separada
Diferencia = dinero retenido por el chofer − parte que le corresponde
            + apertura/deudas/ajustes, descontando pagos ya realizados
```

Cálculos en centavos. Si la división deja un centavo impar, ese centavo queda en la participación de Explora. Si hay pérdida, no se genera caja y la pérdida se comparte por mitades. Los gastos cargados como operativos se deducen antes del reparto; no se aplica además un segundo reintegro del 50%. No cargues allí como gasto compartido una deuda exclusivamente personal: registrala con el circuito separado de deuda.

Caso de referencia: $301.000 efectivo − $124.000 gastos = $177.000 con el chofer. $175.000 digital + $75.000 Uber digital = $250.000 con Explora. Disponible $427.000; caja $42.700; reparto $384.300; $192.150 cada uno. **Explora te debe $15.150**. Explora conserva $234.850, de los cuales $42.700 son caja y $192.150 participación.

Los cierres históricos `on_demand` mantienen su corte. Los pagos/ajustes y cierres de mera liquidación no se convierten en ingresos nuevos. Los adelantos y deudas aceptadas siguen separados. El período abierto se recalcula con la nueva fórmula; un período ya cortado no se reabre automáticamente.

## Comprobantes: dos destinos diferentes

- **Efectivo y digital en el extracto:** factura autorizada de ARCA. Nombre corto `FC-1-637.pdf`; en homologación `PRUEBA-FC-1-637.pdf`. Hasta la autorización se muestra el estado real, no una factura inventada. El PDF fiscal corresponde al importe del servicio, no al saldo de liquidación.
- **Gastos en Explora:** PDF real, como `G-abc123.pdf`. Una imagen JPG/PNG/WebP se convierte a PDF; no se limita a cambiar la extensión. En los cobros digitales se conserva además el comprobante de pago, separado de la factura fiscal.
- **Telegram:** los cobros digitales y gastos se envían como imagen con el importe en el texto. Una autorización fiscal posterior actualiza la leyenda sin reemplazar la foto por un PDF ni duplicar el aviso. Si falta la imagen o falla su envío, queda error/reintento; no se da por enviado solamente un texto.

La carga nueva de gastos y pagos digitales exige una imagen legible para poder enviarla como foto. El PDF de esa imagen se guarda en Explora y el JPEG se conserva para Telegram. Si solo tenés un PDF de pago/gasto, adjuntá una captura legible de ese comprobante para ese circuito. Esto no aplica a la factura ARCA, que es el documento fiscal independiente. El límite de origen es 15 MB; HEIC no decodificable debe convertirse a JPG/PNG.

### Imágenes históricas

Al abrir un comprobante histórico se prepara su PDF mediante una función autenticada. También existe conversión por lote:

```bash
bash explora.sh migrate-pdfs
# Simula y genera informe; no modifica los documentos.
bash explora.sh migrate-pdfs --apply
# Pide confirmación y convierte. Conserva el original, importe y fecha.
```

La operación guarda progreso local para reanudarse. Para volver a revisar desde el comienzo, incluidos errores anteriores:

```bash
bash explora.sh migrate-pdfs --apply --restart
```

Solo procesa objetos del Storage del proyecto seleccionado que correspondan al titular del movimiento. No descarga URLs arbitrarias ni copia archivos del otro Firebase. Los errores quedan en `.explora-local`. No se hicieron conversiones sobre tus datos reales al preparar este paquete.

## Revisión y recuperación

`bash explora.sh preview` abre una vista de demostración local en el puerto 8080, ruta `/preview.html`, con datos explícitamente ficticios; no usa Firebase. En Cloud Shell utilizá la vista previa web de ese puerto. `check-offline` ejecuta los controles sin instalar SDKs cloud. `check` exige además las suites completas con dependencias. GitHub Actions valida pero **no despliega**.

`backup` es solo una copia del código local: **no es una copia de Firestore, Authentication ni Storage**. Antes de sustituir una app usada, conservá el código anterior y realizá el respaldo de sus datos por los medios del proyecto. El SH no hace `git push`, `git reset`, `git clean` ni publicación sin confirmación. No subas `.explora-local`, `.env`, certificados, claves o tokens al GitHub público.

El informe `INFORME_PRUEBAS.md` diferencia pruebas ejecutadas de verificaciones reales pendientes. Los documentos y accesos de despliegue viejos conservados en la carpeta son históricos; para esta entrega utilizá `explora.sh` y este README.
