# Auditoría Fase 0 — Teléfono flotante vs. WhatsApp Web

**Fecha:** 2026-09-11 · **Alcance:** solo CSA (sidecar `whatsapp-service` + teléfono flotante del `dashboard`) ·
**Baileys instalado:** `baileys@6.7.23` (paquete `baileys`, WhiskeySockets) · **Sin tocar código.**

Todo lo que sigue está leído del código real (rutas `fichero:línea`) y medido sobre una **copia** de la base de
producción (`csa-backups/sidecar/2026-09-11-wa.sqlite3.gz`, último mensaje 2026-09-09 18:39Z; copia borrada al
terminar). Los scripts de consulta son de solo lectura y no imprimen textos ni nombres.

---

## 0. Resumen en diez líneas

1. **Un solo socket vivo en producción.** Un proceso (`Dockerfile` → `npx tsx src/index.ts`), volumen Railway ⇒ una
   réplica, y la fachada re-adjunta los mismos listeners a cada socket nuevo. No hay eventos duplicados por doble
   instancia. El riesgo está en local: `INICIAR DASHBOARD + WHATSAPP.bat` levanta `tsx watch` y hay un emparejamiento
   guardado en `whatsapp-service/data/auth` (1.002 ficheros).
2. **La causa nº 1 de duplicados y de orden distinto es la identidad:** WhatsApp direcciona a la misma persona por
   teléfono (`34…@s.whatsapp.net`) y por LID (`…@lid`) y el sidecar guarda una fila de chat **por jid**. Hoy: **93
   personas con dos filas vivas, 41 con las dos activas la última semana**. El dashboard las funde solo en pantalla, y
   solo si conoce el teléfono del `@lid`: **134 chats `@lid` no tienen teléfono resoluble, 90 de ellos activos**.
3. **El orden de la lista se calcula con `chats.last_message_at`, que se adelanta sin mensaje:** 12 chats de la era
   Baileys tienen la fecha de lista 25 min – 3 h por delante de su último mensaje real (8 de ellos por una
   re-entrega de un mensaje propio ya guardado). La causa es que la ingesta «sube» el chat **antes** de saber si el
   mensaje es nuevo.
4. **El desfase con el móvil tiene cuatro fuentes concretas**: (a) los mensajes que llegan mientras el sidecar
   estaba caído entran como `append` y se tratan como historial (sin media, sin campaña, sin re-análisis); (b) la
   lista carga solo 200 chats y los gemelos fuera de esa ventana no se funden; (c) WhatsApp **no está vinculado desde
   el 09-09 20:39** (sigue en `needs_qr` a las 12:38 de hoy); (d) el estado leído/no leído solo viaja WhatsApp → aquí.
5. **Ticks, citas, reacciones, ediciones y borrados no existen o son decorativos**: los ticks son un SVG fijo
   (`FloatingPhone.tsx:168`), las 708 citas están en `raw_json` pero no se sirven, las reacciones no se escuchan, un
   borrado deja el texto original visible.
6. **Baileys 6.7.23 sí da lo necesario para el mapeo LID↔teléfono** (`key.senderPn`, `Contact.lid`,
   `chats.phoneNumberShare`, `pnJid/lidJid` del history sync) pero **no trae almacén de mapeo** (`lidMapping` /
   `lid-mapping.update` no existen en esta versión): hay que mantenerlo aquí (ya existe `wa_lid_map`).
7. **Riesgo inminente:** al re-escanear el QR llegará un `messaging-history.set` que WhatsApp direcciona ya por LID.
   Con la ingesta actual, las conversaciones que hoy viven bajo `34…@s.whatsapp.net` volverán a entrar bajo `…@lid`
   → gemelos y mensajes repetidos a gran escala. Conviene decidir si el arreglo de identidad (P0) va **antes** del
   re-escaneo.
8. Tres cosas del checklist chocan con el guardián `check:nosend` y necesitan tu decisión, no la mía: enviar acuse
   de lectura al abrir (`readMessages`), fijar/archivar/silenciar desde aquí (`chatModify`) y presencia
   (`presenceSubscribe`).
9. Los grupos se ignoran a nivel de socket (`socket.ts:216`) por decisión previa. WhatsApp Web los enseña; el
   checklist los pide en P2. Otra decisión.
10. Nada de lo anterior requiere reescribir: son bloques pequeños sobre `ingest.ts`, `chats.ts`, `whatsappStore.tsx`
    y `FloatingPhone.tsx`, más un script de fusión en modo prueba para lo ya guardado.

---

## 1. Mapa de arquitectura

### 1.1 Dónde se crea el socket y cómo vive

| Pieza | Fichero | Detalle |
|---|---|---|
| Creación | `src/wa/socket.ts:195-220` | `makeWASocket` con `useMultiFileAuthState(config.authDir)`, `markOnlineOnConnect:false`, `shouldIgnoreJid = grupo ∨ newsletter`, sin `syncFullHistory` (428 verificado), sin `getMessage` (los reintentos de terceros sobre nuestros mensajes no se pueden servir). |
| Listeners externos | `socket.ts:57,92-98,226-228` | `onWaEvent()` guarda cada registro en `registrations[]` y lo **re-adjunta a cada socket nuevo**. `registerIngest()` se llama una vez (`index.ts:22`). |
| Reconexión | `socket.ts:241-249,315-333` | `close` ⇒ `teardownSocket()` (`end()` + `sock=null`) y backoff 1 s → 60 s. `loggedOut` ⇒ `resetSession()` borra `data/auth` y pide QR. Guardas `starting`/`shuttingDown` evitan solapes. |
| Estado hoy en prod | logs Railway 2026-09-11 | `needs_qr` en bucle: QR → 408 a los ~2:40 min → `close` → `connecting` a los 60 s → nuevo QR. Desde el 09-09 20:39 (Madrid). El `[campanas]` queda «en espera (offline)». |

### 1.2 Eventos de Baileys: qué se escucha y qué no

| Evento (6.7.23) | ¿Escuchado? | Dónde | Qué se hace |
|---|---|---|---|
| `connection.update`, `creds.update` | sí | `socket.ts:222-225` | estado + QR + guardar credenciales |
| `messaging-history.set` | sí | `ingest.ts:404` | `ingestChatShells` (jid, nombre, `conversationTimestamp`, `unreadCount`) + `ingestMessages` + nombres de contactos. **Ignora `chat.pnJid`/`chat.lidJid`** (están en el proto, `WAProto/index.d.ts:12428-12438`) y el campo `lid` que Baileys pone en cada contacto (`lib/Utils/history.js:35`). Nunca ha ocurrido en esta base (`meta.last_history_sync` no existe). |
| `messages.upsert` | sí | `ingest.ts:462` | `notify` y `append`. Solo `notify` descarga media, avisa a campañas y re-analiza. **`append` no es solo historial:** es también la re-entrega *offline* de lo que llegó con el sidecar caído (`lib/Socket/messages-recv.js:699`) y el eco de nuestros propios envíos (`messages-send.js:705`). |
| `messages.update` | parcial | `ingest.ts:532` | solo si trae `update.message` (contenido tardío o `editedMessage`). **Se ignoran** `update.status` (ticks: `messages-recv.js:543`) y `messageStubType: REVOKE` con `message:null` (borrados: `process-message.js:195-203`). |
| `contacts.upsert` / `contacts.update` | sí | `ingest.ts:574-575` | nombre (`name ?? verifiedName ?? notify`). `upsert` no pisa; `update` sí. **Se ignora `contact.lid`** (`lib/Types/Contact.d.ts:5`; lo rellena `contactAction` del app-state, `chat-utils.js:650-655`). |
| `chats.update` / `chats.upsert` | parcial | `ingest.ts:582-597` | solo `unreadCount` → marca `wa_read_at`. **Se ignoran** `archived`, `pinned`, `muteEndTime`, `markedAsUnread`, `conversationTimestamp`, `name`. |
| `labels.edit` / `labels.association` | sí | `ingest.ts:603-644` | catálogo y asociaciones por chat |
| `messages.reaction` | **no** | — | reacciones invisibles |
| `messages.delete` | **no** | — | «eliminar para mí» desde el móvil no se refleja |
| `message-receipt.update` | **no** | — | solo grupos (fuera de alcance hoy) |
| `chats.delete` | **no** | — | un chat borrado en el móvil sigue aquí |
| `chats.phoneNumberShare` | **no** | — | `{lid, jid}` cuando el contacto comparte número (`messages-recv.js:642-645`) |
| `presence.update` | **no** | — | requiere `presenceSubscribe(jid)` |
| `messages.media-update`, `blocklist.*`, `call` | **no** | — | — |

### 1.3 Cómo se guardan los datos (`src/db/schema.sql` + `db.ts:migrate`)

- `chats(jid PK, phone, display_name, last_message_at, last_message_preview, last_opened_at, ignored, wa_read_at, …)`.
  `phone` = **solo móvil español de 9 dígitos** (`jidPhone.ts:15,48-57`); internacionales y `@lid` → `NULL`.
- `messages(chat_jid, id) PK`, `ts` epoch s, `type`, `text`, `media_path`, `raw_json`. Índice `(chat_jid, ts DESC)`.
  `ON CONFLICT DO NOTHING` ⇒ idempotente **por jid**; el mismo `id` bajo otro jid es otra fila.
- `wa_lid_map(lid PK, pn, phone, source)` (`lidMap.ts`): se alimenta de `key.senderPn` (entrantes) y de `onWhatsApp`
  (`resolve-lids`). Nunca de `contacts.*`, `phoneNumberShare` ni del history sync.
- `chat_lead_links`, `lead_directory` (CRM), `wa_labels`, `wa_chat_labels`, `campana_marcas`, `wa_send_audit`.
- Escritores de `chats.last_message_at`: `ingest.ts:134-144` (upsert por cada mensaje **con o sin insert**),
  `ingest.ts:559` (contenido tardío, con `now`), `send.ts:179,267` (envío manual/campaña, con `now` tras el `await`),
  `import.ts:64`, `admin.ts:202-215` (fusión). Nadie lo recalcula desde `messages`.

### 1.4 Cómo llegan los cambios al frontend

```
Baileys ──▶ ingest.ts ──▶ SQLite ──▶ emitSse()  ──▶ GET /events (SSE, ping 25 s)
                                                        │
 dashboard/app/api/whatsapp/[...path]/route.ts (proxy, propaga signal/Range) ◀──┘
                                                        │
 store/whatsappStore.tsx: EventSource + backoff 1→15 s + watchdog 40 s + catch-up al reconectar/visibilitychange/online
   · message.new / chat.updated / chats.synced ⇒ refreshChats() (debounce 300 ms) = GET /chats?limit=200
   · message.new del chat activo o de un gemelo ⇒ fetchLatest(jid) = GET /chats/:jid/messages?limit=50 por cada gemelo
   · respaldo: status 10 s, lista 45 s, conversación abierta 5 s
```

Eventos SSE existentes: `ping`, `connection`, `message.new`, `chat.updated`, `labels.updated`, `chats.synced`
(`shared/whatsapp-contracts.ts:153-162`). No hay evento de «mensaje borrado/editado/reaccionado» ni de «estado de
mensaje».

### 1.5 Frontend del teléfono flotante

| Qué | Dónde | Cómo |
|---|---|---|
| Lista | `FloatingPhone.tsx:746-865` | `unificarGemelos(chats)` (`lib/whatsapp/gemelos.ts`) funde por **teléfono ES** las filas cargadas; filtro no leídos / sin contestar; orden `lastMessageAt DESC`, desempate `jid`. |
| Fila | `FloatingPhone.tsx:1003-1054` | nombre, «también: …», hora, preview, globo. Sin «Tú:», sin fijado, sin silenciado, sin archivado. |
| Conversación | `whatsappStore.tsx:300-349` | `fetchLatest` pide los 50 últimos de **cada gemelo** y concatena **sin deduplicar por `id`** (`latestAsc = vivas.flatMap(...)`). Purga los `tmp-` optimistas. |
| Envío optimista | `whatsappStore.tsx:396-434` | `tmp-<ms>` → tras `ok` `fetchLatest` lo sustituye por el real (mismo `id` del sidecar). Correcto. |
| Leído | `whatsappStore.tsx:371-380` | `POST /chats/:jid/opened` en todos los gemelos (marca **local**); no se envía acuse a WhatsApp. |
| Scroll | `FloatingPhone.tsx:1527-1536` | pegado al fondo si estabas a <120 px; «Cargar mensajes anteriores» por botón (no al subir); no abre en el primer no leído; al cargar más, no conserva la posición. |
| Horas | `FloatingPhone.tsx:87-108` | `toLocaleTimeString`/`toLocaleDateString` = zona del navegador (como WhatsApp Web) sobre epoch UTC. Correcto. |
| Ticks | `FloatingPhone.tsx:168-176` | doble check **fijo** para todo saliente. |
| Pie | `FloatingPhone.tsx:977-982` | «Conectado · escritura manual» con punto verde **aunque WhatsApp esté desvinculado** (solo mira que exista `status.me`). La píldora de fuera sí dice «Vincular móvil». |

---

## 2. ¿Cuántos sockets pueden estar vivos?

| Escenario | Instancias | Evidencia |
|---|---|---|
| Producción (Railway `content-adventure` / `csa-whatsapp-service`) | **1** | `Dockerfile` → `CMD ["npx","tsx","src/index.ts"]` (sin `watch`); servicio con volumen ⇒ una réplica; `railway status` muestra un único deployment activo. Un deploy para el contenedor viejo antes de arrancar el nuevo (corte de 30-90 s, ya documentado). |
| Reconexión dentro del proceso | 1 | `teardownSocket()` hace `end()` y suelta el objeto; el nuevo socket recibe los mismos `registrations`. Los listeners del viejo mueren con él. Si Baileys vacía su búfer al cerrar, la ingesta es idempotente por PK (a lo sumo un `emitSse` de más). |
| Desarrollo local (`INICIAR DASHBOARD + WHATSAPP.bat:19`) | 1 por proceso, pero **`tsx watch`** reinicia al guardar: durante ~1 s conviven el proceso que muere y el nuevo, ambos con `data/auth` local. | Hoy no hay ningún sidecar local corriendo (puerto 3211 libre, sin `node tsx src/index`). Existe un emparejamiento local (`data/auth`, 1.002 ficheros). |
| Backup restaurado en otra máquina | **peligro real** | El backup diario **incluye `data/auth`** (`src/brain/backup.ts`, memoria `backups-supabase-storage`). Si alguien lo restaura y arranca con `WA_CONNECT` encendido mientras prod está vinculado, WhatsApp expulsa a uno de los dos (440/401). Hoy no aplica porque prod está desvinculado; después del re-escaneo, sí. |

**Conclusión:** los eventos no se duplican por doble instancia. Se duplican por doble **jid** (§3.1).

---

## 3. Diagnóstico con evidencia

Cifras de la copia del 2026-09-11 (1.760 chats, 29 ignorados; 69.177 mensajes; 1.319 `@s.whatsapp.net` + 441 `@lid`;
0 jids con sufijo de dispositivo `:N`; 0 `@c.us`).

### 3.1 Identidad y duplicados

| Hecho medido | Cifra | Qué significa |
|---|---|---|
| Personas (por teléfono) con **2 filas de chat vivas** | **93** (92 con mensajes en ambas) | Una fila `34…@s.whatsapp.net` donde escribimos nosotros (campaña, teléfono flotante) y una `…@lid` por donde contesta la persona o por donde le escribe Fran desde el móvil. |
| …con las dos filas activas en los últimos 30 días / 7 días | **42 / 41** | No es residuo histórico: pasa cada semana. |
| Mismo `id` de mensaje en las dos filas | 16 (9 con `ts` distinto) | Nuestro envío se guarda dos veces: `send.ts` lo persiste bajo el jid al que enviamos con `ts = ahora` tras el `await`, y el eco de Baileys llega bajo el otro jid con su propio `messageTimestamp`. En pantalla, al fundir gemelos, la burbuja sale **dos veces** (`fetchLatest` no deduplica por `id`). |
| `@lid` sin teléfono resoluble (ni `chats.phone` ni `wa_lid_map`) | **134**, **90 activos** en 30 días | 89 de los 90 solo tienen mensajes **salientes**: son contactos a los que Fran escribió desde el móvil; WhatsApp los entrega como `fromMe` con `remoteJid=@lid` y **sin `senderPn`** (0 de 5.395 salientes `@lid` lo traen). Sin teléfono no hay forma de fundirlos con la fila `34…@s.whatsapp.net` de la campaña ⇒ la persona sale dos veces con «último mensaje» distinto. |
| Entrantes `@lid` con `senderPn` | 3.125 de 3.126 | El rescate en vivo funciona; el hueco son los chats donde la persona **aún no ha contestado**. |
| Internacionales (`@s.whatsapp.net` no ES) | 71 chats con `phone NULL` | No hay E.164: `telefonoDeChat` solo agrupa móviles ES ⇒ un extranjero con `@lid` y con número nunca se funde. |
| Duplicado **dentro** del mismo chat (mismo `from_me+ts+texto`, ids distintos) | 52, **51 del 17-07** | Solape entre la importación del iPhone (ids `ios…`) y el primer volcado de Baileys. Se ven como burbujas repetidas ese día. |
| Chats con más de un vínculo CRM activo | 161 | `/chats` ya desempata; el índice sí, pero la ficha/CRM pueden discrepar. |
| `wa_chat_labels` cuyo `chat_jid` no existe en `chats` | 818 de 1.497 | Las etiquetas del móvil llegan con jids que aquí no tenemos (grupos ignorados y `@lid`/`@s.whatsapp.net` del gemelo ausente). Una etiqueta puesta al gemelo que no vemos no se pinta. |

**Causa raíz (código):** `ingestMessages` toma `jid = msg.key.remoteJid` tal cual (`ingest.ts:227`) y `upsertChat` crea
una fila por jid (`ingest.ts:236-243`). No existe una capa de «identidad canónica del chat» antes de escribir. Baileys
6.7.23 ofrece los datos para construirla (`key.senderPn`, `Contact.lid`, `chats.phoneNumberShare`, `pnJid`/`lidJid`
del history sync, `onWhatsApp`) pero **no** un almacén propio de mapeo LID↔PN (comprobado: ni `lidMapping` ni
`lid-mapping.update` existen en `node_modules/baileys/lib`).

### 3.2 Orden de la lista

| Hecho medido | Cifra |
|---|---|
| Chats no ignorados con `last_message_at` **posterior** a su último mensaje real | **99** (87 anteriores al 17-07: vienen de la importación del iPhone; **12 de la era Baileys**) |
| Los 12 de la era Baileys, todos `@lid` | adelantos de 7 s a 205 min; `last_message_at = updated_at` (escritura sin mensaje) en 8 |
| Su `last_message_preview` es el texto de… | en 8 de 12, **un mensaje propio anterior ya guardado** (`from_me=1`, status SERVER_ACK) en el mismo chat; en 1, ninguno guardado |
| Correlación con deploys | ninguna (deploys del 08-09 a las 12:20/14:07/14:22/14:40/16:11/16:15/16:24 Madrid; saltos a las 17:16/18:05/18:06) |
| Preview ≠ último mensaje guardado (era Baileys) | 7 de 522 (el resto de los 1.181 discordantes son pre-Baileys) |

**Causa raíz (código):** `upsertChat` se ejecuta **antes** de `upsertMessage` y para **todos** los mensajes con
contenido, se inserten o no (`ingest.ts:236-252`): una re-entrega de un mensaje ya guardado con un `messageTimestamp`
posterior sube el chat sin que exista un mensaje a esa hora. Además `send.ts:166-182` usa `ts = ahora` después del
`await sendMessage`, distinto del `messageTimestamp` del eco (de ahí los saltos de segundos y los 9 ids con dos `ts`).
Nadie recalcula `last_message_at` desde `messages`. En WhatsApp el orden es `conversationTimestamp` (Baileys lo emite en
`chats.update`, `process-message.js:99`, y en el history sync) y aquí se ignora.

Sobre la lista del dashboard: `GET /chats` ordena por `last_message_at DESC` **sin desempate** (`chats.ts:206`) y el
cliente carga **200** filas (`whatsappStore.tsx:261`) de 405 activas en 30 días; los gemelos cuya otra fila cae fuera
de esas 200 **no se funden** (`unificarGemelos` solo ve lo cargado) y la conversación abierta no incluye su historial
(`jidsGemelos` usa `chatsRef.current`). El desempate por `jid` en el cliente (`FloatingPhone.tsx:859-864`) es correcto.

### 3.3 Desfase entre el móvil y el teléfono flotante

| Fuente del desfase | Evidencia | Efecto |
|---|---|---|
| **WhatsApp desvinculado** desde el 09-09 20:39 (Madrid) | logs de hoy: bucle `needs_qr` → 408 → `connecting`; `[campanas] en espera (offline)` | Nada de lo escrito o recibido desde entonces existe aquí. Hasta que Fran escanee el QR, todo lo demás es secundario. |
| Mensajes recibidos con el sidecar caído llegan como `append` | `messages-recv.js:699` (`node.attrs.offline ? 'append' : 'notify'`); `ingest.ts:474-478` trata `append` como historial | Tras cada deploy (7 el 08-09), lo que entró durante el corte se guarda **sin media, sin aviso a campañas y sin re-análisis**. La lista sí se refresca (`message.new`). |
| Estado leído solo WhatsApp → aquí, y **monótono** | `readState.ts:53-83`; `applyWaRead` con `unreadCount=N` necesita ≥N entrantes guardados en **esa fila** | Con gemelos, el globo de la persona se calcula fila a fila; «marcar como no leído» en el móvil no se refleja; 199 chats sin `wa_read_at` (creados después de la línea base). Abrir aquí no lo marca leído en el móvil (guardián). |
| Ventana de 200 chats | `whatsappStore.tsx:261` | Un evento `message.new` de un gemelo no cargado no refresca la conversación abierta (`esMismaConversacion` no lo conoce). |
| Sin history sync al reconectar con credenciales | `meta.last_history_sync` inexistente; memoria `no-leidos-espejo-whatsapp` | Los huecos de una desconexión larga solo se cierran con re-emparejamiento. |
| Nombres | `ingest.ts:239` pone el `pushName` al crear el chat; `contacts.upsert` no pisa (`overwrite=false`) | El nombre de agenda de Fran solo gana si llega un `contacts.update`. 481 chats con nombre = número, 167 sin nombre. |
| Pie del teléfono | `FloatingPhone.tsx:981` | Dice «Conectado» con WhatsApp desvinculado. |

### 3.4 Mensajes que se pierden o se representan mal

| Caso | Hoy | Dónde |
|---|---|---|
| Borrado («Se eliminó este mensaje») | el texto original sigue visible; el evento llega (`messages.update` con `messageStubType=REVOKE`, `process-message.js:195`) y se descarta por `!upd.message` | `ingest.ts:543` |
| Edición | se sustituye el texto en silencio, sin «Editado» | `ingest.ts:546-547` |
| Reacciones | no se escuchan | — |
| Citas (respuesta a un mensaje) | 708 mensajes con `contextInfo.quotedMessage` en `raw_json`; `/chats/:jid/messages` no lo devuelve | `chats.ts:306-311` |
| Ticks | SVG fijo; el `status` real llega por `messages.update` y se ignora (en `raw_json` solo queda el estado del momento de guardar: 5.242 SERVER_ACK, 132 DELIVERY, 20 READ) | `FloatingPhone.tsx:168`, `ingest.ts:543` |
| Media entrante con el sidecar caído | no se descarga (llega como `append`) | `ingest.ts:475` |
| Stickers, contactos, listas, plantillas, álbumes | tipo `other`, «Mensaje no compatible» (1.852 filas) | `ingest.ts:84-94` |
| Ver una vez / efímeros | se desenvuelven y se guardan como normales | `ingest.ts:48-53` |
| Encuestas, ubicaciones | `other` | — |
| Grupos, difusión, estados, canales | ignorados a nivel de socket / ingesta | `socket.ts:216`, `jidPhone.ts:43` |

---

## 4. Lo que Baileys 6.7.23 permite (comprobado en `node_modules/baileys/lib`)

- **Identidad LID:** `WAMessageKey` lleva `senderPn`, `senderLid`, `participantPn`, `participantLid`
  (`Types/Message.d.ts:16-23`, rellenados en `Utils/decode-wa-message.js:90-94`). `Contact.lid`
  (`Types/Contact.d.ts:5`), rellenado por el history sync (`Utils/history.js:32-37`) y por la agenda del móvil
  (`Utils/chat-utils.js:650-656`). `chats.phoneNumberShare {lid, jid}` (`Socket/messages-recv.js:642-645`).
  `proto.IConversation.pnJid` / `lidJid` en cada chat del history sync. `onWhatsApp(jid)` → `{jid, exists, lid}`.
  **No existe** `signalRepository.lidMapping` ni el evento `lid-mapping.update` (versiones posteriores).
- **Utilidades de jid:** `jidNormalizedUser` (quita `:dispositivo`), `jidDecode`, `areJidsSameUser`, `isLidUser`,
  `isJidUser` (`WABinary/jid-utils.d.ts`). Nuestros datos ya vienen sin sufijo (0 jids con `:`), pero conviene
  normalizar en la entrada.
- **Orden:** `chats.update` con `conversationTimestamp` en cada mensaje real (`process-message.js:96-103`;
  «real» excluye protocolo, reacciones y votos de encuesta: `isRealMessage`, `process-message.js:46-57`).
- **Estado de la app (móvil → aquí), sin escribir nada:** `chats.update` con `muteEndTime`, `archived`,
  `pinned`, `markedAsUnread`/`unreadCount`; `messages.delete` (eliminar para mí); `contacts.upsert` (nombre y `lid`);
  `labels.*`; `chats.delete`. Todo llega por el app-state sync (`resyncAppState`, ya usado en `labels.ts:87`).
- **Mensajes:** `messages.update {status}` para ticks 1-a-1 (`messages-recv.js:543-547`), `message-receipt.update`
  para grupos, `messages.reaction`, `REVOKE` y `MESSAGE_EDIT` por `messages.update`, `messages.upsert.type` =
  `notify` (en vivo) | `append` (offline, propios, notificaciones, boletines).
- **Presencia:** `presence.update` tras `presenceSubscribe(jid)`.
- **Prohibido por `scripts/check-nosend.ts`:** `sendMessage` (salvo `send.ts`), `relayMessage`, `sendReceipt`,
  `readMessages`, `chatModify`, `sendPresenceUpdate`, `addChatLabel`/`removeChatLabel` (salvo `labels.ts`).
  `presenceSubscribe` y `resyncAppState` no están en la lista.

---

## 5. Riesgo inminente: el re-escaneo del QR

Al emparejar de nuevo llega `messaging-history.set` (INITIAL_BOOTSTRAP + RECENT). WhatsApp direcciona ya la mayoría de
chats 1-a-1 por LID, y este volcado **nunca ha entrado en esta base**. Con la ingesta actual:

- las conversaciones que hoy viven bajo `34…@s.whatsapp.net` (campañas, envíos manuales, importación del iPhone)
  volverán a entrar bajo `…@lid` → **nuevos gemelos y los mismos mensajes repetidos** (mismo `id`, otro jid);
- lo importado del iPhone con ids `ios…` que solape con el volcado se duplicará dentro del mismo chat (ya pasó el
  17-07: 51 casos);
- los `chats[]` del volcado traen `pnJid`/`lidJid` y `unreadCount`: es la mejor oportunidad para cerrar el mapeo
  LID↔teléfono de los 134 `@lid` huérfanos… si la ingesta los lee.

Recomendación: cerrar el bloque P0 de identidad **antes** de escanear, o asumir la limpieza posterior con el script de
fusión en modo prueba. Es tu decisión; ambas vías están cubiertas en la Fase 2.

---

## 6. Decisiones que necesito de ti antes de la Fase 2

1. **Acuse de lectura al abrir un chat** (`readMessages`): el checklist lo pide; el guardián lo prohíbe y la memoria
   dice «decisión de producto del usuario». ¿Se abre una puerta estrecha (solo desde el teléfono flotante, auditada)?
2. **Fijar / archivar / silenciar desde aquí** (`chatModify`): mismo dilema. Leerlo del móvil sí se puede sin tocar
   el guardián.
3. **Presencia** («escribiendo…», en línea): `presenceSubscribe` no está prohibido, pero es una escritura hacia
   WhatsApp (suscripción). ¿Se activa?
4. **Grupos:** hoy se ignoran a nivel de socket. ¿Los quieres en la lista (P2) o siguen fuera?
5. **Fusión física de gemelos ya guardados:** el 06-08 se descartó mover historial (37 pares, 2.347 mensajes). Con
   93 pares vivos y 41 activos cada semana, la fusión en pantalla no basta para el orden ni para los no leídos.
   Propongo un script en modo prueba con informe y copia de seguridad; lo ejecutas tú con tu OK.
6. **Versión de Baileys:** 6.7.23 sirve para todo lo P0/P1 con el mapeo mantenido aquí. Subir de versión (7.x trae
   almacén LID nativo) es un cambio de riesgo para el emparejamiento; no lo propongo ahora.

---

## 7. Plan de Fase 2 (bloques pequeños, por prioridad)

**P0 — identidad y deduplicación (sidecar)**
- B1. Capa de identidad en la ingesta: normalizar jid (`jidNormalizedUser`, `@c.us`→`@s.whatsapp.net`), resolver
  LID→PN con `wa_lid_map` **antes** de escribir, y alimentar el mapa desde `senderPn`, `contacts.*.lid`,
  `chats.phoneNumberShare` y `pnJid/lidJid` del history sync. Un chat canónico por persona; el jid LID se guarda
  como alias.
- B2. `last_message_at`/`preview` solo cuando el mensaje **se inserta**, y recálculo desde `messages`; `send.ts` usa
  el `messageTimestamp` del resultado y no `ahora`.
- B3. Tratar `append` con `requestId`/offline como en vivo (media, campañas, análisis).
- B4. Script `dry-run` de fusión de gemelos existentes (informe + backup) → espera tu OK.

**P0 — dashboard**
- B5. `fetchLatest` deduplica por `id` al unir gemelos; lista con desempate en el servidor; ventana de gemelos
  independiente de los 200.
- B6. Pie del teléfono ligado al estado real; indicador de conexión también dentro de la conversación.

**P1 — mensajes**
- B7. `messages.update {status}` → ticks reales; `REVOKE` → «Se eliminó este mensaje»; edición → «Editado»;
  `messages.reaction` → reacciones; citas servidas desde `raw_json`.
- B8. Lectura del app-state (`archived`, `pinned`, `muteEndTime`, `markedAsUnread`) → lista como WhatsApp Web.
- B9. Scroll: abrir en el primer no leído, cargar al subir manteniendo la posición.

**P2** — grupos y presencia, según decisiones 3 y 4.

**Fase 3** — tests de normalización/LID/E.164, idempotencia (mismo evento ×3 = 1 mensaje), orden y reconciliación
optimista; guion manual lado a lado; checklist actualizado.

---

## Anexo — cómo se midió

- Copia de la base: `railway run --service csa-whatsapp-service … node bajar-backup-wa.mjs` (bucket privado
  `csa-backups/sidecar/2026-09-11-wa.sqlite3.gz`, marca `ultimoMensajeTs 1788979182`). **Borrada al terminar.**
- Consultas: `auditoria-wa.cjs`, `-2`, `-3`, `-4`, `-5` (solo lectura, `better-sqlite3` `readonly`), en el
  scratchpad de la sesión. Imprimen recuentos y jids ofuscados; nunca textos ni nombres.
- Logs: `railway logs --service csa-whatsapp-service --environment production` (2026-09-11 08:51Z → 10:38Z).
- Baileys: `npm ls baileys` → 6.7.23; tipos y fuentes citados de `node_modules/baileys/lib`.
