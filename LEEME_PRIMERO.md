# Barbería República Argentina

Esta PWA está separada de Explora y conectada exclusivamente al proyecto Firebase `barberia-c25a1`.

## Lógica del reparto

- El **5% de cada cobro en efectivo** y el **5% de cada cobro digital** se reservan para **Caja para publicidad**.
- Cada cobro crea un solo comprobante de publicidad del 5% en el mismo medio: efectivo o digital.
- Los comprobantes de efectivo, publicidad y digital aparecen en secciones separadas.
- Todos los usuarios ven el saldo en tiempo real de los barberos activos, sin acceso a comprobantes ajenos.
- El 95% restante se divide en partes iguales: 47,5% para el barbero y 47,5% para la barbería.
- El efectivo queda físicamente en manos del barbero: debe entregar 52,5% a la barbería.
- El digital entra a la cuenta de la barbería: la barbería entrega 47,5% al barbero.
- Saldo neto: `52,5% del efectivo - 47,5% del digital`.

## Cierres

Al pedir un cierre se guarda una fotografía completa del período y el tablero vuelve inmediatamente a cero. Completar ese pedido desde Admin no borra los cobros posteriores: esos ya pertenecen al período nuevo.

## Accesos

El login usa Firebase Authentication. Los barberos creados desde Admin ingresan con su usuario y clave. El usuario interno se crea como `usuario@barberia.local`.

La cuenta propietaria existente debe tener uno de estos roles en `usuarios`, `users` o `perfiles`: `admin`, `administrador`, `owner`, `propietario` o `superadmin`; también puede existir como documento en `administradores/{uid}` o `admins/{uid}`.

## Telegram

Telegram está conectado exclusivamente al grupo **Barberia**, Chat ID `-5393018000`. Se envían avisos cuando:

- se registra un cobro;
- un barbero solicita un cierre;
- el administrador completa un cierre.

El token del bot **no está escrito dentro del proyecto**. Se guarda como secreto de Firebase con el nombre `BARBERIA_TELEGRAM_BOT_TOKEN`. En el primer despliegue, `DESPLEGAR_BARBERIA.sh` detecta que todavía no existe y Firebase pide pegar el token nuevo de `@Explora_notificaciones_bot`.

Las funciones usan un registro interno `_telegram_delivery` para evitar que un mismo evento normal termine enviándose dos veces por una ejecución repetida.

## Despliegue desde iPhone / Cloud Shell

Sube el ZIP, descomprímelo y ejecuta `bash DESPLEGAR_BARBERIA.sh`. El script fija el proyecto `barberia-c25a1`, configura el secreto de Telegram la primera vez, instala dependencias, corre las pruebas y despliega Hosting, reglas y todas las funciones de la barbería.
