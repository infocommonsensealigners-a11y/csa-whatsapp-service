/**
 * MARCAS DE CAMPAÑA — la marca de agua del teléfono flotante.
 *
 * Petición del usuario (2026-09-07): "que los mensajes que se hayan enviado de
 * forma automática queden registrados como marca de agua en el teléfono flotante
 * para saber que no los ha enviado de forma manual", y una nota al final del tipo
 * "acabó interacción por parte de Fransua — dirección postal conseguida".
 *
 * Dos clases de fila en la misma tabla:
 *
 *  - `wa_msg_id` con valor → ese mensaje SALIÓ de la automatización. La UI le
 *    pone la marca. Sin esto no habría forma de distinguirlo de uno que escribió
 *    Fran a mano: en `messages` los dos son `from_me = 1` y nada más.
 *  - `wa_msg_id` NULL → NOTA INTERNA. No se envió a nadie; es una línea de
 *    sistema para que Fran vea cómo acabó la conversación.
 */

import { getDb } from "../db/db";

let listo = false;

function ensureTabla(): void {
  if (listo) return;
  const db = getDb();
  db.exec(
    `CREATE TABLE IF NOT EXISTS campana_marcas (
       id INTEGER PRIMARY KEY,
       chat_jid TEXT NOT NULL,
       wa_msg_id TEXT,
       campana TEXT,
       campana_id TEXT,
       nota TEXT,
       created_at INTEGER NOT NULL
     )`
  );
  db.exec(`CREATE INDEX IF NOT EXISTS idx_campana_marcas_chat ON campana_marcas (chat_jid)`);
  // Un mensaje no puede marcarse dos veces (el worker puede reintentar).
  db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS idx_campana_marcas_msg ON campana_marcas (wa_msg_id) WHERE wa_msg_id IS NOT NULL`);
  listo = true;
}

const ahora = () => Math.floor(Date.now() / 1000);

/** Marca un mensaje ENVIADO por la automatización. */
export function registrarAutomatico(jid: string, waMsgId: string, campana: string, campanaId: string): void {
  try {
    ensureTabla();
    getDb()
      .prepare(
        /**
         * ⚠️ El `WHERE wa_msg_id IS NOT NULL` del ON CONFLICT no es adorno: hay
         * que REPETIR la cláusula del índice parcial o SQLite no lo reconoce y
         * lanza "ON CONFLICT clause does not match any PRIMARY KEY or UNIQUE
         * constraint".
         *
         * Sin él, esta consulta fallaba SIEMPRE y el catch de abajo se lo
         * tragaba: la marca de agua no se registró ni una vez, así que en el
         * teléfono flotante un mensaje de la automatización y uno escrito por
         * Fran eran indistinguibles. Se vio en los logs de producción con el
         * primer envío real de la campaña del taller.
         */
        `INSERT INTO campana_marcas (chat_jid, wa_msg_id, campana, campana_id, nota, created_at)
         VALUES (?, ?, ?, ?, NULL, ?)
         ON CONFLICT(wa_msg_id) WHERE wa_msg_id IS NOT NULL DO NOTHING`
      )
      .run(jid, waMsgId, campana, campanaId, ahora());
  } catch (e) {
    // Que falle una marca NO debe romper un envío que ya salió.
    console.warn("[campanas] no se pudo marcar el mensaje:", (e as Error).message);
  }
}

/** Deja una NOTA interna en el chat (no se envía a nadie). */
export function registrarNota(jid: string, nota: string, campanaId: string | null): void {
  try {
    ensureTabla();
    getDb()
      .prepare(
        `INSERT INTO campana_marcas (chat_jid, wa_msg_id, campana, campana_id, nota, created_at)
         VALUES (?, NULL, NULL, ?, ?, ?)`
      )
      .run(jid, campanaId, nota.slice(0, 400), ahora());
  } catch (e) {
    console.warn("[campanas] no se pudo dejar la nota:", (e as Error).message);
  }
}

export interface MarcasChat {
  /** ids de mensajes que mandó la automatización. */
  automaticos: string[];
  /** Notas internas, en orden cronológico. */
  notas: { nota: string; ts: number; campanaId: string | null }[];
  /** Nombre de la campaña que ha tocado este chat, si alguna. */
  campana: string | null;
}

/** Marcas de un chat, para que la UI pinte la marca de agua y las notas. */
export function marcasDeChat(jid: string): MarcasChat {
  try {
    ensureTabla();
    const rows = getDb()
      .prepare(
        `SELECT wa_msg_id AS msgId, campana, campana_id AS campanaId, nota, created_at AS ts
           FROM campana_marcas WHERE chat_jid = ? ORDER BY created_at ASC`
      )
      .all(jid) as { msgId: string | null; campana: string | null; campanaId: string | null; nota: string | null; ts: number }[];
    const automaticos: string[] = [];
    const notas: MarcasChat["notas"] = [];
    let campana: string | null = null;
    for (const r of rows) {
      if (r.msgId) automaticos.push(r.msgId);
      if (r.nota) notas.push({ nota: r.nota, ts: r.ts, campanaId: r.campanaId });
      if (r.campana && !campana) campana = r.campana;
    }
    return { automaticos, notas, campana };
  } catch {
    return { automaticos: [], notas: [], campana: null };
  }
}

/** Los jids que están o han estado en una automatización (para la etiqueta). */
export function jidsConCampana(): { jid: string; campana: string | null }[] {
  try {
    ensureTabla();
    return getDb()
      .prepare(
        `SELECT chat_jid AS jid, MAX(campana) AS campana
           FROM campana_marcas GROUP BY chat_jid`
      )
      .all() as { jid: string; campana: string | null }[];
  } catch {
    return [];
  }
}
