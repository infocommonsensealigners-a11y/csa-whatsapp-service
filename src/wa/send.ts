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
import { getActiveSocket } from "./socket";
import { MEDIA_MAX_BYTES, extFromMime, saveMediaBuffer } from "./mediaStore";

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
function requireOnlineKnownChat(jid: string): { ok: true; sock: NonNullable<ReturnType<typeof getActiveSocket>> } | { ok: false; error: string; code: "invalid" | "unknown-chat" | "offline" } {
  if (!isStorableChatJid(jid)) return { ok: false, error: "Destino no válido (solo chats 1-a-1).", code: "invalid" };
  const chat = getDb().prepare("SELECT jid FROM chats WHERE jid = ?").get(jid) as { jid: string } | undefined;
  if (!chat) return { ok: false, error: "Ese chat no está en el historial.", code: "unknown-chat" };
  const sock = getActiveSocket();
  if (!sock) return { ok: false, error: "WhatsApp no está conectado ahora mismo.", code: "offline" };
  return { ok: true, sock };
}

/** Envía TEXTO plano a un chat 1-a-1 existente. Escrito a mano por una persona. */
export async function sendText(jid: string, rawText: string, actor: string | null): Promise<SendResult> {
  const text = String(rawText ?? "").trim();
  if (!text || text.length > 4096) {
    return { ok: false, error: "El mensaje debe tener entre 1 y 4096 caracteres.", code: "invalid" };
  }
  const known = requireOnlineKnownChat(jid);
  if (!known.ok) return known;
  const rate = checkRate();
  if (!rate.ok) return { ok: false, error: rate.error, code: "rate" };

  const db = getDb();
  try {
    const result = await known.sock.sendMessage(jid, { text });
    markSent();
    const ts = Math.floor(Date.now() / 1000);
    const id = result?.key?.id ?? `sent-${ts}-${Math.random().toString(36).slice(2)}`;

    // Persistencia inmediata (el eco de messages.upsert deduplica por PK).
    db.prepare(
      `INSERT INTO messages(chat_jid, id, from_me, ts, type, text, media_path, media_mime, raw_json)
       VALUES (?, ?, 1, ?, 'text', ?, NULL, NULL, NULL)
       ON CONFLICT(chat_jid, id) DO NOTHING`
    ).run(jid, id, ts, text);
    db.prepare(
      `UPDATE chats SET last_message_at = MAX(COALESCE(last_message_at, 0), ?),
                        last_message_preview = ?, updated_at = ?
       WHERE jid = ?`
    ).run(ts, text.slice(0, 120), ts, jid);

    ensureAuditTable();
    db.prepare(
      `INSERT INTO wa_send_audit (chat_jid, actor, chars, wa_msg_id, created_at, kind) VALUES (?, ?, ?, ?, ?, 'text')`
    ).run(jid, actor, text.length, id, ts);

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
export async function sendMedia(jid: string, input: SendMediaInput, actor: string | null): Promise<SendResult> {
  if (input.buffer.byteLength === 0) return { ok: false, error: "El archivo está vacío.", code: "invalid" };
  if (input.buffer.byteLength > MEDIA_MAX_BYTES) {
    return { ok: false, error: `El archivo pesa más de ${Math.round(MEDIA_MAX_BYTES / 1024 / 1024)} MB.`, code: "too-big" };
  }
  const known = requireOnlineKnownChat(jid);
  if (!known.ok) return known;
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
    const ts = Math.floor(Date.now() / 1000);
    const id = result?.key?.id ?? `sent-${ts}-${Math.random().toString(36).slice(2)}`;

    // Guarda el binario YA (lo tenemos en memoria: no hace falta re-descargarlo
    // de WhatsApp) para que la burbuja lo muestre al instante, con la misma
    // cuota LRU que la media entrante.
    const file = saveMediaBuffer(jid, id, input.mimetype, input.buffer, input.fileName);
    const text = input.kind === "document" ? (input.fileName ?? caption ?? null) : caption ?? null;
    const previewIcon = input.kind === "image" ? "📷 Foto" : input.ptt ? "🎤 Nota de voz" : input.kind === "audio" ? "🎤 Audio" : "📄 Documento";

    db.prepare(
      `INSERT INTO messages(chat_jid, id, from_me, ts, type, text, media_path, media_mime, raw_json)
       VALUES (?, ?, 1, ?, ?, ?, ?, ?, NULL)
       ON CONFLICT(chat_jid, id) DO NOTHING`
    ).run(jid, id, ts, input.kind, text, file, input.mimetype);
    db.prepare(
      `UPDATE chats SET last_message_at = MAX(COALESCE(last_message_at, 0), ?),
                        last_message_preview = ?, updated_at = ?
       WHERE jid = ?`
    ).run(ts, previewIcon, ts, jid);

    ensureAuditTable();
    db.prepare(
      `INSERT INTO wa_send_audit (chat_jid, actor, chars, wa_msg_id, created_at, kind, bytes) VALUES (?, ?, 0, ?, ?, ?, ?)`
    ).run(jid, actor, id, ts, input.ptt ? "ptt" : input.kind, input.buffer.byteLength);

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
