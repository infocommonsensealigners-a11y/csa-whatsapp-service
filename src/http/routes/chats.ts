/**
 * Rutas de inbox (Fase 1, parcial):
 *  - GET  /chats?query=&limit=&offset=      → { chats: ChatSummary[], total }
 *  - GET  /chats/:jid/messages?beforeTs=&limit= → { messages: WaMessage[] } (desc)
 *  - POST /chats/:jid/opened                → marca leído local (last_opened_at)
 *  - POST /chats/:jid/ignore                → { ignored: boolean }
 *
 * links/tags/hasAbstract llegan vacíos hasta que el matcher (F1) y la capa IA
 * (F2) los rellenen — el shape del contrato ya es el definitivo.
 */
import type { FastifyInstance } from "fastify";
import { getDb } from "../../db/db";
import { marcasDeChat } from "../../campanas/marcas";
import { emitSse } from "../sse";
import type { ChatSummary, WaMessage } from "../../shared/whatsapp-contracts";

interface ChatRow {
  jid: string;
  phone: string | null;
  display_name: string | null;
  last_message_at: number | null;
  last_message_preview: string | null;
  ignored: number;
  unread: number;
  /** from_me del ÚLTIMO mensaje; null si el chat no tiene ninguno. */
  last_from_me: number | null;
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

/**
 * Nombre que se ENSEÑA de un chat, por orden de fiabilidad:
 *   nombre de WhatsApp → nombre del lead del CRM → teléfono → etiqueta honesta.
 *
 * ⚠️ EL ÚLTIMO RECURSO NO PUEDE SER EL JID (bug reportado el 2026-08-13: la
 * cabecera del teléfono flotante mostraba "154455630713007" como si fuera el
 * número de la persona, cuando es el identificador interno de un `@lid`). Para
 * un número oculto sin nombre se dice justamente eso; para el resto, el número
 * sí es real y se puede mostrar.
 *
 * El nombre del CRM ya se consultaba en este mismo endpoint... pero solo en el
 * `WHERE` de búsqueda: se podía ENCONTRAR el chat buscando "Susana" y aun así
 * verlo rotulado con el LID. Ahora ese JOIN también se proyecta.
 */
function nombreDeChat(row: ChatRow): string {
  const wa = (row.display_name ?? "").trim();
  if (wa) return wa;
  const crm = (row.lead_name ?? "").trim();
  if (crm) return crm;
  const tel = (row.phone ?? "").trim();
  if (tel) return tel;
  if (esLid(row.jid)) return "Número oculto";
  const user = row.jid.split("@")[0].split(":")[0];
  return /^\d{6,}$/.test(user) ? `+${user}` : "Contacto sin nombre";
}

function toSummary(row: ChatRow): ChatSummary {
  return {
    jid: row.jid,
    phone: row.phone,
    displayName: nombreDeChat(row),
    lastMessageAt: row.last_message_at,
    lastMessagePreview: row.last_message_preview,
    unread: row.unread,
    // Habló ELLA/ÉL el último → la pelota está en nuestro tejado.
    pendingReply: row.last_from_me === 0,
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
     */
    const where = search
      ? `WHERE c.ignored = 0 AND (
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
      : "WHERE c.ignored = 0";
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
                -- NO LEÍDOS: un mensaje solo cuenta si es posterior a AMBAS
                -- marcas — la local (abrir el chat aquí) y la de WhatsApp
                -- (leerlo en el móvil o en WhatsApp Web, ver src/wa/readState.ts).
                -- Es decir: leído en cualquiera de los dos sitios = leído.
                (SELECT COUNT(*) FROM messages m
                  WHERE m.chat_jid = c.jid AND m.from_me = 0
                    AND m.ts > MAX(COALESCE(c.last_opened_at, 0),
                                   COALESCE(c.wa_read_at, 0))) AS unread,
                -- PENDIENTE DE CONTESTAR: el último mensaje del chat lo escribió
                -- ELLOS. Es un hecho crudo (barato: hay índice por chat_jid+ts);
                -- decidir a partir de cuándo deja de ser accionable es cosa de
                -- quien lo pinta, no de aquí.
                (SELECT m2.from_me FROM messages m2
                  WHERE m2.chat_jid = c.jid ORDER BY m2.ts DESC LIMIT 1) AS last_from_me
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
         ORDER BY c.last_message_at DESC
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
          WHERE c.ignored = 0
          ORDER BY c.last_message_at DESC`
      )
      .all() as Array<{ jid: string; phone: string | null; lastMessageAt: number | null; sourceRow: number | null }>;
    return { chats: filas, total: filas.length };
  });

  app.get("/chats/:jid/messages", async (request) => {
    const { jid } = request.params as { jid: string };
    const q = request.query as { beforeTs?: string; limit?: string };
    const limit = Math.min(Number(q.limit) || 50, 200);
    const beforeTs = Number(q.beforeTs) || Number.MAX_SAFE_INTEGER;

    const rows = getDb()
      .prepare(
        // `recuperable`: el mensaje conserva su raw_json, o sea las claves de
        // descifrado → su binario SE PUEDE pedir a WhatsApp aunque nunca se
        // descargara (POST /media/:jid/:id/fetch). Sin raw_json no hay nada que
        // hacer y la interfaz debe decirlo en vez de ofrecer un botón muerto.
        // Se devuelve como 0/1 y NO se manda el raw_json entero: son decenas de
        // KB por mensaje y el navegador no los necesita para nada.
        `SELECT id, chat_jid, from_me, ts, type, text, media_path,
                CASE WHEN raw_json IS NOT NULL AND raw_json <> '' THEN 1 ELSE 0 END AS recuperable
         FROM messages
         WHERE chat_jid = ? AND ts < ?
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
      recuperable: number;
    }>;

    // MARCA DE AGUA de campaña: qué mensajes los mandó la automatización y qué
    // notas internas de cierre hay en este chat (esas no se enviaron a nadie).
    const marcas = marcasDeChat(jid);
    const autos = new Set(marcas.automaticos);

    const messages: WaMessage[] = rows.map((r) => ({
      id: r.id,
      chatJid: r.chat_jid,
      fromMe: r.from_me === 1,
      automatico: autos.has(r.id),
      ts: r.ts,
      type: r.type,
      text: r.text,
      mediaUrl: r.media_path ? `/api/whatsapp/media/${encodeURIComponent(r.chat_jid)}/${encodeURIComponent(r.id)}` : null,
      recuperable: r.recuperable === 1,
    }));
    return { messages, campana: marcas.campana, notas: marcas.notas };
  });

  app.post("/chats/:jid/opened", async (request) => {
    const { jid } = request.params as { jid: string };
    getDb()
      .prepare("UPDATE chats SET last_opened_at = ?, updated_at = ? WHERE jid = ?")
      .run(Math.floor(Date.now() / 1000), Math.floor(Date.now() / 1000), jid);
    emitSse({ type: "chat.updated", jid });
    return { ok: true };
  });

  app.post("/chats/:jid/ignore", async (request, reply) => {
    const { jid } = request.params as { jid: string };
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
}
