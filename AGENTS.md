# 🚦 Sidecar WhatsApp — reglas de deploy (crítico, hay VARIAS sesiones a la vez)

Este servicio corre en Railway con **VOLUMEN** (`/data`, ahí vive `wa.sqlite3` con
60k+ mensajes) → **CADA deploy corta el servicio ~30-90s SIN remedio** (Railway no
puede solapar contenedores con volumen). Mientras está caído, el dashboard pierde
Fransua/intel/chats/agenda. Fran lo usa a diario.

## PACTO DE DEPLOYS (obligatorio)
1. **Push = deploy = corte.** Commitea en local libremente; **pushea SOLO al cerrar
   una feature verificada** (máx ~1 push/hora). Nada de push-por-commit ni "probar en prod".
2. Mejor **fuera del horario de Fran (L-V ~9-18h)** salvo urgencia.
3. **Turno de deploy**: antes de push/variables/redeploy mira
   `../dashboard/.deploy-lock.json` y `railway status`. Deploy en curso o lock
   tomado < 20 min → ESPERA. Toma el lock para desplegar y libéralo al verificar.
4. **PRODUCCIÓN = proyecto Railway `content-adventure`** (su `csa-whatsapp-service`
   es el que usa el dominio real del dashboard). `enchanting-recreation` es un
   DUPLICADO con los mismos nombres conectado al mismo repo: variables puestas ahí
   se pierden, y un push despliega en LOS DOS.
5. Protocolo completo: **`../dashboard/DEPLOY-COORDINATION.md`**.

## 🔴 BAILEYS ESTÁ ENCENDIDO EN PROD Y **NO SE APAGA** (decisión del usuario, 28-07-2026)

**`WA_CONNECT=on` es lo CORRECTO en producción. NO lo pongas a `off`.**

Esta regla decía justo lo contrario hasta el 28-07-2026 ("Baileys apagado, el
directo llegará por Coexistence"). Era un plan de futuro que **no se ha
cumplido todavía**: Coexistence (Cloud API) está *por integrar* — al usuario le
falta documentación de Meta. Mientras eso no ocurra, **Baileys es la ÚNICA vía por
la que entran los mensajes de WhatsApp** (verificado 28-07: el webhook de
Coexistence recibió 2 peticiones en 24 h y ambas eran pruebas; los mensajes reales
llegan por Baileys — `state: "open"`, 61.901 mensajes).

⚠️ **Si apagas `WA_CONNECT`, Fran deja de recibir WhatsApp.** No es una mejora de
seguridad ni una limpieza: es una caída total de la función. Si algún día ves la
incoherencia "la doc dice off pero está on", la doc que hay que creer es ESTA.

Cuando Coexistence esté integrado de verdad, el webhook ya está preparado y
protegido con firma (`WA_APP_SECRET` + `WA_APP_SECRET_ENFORCE=true`, ver
`../dashboard/DOCS/SECRETOS-META-GUIA.md`) — la transición no requiere apagar
Baileys de golpe.

## ✍️ ENVÍO MANUAL: permitido SOLO en `src/wa/send.ts` (decisión del usuario, 29-07-2026)

Este servicio dejó de ser 100% solo-lectura: desde el **teléfono flotante** del
dashboard se puede **RESPONDER**. La garantía no se borró, se **acotó**:

- `npm run check:nosend` sigue siendo obligatorio y falla si `sendMessage`
  aparece en **cualquier fichero de `src/` que no sea `src/wa/send.ts`**. El resto
  de tokens (`relayMessage`, `sendReceipt`, `readMessages`, `chatModify`,
  `sendPresenceUpdate`) siguen **prohibidos en TODAS partes**.
- **Fransua NO puede enviar.** Todo `src/ai/` y `src/brain/` tiene vetado el
  token: el agente puede *sugerir* texto, pero la única salida es la ruta
  `POST /chats/:jid/send`, que llama una persona desde la interfaz.
- Salvaguardas en `send.ts`: solo texto (1..4096), solo chats 1-a-1 **ya
  existentes** (no inicia conversaciones frías), ritmo mínimo 1,5 s entre envíos
  y tope de 30 por 5 min, y **auditoría** en `wa_send_audit` (actor, chat,
  longitud, cuándo).

⚠️ Si alguna vez hay que automatizar respuestas, **NO se hace ampliando esta
allowlist**: es una decisión de producto y de riesgo de cuenta que debe tomar el
usuario explícitamente.

## 🏷️ ETIQUETAS: permitido SOLO en `src/wa/labels.ts` (decisión del usuario, 30-07-2026)

Las **etiquetas de WhatsApp Business son BIDIRECCIONALES**: lo que se marca en el
teléfono flotante del dashboard se escribe en WhatsApp, y lo que Fran etiqueta
desde el móvil aparece aquí. Mismo patrón de acotación que el envío:

- `check:nosend` prohíbe **`addChatLabel`/`removeChatLabel` en todo `src/`
  salvo `src/wa/labels.ts`**. Fransua (`src/ai/`, `src/brain/`) NO puede
  etiquetar: no se le ha dado la herramienta ni podría nombrarla.
- **`chatModify` sigue prohibido SIN excepción, ni siquiera ahí.** Es la puerta
  ancha (marca como leído, archiva, silencia) y no la usamos: `addChatLabel` /
  `removeChatLabel` son la puerta estrecha, y etiquetar no envía nada ni toca
  los acuses de lectura.
- Orden de escritura en `setChatLabel`: **primero WhatsApp, después el espejo
  local**. Si WhatsApp rechaza, la copia local no se toca — nunca se enseña una
  etiqueta que allí no existe. Auditoría en `wa_label_audit`.
- El catálogo (`wa_labels`) se llena con los eventos `labels.edit` de la
  sincronización de estado. Si Fran crea una etiqueta nueva en el móvil,
  `POST /labels/resync` se la pide a WhatsApp (botón "Traer etiquetas nuevas"
  en el menú de los 3 puntos).

## Datos que no se tocan a la ligera
- El volumen `/data` PERSISTE entre deploys (verificado); las "pérdidas" históricas
  fueron crashes por repo mal conectado, no borrados.
- **`/data/auth` = el EMPAREJAMIENTO de Baileys.** Si se pierde, WhatsApp se
  desconecta y hay que **volver a escanear el QR a mano desde el móvil de Fran**.
  Nunca lo borres "para limpiar"; `POST /session/reset` lo borra a propósito y solo
  debe usarse si el emparejamiento ya está roto.
