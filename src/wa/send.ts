/**
 * ENVÍO MANUAL de mensajes — el ÚNICO fichero del servicio autorizado a usar la
 * API de publicación de Baileys (decisión del usuario, 2026-07-29: puede
 * responder desde el teléfono flotante del dashboard; todo escrito A MANO).
 *
 * El guardián `npm run check:nosend` permite el token de publicación SOLO aquí:
 * cualquier otro fichero de src/ que lo nombre (incluido TODO src/ai/ y
 * src/brain/ — Fransua) rompe la verificación. Es la garantía mecánica de que
 * el envío jamás se automatiza: Fransua puede SUGERIR texto, pero la única vía
 * de salida es esta, invocada por la ruta HTTP que llama la interfaz tras el
 * login del dashboard.
 *
 * Salvaguardas anti-accidente (no anti-humano):
 *  - Ritmo: mínimo 1,5 s entre envíos y máximo 30 por ventana de 5 min — un
 *    humano escribiendo no lo nota; un bucle descontrolado se corta en seco.
 *  - Solo texto plano, 1..4096 caracteres, a chats 1-a-1 ya conocidos.
 *  - Auditoría: cada envío queda en wa_send_audit (quién, a quién, cuándo).
 *  - El mensaje se persiste al instante (mismo esquema que la ingesta) y se
 *    emite `message.new` → aparece en la interfaz sin esperar al eco.
 */
import { getDb } from "../db/db";
import { emitSse } from "../http/sse";
import { isStorableChatJid, jidToPhone } from "./jidPhone";
import { avisarSalienteManual } from "../campanas/manual";
import { getActiveSocket, lookupLids } from "./socket";
import { MEDIA_MAX_BYTES, extFromMime, saveMediaBuffer } from "./mediaStore";
import { aprenderMapeo, canonicoDe } from "./canonico";
import { registrarMensajePropio, tsOf } from "./ingestCore";

const MIN_GAP_MS = 1_500;
const WINDOW_MS = 5 * 60_000;
const MAX_PER_WINDOW = 30;

let lastSendAt = 0;
let windowStart = 0;
let windowCount = 0;

/** Comparten el mismo contador de ritmo que el texto: no hay una vía más rápida
 *  para colarse por ser "adjunto" en vez de "mensaje". */
function checkRate(): { ok: true } | { ok: false; error: string } {
  const now = Date.now();
  if (now - lastSendAt < MIN_GAP_MS) return { ok: false, error: "Demasiado rápido — espera un segundo y reenvía." };
  if (now - windowStart > WINDOW_MS) {
    windowStart = now;
    windowCount = 0;
  }
  if (windowCount >= MAX_PER_WINDOW) return { ok: false, error: "Límite de ritmo alcanzado (30 mensajes / 5 min). Espera un poco." };
  return { ok: true };
}
function markSent(): void {
  lastSendAt = Date.now();
  windowCount++;
}

export type SendMsgType = "text" | "image" | "audio" | "document";
export type SendResult =
  | { ok: true; message: { id: string; chatJid: string; fromMe: true; ts: number; type: SendMsgType; text: string | null; mediaUrl: string | null } }
  | { ok: false; error: string; code: "offline" | "invalid" | "rate" | "unknown-chat" | "fail" | "too-big" };

function ensureAuditTable(): void {
  const db = getDb();
  db.exec(
    `CREATE TABLE IF NOT EXISTS wa_send_audit (
       id INTEGER PRIMARY KEY,
       chat_jid TEXT NOT NULL,
       actor TEXT,
       chars INTEGER NOT NULL,
       wa_msg_id TEXT,
       created_at INTEGER NOT NULL
     )`
  );
  // Columnas añadidas para adjuntos (migración perezosa: SQLite no tiene
  // "ADD COLUMN IF NOT EXISTS", se ignora el error si ya existían).
  for (const ddl of [
    `ALTER TABLE wa_send_audit ADD COLUMN kind TEXT NOT NULL DEFAULT 'text'`,
    `ALTER TABLE wa_send_audit ADD COLUMN bytes INTEGER`,
  ]) {
    try {
      db.exec(ddl);
    } catch {
      /* ya existía */
    }
  }
}

/** Chat existente + socket abierto — la comprobación común a texto y a media. */
/**
 * ⚠️ CHAT NUEVO (conversación en frío) — decisión del usuario 2026-09-07.
 *
 * Hasta hoy esta función exigía que el chat YA EXISTIERA, y era la salvaguarda
 * que impedía escribir a alguien que nunca nos ha escrito. Se abre una puerta
 * ESTRECHA porque de los 175 candidatos del taller de microtornillos solo 49
 * tenían conversación, y el usuario quiso llegar al resto sabiendo el riesgo
 * (se le advirtió tres veces: es el patrón que provoca cierres de cuenta).
 *
 * La puerta es estrecha de verdad:
 *  - Hay que pedirlo explícitamente por llamada (`permitirChatNuevo`), y solo lo
 *    pide el worker de campañas cuando la campaña lo tiene activado. El envío
 *    manual del teléfono flotante NUNCA lo pasa: sigue exigiendo chat existente.
 *  - Antes de escribir se PREGUNTA A WHATSAPP si ese número existe
 *    (`lookupLids` → `onWhatsApp`). Escribir a números que no están en WhatsApp
 *    genera errores en cadena y es una señal de lista comprada.
 */
async function requireOnlineChat(
  jidCrudo: string,
  permitirChatNuevo: boolean,
): Promise<
  | { ok: true; sock: NonNullable<ReturnType<typeof getActiveSocket>>; esNuevo: boolean; jid: string }
  | { ok: false; error: string; code: "invalid" | "unknown-chat" | "offline" }
> {
  // Se trabaja siempre con el jid CANÓNICO de la persona (un @lid con teléfono
  // conocido cae en su chat del teléfono): así el mensaje se guarda en la misma
  // fila en la que lo encontrará el eco de WhatsApp.
  const jid = canonicoDe(jidCrudo);
  if (!jid || !isStorableChatJid(jid)) return { ok: false, error: "Destino no válido (solo chats 1-a-1).", code: "invalid" };
  const sock = getActiveSocket();
  if (!sock) return { ok: false, error: "WhatsApp no está conectado ahora mismo.", code: "offline" };

  const chat = getDb().prepare("SELECT jid FROM chats WHERE jid = ?").get(jid) as { jid: string } | undefined;
  if (chat) return { ok: true, sock, esNuevo: false, jid };

  if (!permitirChatNuevo) {
    return { ok: false, error: "Ese chat no está en el historial.", code: "unknown-chat" };
  }

  // Comprobar que el número está en WhatsApp antes de estrenar conversación.
  const res = await lookupLids([jid]);
  const existe = res.some((r) => r.exists);
  if (!existe) {
    return { ok: false, error: "Ese número no está en WhatsApp.", code: "unknown-chat" };
  }
  // La consulta devuelve el LID de ese teléfono: se aprende ya, para que su
  // respuesta (que llegará por el @lid) caiga en este mismo chat.
  for (const r of res) if (r.lid) aprenderMapeo(r.lid, jid, "onWhatsApp");
  return { ok: true, sock, esNuevo: true, jid };
}

/**
 * Crea la fila del chat cuando se estrena conversación.
 *
 * Sin esto el mensaje quedaría HUÉRFANO: `messages` tendría la fila pero
 * `chats` no, y el teléfono flotante —que lista desde `chats`— no enseñaría la
 * conversación. Se descubrió al montar el envío en frío.
 */
function asegurarChat(jid: string, ts: number): void {
  getDb()
    .prepare(
      `INSERT INTO chats (jid, phone, display_name, last_message_at, last_message_preview, created_at, updated_at)
       VALUES (?, ?, '', ?, '', ?, ?)
       ON CONFLICT(jid) DO NOTHING`
    )
    .run(jid, jidToPhone(jid), ts, ts, ts);
}

/** Envía TEXTO plano a un chat 1-a-1 existente. Escrito a mano por una persona. */
export async function sendText(
  jidPedido: string,
  rawText: string,
  actor: string | null,
  opts: { permitirChatNuevo?: boolean } = {},
): Promise<SendResult> {
  const text = String(rawText ?? "").trim();
  if (!text || text.length > 4096) {
    return { ok: false, error: "El mensaje debe tener entre 1 y 4096 caracteres.", code: "invalid" };
  }
  const known = await requireOnlineChat(jidPedido, opts.permitirChatNuevo === true);
  if (!known.ok) return known;
  const jid = known.jid;
  const rate = checkRate();
  if (!rate.ok) return { ok: false, error: rate.error, code: "rate" };

  const db = getDb();
  try {
    const result = await known.sock.sendMessage(jid, { text });
    markSent();
    const now = Math.floor(Date.now() / 1000);
    // La hora es la del mensaje según WhatsApp, no la del reloj local tras el
    // `await`: con `ahora` el eco (mismo id, hora real) quedaba con otro ts y el
    // chat aparecía adelantado unos segundos respecto a su último mensaje.
    const ts = tsOf(result?.messageTimestamp, now);
    const id = result?.key?.id ?? `sent-${ts}-${Math.random().toString(36).slice(2)}`;
    // Conversación estrenada: sin la fila de `chats` el mensaje queda huérfano
    // y el teléfono flotante no la enseñaría.
    if (known.esNuevo) asegurarChat(jid, ts);

    // Persistencia inmediata por el mismo camino que la ingesta (el eco de
    // messages.upsert deduplica por PK y no vuelve a mover el chat).
    registrarMensajePropio({ jid, id, ts, type: "text", text, rawJson: result ? JSON.stringify(result) : null });

    ensureAuditTable();
    db.prepare(
      `INSERT INTO wa_send_audit (chat_jid, actor, chars, wa_msg_id, created_at, kind) VALUES (?, ?, ?, ?, ?, 'text')`
    ).run(jid, actor, text.length, id, ts);

    /**
     * ⚠️ TOMA MANUAL: si esto NO lo manda la automatización, lo manda una
     * persona, y entonces la automatización tiene que retirarse de este chat.
     * Petición del usuario (2026-09-08): «si mi compañero lo toma en manual se
     * para el automático». Se avisa aquí, en el único punto por el que sale
     * cualquier mensaje de este servicio, para que no haya forma de escribir a
     * mano por un camino que se lo salte.
     */
    avisarSalienteManual(jid, actor);

    emitSse({ type: "message.new", jid });
    console.log(`[send] ${actor ?? "?"} → ${jidToPhone(jid) ?? jid} (${text.length} chars)`);
    return { ok: true, message: { id, chatJid: jid, fromMe: true, ts, type: "text", text, mediaUrl: null } };
  } catch (e) {
    console.error("[send] fallo al enviar:", (e as Error).message);
    return { ok: false, error: "WhatsApp rechazó el envío. Reintenta.", code: "fail" };
  }
}

export interface SendMediaInput {
  /** "image" | "audio" | "document". */
  kind: "image" | "audio" | "document";
  buffer: Buffer;
  mimetype: string;
  fileName?: string | null;
  caption?: string | null;
  /** Nota de voz (micrófono del teléfono flotante) en vez de audio adjunto. */
  ptt?: boolean;
}

/**
 * Envía un ADJUNTO (foto, documento o nota de voz) a un chat 1-a-1 existente.
 * Mismas salvaguardas que `sendText` (chat conocido, socket abierto, ritmo) más
 * un tope de tamaño — un archivo desmedido no debe poder colarse por aquí
 * cuando por el compositor de texto está limitado a 4096 caracteres.
 */
export async function sendMedia(jidPedido: string, input: SendMediaInput, actor: string | null): Promise<SendResult> {
  if (input.buffer.byteLength === 0) return { ok: false, error: "El archivo está vacío.", code: "invalid" };
  if (input.buffer.byteLength > MEDIA_MAX_BYTES) {
    return { ok: false, error: `El archivo pesa más de ${Math.round(MEDIA_MAX_BYTES / 1024 / 1024)} MB.`, code: "too-big" };
  }
  // Los ADJUNTOS siguen exigiendo chat existente: estrenar conversacion con
  // un archivo es peor que con un texto, y nadie lo ha pedido.
  const known = await requireOnlineChat(jidPedido, false);
  if (!known.ok) return known;
  const jid = known.jid;
  const rate = checkRate();
  if (!rate.ok) return { ok: false, error: rate.error, code: "rate" };

  const db = getDb();
  try {
    const caption = input.caption?.trim() || undefined;
    const payload =
      input.kind === "image"
        ? { image: input.buffer, caption }
        : input.kind === "audio"
          ? { audio: input.buffer, mimetype: input.mimetype, ptt: input.ptt ?? false }
          : { document: input.buffer, mimetype: input.mimetype, fileName: input.fileName ?? "archivo", caption };
    const result = await known.sock.sendMessage(jid, payload);
    markSent();
    const now = Math.floor(Date.now() / 1000);
    const ts = tsOf(result?.messageTimestamp, now);
    const id = result?.key?.id ?? `sent-${ts}-${Math.random().toString(36).slice(2)}`;
    // Conversación estrenada: sin la fila de `chats` el mensaje queda huérfano
    // y el teléfono flotante no la enseñaría.
    if (known.esNuevo) asegurarChat(jid, ts);

    // Guarda el binario YA (lo tenemos en memoria: no hace falta re-descargarlo
    // de WhatsApp) para que la burbuja lo muestre al instante, con la misma
    // cuota LRU que la media entrante.
    const file = saveMediaBuffer(jid, id, input.mimetype, input.buffer, input.fileName);
    const text = input.kind === "document" ? (input.fileName ?? caption ?? null) : caption ?? null;

    registrarMensajePropio({
      jid, id, ts, type: input.kind, text, mediaPath: file, mediaMime: input.mimetype,
      rawJson: result ? JSON.stringify(result) : null,
    });
    // Una nota de voz se anuncia como tal en la lista (la ingesta no distingue ptt).
    if (input.ptt) db.prepare("UPDATE chats SET last_message_preview = '🎤 Nota de voz' WHERE jid = ? AND last_message_at = ?").run(jid, ts);

    ensureAuditTable();
    db.prepare(
      `INSERT INTO wa_send_audit (chat_jid, actor, chars, wa_msg_id, created_at, kind, bytes) VALUES (?, ?, 0, ?, ?, ?, ?)`
    ).run(jid, actor, id, ts, input.ptt ? "ptt" : input.kind, input.buffer.byteLength);

    // Un adjunto a mano también es una toma manual (ver sendText).
    avisarSalienteManual(jid, actor);

    emitSse({ type: "message.new", jid });
    console.log(`[send] ${actor ?? "?"} → ${jidToPhone(jid) ?? jid} (${input.kind}, ${(input.buffer.byteLength / 1024).toFixed(0)} KB)`);
    return {
      ok: true,
      message: {
        id, chatJid: jid, fromMe: true, ts, type: input.kind, text,
        mediaUrl: file ? `/api/whatsapp/media/${encodeURIComponent(jid)}/${encodeURIComponent(id)}` : null,
      },
    };
  } catch (e) {
    console.error("[send] fallo al enviar adjunto:", (e as Error).message);
    return { ok: false, error: "WhatsApp rechazó el envío. Reintenta.", code: "fail" };
  }
}

/** Reexportado por si una ruta necesita deducir la extensión de un mimetype cliente. */
export { extFromMime };
