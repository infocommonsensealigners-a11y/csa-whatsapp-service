/**
 * GET /programa-enviado → ¿a qué leads se les mandó el dossier del PROGRAMA?
 *
 * Devuelve UNA sola respuesta con todos los chats que han recibido el programa,
 * para que el CRM la pida una vez y no una por fila (2.500 leads). Se resuelve
 * por TELÉFONO canónico además del sourceRow: la fila del Sheet se mueve, el
 * teléfono no (misma regla que el resto del proyecto).
 *
 * El programa es el dossier que se manda AL INICIAR el contacto; la PROPUESTA
 * personalizada (que va después de la llamada de venta) NO cuenta — la
 * distinción vive en `programaDetect.ts`, diseñada sobre los nombres reales del
 * histórico.
 */
import type { FastifyInstance } from "fastify";
import { getDb } from "../../db/db";
import { clasificarDocumento, vacio, algunoEnviado, type ProgramaKey, type ProgramasEnviados } from "../../wa/programaDetect";

interface Fila {
  chat_jid: string;
  phone: string | null;
  source_row: number | null;
  text: string;
  ts: number;
}

export interface ProgramaEnviadoItem {
  jid: string;
  phone: string | null;
  sourceRow: number | null;
  programas: ProgramasEnviados;
  /** Epoch s del PRIMER envío de programa (cuándo se inició el contacto de verdad). */
  primerEnvioTs: number | null;
  /** Nombre del documento que lo demuestra, para poder auditarlo desde la UI. */
  evidencia: string | null;
}

export function registerProgramaRoutes(app: FastifyInstance): void {
  app.get("/programa-enviado", async () => {
    const db = getDb();
    /**
     * Solo documentos ENVIADOS por nosotros (from_me=1): lo que manda el lead no
     * es el programa. Los LEFT JOIN traen el sourceRow cuando el chat está
     * vinculado, sin descartar los que no lo están (se cruzan por teléfono).
     *
     * Dos rescates que antes faltaban y dejaban envíos reales sin detectar
     * (caso Silvia Martínez, PDF del SBA no detectado, 2026-08-13):
     *
     * 1. EL NOMBRE DEL DOCUMENTO, desde `raw_json`. Un cliente de WhatsApp de
     *    Fran manda `caption:""` y hasta hoy eso se guardaba tal cual en
     *    `messages.text`, pisando el `fileName` (ya arreglado en `ingest.ts`,
     *    pero lo YA guardado sigue vacío). El nombre nunca se perdió: está en
     *    `raw_json`. Sacándolo aquí se recupera el histórico entero sin
     *    migración y sin depender de un backfill que alguien tenga que lanzar.
     *    Se prueban las rutas de los envoltorios (documentWithCaption, efímeros,
     *    view-once), que es donde acaba el documento según cómo se envíe.
     *
     * 2. EL TELÉFONO de los chats `@lid` ("número oculto"), con el MISMO
     *    COALESCE que ya usa `/chats/index`: `chats.phone` está NULL en los 88
     *    chats @lid y el cruce con el CRM se hace por teléfono, así que sin esto
     *    el item se descartaba entero aunque el PDF constara — y hoy casi todo
     *    el tráfico nuevo entra por @lid.
     */
    const filas = db
      .prepare(
        `SELECT m.chat_jid,
                COALESCE(NULLIF(c.phone,''), lm.phone, l.phone_snapshot, ld.phone) AS phone,
                l.source_row,
                COALESCE(
                  NULLIF(TRIM(m.text), ''),
                  NULLIF(TRIM(json_extract(m.raw_json, '$.message.documentMessage.fileName')), ''),
                  NULLIF(TRIM(json_extract(m.raw_json, '$.message.documentMessage.title')), ''),
                  NULLIF(TRIM(json_extract(m.raw_json, '$.message.documentWithCaptionMessage.message.documentMessage.fileName')), ''),
                  NULLIF(TRIM(json_extract(m.raw_json, '$.message.ephemeralMessage.message.documentMessage.fileName')), ''),
                  NULLIF(TRIM(json_extract(m.raw_json, '$.message.viewOnceMessageV2.message.documentMessage.fileName')), '')
                ) AS text,
                m.ts
           FROM messages m
           JOIN chats c ON c.jid = m.chat_jid
           LEFT JOIN chat_lead_links l ON l.chat_jid = m.chat_jid AND l.status = 'active'
           LEFT JOIN wa_lid_map lm ON lm.lid = c.jid
           LEFT JOIN lead_directory ld ON ld.source_row = l.source_row
          WHERE m.type = 'document' AND m.from_me = 1
          ORDER BY m.ts ASC`
      )
      .all() as Fila[];

    const porJid = new Map<string, ProgramaEnviadoItem>();
    for (const f of filas) {
      // El nombre puede seguir siendo NULL (documento sin `raw_json`, del
      // histórico anterior a que se guardara): sin nombre no hay nada que
      // clasificar. Antes lo filtraba el WHERE; ahora se descarta aquí.
      if (!f.text || !f.text.trim()) continue;
      const c = clasificarDocumento(f.text);
      if (!c.key) continue;
      let item = porJid.get(f.chat_jid);
      if (!item) {
        item = {
          jid: f.chat_jid,
          phone: f.phone,
          sourceRow: f.source_row ?? null,
          programas: vacio(),
          primerEnvioTs: null,
          evidencia: null,
        };
        porJid.set(f.chat_jid, item);
      }
      item.programas[c.key as ProgramaKey] = true;
      // `ORDER BY ts ASC` → el primero que llega es el más antiguo.
      if (item.primerEnvioTs == null) {
        item.primerEnvioTs = f.ts;
        item.evidencia = f.text;
      }
      if (item.sourceRow == null && f.source_row != null) item.sourceRow = f.source_row;
    }

    const items = [...porJid.values()].filter((i) => algunoEnviado(i.programas));
    return { ok: true, total: items.length, items };
  });
}
