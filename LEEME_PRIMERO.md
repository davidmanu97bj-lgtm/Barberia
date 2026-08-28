# Barbería República Argentina

Esta PWA está separada de Explora y conectada exclusivamente al proyecto Firebase `barberia-c25a1`.

## Lógica del reparto

- El 10% de cada corte se reserva para **Caja para publicidad**.
- Se crean dos comprobantes internos del 5%: uno identificado como efectivo y otro como digital.
- El 90% restante se divide: 45% para el barbero y 45% para la barbería.
- El efectivo queda físicamente en manos del barbero: debe entregar 55% a la barbería.
- El digital entra a la cuenta de la barbería: la barbería entrega 45% al barbero.
- Saldo neto: `55% del efectivo - 45% del digital`.

## Cierres

Al pedir un cierre se guarda una fotografía completa del período y el tablero vuelve inmediatamente a cero. Completar ese pedido desde Admin no borra los cobros posteriores: esos ya pertenecen al período nuevo.

## Accesos

El login usa Firebase Authentication. Los barberos creados desde Admin ingresan con su usuario y clave. El usuario interno se crea como `usuario@barberia.local`.

La cuenta propietaria existente debe tener uno de estos roles en `usuarios`, `users` o `perfiles`: `admin`, `administrador`, `owner`, `propietario` o `superadmin`; también puede existir como documento en `administradores/{uid}` o `admins/{uid}`.

## Telegram

Los cobros y cierres ya guardan campos de evento preparados para Telegram, pero esta versión no incluye token ni grupo. Así se evita enviar información al grupo de Explora. La conexión al grupo nuevo se agrega en la siguiente etapa.

## Despliegue desde iPhone / Cloud Shell

Sube el ZIP, descomprímelo y ejecuta `bash DESPLEGAR_BARBERIA.sh`. El script fija el proyecto `barberia-c25a1`, instala dependencias, corre las pruebas y despliega Hosting, reglas y las funciones de creación/edición de barberos.
