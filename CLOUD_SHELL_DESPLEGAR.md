# Despliegue desde Google Cloud Shell

El proyecto destino es siempre:

`explora-control-operativo`

## Opción recomendada

Desde la raíz de `Barberia-main-migrado`, ejecuta:

```bash
chmod +x tools/deploy-migracion-cloud-shell.sh
./tools/deploy-migracion-cloud-shell.sh
```

El script:

1. valida JavaScript;
2. instala dependencias de Functions con `npm ci`;
3. ejecuta las pruebas de Telegram/saldos;
4. selecciona `explora-control-operativo`;
5. despliega Firestore Rules, Storage Rules y todas las Cloud Functions.

## Secrets de Telegram

El deploy reutiliza los secrets existentes del proyecto. No hace falta volver a cargar el token si ya está configurado.

Para verificar que existen:

```bash
firebase functions:secrets:access TELEGRAM_CHAT_ID --project explora-control-operativo
```

No pegues `TELEGRAM_BOT_TOKEN` en archivos del repositorio.

## Hosting

Si la web se publica por GitHub Pages, sube el contenido de este proyecto al repositorio que uses para la app y no es necesario desplegar Firebase Hosting.

Si también quieres publicar la web por Firebase Hosting:

```bash
firebase deploy --project explora-control-operativo --only hosting
```
