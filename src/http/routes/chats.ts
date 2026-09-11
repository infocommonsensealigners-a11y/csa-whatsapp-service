/**
 * Rutas de inbox:
 *  - GET  /chats?query=&limit=&offset=      → { chats: ChatSummary[], total }
 *  - GET  /chats/index                      → mapa teléfono → chat (para el CRM)
 *  - GET  /chats/:jid/messages?beforeTs=&limit= → { messages, campana, notas, unreadFrom, unreadCount }
 *  - POST /chats/:jid/opened                → marca leído local (last_opened_at)
 *  - POST /chats/:jid/ignore                → { ignored: boolean }
 *  - POST /chats/:jid/presence              → suscribe la presencia del contacto (escribiendo…)
 *
 * Toda ruta `/chats/:jid/...` acepta cualquier jid de la persona (también un
 * `@lid` ya fundido) y trabaja sobre su chat CANÓNICO (ver src/wa/canonico.ts).
 */
import type { FastifyInstance } from "fastify";
import type { WAMessage } from "baileys";
import { getDb } from "../../db/db";
import { marcasDeChat } from "../../campanas/marcas";
import { canonicoDe } from "../../wa/canonico";
import { digitosDeJid, esGrupo } from "../../wa/identidad";
import { contenidoInterior, extractContent } from "../../wa/ingestCore";
import { getMe, suscribirPresencia } from "../../wa/socket";
import { emitSse } from "../sse";
import type { ChatSummary, WaCita, WaEstadoMensaje, WaMessage, WaReaccion } from "../../shared/whatsapp-contracts";

/**
 * Jid de una ruta `/chats/:jid/...` → jid CANÓNICO. Un enlace guardado con el
 * `@lid` de una persona cuyo chat se ha fundido en el del teléfono sigue
 * funcionando: se redirige a la fila que tiene la conversación.
 */
export function jidDeRuta(param: unknown): string {
  const crudo = String(param ?? "");
  return canonicoDe(crudo) || crudo;
}

interface ChatRow {
  jid: string;
  phone: string | null;
  display_name: string | null;
  last_message_at: number | null;
  last_message_preview: string | null;
  ignored: number;
  archived: number;
  pinned: number | null;
  mute_until: number | null;
  unread: number;
  /** from_me / status del ÚLTIMO mensaje; null si el chat no tiene ninguno. */
  last_from_me: number | null;
  last_status: number | null;
  participantes: number;
  /** Nombre del lead del CRM atado a este chat (vínculo activo), si lo hay. */
  lead_name: string | null;
  /** Fila del CRM del vínculo activo, si lo hay. */
  lead_source_row: number | null;
}

/**
 * ¿Es un jid de "número oculto" de WhatsApp? Su parte de usuario es un
 * identificador interno de 15 dígitos, NO un teléfono: pintarlo tal cual es lo
 * que hacía que el teléfono flotante pareciera "inventarse" un número.
 */
function esLid(jid: string): boolean {
  return jid.endsWith("@lid");
}

const ESTADO_TEXTO: Record<number, WaEstadoMensaje> = { 0: "error", 1: "pending", 2: "sent", 3: "delivered", 4: "read", 5: "played" };
function estadoTexto(v: number | null | undefined): WaEstadoMensaje | null {
  return typeof v === "number" && v in ESTADO_TEXTO ? ESTADO_TEXTO[v] : null;
}

/**
 * Nombre que se ENSEÑA de un chat, por orden de fiabilidad:
 *   nombre de WhatsApp → nombre del lead del CRM → teléfono → etiqueta honesta.
 *
 * ⚠️ EL ÚLTIMO RECURSO NO PUEDE SER EL JID (bug reportado el 2026-08-13: la
 * cabecera del teléfono flotante mostraba "154455630713007" como si fuera el
 * número de la persona, cuando es el identificador interno de un `@lid`). Para
 * un número oculto sin nombre se dice justamente eso; para el resto, el número
 * sí es real y se puede mostrar.
 */
function nombreDeChat(row: ChatRow): string {
  const wa = (row.display_name ?? "").trim();
  if (wa) return wa;
  if (esGrupo(row.jid)) return "Grupo";
  const crm = (row.lead_name ?? "").trim();
  if (crm) return crm;
  const tel = (row.phone ?? "").trim();
  if (tel) return tel;
  if (esLid(row.jid)) return "Número oculto";
  const user = row.jid.split("@")[0].split(":")[0];
  return /^\d{6,}$/.test(user) ? `+${user}` : "Contacto sin nombre";
}

/**
 * EL OTRO NOMBRE con el que está guardada esta persona, si difiere del que se
 * enseña.
 *
 * ⚠️ Pedido del usuario (08-09-2026): «si hay dos nombres registrados a ese
 * número mucho cuidado… que se muestre ese otro nombre por el que se guarda».
 * En el teléfono flotante hay UNA conversación por número, así que si WhatsApp
 * lo tiene como «Javier Lead SBA» y el CRM como «Javier García Cardeñosa»,
 * enseñar solo uno hace imposible reconocerlo por el otro. La búsqueda ya casaba
 * los dos (ver el WHERE de /chats); lo que faltaba era VERLO.
 *
 * Se compara sin acentos ni mayúsculas para no enseñar como «otro nombre» lo que
 * es el mismo escrito distinto.
 */
function nombreAlternoDeChat(row: ChatRow): string | null {
  const wa = (row.display_name ?? "").trim();
  const crm = (row.lead_name ?? "").trim();
  if (!wa || !crm) return null;
  const norm = (s: string) =>
    s.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/\s+/g, " ").trim();
  if (norm(wa) === norm(crm)) return null;
  // Se enseña el que NO se está mostrando. `nombreDeChat` prefiere el de
  // WhatsApp, así que el alterno es el del CRM.
  return crm;
}

function toSummary(row: ChatRow): ChatSummary {
  const grupo = esGrupo(row.jid);
  return {
    jid: row.jid,
    phone: row.phone,
    displayName: nombreDeChat(row),
    nombreAlterno: grupo ? null : nombreAlternoDeChat(row),
    isGroup: grupo,
    archived: row.archived === 1,
    pinned: row.pinned ?? null,
    mutedUntil: row.mute_until ?? null,
    lastMessageAt: row.last_message_at,
    lastMessagePreview: row.last_message_preview,
    lastMessageFromMe: row.last_from_me == null ? null : row.last_from_me === 1,
    lastMessageStatus: row.last_from_me === 1 ? estadoTexto(row.last_status) : null,
    participants: grupo ? row.participantes : undefined,
    unread: row.unread,
    // Habló ELLA/ÉL el último → la pelota está en nuestro tejado (no en grupos).
    pendingReply: !grupo && row.last_from_me === 0,
    ignored: row.ignored === 1,
    // El contrato ya preveía este hueco (`ChatLeadLink`) y estaba a []: sin él,
    // la interfaz no podía saber a qué lead pertenece un chat sin volver a
    // adivinarlo por su cuenta.
    links:
      row.lead_source_row != null
        ? [
            {
              sourceRow: row.lead_source_row,
              method: "auto" as const,
              leadName: (row.lead_name ?? "").trim() || null,
              phoneSnapshot: row.phone,
              healthy: true,
            },
          ]
        : [],
    approvedTags: [],
    proposedTags: [],
    hasAbstract: false,
  };
}

/* ------------------------ nombres de participantes ------------------------ */

/**
 * Nombre de una persona por su jid (para grupos, citas y reacciones), con la
 * misma prioridad que WhatsApp Web: agenda → negocio → chat 1-a-1 → pushName →
 * número. Se cachea por petición.
 */
function resolverNombres(jids: Iterable<string>): Map<string, string> {
  const db = getDb();
  const contacto = db.prepare("SELECT name, verified_name, notify FROM wa_contacts WHERE jid = ?");
  const chat = db.prepare("SELECT display_name FROM chats WHERE jid = ?");
  const out = new Map<string, string>();
  for (const jid of jids) {
    if (!jid || out.has(jid)) continue;
    const c = contacto.get(jid) as { name: string | null; verified_name: string | null; notify: string | null } | undefined;
    const ch = chat.get(jid) as { display_name: string | null } | undefined;
    const nombre =
      (c?.name ?? "").trim() || (c?.verified_name ?? "").trim() || (ch?.display_name ?? "").trim() || (c?.notify ?? "").trim();
    if (nombre) out.set(jid, nombre);
    else {
      const d = digitosDeJid(jid);
      out.set(jid, d ? `+${d}` : esLid(jid) ? "Número oculto" : jid.split("@")[0]);
    }
  }
  return out;
}

/** Texto de una línea de SISTEMA, como la redacta WhatsApp Web. */
function textoDeSistema(stub: string, params: string[], fromMe: boolean, actor: string | null, nombres: Map<string, string>): string {
  const quien = fromMe ? "Tú" : actor ? (nombres.get(actor) ?? "Alguien") : "Alguien";
  const lista = params.map((p) => canonicoDe(p) || p).map((p) => (p === "me" ? "ti" : (nombres.get(p) ?? p.split("@")[0])));
  switch (stub) {
    case "CIPHERTEXT":
      return "Esperando el mensaje. Puede tardar un poco.";
    case "REVOKE":
      return "Se eliminó este mensaje";
    case "GROUP_CREATE":
      return `${quien} creó el grupo`;
    case "GROUP_CHANGE_SUBJECT":
      return `${quien} cambió el asunto a «${params[0] ?? ""}»`;
    case "GROUP_CHANGE_ICON":
      return `${quien} cambió la imagen del grupo`;
    case "GROUP_CHANGE_DESCRIPTION":
      return `${quien} cambió la descripción del grupo`;
    case "GROUP_PARTICIPANT_ADD":
      return `${quien} añadió a ${lista.join(", ") || "alguien"}`;
    case "GROUP_PARTICIPANT_REMOVE":
      return `${quien} eliminó a ${lista.join(", ") || "alguien"}`;
    case "GROUP_PARTICIPANT_PROMOTE":
      return `${lista.join(", ") || quien} ahora es admin`;
    case "GROUP_PARTICIPANT_DEMOTE":
      return `${lista.join(", ") || quien} ya no es admin`;
    case "GROUP_PARTICIPANT_INVITE":
      return `${quien} se unió con el enlace de invitación`;
    case "GROUP_PARTICIPANT_LEAVE":
      return `${quien} salió`;
    case "GROUP_DELETE":
      return "Este grupo se eliminó";
    case "CALL_MISSED_VOICE":
    case "CALL_MISSED_GROUP_VOICE":
      return "Llamada de voz perdida";
    case "CALL_MISSED_VIDEO":
    case "CALL_MISSED_GROUP_VIDEO":
      return "Videollamada perdida";
    default:
      return "Cambio en el grupo";
  }
}

/** ¿Es un jid nuestro (el de la cuenta o su LID)? */
function esMio(jid: string | null | undefined): boolean {
  if (!jid) return false;
  const me = getMe();
  if (!me) return false;
  const d = digitosDeJid(jid);
  return !!d && d === digitosDeJid(me.jid);
}

/** La cita (respuesta a otro mensaje) escondida en el raw_json de un mensaje. */
function citaDe(raw: string | null, chatJid: string, nombres: Map<string, string>, faltan: Set<string>): WaCita | null {
  if (!raw) return null;
  let msg: WAMessage;
  try {
    msg = JSON.parse(raw) as WAMessage;
  } catch {
    return null;
  }
  const inner = contenidoInterior(msg.message);
  if (!inner) return null;
  for (const v of Object.values(inner as Record<string, unknown>)) {
    const ctx = (v as { contextInfo?: { stanzaId?: string | null; participant?: string | null; quotedMessage?: WAMessage["message"] } } | null)?.contextInfo;
    if (!ctx?.stanzaId) continue;
    const original = getDb().prepare("SELECT from_me, participant FROM messages WHERE chat_jid = ? AND id = ?").get(chatJid, ctx.stanzaId) as
      | { from_me: number; participant: string | null }
      | undefined;
    const participante = canonicoDe(ctx.participant) || null;
    const fromMe = original ? original.from_me === 1 : esMio(participante);
    const contenido = ctx.quotedMessage ? extractContent({ key: {}, message: ctx.quotedMessage } as WAMessage) : null;
    const quien = fromMe ? null : (original?.participant ?? participante);
    if (quien && !nombres.has(quien)) faltan.add(quien);
    return {
      id: ctx.stanzaId,
      fromMe,
      participantName: fromMe ? null : quien ? (nombres.get(quien) ?? null) : null,
      text: contenido?.text ?? null,
      type: contenido?.type ?? "other",
    };
  }
  return null;
}

export function registerChatRoutes(app: FastifyInstance): void {
  app.get("/chats", async (request) => {
    const q = request.query as { query?: string; limit?: string; offset?: string };
    const limit = Math.min(Number(q.limit) || 100, 500);
    const offset = Number(q.offset) || 0;
    const search = (q.query ?? "").trim();

    const db = getDb();
    /**
     * BUSCAR POR LO QUE LA PERSONA SABE, no por lo que WhatsApp guardó.
     *
     * Hasta 2026-08-07 solo se miraba `display_name` y `phone` del chat, y eso
     * dejaba invisibles casos reales: hay 153 chats sin teléfono (84 de ellos
     * `@lid`, los de "número oculto"), y su nombre en WhatsApp puede ser un
     * número pelado como "34645643911". Buscar "Isabel Gallego" —el nombre que
     * Fran ve en el CRM— no encontraba nada, y la conclusión razonable era
     * "esta conversación no existe aquí".
     *
     * Ahora se busca además por:
     *  - el nombre y el teléfono del LEAD en el directorio del CRM, atados al
     *    chat por `chat_lead_links` (solo vínculos activos);
     *  - la instantánea del nombre guardada en el propio vínculo, que sobrevive
     *    aunque la fila del CRM se mueva o se borre;
     *  - el teléfono real detrás de un `@lid` (`wa_lid_map`), para los que
     *    todavía no se han volcado a `chats.phone`.
     *
     * `alias_of IS NULL`: las filas @lid ya fundidas en el chat del teléfono no
     * son conversaciones, son redirecciones (ver src/db/fusion.ts).
     * `deleted_at IS NULL`: un chat borrado en el móvil no se enseña (renace si
     * llega un mensaje).
     */
    const base = "c.ignored = 0 AND c.alias_of IS NULL AND c.deleted_at IS NULL";
    const where = search
      ? `WHERE ${base} AND (
             c.display_name LIKE @like
          OR c.phone LIKE @like
          OR EXISTS (SELECT 1 FROM wa_lid_map lm
                      WHERE lm.lid = c.jid AND (lm.phone LIKE @like OR lm.pn LIKE @like))
          OR EXISTS (SELECT 1 FROM chat_lead_links cll
                      LEFT JOIN lead_directory ld ON ld.source_row = cll.source_row
                      WHERE cll.chat_jid = c.jid AND cll.status = 'active'
                        AND (cll.lead_name_snapshot LIKE @like
                          OR cll.phone_snapshot LIKE @like
                          OR ld.name LIKE @like
                          OR ld.phone LIKE @like))
        )`
      : `WHERE ${base}`;
    const rows = db
      .prepare(
        `SELECT c.jid,
                -- El teléfono REAL aunque el chat sea @lid: mismo COALESCE que
                -- /chats/index (chats.phone está NULL en todos los @lid).
                COALESCE(NULLIF(c.phone,''), lm.phone, cll.phone_snapshot, ld.phone) AS phone,
                c.display_name,
                cll.source_row                                   AS lead_source_row,
                COALESCE(NULLIF(cll.lead_name_snapshot,''), ld.name) AS lead_name,
                c.last_message_at, c.last_message_preview, c.ignored,
                c.archived, c.pinned, c.mute_until,
                -- NO LEÍDOS: un mensaje solo cuenta si es posterior a AMBAS
                -- marcas — la local (abrir el chat aquí) y la de WhatsApp
                -- (leerlo en el móvil o en WhatsApp Web, ver src/wa/readState.ts).
                -- Es decir: leído en cualquiera de los dos sitios = leído.
                (SELECT COUNT(*) FROM messages m
                  WHERE m.chat_jid = c.jid AND m.from_me = 0 AND m.deleted_for_me = 0
                    AND m.ts > MAX(COALESCE(c.last_opened_at, 0),
                                   COALESCE(c.wa_read_at, 0))) AS unread,
                -- PENDIENTE DE CONTESTAR y tick de la lista: quién escribió el
                -- último mensaje y en qué estado está (barato: índice chat_jid+ts).
                (SELECT m2.from_me FROM messages m2
                  WHERE m2.chat_jid = c.jid AND m2.deleted_for_me = 0 ORDER BY m2.ts DESC LIMIT 1) AS last_from_me,
                (SELECT m3.status FROM messages m3
                  WHERE m3.chat_jid = c.jid AND m3.deleted_for_me = 0 ORDER BY m3.ts DESC LIMIT 1) AS last_status,
                (SELECT COUNT(*) FROM wa_group_participants gp WHERE gp.group_jid = c.jid) AS participantes
         FROM chats c
         LEFT JOIN wa_lid_map lm ON lm.lid = c.jid
         -- ⚠️ UN SOLO VÍNCULO POR CHAT. Hay 7 chats con más de un vínculo activo
         -- (una persona con dos filas en el CRM), y sin este desempate el LEFT
         -- JOIN devolvería el chat repetido: con LIMIT/OFFSET los duplicados se
         -- comen sitios de la página y la lista se salta conversaciones. Gana el
         -- vínculo tocado más recientemente.
         LEFT JOIN chat_lead_links cll
                ON cll.chat_jid = c.jid AND cll.status = 'active'
               AND cll.source_row = (SELECT c2.source_row FROM chat_lead_links c2
                                      WHERE c2.chat_jid = c.jid AND c2.status = 'active'
                                      ORDER BY c2.updated_at DESC, c2.source_row DESC LIMIT 1)
         LEFT JOIN lead_directory ld ON ld.source_row = cll.source_row
         ${where}
         -- Como WhatsApp Web: los FIJADOS siempre arriba (y siempre en la primera
         -- página), el resto por recencia. Desempate fijo por jid: dos chats con
         -- el mismo segundo no deben cambiar de orden entre páginas.
         ORDER BY (c.pinned IS NOT NULL) DESC, c.last_message_at DESC, c.jid ASC
         LIMIT @limit OFFSET @offset`
      )
      .all({ like: `%${search}%`, limit, offset }) as ChatRow[];
    const total = (
      db.prepare(`SELECT COUNT(*) AS n FROM chats c ${where}`).get({ like: `%${search}%` }) as {
        n: number;
      }
    ).n;

    // Etiquetas de WhatsApp Business por chat (read-only, del móvil del usuario).
    // Defensivo: si las tablas de etiquetas faltan o fallan, NUNCA rompe /chats.
    let chats;
    try {
      // `id` va incluido desde 2026-07-30: la interfaz lo necesita para poder
      // poner/quitar la etiqueta (bidireccional, ver src/wa/labels.ts).
      const labelStmt = db.prepare(
        `SELECT l.id AS id, l.name AS name, l.color AS color
           FROM wa_chat_labels cl JOIN wa_labels l ON l.id = cl.label_id
          WHERE cl.chat_jid = ? AND l.deleted = 0
          ORDER BY l.name`
      );
      chats = rows.map((r) => ({
        ...toSummary(r),
        waLabels: labelStmt.all(r.jid) as Array<{ id: string; name: string; color: number }>,
      }));
    } catch {
      chats = rows.map((r) => ({ ...toSummary(r), waLabels: [] as Array<{ id: string; name: string; color: number }> }));
    }
    return { chats, total };
  });

  /**
   * GET /chats/index — el mapa TELÉFONO → conversación, para el CRM.
   *
   * Por qué existe (fallo reportado 2026-08-07): la columna WhatsApp del CRM
   * resolvía a qué chat llevar mirando `chat_intel`, o sea el cerebro de
   * Fransua. Pero el intel solo tiene lo que la IA ha ASIMILADO: un lead al que
   * se le escribió una vez y no ha contestado no está ahí, así que la columna se
   * quedaba muda aunque la conversación existiera y estuviera a un clic. El
   * usuario lo dijo claro: "da igual que solo haya un mensaje y no nos haya
   * contestado, siempre nos hipervincula a la conversación".
   *
   * Devuelve TODOS los chats (no los 500 del listado) pero solo tres campos, así
   * que son ~60 KB para 1.400 conversaciones: cabe de sobra en una petición y el
   * dashboard lo cachea.
   *
   * El teléfono sale de tres sitios, por orden: el del chat, el del mapa `@lid`
   * (los "número oculto" traen el real en `key.senderPn`), y la instantánea del
   * vínculo con el CRM. Y se devuelven también las filas del CRM enlazadas, para
   * poder casar por fila cuando el teléfono esté escrito de otra forma.
   */
  app.get("/chats/index", async () => {
    const filas = getDb()
      .prepare(
        /**
         * `ld.phone` cierra el último hueco (bug del 2026-08-13, Núñez del
         * Prado sin icono de WhatsApp estando en conversación): un chat
         * vinculado POR NOMBRE guarda `phone_snapshot = chats.phone`, que en un
         * `@lid` es NULL, así que entraba en el índice sin teléfono y su única
         * vía de cruce era el número de fila — justo el puntero que se mueve.
         * El teléfono del lead sí está en el directorio del CRM.
         */
        `SELECT c.jid                                        AS jid,
                COALESCE(NULLIF(c.phone,''), lm.phone, cll.phone_snapshot, ld.phone) AS phone,
                c.last_message_at                            AS lastMessageAt,
                cll.source_row                               AS sourceRow
           FROM chats c
           LEFT JOIN wa_lid_map lm ON lm.lid = c.jid
           -- Un solo vínculo por chat (ver la nota en /chats): aquí la repetición
           -- no rompía nada porque el cliente construye mapas, pero devolver el
           -- mismo chat dos veces con teléfonos distintos hace que cuál gane
           -- dependa del orden, y eso es justo lo que no queremos en un cruce.
           LEFT JOIN chat_lead_links cll
                  ON cll.chat_jid = c.jid AND cll.status = 'active'
                 AND cll.source_row = (SELECT c2.source_row FROM chat_lead_links c2
                                        WHERE c2.chat_jid = c.jid AND c2.status = 'active'
                                        ORDER BY c2.updated_at DESC, c2.source_row DESC LIMIT 1)
           LEFT JOIN lead_directory ld ON ld.source_row = cll.source_row
          WHERE c.ignored = 0 AND c.alias_of IS NULL AND c.jid NOT LIKE '%@g.us'
          ORDER BY c.last_message_at DESC, c.jid ASC`
      )
      .all() as Array<{ jid: string; phone: string | null; lastMessageAt: number | null; sourceRow: number | null }>;
    return { chats: filas, total: filas.length };
  });

  app.get("/chats/:jid/messages", async (request) => {
    const jid = jidDeRuta((request.params as { jid: string }).jid);
    const q = request.query as { beforeTs?: string; limit?: string };
    const limit = Math.min(Number(q.limit) || 50, 200);
    const beforeTs = Number(q.beforeTs) || Number.MAX_SAFE_INTEGER;
    const db = getDb();

    const rows = db
      .prepare(
        // `recuperable`: el mensaje conserva su raw_json, o sea las claves de
        // descifrado → su binario SE PUEDE pedir a WhatsApp aunque nunca se
        // descargara (POST /media/:jid/:id/fetch). El raw_json se usa AQUÍ para
        // sacar la cita y los parámetros de sistema; al navegador no viaja.
        // Los borrados «para mí» no se enseñan, como en WhatsApp Web.
        `SELECT id, chat_jid, from_me, ts, type, text, media_path, participant, status, revoked, edited, stub, raw_json
         FROM messages
         WHERE chat_jid = ? AND ts < ? AND deleted_for_me = 0
         ORDER BY ts DESC
         LIMIT ?`
      )
      .all(jid, beforeTs, limit) as Array<{
      id: string;
      chat_jid: string;
      from_me: number;
      ts: number;
      type: WaMessage["type"];
      text: string | null;
      media_path: string | null;
      participant: string | null;
      status: number | null;
      revoked: number;
      edited: number;
      stub: string | null;
      raw_json: string | null;
    }>;

    // Reacciones de esta página, en una sola consulta.
    const reacciones = new Map<string, Array<{ sender: string; emoji: string; ts: number | null }>>();
    if (rows.length) {
      const ids = rows.map((r) => r.id);
      const marcas = db
        .prepare(`SELECT msg_id, sender, emoji, ts FROM wa_reactions WHERE chat_jid = ? AND msg_id IN (${ids.map(() => "?").join(",")})`)
        .all(jid, ...ids) as Array<{ msg_id: string; sender: string; emoji: string; ts: number | null }>;
      for (const m of marcas) {
        const l = reacciones.get(m.msg_id) ?? [];
        l.push(m);
        reacciones.set(m.msg_id, l);
      }
    }

    // Nombres de todo el que aparece (participantes, citados, reaccionantes, actores de sistema).
    const jidsNombre = new Set<string>();
    for (const r of rows) {
      if (r.participant) jidsNombre.add(r.participant);
      for (const x of reacciones.get(r.id) ?? []) if (x.sender !== "me") jidsNombre.add(x.sender);
      if (r.stub && r.raw_json) {
        try {
          const params = (JSON.parse(r.raw_json) as WAMessage).messageStubParameters ?? [];
          for (const p of params) {
            const c = canonicoDe(String(p));
            if (c) jidsNombre.add(c);
          }
        } catch {
          /* sin nombres */
        }
      }
    }
    const nombres = resolverNombres(jidsNombre);
    // Las citas pueden nombrar a alguien que no estaba en la lista: segunda pasada.
    const faltan = new Set<string>();
    const citas = new Map<string, WaCita | null>();
    for (const r of rows) if (!r.stub && r.raw_json?.includes("stanzaId")) citas.set(r.id, citaDe(r.raw_json, jid, nombres, faltan));
    if (faltan.size) {
      for (const [k, v] of resolverNombres(faltan)) nombres.set(k, v);
      for (const r of rows) if (citas.has(r.id)) citas.set(r.id, citaDe(r.raw_json, jid, nombres, new Set()));
    }

    // MARCA DE AGUA de campaña: qué mensajes los mandó la automatización y qué
    // notas internas de cierre hay en este chat (esas no se enviaron a nadie).
    const marcas = marcasDeChat(jid);
    const autos = new Set(marcas.automaticos);

    const messages: WaMessage[] = rows.map((r) => {
      let system: string | null = null;
      if (r.stub) {
        let params: string[] = [];
        try {
          params = ((JSON.parse(r.raw_json ?? "{}") as WAMessage).messageStubParameters ?? []).map(String);
        } catch {
          /* sin parámetros */
        }
        system = textoDeSistema(r.stub, params, r.from_me === 1, r.participant, nombres);
      }
      const reacs: WaReaccion[] = (reacciones.get(r.id) ?? []).map((x) => ({
        emoji: x.emoji,
        fromMe: x.sender === "me",
        sender: x.sender === "me" ? null : x.sender,
        senderName: x.sender === "me" ? null : (nombres.get(x.sender) ?? null),
        ts: x.ts,
      }));
      return {
        id: r.id,
        chatJid: r.chat_jid,
        fromMe: r.from_me === 1,
        automatico: autos.has(r.id),
        ts: r.ts,
        type: r.type,
        text: r.revoked ? null : r.text,
        mediaUrl: r.media_path && !r.revoked ? `/api/whatsapp/media/${encodeURIComponent(r.chat_jid)}/${encodeURIComponent(r.id)}` : null,
        recuperable: !!r.raw_json && !r.revoked,
        status: r.from_me === 1 ? estadoTexto(r.status) : null,
        revoked: r.revoked === 1,
        edited: r.edited === 1,
        participant: r.participant,
        participantName: r.participant ? (nombres.get(r.participant) ?? null) : null,
        reactions: reacs.length ? reacs : undefined,
        quoted: citas.get(r.id) ?? null,
        system,
      };
    });

    // PRIMER NO LEÍDO: para abrir la conversación ahí, como WhatsApp Web. Solo
    // tiene sentido en la primera página (sin `beforeTs`).
    let unreadFrom: number | null = null;
    let unreadCount = 0;
    if (!q.beforeTs) {
      const marca = db.prepare("SELECT MAX(COALESCE(last_opened_at, 0), COALESCE(wa_read_at, 0)) AS m FROM chats WHERE jid = ?").get(jid) as { m: number } | undefined;
      const r = db
        .prepare("SELECT MIN(ts) AS t, COUNT(*) AS n FROM messages WHERE chat_jid = ? AND from_me = 0 AND deleted_for_me = 0 AND ts > ?")
        .get(jid, marca?.m ?? 0) as { t: number | null; n: number };
      unreadFrom = r.t ?? null;
      unreadCount = r.n;
    }
    return { messages, campana: marcas.campana, notas: marcas.notas, unreadFrom, unreadCount };
  });

  app.post("/chats/:jid/opened", async (request) => {
    const jid = jidDeRuta((request.params as { jid: string }).jid);
    getDb()
      .prepare("UPDATE chats SET last_opened_at = ?, updated_at = ? WHERE jid = ?")
      .run(Math.floor(Date.now() / 1000), Math.floor(Date.now() / 1000), jid);
    emitSse({ type: "chat.updated", jid });
    return { ok: true };
  });

  app.post("/chats/:jid/ignore", async (request, reply) => {
    const jid = jidDeRuta((request.params as { jid: string }).jid);
    const body = request.body as { ignored?: unknown } | null;
    if (typeof body?.ignored !== "boolean") {
      return reply.status(400).send({ ok: false, error: 'Requiere body { "ignored": boolean }.' });
    }
    getDb()
      .prepare("UPDATE chats SET ignored = ?, updated_at = ? WHERE jid = ?")
      .run(body.ignored ? 1 : 0, Math.floor(Date.now() / 1000), jid);
    emitSse({ type: "chat.updated", jid });
    return { ok: true };
  });

  /**
   * Suscribe la PRESENCIA del contacto del chat abierto («en línea»,
   * «escribiendo…»). Lo que hace WhatsApp Web al abrir un chat; los avisos
   * llegan por SSE (`presence`). Solo lectura: nuestra presencia no se publica.
   */
  app.post("/chats/:jid/presence", async (request) => {
    const jid = jidDeRuta((request.params as { jid: string }).jid);
    if (esGrupo(jid)) return { ok: false, error: "grupo" };
    const ok = await suscribirPresencia(jid);
    return { ok };
  });
}
