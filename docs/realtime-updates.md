# Actualización de saldo e historial

El inicio escucha las colecciones del chofer con Firestore `onSnapshot`. Cada cambio actualiza un índice por ID; solo se normalizan las altas y modificaciones recibidas y se quitan las bajas. Se mantienen los aliases de propiedad de los registros anteriores.

`onSnapshotsInSync` vacía los dibujos pendientes cuando los listeners afectados ya procesaron el cambio. El saldo y el historial usan entonces los mismos datos, sin esperar a una animación de números. Este evento sincroniza listeners entre sí: la confirmación del servidor se determina por los metadatos de cada snapshot. Se muestra «Guardando…» mientras hay escrituras pendientes y «Sin conexión» cuando corresponde.

Al confirmar una operación, la vista previa conserva su saldo inicial mientras llega el alta para evitar sumar dos veces el impacto en pantalla. En cobros, gastos y Gestión, ese punto de partida se actualiza justo antes de escribir, después de subir la foto y de las lecturas necesarias. El inicio sigue recibiendo cambios durante el guardado. Tras la confirmación se cierra el formulario inmediatamente, sin los antiguos temporizadores de 700–1300 ms.

Al volver a la app o recuperar conexión, se dibuja el estado disponible. Se reutilizan los listeners existentes; no se agregan consultas periódicas, funciones de servidor ni instancias permanentes. Las reglas de caja chica, reintegros, ARCA y los saldos históricos no cambian. La subida de imágenes y la confirmación remota siguen dependiendo de la conexión del dispositivo.

## Verificación

- `tests/realtime-balance.test.mjs`: importes exactos, normalización incremental con 1000 movimientos, metadatos, regreso a la app, bloqueo de doble impacto en los cuatro formularios y confirmaciones sin conexión.
- `tests/loading-performance.test.mjs`: coordinación del render, altas, modificaciones, bajas, caché y aislamiento entre sesiones.
- `tests/settlement-gross-flow.test.mjs`: concordancia de los cálculos del inicio, el historial y el servidor para cobros, gastos, Gestión y Uber.
- Prueba local con dos clientes Firestore: efectivo, digital, gasto y reintegro, corrección, eliminación y reconexión recibidos sin recargar.
- Prueba visual en dos pestañas y viewport de 412 × 915: gasto temporal de $1000, reintegro de $500 y saldo final idéntico al «Después» en ambas vistas. Se eliminó el registro de prueba y su imagen; no se enviaron facturas ni mensajes externos.

El 13/09/2026 pasaron las 186 pruebas del proyecto. Las pruebas locales no representan una medición de la red móvil de un teléfono Android real.

## Acceso sin pausa al finalizar la carga

El login intenta primero el email o usuario habitual. Solo consulta `login_aliases` si fallan esas credenciales, conservando los accesos antiguos y evitando repetir el mismo intento. Las lecturas directas de perfil siguen en paralelo y mantienen su prioridad histórica; un perfil principal encontrado ya no espera una lectura secundaria innecesaria.

Después de verificar el perfil, se abre el inicio sin esperar a descargar todo el historial ni agotar el antiguo límite de seis segundos. Los importes y botones financieros siguen bloqueados hasta tener todas las colecciones sincronizadas, por lo que ningún saldo parcial aparece como definitivo. Los perfiles desactivados siguen cerrando sesión y las respuestas de sesiones anteriores se descartan. La consulta del equipo comienza después de abrir el inicio.

El indicador de acceso gira continuamente, sin el antiguo progreso simulado que quedaba en 91%. Al completar el acceso se muestra la pantalla inmediatamente, sin otro temporizador de transición. Respeta la preferencia de movimiento reducido.

Validación: 194 pruebas aprobadas, incluyendo `tests/login-performance.test.mjs` y el ingreso con historial pendiente de `tests/loading-performance.test.mjs`. La prueba de navegador local con un usuario habitual abrió el inicio con saldo sincronizado en aproximadamente 824 ms; también se verificaron contraseña incorrecta, cierre y restauración de sesión. Es una medición del entorno local, no de un teléfono o conexión móvil real.
