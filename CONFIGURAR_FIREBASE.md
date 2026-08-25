# Firebase de Barbería Main — configuración migrada

Este proyecto **ya está configurado** para usar el Firebase histórico de Santander Main/EXPLORA.

- Firebase Project ID: `explora-control-operativo`
- Auth domain: `explora-control-operativo.firebaseapp.com`
- Datos: colecciones históricas de nivel raíz
- Comprobantes: Storage histórico de EXPLORA
- Functions/Telegram: código incluido en `functions/`

No crees otro proyecto Firebase y no cambies `firebase-config.js` a `barberia-c25a1`, porque eso separaría nuevamente la app de los datos históricos.

## Login

Se reutilizan las cuentas existentes de Firebase Authentication. El login acepta el esquema histórico `usuario@explora.local` y también consulta `login_aliases` cuando corresponde.

## Despliegue del backend

Lee `CLOUD_SHELL_DESPLEGAR.md` o ejecuta:

```bash
chmod +x tools/deploy-migracion-cloud-shell.sh
./tools/deploy-migracion-cloud-shell.sh
```

## Publicación web

La interfaz puede seguir publicándose en GitHub Pages. Para la web, sube los archivos del proyecto nuevo al repositorio que vayas a usar como Barbería Main.

## Regla clave

Puedes dejar de utilizar el código/frontend viejo de Santander Main, pero **no borres el proyecto Firebase `explora-control-operativo`**, porque ahora es el backend permanente del Barbería Main migrado.
