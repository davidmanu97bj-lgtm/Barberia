# EXPLORA — Telegram con foto para gastos y cobros digitales

> Documento histórico. La configuración y el flujo vigentes están en [docs/telegram.md](docs/telegram.md) y el despliegue desde `main` está en [README.md](README.md). No usar el ZIP ni los comandos de este documento para publicar la versión actual.

## Qué se agregó

- `notifyBillingRecordV2`: escucha nuevos documentos en `billing_records/{docId}`.
- Solo envía cobros digitales: **tarjeta, QR y transferencia**.
- `notifyExpenseV2`: escucha nuevos documentos en `gastos/{docId}`.
- Ambos envían a Telegram la foto real del comprobante con chofer, monto, tipo/método, fecha e ID.
- Usa `telegram_notifications` para evitar avisos duplicados.
- Primero intenta enviar la URL de Firebase; si Telegram no puede abrirla, descarga la imagen y la adjunta físicamente.
- Los cobros en efectivo no se envían porque no tienen comprobante.

## Datos configurados

- Proyecto Firebase: `explora-control-operativo`
- Chat de Telegram: `8882136575`
- Secret existente esperado: `TELEGRAM_BOT_TOKEN`
- Secret nuevo: `TELEGRAM_CHAT_ID`

## Comandos exactos para Google Cloud Shell

Sube `explora-telegram-fotos-cloud-shell.zip` a Cloud Shell y ejecuta:

```bash
rm -rf ~/telegram-fotos
mkdir -p ~/telegram-fotos
unzip -o ~/explora-telegram-fotos-cloud-shell.zip -d ~/telegram-fotos
cd ~/telegram-fotos

gcloud config set project explora-control-operativo
firebase use explora-control-operativo

printf '%s' '8882136575' > /tmp/telegram_chat_id.txt
firebase functions:secrets:set TELEGRAM_CHAT_ID --data-file=/tmp/telegram_chat_id.txt
rm -f /tmp/telegram_chat_id.txt

firebase deploy --only "functions:notifyBillingRecordV2,functions:notifyExpenseV2" --project explora-control-operativo
```

Si `TELEGRAM_BOT_TOKEN` todavía no existe, antes del deploy ejecuta:

```bash
firebase functions:secrets:set TELEGRAM_BOT_TOKEN
```

Cuando lo solicite, pega el token completo del bot. No lo escribas dentro de `index.js`.

## Verificación

```bash
firebase functions:log --only notifyBillingRecordV2,notifyExpenseV2 --project explora-control-operativo
```

Después registra en la app:

1. Un gasto con foto.
2. Un cobro por transferencia, QR o tarjeta con foto.

Cada operación debe llegar a Telegram una sola vez y con su imagen.
