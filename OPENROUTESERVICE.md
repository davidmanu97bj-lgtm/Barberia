# Activación de direcciones y kilómetros

La pantalla de cobros consulta la función autenticada `exploraRoute`. La clave nunca se incluye en el navegador ni en Git. La integración no emite facturas ni determina exenciones fiscales. El kilometraje es una estimación por carretera, editable por el chofer; el tipo nacional/internacional se propone según el país de los puntos elegidos y puede corregirse por el usuario.

1. Crear una cuenta en https://account.heigit.org y solicitar una clave Standard gratuita. Revisar allí las condiciones y cupos vigentes, incluido uso comercial y atribución.
2. Guardar la clave desde un terminal privado con `firebase functions:secrets:set OPENROUTESERVICE_API_KEY --project explora-control-operativo`. No pegarla en el chat, archivos públicos o código. Para emulación, usar `.secret.local` (ignorado por Git).
3. Una vez autorizado el despliegue, publicar la función `exploraRoute` y el Hosting mediante el flujo de despliegue del repositorio. No desplegar automáticamente otras funciones.
4. Probar direcciones reales de Puerto Iguazú, aeropuerto, hoteles, Cataratas y trayectos fronterizos. La cobertura local todavía requiere validación con una clave real. Verificar kilómetros, selección y corrección manual.

La función solo admite usuarios habilitados y limita consultas en contadores privados `route_usage`: 800 búsquedas y 1500 rutas por día UTC para toda la app, 35 consultas/minuto globales, 15/minuto y 200/día por usuario. Estos límites son conservadores, no una garantía de cupo del proveedor: deben ajustarse al plan confirmado. Firestore y Cloud Functions pueden tener costos propios según consumo.

La interfaz busca al pulsar Buscar para evitar consultas por cada letra. Si falta la clave, falla el proveedor o se agota el cupo, se permite completar los datos manualmente. Modificar un punto invalida los kilómetros previos; respuestas tardías no deben sobrescribir una corrección manual. No incluye mapa interactivo ni seguimiento GPS.

Documentación: https://giscience.github.io/openrouteservice/api-reference/endpoints/geocoder/ y https://giscience.github.io/openrouteservice/api-reference/endpoints/directions/

La integración usa los endpoints actuales de HeiGIT: /pelias/v1/search y /openrouteservice/v2/directions/driving-car/json en api.heigit.org. Migración oficial: https://ask.openrouteservice.org/t/deprecating-api-openrouteservice-org-in-favour-of-api-heigit-org/7912

La búsqueda se limita a un radio geográfico de 100 km desde Puerto Iguazú (-54.5736, -25.5972), en Argentina, Brasil y Paraguay, con filtro de país y distancia también sobre los resultados. No es un límite de kilómetros por carretera ni acredita una exención de IVA. Un recorrido calculado mayor a 100 km muestra aviso y conserva su distancia real.
