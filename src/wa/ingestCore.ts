/**
 * NÚCLEO DE LA INGESTA — mensaje/chat/contacto de Baileys → filas de SQLite.
 *
 * Sin socket, sin red, sin IA: solo la base y la capa de identidad. Así se
 * puede probar con una BD en memoria (scripts/test-ingest.ts) exactamente el
 * mismo código que corre en producción. El cableado a los eventos de Baileys,
 * la descarga de media, las campañas y el re-análisis viven en `ingest.ts`.
 *
 * Reglas que salen de la auditoría 2026-09-11:
 *  - Cada mensaje se guarda bajo el jid CANÓNICO de la persona (canonico.ts):
 *    un `@lid` con teléfono conocido cae en la fila del teléfono. Antes había
 *    una fila por jid y la misma persona salía dos veces.
 *  - Primero se aprende la identidad (senderPn, pnJid/lidJid, agenda) y luego se
 *    escribe: si llega el primer mensaje de alguien por su `@lid` con
 *    `senderPn`, ya nace bajo el teléfono.
 *  - `last_message_at` y el preview solo se mueven cuando el mensaje SE INSERTA.
 *    Antes se movían con cualquier re-entrega, y 12 chats tenían la fecha de
 *    lista horas por delante de su último mensaje real.
 *  - Idempotente por `(chat_jid, id)`: el mismo evento tres veces = un mensaje.
 *  - `append` no es solo historial: es también lo que WhatsApp re-entrega tras
 *    una desconexión. Un mensaje reciente (3 días) que llega por `append` se
 *    trata como en vivo (media, campañas, análisis).
 */
import type { Chat, Contact, WAMessage } from "baileys";
import { getDb } from "../db/db";
import { isStorableChatJid } from "./jidPhone";
import { aprenderMapeo, canonicoDe } from "./canonico";
import { esGrupo, esLid, esPn, normalizarJid, telefonoEs } from "./identidad";
import { previewDe, type TipoMensaje } from "./preview";
import { applyWaRead } from "./readState";

export type MsgType = TipoMensaje;

export interface ExtractedContent {
  type: MsgType;
  text: string | null;
  /** Solo en tipos de media: para poder descargar el binario después. */
  mimetype?: string | null;
  fileName?: string | null;
}

/**
 * Texto útil o `null` — nunca la cadena vacía. WhatsApp entrega `""` (no
 * `undefined`) en captions que el remitente no escribió, y guardar `""` es peor
 * que guardar `null`: parece dato y no lo es, así que gana a los respaldos con
 * `??` y encima esquiva los filtros `TRIM(text) <> ''` de las consultas.
 */
export function noVacio(v: string | null | undefined): string | null {
  const t = (v ?? "").trim();
  return t ? t : null;
}

/** Desenvuelve wrappers (efímeros, view-once) y clasifica el contenido. */
export function extractContent(msg: WAMessage): ExtractedContent | null {
  const m = msg.message;
  if (!m) return null;
  const inner =
    m.ephemeralMessage?.message ??
    m.viewOnceMessage?.message ??
    m.viewOnceMessageV2?.message ??
    m.documentWithCaptionMessage?.message ??
    m;

  if (inner.conversation) return { type: "text", text: inner.conversation };
  if (inner.extendedTextMessage?.text) return { type: "text", text: inner.extendedTextMessage.text };
  if (inner.imageMessage) {
    return { type: "image", text: noVacio(inner.imageMessage.caption), mimetype: inner.imageMessage.mimetype ?? null };
  }
  if (inner.videoMessage) {
    return { type: "video", text: noVacio(inner.videoMessage.caption), mimetype: inner.videoMessage.mimetype ?? null };
  }
  if (inner.audioMessage) {
    return { type: "audio", text: null, mimetype: inner.audioMessage.mimetype ?? null };
  }
  if (inner.documentMessage) {
    /**
     * ⚠️ `??` NO SIRVE AQUÍ: hay un cliente de WhatsApp de Fran que manda
     * SIEMPRE `caption: ""` en los documentos (medido sobre la base real: de los
     * envíos con id de la familia `4A…`, el 100% se guardó con el nombre
     * perdido, frente a 0% en las familias `3EB0…`/`2A…`). Con `??` esa cadena
     * vacía gana a `fileName`, se guarda `text=""`, y todo lo que detecta por
     * NOMBRE DE DOCUMENTO —"programa enviado" del CRM, que además filtra por
     * `TRIM(text) <> ''`— se queda ciego: el PDF se envió pero no se ve.
     * Caso real: Silvia Martínez, PDF del SBA no detectado (2026-08-13).
     */
    return {
      type: "document",
      text: noVacio(inner.documentMessage.caption) ?? noVacio(inner.documentMessage.fileName),
      mimetype: inner.documentMessage.mimetype ?? null,
      fileName: noVacio(inner.documentMessage.fileName),
    };
  }
  if (inner.stickerMessage) return { type: "other", text: null };
  // Plumbing del protocolo (reacciones, borrados, claves…): no es contenido.
  if (
    inner.protocolMessage ||
    inner.reactionMessage ||
    inner.pollUpdateMessage ||
    inner.senderKeyDistributionMessage
  ) {
    return null;
  }
  return { type: "other", text: null };
}

/** messageTimestamp puede ser number | Long | bigint | string según la ruta de entrada. */
export function tsOf(v: unknown, fallback: number): number {
  if (typeof v === "number" && Number.isFinite(v) && v > 0) return Math.floor(v);
  if (typeof v === "bigint") return Number(v);
  if (typeof v === "string" && /^\d+$/.test(v)) return Number(v);
  if (v && typeof (v as { toNumber?: () => number }).toNumber === "function") {
    return (v as { toNumber: () => number }).toNumber();
  }
  return fallback;
}

export type ModoIngesta = "notify" | "append" | "history";

/** Un mensaje que entra por `append` con menos de esta antigüedad se trata como en vivo. */
export const VENTANA_VIVO_S = 3 * 86_400;

/* ------------------------------ statements -------------------------------- */

function statements() {
  const db = getDb();
  return {
    /** La fila del chat existe (FK de messages) y conserva el nombre/teléfono que ya tuviera. */
    ensureChat: db.prepare(
      `INSERT INTO chats(jid, phone, display_name, created_at, updated_at)
       VALUES (@jid, @phone, @display_name, @now, @now)
       ON CONFLICT(jid) DO UPDATE SET
         display_name = COALESCE(NULLIF(chats.display_name, ''), NULLIF(excluded.display_name, '')),
         phone = COALESCE(NULLIF(chats.phone, ''), excluded.phone),
         updated_at = excluded.updated_at`
    ),
    insertMessage: db.prepare(
      `INSERT INTO messages(chat_jid, id, from_me, ts, type, text, media_path, media_mime, raw_json, participant)
       VALUES (@chat_jid, @id, @from_me, @ts, @type, @text, @media_path, @media_mime, @raw_json, @participant)
       ON CONFLICT(chat_jid, id) DO NOTHING`
    ),
    /** Solo tras INSERTAR: el orden de la lista es el de los mensajes reales. */
    bumpChat: db.prepare(
      `UPDATE chats SET
         last_message_preview = CASE WHEN @ts >= COALESCE(last_message_at, 0) THEN @preview ELSE last_message_preview END,
         last_message_at = MAX(COALESCE(last_message_at, 0), @ts),
         updated_at = @now
       WHERE jid = @jid`
    ),
    updateName: db.prepare(
      `UPDATE chats SET display_name = @name, updated_at = @now
       WHERE jid = @jid AND (display_name IS NULL OR display_name = '' OR @overwrite = 1)`
    ),
    upsertContact: db.prepare(
      `INSERT INTO wa_contacts (jid, name, notify, verified_name, lid, updated_at)
       VALUES (@jid, @name, @notify, @verified, @lid, @now)
       ON CONFLICT(jid) DO UPDATE SET
         name = COALESCE(excluded.name, wa_contacts.name),
         notify = COALESCE(excluded.notify, wa_contacts.notify),
         verified_name = COALESCE(excluded.verified_name, wa_contacts.verified_name),
         lid = COALESCE(excluded.lid, wa_contacts.lid),
         updated_at = excluded.updated_at`
    ),
  };
}

/* -------------------------------- ingesta --------------------------------- */

export interface IngestResult {
  /** Chats (canónicos) con mensajes nuevos realmente insertados. */
  touched: Set<string>;
  /** Chats con contenido válido en el lote aunque el mensaje ya existiera. */
  seen: Set<string>;
  /** Chats con mensajes nuevos EN VIVO (notify, o append reciente): candidatos a re-análisis. */
  vivos: Set<string>;
  /** Media recién insertada y en vivo, para descargar DESPUÉS de la transacción. */
  mediaCandidates: Array<{ jid: string; id: string; msg: WAMessage; mimetype: string | null; fileName: string | null }>;
  /** Texto entrante nuevo y en vivo, de una persona (no grupos): para las campañas. */
  entrantes: Array<{ telefono: string; texto: string; jid: string; waMsgId: string }>;
  /** Salientes nuevos (no historial): candidatos a toma manual. */
  salientes: Array<{ jid: string; waMsgId: string; ts: number }>;
}

function nuevoResultado(): IngestResult {
  return { touched: new Set(), seen: new Set(), vivos: new Set(), mediaCandidates: [], entrantes: [], salientes: [] };
}

type KeyConIdentidad = WAMessage["key"] & { senderPn?: string; senderLid?: string; participantPn?: string; participantLid?: string };

/** Aprende todo lo que un lote de mensajes dice sobre quién es quién (fuera de la transacción). */
function aprenderDeMensajes(messages: WAMessage[]): void {
  for (const msg of messages) {
    const key = msg.key as KeyConIdentidad | undefined;
    if (!key) continue;
    const jid = normalizarJid(key.remoteJid);
    if (esLid(jid) && key.senderPn && !key.fromMe) aprenderMapeo(jid, key.senderPn, "senderPn");
    // En un grupo, quien habla puede venir como @lid con su teléfono al lado.
    const participante = normalizarJid(key.participant);
    if (esLid(participante) && key.participantPn) aprenderMapeo(participante, key.participantPn, "participantPn");
  }
}

export function ingestMessages(messages: WAMessage[], opts: { modo: ModoIngesta; now?: number }): IngestResult {
  const db = getDb();
  const stmts = statements();
  const out = nuevoResultado();
  const now = opts.now ?? Math.floor(Date.now() / 1000);

  aprenderDeMensajes(messages);

  const run = db.transaction((batch: WAMessage[]) => {
    for (const msg of batch) {
      const key = msg.key as KeyConIdentidad | undefined;
      const jidCrudo = normalizarJid(key?.remoteJid);
      if (!jidCrudo || !isStorableChatJid(jidCrudo) || msg.broadcast) continue;
      const content = extractContent(msg);
      if (!content) continue;

      const jid = canonicoDe(jidCrudo);
      const fromMe = !!key?.fromMe;
      const ts = tsOf(msg.messageTimestamp, now);
      const id = key?.id ?? `${ts}-${Math.random().toString(36).slice(2)}`;
      const grupo = esGrupo(jid);
      const participant = grupo ? canonicoDe(key?.participant) || null : null;
      out.seen.add(jid);

      stmts.ensureChat.run({
        jid,
        phone: telefonoEs(jid),
        // El pushName es el nombre que la persona se pone; en un grupo es el de
        // quien habla, no el del grupo. Nunca el nuestro (fromMe).
        display_name: !fromMe && !grupo ? (msg.pushName ?? "") : "",
        now,
      });
      const inserted = stmts.insertMessage.run({
        chat_jid: jid,
        id,
        from_me: fromMe ? 1 : 0,
        ts,
        type: content.type,
        text: content.text,
        media_path: null,
        media_mime: null,
        raw_json: JSON.stringify(msg),
        participant,
      });
      if (inserted.changes === 0) continue;

      stmts.bumpChat.run({ jid, ts, preview: previewDe(content.type, content.text), now });
      out.touched.add(jid);
      const vivo = opts.modo === "notify" || (opts.modo === "append" && now - ts <= VENTANA_VIVO_S);
      if (vivo) out.vivos.add(jid);
      if (vivo && content.type !== "text" && content.type !== "other") {
        out.mediaCandidates.push({ jid, id, msg, mimetype: content.mimetype ?? null, fileName: content.fileName ?? null });
      }
      if (vivo && !fromMe && !grupo && content.type === "text" && content.text) {
        /**
         * ⚠️ `senderPn` ES UN JID, no un teléfono ("34657955578@s.whatsapp.net").
         * Se canoniza aquí; pasarlo crudo hacía que el dashboard lo tomara por un
         * internacional y descartara TODA respuesta entrada por `@lid`.
         */
        const tel = telefonoEs(jid) ?? telefonoEs(key?.senderPn);
        if (tel) out.entrantes.push({ telefono: tel, texto: content.text, jid, waMsgId: id });
      }
      if (opts.modo !== "history" && fromMe) out.salientes.push({ jid, waMsgId: id, ts });
    }
  });
  run(messages);
  return out;
}

/**
 * Filas de chat a partir del listado del history sync, aunque no traigan
 * mensajes. Aprende `pnJid`/`lidJid` (el par teléfono↔LID que WhatsApp ya sabe),
 * coloca los chats sin mensajes nuestros donde WhatsApp los tiene
 * (`conversationTimestamp`) y aplica el estado de lectura real.
 */
export function ingestChatShells(chats: Chat[]): number {
  const db = getDb();
  const stmts = statements();
  const now = Math.floor(Date.now() / 1000);
  const posicion = db.prepare(
    `UPDATE chats SET last_message_at = MAX(COALESCE(last_message_at, 0), @ts), updated_at = @now
      WHERE jid = @jid AND NOT EXISTS (SELECT 1 FROM messages m WHERE m.chat_jid = @jid)`
  );
  for (const chat of chats) {
    const c = chat as Chat & { pnJid?: string | null; lidJid?: string | null };
    const jid = normalizarJid(c.id);
    if (!jid) continue;
    if (esLid(jid) && c.pnJid) aprenderMapeo(jid, c.pnJid, "history.pnJid");
    if (esPn(jid) && c.lidJid) aprenderMapeo(c.lidJid, jid, "history.lidJid");
  }
  let n = 0;
  const run = db.transaction((batch: Chat[]) => {
    for (const chat of batch) {
      const jidCrudo = normalizarJid(chat.id);
      if (!jidCrudo || !isStorableChatJid(jidCrudo)) continue;
      const jid = canonicoDe(jidCrudo);
      stmts.ensureChat.run({ jid, phone: telefonoEs(jid), display_name: chat.name ?? "", now });
      const ts = tsOf(chat.conversationTimestamp, 0);
      if (ts > 0) posicion.run({ jid, ts, now });
      n++;
    }
  });
  run(chats);
  // El estado de lectura se aplica FUERA de la transacción de shells: hace sus
  // propias consultas por chat y no debe alargar el lock de escritura.
  for (const chat of chats) {
    const jidCrudo = normalizarJid(chat.id);
    if (jidCrudo && isStorableChatJid(jidCrudo)) applyWaRead(canonicoDe(jidCrudo), chat.unreadCount);
  }
  return n;
}

/**
 * Nombres de la agenda de WhatsApp. Prioridad como WhatsApp Web: nombre guardado
 * en la agenda > nombre de negocio verificado > pushName. Un nombre de agenda
 * PISA un pushName; un pushName solo rellena si no había nada.
 */
export function applyContactNames(contacts: Array<Partial<Contact>>, overwrite: boolean): void {
  const stmts = statements();
  const now = Math.floor(Date.now() / 1000);
  for (const c of contacts) {
    const jid = normalizarJid(c.id);
    if (!jid) continue;
    if (c.lid && esPn(jid)) aprenderMapeo(c.lid, jid, "contacts.lid");
    try {
      stmts.upsertContact.run({
        jid,
        name: noVacio(c.name),
        notify: noVacio(c.notify),
        verified: noVacio(c.verifiedName),
        lid: c.lid ? normalizarJid(c.lid) || null : null,
        now,
      });
    } catch {
      /* la agenda es accesoria */
    }
    const name = noVacio(c.name) ?? noVacio(c.verifiedName) ?? noVacio(c.notify);
    if (!name || !isStorableChatJid(jid)) continue;
    const pisa = overwrite || !!(noVacio(c.name) ?? noVacio(c.verifiedName));
    stmts.updateName.run({ jid: canonicoDe(jid), name, now, overwrite: pisa ? 1 : 0 });
  }
}

/**
 * CONTENIDO QUE LLEGA TARDE por `messages.update` (ediciones y cuerpos que
 * WhatsApp entrega después del upsert original). Actualiza el texto si la fila
 * existe (en el chat canónico); si no existe, la crea con la hora que traiga el
 * update o, en su defecto, la actual. Devuelve los chats tocados.
 */
export function aplicarContenidoTardio(
  updates: Array<{ key: WAMessage["key"]; update: Partial<WAMessage> }>,
  now = Math.floor(Date.now() / 1000)
): Set<string> {
  const db = getDb();
  const stmts = statements();
  const updateContent = db.prepare(
    `UPDATE messages SET type = @type, text = @text, raw_json = @raw_json WHERE chat_jid = @chat_jid AND id = @id`
  );
  const touched = new Set<string>();
  for (const u of updates) {
    const jidCrudo = normalizarJid(u.key?.remoteJid);
    const upd = u.update as { message?: WAMessage["message"]; messageTimestamp?: unknown } | undefined;
    if (!jidCrudo || !isStorableChatJid(jidCrudo) || !upd?.message) continue;
    const jid = canonicoDe(jidCrudo);
    // Una EDICIÓN viene envuelta en protocolMessage.editedMessage y apunta al id
    // del mensaje ORIGINAL; el contenido tardío normal viene directo.
    const proto = upd.message.protocolMessage;
    const body = proto?.editedMessage ?? upd.message;
    const targetId = proto?.key?.id ?? u.key?.id;
    if (!targetId) continue;
    const content = extractContent({ key: u.key, message: body } as WAMessage);
    if (!content) continue;
    const raw = JSON.stringify({ key: u.key, message: body });
    const updated = updateContent.run({ type: content.type, text: content.text, raw_json: raw, chat_jid: jid, id: targetId });
    if (updated.changes === 0) {
      const ts = tsOf(upd.messageTimestamp, now);
      stmts.ensureChat.run({ jid, phone: telefonoEs(jid), display_name: "", now });
      const ins = stmts.insertMessage.run({
        chat_jid: jid, id: targetId, from_me: u.key?.fromMe ? 1 : 0, ts,
        type: content.type, text: content.text, media_path: null, media_mime: null, raw_json: raw, participant: null,
      });
      if (ins.changes > 0) stmts.bumpChat.run({ jid, ts, preview: previewDe(content.type, content.text), now });
    } else {
      // Si era el último mensaje, el preview de la lista cambia con él.
      db.prepare(
        `UPDATE chats SET last_message_preview = @preview
          WHERE jid = @jid AND last_message_at = (SELECT ts FROM messages WHERE chat_jid = @jid AND id = @id)`
      ).run({ preview: previewDe(content.type, content.text), jid, id: targetId });
    }
    touched.add(jid);
  }
  return touched;
}

/** `chats.update` / `chats.upsert`: hoy solo el estado de lectura. Devuelve los chats cuyo contador cambió. */
export function aplicarLecturaDeChats(updates: Array<{ id?: string | null; unreadCount?: number | null }>): string[] {
  const tocados: string[] = [];
  for (const u of updates) {
    const jidCrudo = normalizarJid(u?.id);
    if (!jidCrudo || !isStorableChatJid(jidCrudo)) continue;
    const jid = canonicoDe(jidCrudo);
    if (applyWaRead(jid, u.unreadCount)) tocados.push(jid);
  }
  return tocados;
}

/**
 * Persistencia inmediata de un mensaje que ACABAMOS de enviar (send.ts). Mismo
 * camino que la ingesta, para que el eco de WhatsApp lo encuentre ya guardado
 * (misma PK) y no lo repita. Devuelve true si se insertó.
 */
export function registrarMensajePropio(m: {
  jid: string;
  id: string;
  ts: number;
  type: MsgType;
  text: string | null;
  mediaPath?: string | null;
  mediaMime?: string | null;
  rawJson?: string | null;
}): boolean {
  const stmts = statements();
  const now = Math.floor(Date.now() / 1000);
  stmts.ensureChat.run({ jid: m.jid, phone: telefonoEs(m.jid), display_name: "", now });
  const ins = stmts.insertMessage.run({
    chat_jid: m.jid, id: m.id, from_me: 1, ts: m.ts, type: m.type, text: m.text,
    media_path: m.mediaPath ?? null, media_mime: m.mediaMime ?? null, raw_json: m.rawJson ?? null, participant: null,
  });
  if (ins.changes > 0) stmts.bumpChat.run({ jid: m.jid, ts: m.ts, preview: previewDe(m.type, m.text), now });
  return ins.changes > 0;
}
