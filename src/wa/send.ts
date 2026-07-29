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

const MIN_GAP_MS = 1_500;
const WINDOW_MS = 5 * 60_000;
const MAX_PER_WINDOW = 30;

let lastSendAt = 0;
let windowStart = 0;
let windowCount = 0;

export type SendResult =
  | { ok: true; message: { id: string; chatJid: string; fromMe: true; ts: number; type: "text"; text: string; mediaUrl: null } }
  | { ok: false; error: string; code: "offline" | "invalid" | "rate" | "unknown-chat" | "fail" };

function ensureAuditTable(): void {
  getDb().exec(
    `CREATE TABLE IF NOT EXISTS wa_send_audit (
       id INTEGER PRIMARY KEY,
       chat_jid TEXT NOT NULL,
       actor TEXT,
       chars INTEGER NOT NULL,
       wa_msg_id TEXT,
       created_at INTEGER NOT NULL
     )`
  );
}

/** Envía TEXTO plano a un chat 1-a-1 existente. Escrito a mano por una persona. */
export async function sendText(jid: string, rawText: string, actor: string | null): Promise<SendResult> {
  const text = String(rawText ?? "").trim();
  if (!text || text.length > 4096) {
    return { ok: false, error: "El mensaje debe tener entre 1 y 4096 caracteres.", code: "invalid" };
  }
  if (!isStorableChatJid(jid)) {
    return { ok: false, error: "Destino no válido (solo chats 1-a-1).", code: "invalid" };
  }
  const db = getDb();
  const chat = db.prepare("SELECT jid FROM chats WHERE jid = ?").get(jid) as { jid: string } | undefined;
  if (!chat) {
    // Solo se responde a conversaciones que EXISTEN — este panel no inicia
    // frío con desconocidos (menos superficie de error y de spam accidental).
    return { ok: false, error: "Ese chat no está en el historial.", code: "unknown-chat" };
  }
  const sock = getActiveSocket();
  if (!sock) return { ok: false, error: "WhatsApp no está conectado ahora mismo.", code: "offline" };

  const now = Date.now();
  if (now - lastSendAt < MIN_GAP_MS) {
    return { ok: false, error: "Demasiado rápido — espera un segundo y reenvía.", code: "rate" };
  }
  if (now - windowStart > WINDOW_MS) {
    windowStart = now;
    windowCount = 0;
  }
  if (windowCount >= MAX_PER_WINDOW) {
    return { ok: false, error: "Límite de ritmo alcanzado (30 mensajes / 5 min). Espera un poco.", code: "rate" };
  }

  try {
    const result = await sock.sendMessage(jid, { text });
    lastSendAt = Date.now();
    windowCount++;
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
      `INSERT INTO wa_send_audit (chat_jid, actor, chars, wa_msg_id, created_at) VALUES (?, ?, ?, ?, ?)`
    ).run(jid, actor, text.length, id, ts);

    emitSse({ type: "message.new", jid });
    console.log(`[send] ${actor ?? "?"} → ${jidToPhone(jid) ?? jid} (${text.length} chars)`);
    return { ok: true, message: { id, chatJid: jid, fromMe: true, ts, type: "text", text, mediaUrl: null } };
  } catch (e) {
    console.error("[send] fallo al enviar:", (e as Error).message);
    return { ok: false, error: "WhatsApp rechazó el envío. Reintenta.", code: "fail" };
  }
}
