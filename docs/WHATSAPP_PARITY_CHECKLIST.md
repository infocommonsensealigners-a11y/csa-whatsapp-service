# Checklist de paridad con WhatsApp Web — teléfono flotante (CSA)

**Fecha:** 2026-09-11 · **Baileys:** `baileys@6.7.23` · Columnas: comportamiento en WhatsApp Web ·
**estado** (OK / Parcial / Falla / No existe / Decisión) · cómo lo soporta Baileys · prioridad.

«Estado» = tras los bloques P0/P1/P2 de la Fase 2 (sidecar `fcc6345` + `717219a`, dashboard
`856b50d` + el commit de interfaz). Lo que dependa del guardián `check:nosend` (escribir hacia
la cuenta) está marcado **Decisión**: se hace en cuanto el usuario lo autorice, no antes.

---

## Identidad y deduplicación (P0)

| WhatsApp Web | Estado | Baileys | Prio |
|---|---|---|---|
| Un chat = un contacto/grupo. Normalizar jids (sin sufijo `:N`, `@c.us` → `@s.whatsapp.net`). | **OK** — `identidad.ts: normalizarJid` en toda entrada (mensajes, chats, contactos, rutas). 0 jids con sufijo en prod; test `test-identidad`. | `jidNormalizedUser` (copiado, puro) | P0 |
| Internacionales en E.164: el mismo contacto no existe con formatos distintos. | **OK** — clave de cruce `claveTelefono` (ES → 9 dígitos; resto → E.164 sin `+`); el jid ya es E.164. `chats.phone` sigue siendo ES (contrato del CRM). | jid `<E.164>@s.whatsapp.net` | P0 |
| Unificar `@lid` y `@s.whatsapp.net` de la misma persona. | **OK** — canónico = teléfono; el `@lid` es alias (`chats.alias_of`). Se aprende de `key.senderPn`, `pnJid/lidJid` (history sync), `contact.lid` (agenda), `chats.phoneNumberShare` y `onWhatsApp`. **Parcial** para los 134 `@lid` sin teléfono aún: se funden solos cuando llega el dato (respuesta, agenda, re-emparejamiento). | `WAMessageKey.senderPn/participantPn`, `Contact.lid`, `IConversation.pnJid/lidJid`, evento `chats.phoneNumberShare`, `onWhatsApp` | P0 |
| Deduplicar mensajes: clave única `(chat normalizado, id)`, upsert idempotente. | **OK** — PK `(chat_jid, id)` sobre el canónico + `ON CONFLICT DO NOTHING`; el mismo evento ×3 = 1 fila (`test-fusion`). | — | P0 |
| Envío optimista: el temporal se sustituye por el real, nunca se duplica. | **OK** — `tmp-` se purga al refrescar; `send.ts` persiste con el id y `messageTimestamp` de WhatsApp; el eco cae en la misma PK. | `sendMessage` devuelve la `key` | P0 |
| Mensajes enviados desde el móvil/otro dispositivo aparecen igual. | **OK** — `messages.upsert` `fromMe` (notify/append) al canónico; ticks reales también. | `messages.upsert` | P0 |
| Los gemelos ya guardados se funden sin perder nada. | **OK** — `fusionInicial` al arrancar con copia consistente; ensayo sobre prod: 307 pares, 16.499 mensajes, integridad exacta. | — | P0 |

## Orden y lista de chats (P0)

| WhatsApp Web | Estado | Baileys | Prio |
|---|---|---|---|
| Orden por el último mensaje real, descendente y estable. | **OK** — `last_message_at` solo se mueve al INSERTAR; recálculo desde `messages`; desempate por jid en servidor y cliente. 99 chats adelantados → 0. | `messageTimestamp` | P0 |
| Qué NO sube un chat: protocolo, reacciones, ediciones, recibos. | **OK** — `extractContent` los descarta; reacciones/ediciones/acuses van por `messages.update`/`messages.reaction` sin tocar el orden. | `isRealMessage` (mismo criterio) | P0 |
| Fijados arriba (hasta 3) en su orden. | **OK** — `chats.update.pinned` → `chats.pinned`; `/chats` y `ordenarChats` los ponen primero. **Decisión** para fijar DESDE el dashboard (`chatModify`). | app-state `pinAction` | P0 |
| Archivados fuera de la lista principal. | **OK** — carpeta «Archivados» como WhatsApp Web; desde el móvil. **Decisión** para archivar desde aquí. | app-state `archiveChatAction` | P0 |
| Silenciados. | **OK** — 🔕 y globo gris; desde el móvil. **Decisión** para silenciar desde aquí. | app-state `muteAction` | P0 |
| Vista previa del último mensaje correcta (media, «Tú:», borrado, reacción). | **OK** — preview único (`previewDe`), tick delante si es nuestro (WhatsApp Web usa el tick, no «Tú:»), «🚫 Se eliminó este mensaje». **Parcial**: la reacción no cambia el preview (WhatsApp Web muestra «Reaccionó 👍 a …»). | — | P0 |
| Contador de no leídos y «no leído manual» sincronizados en ambas direcciones. | **Parcial** — móvil → aquí sí (`unreadCount`, marca monótona). Aquí → móvil **Decisión** (`readMessages`/`chatModify markRead`). «Marcar como no leído» en el móvil: no se refleja (`markedAsUnread` disponible, sin usar). | `chats.update.unreadCount`, `markedAsUnread` | P0 |
| Nombre mostrado: agenda > negocio > pushName > número. | **OK** — `wa_contacts` + prioridad; el nombre de agenda pisa un pushName; el CRM como «también:». | `contacts.upsert/update`, history `chat.name` | P0 |

## Sincronización y desfase (P0)

| WhatsApp Web | Estado | Baileys | Prio |
|---|---|---|---|
| Sincronización inicial del historial sin duplicar y fusionada. | **OK con respaldo** — `messaging-history.set` al canónico, PK idempotente; `pnJid/lidJid` aprendidos antes de escribir. **11-09-2026 16:31, re-escaneo real:** el móvil mandó sus avisos y Baileys no emitió ningún volcado ni error. Desde entonces `historial.ts` ve cada aviso en `messages.upsert`, lo registra, y si Baileys no entrega el volcado en 60 s lo descarga y procesa él (tiempo límite, reintentos, payload en línea, solo avisos de nuestra cuenta). `/status.historySync` lo enseña. | `messaging-history.set`, `getHistoryMsg`, `downloadContentFromMessage('md-msg-hist')`, `processHistoryMessage` | P0 |
| Eventos en vivo: upsert (notify/append), update, chats.*, contacts.*. | **OK** — todos cableados; `append` reciente (3 días) se trata como en vivo (media, campañas, análisis). | ver `ingest.ts` | P0 |
| Estado de la app (archivar, fijar, silenciar, leído) móvil → aquí. | **OK** (ver arriba). Al revés: **Decisión**. | app-state sync | P0 |
| Reconexión sin huecos ni duplicados; indicador visible. | **OK** — WhatsApp re-entrega lo perdido como `append`; PK evita duplicados; pie del teléfono y píldora dicen el estado real. Tras escanear, reconexión inmediata al 515 (antes esperaba 60 s y el móvil retiraba el dispositivo). **Parcial**: una desconexión larga (días, dispositivo retirado) solo se cierra con re-emparejamiento: el volcado del móvil trae el tramo perdido; además, al conectar con un silencio de más de 20 h en la base, `historial.ts` pide al móvil los últimos 50 mensajes de los chats activos antes del hueco (sonda de un chat primero; si el móvil no atiende, se para; tope 40 chats, uno cada 4 s). | `connection.update`, `append` offline, `fetchMessageHistory` | P0 |
| El frontend recibe cambios en tiempo real y se reconcilia al volver. | **OK** — SSE `message.new/updated`, `chat.updated`, `chats.synced`, `presence` + catch-up al reconectar/visibilitychange/online + polls de respaldo. | — | P0 |

## Mensajes (P1)

| WhatsApp Web | Estado | Baileys | Prio |
|---|---|---|---|
| Ticks enviado/entregado/leído. | **OK** en 1-a-1 (`messages.update.status`, monótono). **Parcial** en grupos (`message-receipt.update` no se agrega aún; se enseña el estado del mensaje). | `messages.update {status}`, `message-receipt.update` | P1 |
| Enviar acuse de lectura al abrir un chat. | **Decisión** — prohibido por `check:nosend`. | `readMessages` | P1 |
| Respuestas citadas con salto al original. | **OK** — cita servida desde `contextInfo.stanzaId`; responder desde el flotante con `{ citar }`. | `contextInfo.quotedMessage`, `sendMessage(..., { quoted })` | P1 |
| Reacciones (añadir/quitar/cambiar). | **OK** — ambos sentidos; enviar por `send.ts`. | `messages.reaction`, `{ react }` | P1 |
| Ediciones («Editado»). | **OK**. | `messages.update` `MESSAGE_EDIT` | P1 |
| Borrados («Se eliminó este mensaje»). | **OK** (el texto se conserva en la base, no se enseña). Borrar desde aquí: **No existe** (sería `sendMessage {delete}` en `send.ts`; no pedido). | `messages.update` `REVOKE` | P1 |
| «Eliminar para mí» / vaciar chat desde el móvil. | **OK** — se ocultan. | `messages.delete` | P1 |
| Media: imagen, vídeo, audio/nota de voz, documento. | **OK** (ya existía) + ahora también lo recibido con el sidecar caído. **Parcial**: sticker, ubicación, contacto, encuesta se enseñan como «Mensaje no compatible». Reintento si la media caducó: bajo demanda (`/media/:jid/:id/fetch`). | `downloadMediaMessage`, `updateMediaMessage` | P1 |
| Temporales, ver una vez, encuestas. | **Parcial** — efímeros y «ver una vez» se desenvuelven y se guardan como normales (sin marcador); encuestas = «Mensaje no compatible». | wrappers `ephemeralMessage`, `viewOnceMessage*` | P1 |
| Separadores de fecha, horas en la zona del navegador, UTC en base. | **OK** (ya existía). **Parcial**: los mensajes seguidos no se agrupan visualmente. | — | P1 |
| Scroll: abrir en el primer no leído, cargar al subir sin saltos, mantener posición. | **OK** — separador «N mensajes no leídos» (`unreadFrom`), carga al subir conservando la posición, pegado al fondo solo si estabas abajo. | — | P1 |

## Grupos y presencia (P2)

| WhatsApp Web | Estado | Baileys | Prio |
|---|---|---|---|
| Grupos en la lista, con asunto y nº de participantes. | **OK** — entran desde el 2026-09-11; asunto por `groups.*`/`groupMetadata`/history. Escribir a un grupo: solo a mano desde el flotante. | `groups.upsert/update`, `groupMetadata` | P2 |
| Nombre del participante en cada mensaje. | **OK** — `participant` + nombre (agenda / pushName), color estable. | `key.participant`, `participantPn` | P2 |
| Menciones. | **No existe** (se ven como texto `@…`). | `contextInfo.mentionedJid` | P2 |
| Mensajes de sistema (entró, salió, cambió el asunto). | **OK** — líneas centradas redactadas como WhatsApp; también llamadas perdidas y «Esperando el mensaje…». | `messageStubType` + `messageStubParameters` | P2 |
| «Escribiendo…» / «grabando audio…» / en línea / últ. vez. | **OK** — se suscribe al abrir el chat (solo lectura); caduca sola. Depende de la privacidad del contacto. | `presenceSubscribe`, `presence.update` | P2 |
| Nuestra presencia («escribiendo…» hacia el contacto). | **Decisión** — prohibido (`sendPresenceUpdate`); además nunca aparecemos «en línea» por diseño. | `sendPresenceUpdate` | P2 |

## Límites del protocolo (no se pueden igualar) y cómo se muestran

| Qué | Por qué | En la interfaz |
|---|---|---|
| Llamadas de voz/vídeo | Baileys no las cursa. | Solo la línea «Llamada perdida»; los iconos de llamada de la cabecera son decorativos. |
| Estados (stories) y canales (newsletters) | Fuera del alcance; los canales se ignoran a nivel de socket. | No aparecen. |
| Historial anterior al emparejamiento | WhatsApp entrega una ventana reciente; `syncFullHistory` rompe el emparejamiento (428). | Aviso «historial anterior no disponible»; importación desde exportación del móvil. |
| Historial tras volver a vincular | Lo genera y sube el MÓVIL; con la app cerrada o el teléfono bloqueado el volcado se retrasa hasta que se abre WhatsApp. No hay forma de pedir «lo más nuevo que X»: `fetchMessageHistory` solo devuelve lo anterior a un ancla. | Logs `[historial]` (aviso visto, volcado, hueco) y `/status.historySync`; instrucción operativa: dejar WhatsApp abierto en el móvil unos minutos tras escanear. |
| Media del histórico sin claves | Solo hay claves desde el 17-07-2026. | Etiqueta honesta «sin claves» en vez de un botón muerto. |
| Ver una vez | El contenido llega; WhatsApp Web lo enseña una vez. | Se guarda como foto normal (Parcial). |
| Cifrado fallido | Baileys pide reenvío; hasta entonces no hay contenido. | «Esperando el mensaje. Puede tardar un poco.», que se rellena solo. |
| Presencia | Solo si el contacto lo permite y tras suscribirse. | Se enseña cuando llega; si no, el subtítulo normal. |
