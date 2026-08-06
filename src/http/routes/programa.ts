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
    // Solo documentos ENVIADOS por nosotros (from_me=1): lo que manda el lead no
    // es el programa. El LEFT JOIN trae el sourceRow cuando el chat está
    // vinculado, sin descartar los que no lo están (se cruzan por teléfono).
    const filas = db
      .prepare(
        `SELECT m.chat_jid, c.phone, l.source_row, m.text, m.ts
           FROM messages m
           JOIN chats c ON c.jid = m.chat_jid
           LEFT JOIN chat_lead_links l ON l.chat_jid = m.chat_jid AND l.status = 'active'
          WHERE m.type = 'document' AND m.from_me = 1
            AND m.text IS NOT NULL AND TRIM(m.text) <> ''
          ORDER BY m.ts ASC`
      )
      .all() as Fila[];

    const porJid = new Map<string, ProgramaEnviadoItem>();
    for (const f of filas) {
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
