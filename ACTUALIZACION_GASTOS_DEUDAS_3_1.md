# Explora · actualización 3.1 · Gastos y deudas

Base: Explora 3.0.0 entregado en este chat, con su configuración y su despliegue ya reparados.
Destino autorizado del actualizador: barberia-c25a1. ARCA desactivada y Telegram activado.

## Aplicar y publicar

Subir EXPLORA_ACTUALIZAR_GASTOS_DEUDAS.sh a la carpeta principal de Cloud Shell y ejecutar:

```bash
bash "$HOME/EXPLORA_ACTUALIZAR_GASTOS_DEUDAS.sh"
```

El actualizador utiliza $HOME/explora-barberia-3.0.0. No reinstala el proyecto ni vuelve a pedir usuarios, certificados o tokens. Comprueba versiones, guarda una copia local de los archivos que reemplaza, ejecuta las pruebas completas y el build. Si pasan, pide escribir PUBLICAR barberia-c25a1. Publica las reglas de Firestore, 14 funciones identificadas por nombre en tres tandas y finalmente Hosting. No publica disparadores de ARCA, no cambia regiones, no elimina funciones ni hace git push. Conserva explora.sh y tools/functions-manifest.mjs con las reparaciones ya realizadas.

No usar la aplicación para cargar movimientos durante la actualización. La publicación de Google no es atómica: si falla una etapa, las anteriores pueden haber quedado publicadas. El script se detiene y no avanza a Hosting; no promete deshacer cambios remotos. Repetir el mismo archivo es idempotente para aplicar los archivos locales y permite reintentar el despliegue.

Modo alternativo, sin pruebas ni publicación: --solo-aplicar. Carpeta alternativa: --dir "/ruta/al/proyecto". --help explica las opciones.

## Cambios

En Cobro efectivo, Cobro digital y Gastos se eliminó el paso completo de “Movimientos en tu cuenta”, no solo su título. No queda un paso vacío ni una segunda confirmación de saldos. Se conservan importe, recorrido, foto y los datos del servicio necesarios. Los saldos se siguen calculando internamente y se muestran en Inicio.

Gastos tiene dos entradas: “Gasto pagado en efectivo” y “Deuda del chofer 100%”. La primera conserva la regla vigente: gasto pagado por el chofer, resta del efectivo y del disponible antes de Caja Explora 10% y del reparto del resto. No genera otro reintegro duplicado. La segunda ofrece choque, préstamo, multa y ruptura, además de los conceptos personales que ya existían en el catálogo. Se usa solo cuando existe una obligación del chofer con Explora, no cuando el chofer ya pagó por su cuenta a un tercero y nada debe a Explora.

Al confirmar la segunda entrada, el chofer reconoce la deuda completa. Se guarda en deudas_choferes con tipo driver_debt_100, no en gastos ni en cobros. Aumenta la liquidación en el 100%; no reduce el efectivo, no cambia los ingresos ni el reparto y no genera Caja Explora. Los préstamos registrados aquí son solo capital adeudado: no abonan automáticamente dinero al chofer y no generan intereses ni recargos diarios. No se modificó el circuito histórico independiente de adelantos.

Inicio muestra las deudas con su comprobante PDF, sus saldos pendientes y “Total deudas chofer 100%”, después de los movimientos digitales/Uber y antes del resultado. Incluye deudas pendientes de períodos anteriores; cerrar el período no perdona una deuda. Los pagos generales de la cuenta se muestran como ajustes separados y no se descuentan otra vez de cada deuda. Las cancelaciones/pagos individuales realizados por el administrador actualizan el saldo pendiente de esa deuda.

Ejemplo de verificación: Explora debía $15.150; se registra una multa de $50.000 que el chofer debe a Explora; el nuevo resultado es “Debes a Explora $34.850”. Caja y reparto no cambian por esa deuda.

Las deudas históricas administrativas conservan la aceptación del chofer cuando correspondía. No se reclasifican automáticamente gastos viejos ni se migran datos desde otro Firebase. Se mantienen las cuatro funciones originales de ordenación y los dos logos originales byte por byte.

## Comprobantes y seguridad

Se mantiene PDF real dentro de Explora y JPEG para Telegram. Las nuevas deudas también usan ese circuito; en ellas no se marca el aviso como enviado si falla la fotografía. Los cobros en efectivo/digital siguen sin generar facturas ARCA mientras la integración esté apagada. No se inventan PDFs fiscales.

Las reglas permiten crear únicamente una deuda propia, activa, reconocida y por el importe completo, sin recargos automáticos. El identificador estable evita duplicados. Un reintento no puede cambiar los campos financieros. El chofer no puede perdonarse la deuda modificando el saldo. El administrador conserva las operaciones de pago y anulación existentes.

## Qué se conserva

No se reemplazan .firebaserc, firebase-config.js, functions/deployment-options.json, los secretos, las cuentas, los certificados, los logos, las carpetas de adjuntos, los índices ni Storage rules. No se escribe en el proyecto explora-control-operativo. El ZIP de archivos modificados es un respaldo de código; no es una copia de Firestore/Auth/Storage.

## Verificación posterior

Después de “ACTUALIZACION PUBLICADA”, abrir la web y recargar. Confirmar acceso, dos opciones en Gastos, ausencia de tarjetas antes/impacto/después en los tres formularios y actualización en Inicio. La recepción de fotos reales por Telegram, los permisos desplegados y la sesión real deben verificarse en la cuenta; no se ejecutaron acciones reales con las credenciales del usuario durante la preparación.
