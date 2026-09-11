# Guion de prueba manual — teléfono flotante lado a lado con WhatsApp Web

**Para quién:** quien tenga el móvil de Fran, WhatsApp Web abierto en una pestaña y el dashboard en
otra. **Cuándo:** después de publicar la Fase 2 y de re-escanear el QR. Cada paso dice qué tiene que
pasar en el teléfono flotante; si no pasa, anota el paso y la hora (Madrid) para buscarlo en los logs.

Antes de empezar: píldora del dashboard en verde («Conectado») y pie del teléfono con el nombre de la
cuenta. Si dice «Desvinculado · escanea el QR», primero escanear.

| # | Acción | Resultado esperado en el teléfono flotante |
|---|---|---|
| 1 | Desde el **móvil de Fran**, escribir «prueba 1» a un contacto que ya tenga chat. | En ≤ 3 s: el chat sube al primer puesto, preview «prueba 1» con tick delante (gris, dos), la burbuja aparece en la conversación si está abierta. **Nunca** una segunda fila de la misma persona. |
| 2 | Desde **WhatsApp Web**, responder «prueba 2» en el mismo chat. | Igual que 1. El chat sigue siendo UNO. |
| 3 | Desde el **teléfono flotante**, escribir «prueba 3». | Burbuja al instante con reloj → un tick → dos grises. En el móvil y en WhatsApp Web aparece el mismo mensaje, una sola vez. |
| 4 | Que el contacto **lea** los mensajes (o lee tú con otro número). | Los ticks de 1-3 pasan a **azules** sin recargar. |
| 5 | Que el contacto **conteste** por su cuenta. | Globo verde +1 en la lista; burbuja entrante; si el chat está abierto, «escribiendo…» bajo el nombre justo antes (si su privacidad lo permite). |
| 6 | **Leer** ese chat en el móvil. | El globo verde del flotante se apaga solo (≤ 5 s). |
| 7 | En el **móvil**, **fijar** el chat. | Sube al primer puesto con 📌 aunque haya chats más recientes. Desfijar → vuelve a su sitio por recencia. |
| 8 | En el **móvil**, **archivar** el chat. | Desaparece de la lista y aparece la carpeta «Archivados (1)»; dentro está. Desarchivar → vuelve. |
| 9 | En el **móvil**, **silenciar** el chat. | 🔕 junto a la hora y el globo se vuelve gris. |
| 10 | **Cortar la red del sidecar 2 minutos** (o hacer un deploy) y, mientras, mandar 2 mensajes desde el móvil y recibir 1 del contacto con una foto. | Al volver: los 3 mensajes aparecen UNA vez cada uno, en su orden real, la foto se ve (no «📷 Foto» gris), y el chat está en el sitio que le corresponde. La píldora pasó por «Sin conexión» y volvió a verde. |
| 10b | **Volver a vincular** tras días desvinculado (Dispositivos vinculados → cerrar sesión del dashboard → escanear de nuevo). Dejar WhatsApp abierto en el móvil 3-5 minutos. | En ≤ 10 s la píldora pasa a verde. En los logs: `[historial] emparejado de nuevo…`, uno o varios `[historial] aviso del móvil: tipo=INITIAL_BOOTSTRAP/RECENT…` y sus `[historial] volcado (baileys|propio)…`. En la lista, los chats con mensajes de los días perdidos suben con su fecha real, una sola fila por persona. Si a los 3 min no hay aviso, el log lo dice: abrir WhatsApp en el móvil. |
| 11 | Desde el móvil, escribir a un **grupo**. | El grupo aparece en la lista con 👥 y su asunto; dentro, cada mensaje ajeno lleva el nombre de quien habla en color. |
| 12 | Que alguien **entre** o **salga** del grupo, o cambie el asunto. | Línea centrada «X se unió» / «X salió» / «X cambió el asunto a …». |
| 13 | **Reaccionar** 👍 desde el móvil a un mensaje del flotante, y desde el flotante ❤️ a uno del móvil. | La reacción aparece bajo la burbuja en los dos sitios. Tocar la propia en el flotante la quita también en el móvil. |
| 14 | **Editar** un mensaje desde el móvil. | El texto cambia y aparece «Editado». |
| 15 | **Eliminar para todos** desde el móvil. | «🚫 Se eliminó este mensaje» y el preview de la lista lo dice. |
| 16 | **Responder citando** desde el móvil, y desde el flotante (↩ en la burbuja). | La cita aparece encima del texto en los dos sitios; en el flotante, tocarla salta al original. |
| 17 | Escribir a un **número extranjero** (p. ej. +44…). | Un solo chat, nombre o `+44…`; la conversación se ve igual. |
| 18 | Abrir un chat con **varios sin leer** en el flotante. | Se abre en el separador «N MENSAJES NO LEÍDOS», no al final; subir carga anteriores sin saltos. |
| 19 | **Marcar como no leído** en el móvil. | ⚠️ No se refleja (límite asumido: la marca es monótona). |
| 20 | Abrir un chat en el **flotante** y mirar el móvil. | ⚠️ El móvil NO lo da por leído ni el contacto ve ticks azules (decisión pendiente del usuario: acuse de lectura). |

Si algún paso falla: `railway logs --service csa-whatsapp-service --environment production` filtrando
por `[ingest]`, `[identidad]`, `[fusion]`, `[historial]` y la hora del paso.
