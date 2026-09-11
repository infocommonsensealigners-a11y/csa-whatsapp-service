/**
 * NÚCLEO DE LA INGESTA — mensaje/chat/contacto de Baileys → filas de SQLite.
 *
 * Sin socket, sin red, sin IA: solo la base y la capa de identidad. Así se
 * puede probar con una BD en memoria (scripts/test-fusion.ts, test-paridad.ts)
 * exactamente el mismo código que corre en producción. El cableado a los
 * eventos de Baileys, la descarga de media, las campañas y el re-análisis viven
 * en `ingest.ts`.
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
 *  - Paridad con WhatsApp Web: estado de entrega, borrados, ediciones,
 *    reacciones, mensajes de sistema (grupos, llamadas perdidas, «esperando el
 *    mensaje»), archivado/fijado/silenciado del móvil y grupos.
 */
import type { Chat, Contact, GroupMetadata, WAMessage } from "baileys";
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

/** Desenvuelve wrappers (efímeros, view-once) y devuelve el contenido interior. */
export function contenidoInterior(m: WAMessage["message"]): NonNullable<WAMessage["message"]> | null {
  if (!m) return null;
  return (
    m.ephemeralMessage?.message ??
    m.viewOnceMessage?.message ??
    m.viewOnceMessageV2?.message ??
    m.documentWithCaptionMessage?.message ??
    m
  );
}

/** Desenvuelve wrappers (efímeros, view-once) y clasifica el contenido. */
export function extractContent(msg: WAMessage): ExtractedContent | null {
  const inner = contenidoInterior(msg.message);
  if (!inner) return null;

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

/* ------------------------ estado de entrega (ticks) ------------------------ */

/** WebMessageInfo.Status: 0 error · 1 pendiente · 2 enviado · 3 entregado · 4 leído · 5 reproducido. */
const ESTADOS: Record<string, number> = { ERROR: 0, PENDING: 1, SERVER_ACK: 2, DELIVERY_ACK: 3, READ: 4, PLAYED: 5 };

export function estadoDe(v: unknown): number | null {
  if (typeof v === "number" && v >= 0 && v <= 5) return v;
  if (typeof v === "string" && v in ESTADOS) return ESTADOS[v];
  return null;
}

/* ------------------------ mensajes de sistema (stubs) ------------------------ */

/** WebMessageInfo.StubType → nombre. Solo los que WhatsApp Web enseña como línea de sistema. */
const STUBS: Record<number, string> = {
  1: "REVOKE",
  2: "CIPHERTEXT",
  20: "GROUP_CREATE",
  21: "GROUP_CHANGE_SUBJECT",
  22: "GROUP_CHANGE_ICON",
  24: "GROUP_CHANGE_DESCRIPTION",
  27: "GROUP_PARTICIPANT_ADD",
  28: "GROUP_PARTICIPANT_REMOVE",
  29: "GROUP_PARTICIPANT_PROMOTE",
  30: "GROUP_PARTICIPANT_DEMOTE",
  31: "GROUP_PARTICIPANT_INVITE",
  32: "GROUP_PARTICIPANT_LEAVE",
  40: "CALL_MISSED_VOICE",
  41: "CALL_MISSED_VIDEO",
  43: "GROUP_DELETE",
  45: "CALL_MISSED_GROUP_VOICE",
  46: "CALL_MISSED_GROUP_VIDEO",
};
const NOMBRES_STUB = new Set(Object.values(STUBS));

export function stubDe(msg: WAMessage): { stub: string; params: string[] } | null {
  const raw = (msg as { messageStubType?: unknown }).messageStubType;
  const nombre = typeof raw === "number" ? STUBS[raw] : typeof raw === "string" && NOMBRES_STUB.has(raw) ? raw : undefined;
  if (!nombre) return null;
  const params = Array.isArray(msg.messageStubParameters) ? msg.messageStubParameters.map(String) : [];
  return { stub: nombre, params };
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
      `INSERT INTO messages(chat_jid, id, from_me, ts, type, text, media_path, media_mime, raw_json, participant, status, stub)
       VALUES (@chat_jid, @id, @from_me, @ts, @type, @text, @media_path, @media_mime, @raw_json, @participant, @status, @stub)
       ON CONFLICT(chat_jid, id) DO NOTHING`
    ),
    /** Un «esperando el mensaje…» (CIPHERTEXT) que por fin llega descifrado: se rellena en su sitio. */
    upgradeCiphertext: db.prepare(
      `UPDATE messages SET type = @type, text = @text, raw_json = @raw_json, stub = NULL, status = COALESCE(@status, status)
        WHERE chat_jid = @chat_jid AND id = @id AND stub = 'CIPHERTEXT'`
    ),
    /** Solo tras INSERTAR: el orden de la lista es el de los mensajes reales. Un chat borrado en el móvil renace. */
    bumpChat: db.prepare(
      `UPDATE chats SET
         last_message_preview = CASE WHEN @ts >= COALESCE(last_message_at, 0) THEN @preview ELSE last_message_preview END,
         last_message_at = MAX(COALESCE(last_message_at, 0), @ts),
         deleted_at = NULL,
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
  /** Salientes nuevos (no historial, no grupos): candidatos a toma manual. */
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
      const stub = content ? null : stubDe(msg);
      if (!content && !stub) continue;

      const jid = canonicoDe(jidCrudo);
      const fromMe = !!key?.fromMe;
      const ts = tsOf(msg.messageTimestamp, now);
      const id = key?.id ?? `${ts}-${Math.random().toString(36).slice(2)}`;
      const grupo = esGrupo(jid);
      const participant = grupo ? canonicoDe(key?.participant ?? (msg as { participant?: string }).participant) || null : null;
      const status = fromMe ? estadoDe((msg as { status?: unknown }).status) : null;
      out.seen.add(jid);

      stmts.ensureChat.run({
        jid,
        phone: telefonoEs(jid),
        // El pushName es el nombre que la persona se pone; en un grupo es el de
        // quien habla, no el del grupo. Nunca el nuestro (fromMe).
        display_name: !fromMe && !grupo ? (msg.pushName ?? "") : "",
        now,
      });
      // En un grupo, el nombre de quien habla se guarda en la agenda por su jid.
      if (grupo && participant && !fromMe && noVacio(msg.pushName)) {
        stmts.upsertContact.run({ jid: participant, name: null, notify: noVacio(msg.pushName), verified: null, lid: null, now });
      }

      const tipo: MsgType = content ? content.type : "other";
      const texto = content ? content.text : null;
      const raw = JSON.stringify(msg);
      const inserted = stmts.insertMessage.run({
        chat_jid: jid, id, from_me: fromMe ? 1 : 0, ts, type: tipo, text: texto,
        media_path: null, media_mime: null, raw_json: raw, participant, status, stub: stub?.stub ?? null,
      });
      if (inserted.changes === 0) {
        // Ya estaba: si era un «esperando el mensaje…» y ahora llega el contenido, se rellena.
        if (content && stmts.upgradeCiphertext.run({ type: tipo, text: texto, raw_json: raw, status, chat_jid: jid, id }).changes > 0) {
          out.touched.add(jid);
        }
        continue;
      }

      const preview = stub ? previewDeStub(stub.stub) : previewDe(tipo, texto);
      stmts.bumpChat.run({ jid, ts, preview, now });
      out.touched.add(jid);
      if (!content) continue; // un mensaje de sistema no es media, ni campaña, ni toma manual
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
      if (opts.modo !== "history" && fromMe && !grupo) out.salientes.push({ jid, waMsgId: id, ts });
    }
  });
  run(messages);
  return out;
}

/** Lo que enseña la lista cuando el último mensaje es de sistema. */
export function previewDeStub(stub: string): string {
  if (stub === "CIPHERTEXT") return "Esperando el mensaje…";
  if (stub === "REVOKE") return "🚫 Se eliminó este mensaje";
  if (stub.startsWith("CALL_MISSED")) return stub.includes("VIDEO") ? "📹 Videollamada perdida" : "📞 Llamada de voz perdida";
  return "ℹ️ Cambio en el grupo";
}

/**
 * Filas de chat a partir del listado del history sync, aunque no traigan
 * mensajes. Aprende `pnJid`/`lidJid` (el par teléfono↔LID que WhatsApp ya sabe),
 * coloca los chats sin mensajes nuestros donde WhatsApp los tiene
 * (`conversationTimestamp`) y aplica lectura, archivado, fijado y silencio.
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
      // El nombre del history sync es el título que Fran ve en el móvil: manda.
      if (noVacio(chat.name)) stmts.updateName.run({ jid, name: chat.name, now, overwrite: 1 });
      const ts = tsOf(chat.conversationTimestamp, 0);
      if (ts > 0) posicion.run({ jid, ts, now });
      n++;
    }
  });
  run(chats);
  // El estado se aplica FUERA de la transacción de shells: hace sus propias
  // consultas por chat y no debe alargar el lock de escritura.
  aplicarEstadoDeChats(chats as Array<Partial<Chat>>, false);
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

/** Asunto y participantes de grupos (`groups.upsert`, `groups.update`, `groupMetadata`). */
export function aplicarGrupos(grupos: Array<Partial<GroupMetadata>>): string[] {
  const db = getDb();
  const stmts = statements();
  const now = Math.floor(Date.now() / 1000);
  const upsertPart = db.prepare(
    `INSERT INTO wa_group_participants (group_jid, jid, admin, updated_at) VALUES (?, ?, ?, ?)
     ON CONFLICT(group_jid, jid) DO UPDATE SET admin = excluded.admin, updated_at = excluded.updated_at`
  );
  const tocados: string[] = [];
  for (const g of grupos) {
    const jid = normalizarJid(g.id);
    if (!esGrupo(jid)) continue;
    stmts.ensureChat.run({ jid, phone: null, display_name: g.subject ?? "", now });
    if (noVacio(g.subject)) stmts.updateName.run({ jid, name: g.subject, now, overwrite: 1 });
    if (Array.isArray(g.participants) && g.participants.length) {
      const tx = db.transaction(() => {
        db.prepare("DELETE FROM wa_group_participants WHERE group_jid = ?").run(jid);
        for (const p of g.participants ?? []) {
          const pj = canonicoDe(p.id);
          if (!pj) continue;
          upsertPart.run(jid, pj, p.admin ? 1 : 0, now);
          if (noVacio(p.name) || noVacio(p.notify)) {
            stmts.upsertContact.run({ jid: pj, name: noVacio(p.name), notify: noVacio(p.notify), verified: null, lid: null, now });
          }
        }
      });
      tx();
    }
    tocados.push(jid);
  }
  return tocados;
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
    `UPDATE messages SET type = @type, text = @text, raw_json = @raw_json, edited = MAX(edited, @edited), stub = NULL
      WHERE chat_jid = @chat_jid AND id = @id`
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
    const esEdicion = !!proto?.editedMessage;
    const body = proto?.editedMessage ?? upd.message;
    const targetId = proto?.key?.id ?? u.key?.id;
    if (!targetId) continue;
    const content = extractContent({ key: u.key, message: body } as WAMessage);
    if (!content) continue;
    const raw = JSON.stringify({ key: u.key, message: body });
    const updated = updateContent.run({
      type: content.type, text: content.text, raw_json: raw, edited: esEdicion ? 1 : 0, chat_jid: jid, id: targetId,
    });
    if (updated.changes === 0) {
      const ts = tsOf(upd.messageTimestamp, now);
      stmts.ensureChat.run({ jid, phone: telefonoEs(jid), display_name: "", now });
      const ins = stmts.insertMessage.run({
        chat_jid: jid, id: targetId, from_me: u.key?.fromMe ? 1 : 0, ts,
        type: content.type, text: content.text, media_path: null, media_mime: null, raw_json: raw,
        participant: null, status: null, stub: null,
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

/**
 * ESTADO de mensajes por `messages.update`: acuses (ticks: enviado → entregado →
 * leído, nunca hacia atrás) y BORRADO PARA TODOS (`messageStubType: REVOKE`,
 * `message: null`). Devuelve los chats tocados.
 */
export function aplicarEstadoMensajes(
  updates: Array<{ key: WAMessage["key"]; update: Partial<WAMessage> }>
): Set<string> {
  const db = getDb();
  const estado = db.prepare(
    "UPDATE messages SET status = @status WHERE chat_jid = @jid AND id = @id AND COALESCE(status, -1) < @status"
  );
  const revocar = db.prepare("UPDATE messages SET revoked = 1 WHERE chat_jid = ? AND id = ? AND revoked = 0");
  const previewRevocado = db.prepare(
    `UPDATE chats SET last_message_preview = '🚫 Se eliminó este mensaje'
      WHERE jid = @jid AND last_message_at = (SELECT ts FROM messages WHERE chat_jid = @jid AND id = @id)`
  );
  const touched = new Set<string>();
  for (const u of updates) {
    const jidCrudo = normalizarJid(u.key?.remoteJid);
    if (!jidCrudo || !isStorableChatJid(jidCrudo) || !u.key?.id) continue;
    const jid = canonicoDe(jidCrudo);
    const upd = u.update as { status?: unknown; messageStubType?: unknown; message?: unknown } | undefined;
    const st = estadoDe(upd?.status);
    if (st !== null && estado.run({ status: st, jid, id: u.key.id }).changes > 0) touched.add(jid);
    const stubName = typeof upd?.messageStubType === "number" ? STUBS[upd.messageStubType] : upd?.messageStubType;
    if (stubName === "REVOKE" || (upd && "message" in upd && upd.message === null && stubName)) {
      if (revocar.run(jid, u.key.id).changes > 0) {
        previewRevocado.run({ jid, id: u.key.id });
        touched.add(jid);
      }
    }
  }
  return touched;
}

/** «Eliminar para mí» / «Vaciar chat» hechos en el móvil (`messages.delete`). Se ocultan, no se borran. */
export function aplicarBorradosParaMi(evt: { keys: WAMessage["key"][] } | { jid: string; all: true }): Set<string> {
  const db = getDb();
  const touched = new Set<string>();
  if ("all" in evt) {
    const jid = canonicoDe(evt.jid);
    if (jid && db.prepare("UPDATE messages SET deleted_for_me = 1 WHERE chat_jid = ? AND deleted_for_me = 0").run(jid).changes > 0) {
      touched.add(jid);
    }
    return touched;
  }
  const uno = db.prepare("UPDATE messages SET deleted_for_me = 1 WHERE chat_jid = ? AND id = ? AND deleted_for_me = 0");
  for (const k of evt.keys ?? []) {
    const jid = canonicoDe(k?.remoteJid);
    if (!jid || !k?.id) continue;
    if (uno.run(jid, k.id).changes > 0) touched.add(jid);
  }
  return touched;
}

/** Reacciones (`messages.reaction`): texto vacío = quitar. Devuelve los chats tocados. */
export function aplicarReacciones(
  lista: Array<{ key: WAMessage["key"]; reaction: { text?: string | null; key?: WAMessage["key"] | null; senderTimestampMs?: unknown } }>
): Set<string> {
  const db = getDb();
  const poner = db.prepare(
    `INSERT INTO wa_reactions (chat_jid, msg_id, sender, emoji, ts) VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(chat_jid, msg_id, sender) DO UPDATE SET emoji = excluded.emoji, ts = excluded.ts`
  );
  const quitar = db.prepare("DELETE FROM wa_reactions WHERE chat_jid = ? AND msg_id = ? AND sender = ?");
  const touched = new Set<string>();
  for (const r of lista) {
    const jid = canonicoDe(r.key?.remoteJid);
    const msgId = r.key?.id;
    if (!jid || !msgId) continue;
    const rk = r.reaction?.key;
    const sender = rk?.fromMe ? "me" : canonicoDe(rk?.participant ?? r.key?.participant ?? rk?.remoteJid ?? r.key?.remoteJid) || jid;
    const emoji = noVacio(r.reaction?.text);
    const tsMs = tsOf(r.reaction?.senderTimestampMs, 0);
    if (emoji) poner.run(jid, msgId, sender, emoji, tsMs > 0 ? Math.floor(tsMs / 1000) : null);
    else quitar.run(jid, msgId, sender);
    touched.add(jid);
  }
  return touched;
}

/**
 * `chats.update` / `chats.upsert`: lo que el móvil sincroniza del estado del
 * chat — leído (`unreadCount`), archivado, fijado, silenciado y el nombre de
 * los grupos. Devuelve los chats cuyo estado cambió. `crear` = dar de alta la
 * fila si no existe (solo tiene sentido en `chats.upsert`).
 */
export function aplicarEstadoDeChats(
  updates: Array<Partial<Chat> & { id?: string | null; unreadCount?: number | null }>,
  crear = false
): string[] {
  const db = getDb();
  const stmts = statements();
  const now = Math.floor(Date.now() / 1000);
  const setArch = db.prepare("UPDATE chats SET archived = ?, updated_at = ? WHERE jid = ? AND archived <> ?");
  const setPin = db.prepare("UPDATE chats SET pinned = ?, updated_at = ? WHERE jid = ? AND COALESCE(pinned, -1) <> COALESCE(?, -1)");
  const setMute = db.prepare("UPDATE chats SET mute_until = ?, updated_at = ? WHERE jid = ? AND COALESCE(mute_until, -1) <> COALESCE(?, -1)");
  const tocados: string[] = [];
  for (const u of updates) {
    const jidCrudo = normalizarJid(u?.id);
    if (!jidCrudo || !isStorableChatJid(jidCrudo)) continue;
    const jid = canonicoDe(jidCrudo);
    if (crear) stmts.ensureChat.run({ jid, phone: telefonoEs(jid), display_name: u.name ?? "", now });
    let cambio = false;
    if (applyWaRead(jid, u.unreadCount)) cambio = true;
    if (typeof u.archived === "boolean") cambio = setArch.run(u.archived ? 1 : 0, now, jid, u.archived ? 1 : 0).changes > 0 || cambio;
    if ("pinned" in u) {
      const pin = u.pinned ? tsOf(u.pinned, now) : null;
      cambio = setPin.run(pin, now, jid, pin).changes > 0 || cambio;
    }
    if ("muteEndTime" in u) {
      const hasta = u.muteEndTime ? tsOf(u.muteEndTime, 0) || null : null;
      cambio = setMute.run(hasta, now, jid, hasta).changes > 0 || cambio;
    }
    if (esGrupo(jid) && noVacio(u.name)) cambio = stmts.updateName.run({ jid, name: u.name, now, overwrite: 1 }).changes > 0 || cambio;
    if (cambio) tocados.push(jid);
  }
  return tocados;
}

/** Chats borrados en el móvil (`chats.delete`): se ocultan; si llega un mensaje nuevo, renacen. */
export function borrarChats(jids: string[]): string[] {
  const db = getDb();
  const now = Math.floor(Date.now() / 1000);
  const out: string[] = [];
  for (const j of jids) {
    const jid = canonicoDe(j);
    if (jid && db.prepare("UPDATE chats SET deleted_at = ?, updated_at = ? WHERE jid = ? AND deleted_at IS NULL").run(now, now, jid).changes > 0) out.push(jid);
  }
  return out;
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
  status?: number | null;
}): boolean {
  const stmts = statements();
  const now = Math.floor(Date.now() / 1000);
  stmts.ensureChat.run({ jid: m.jid, phone: telefonoEs(m.jid), display_name: "", now });
  const ins = stmts.insertMessage.run({
    chat_jid: m.jid, id: m.id, from_me: 1, ts: m.ts, type: m.type, text: m.text,
    media_path: m.mediaPath ?? null, media_mime: m.mediaMime ?? null, raw_json: m.rawJson ?? null,
    participant: null, status: m.status ?? 1, stub: null,
  });
  if (ins.changes > 0) stmts.bumpChat.run({ jid: m.jid, ts: m.ts, preview: previewDe(m.type, m.text), now });
  return ins.changes > 0;
}
