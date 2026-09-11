/**
 * FUSIÓN DE CHATS GEMELOS — una fila por persona.
 *
 * La misma persona podía tener dos conversaciones: la del teléfono
 * (`34611222333@s.whatsapp.net`, por donde le escribimos) y la del identificador
 * oculto (`…@lid`, por donde contesta o por donde le escribe Fran desde el
 * móvil). Medido el 2026-09-11 en producción: 93 pares vivos, 41 activos la
 * última semana, 16 mensajes repetidos en las dos filas.
 *
 * Aquí se funden. El CANÓNICO es siempre el jid con teléfono: es estable, es la
 * identidad del proyecto (`canonicalPhone`) y es a donde se envía. El `@lid`
 * queda como ALIAS (`chats.alias_of`), nunca se borra: cualquier referencia
 * antigua o evento que llegue con ese jid se redirige (ver src/wa/canonico.ts).
 *
 * Garantías:
 *  - Cada par se funde en UNA transacción: o entra todo o no entra nada.
 *  - Ningún mensaje se pierde: `INSERT OR IGNORE` por `(chat, id)`; cuando el
 *    mismo `id` estaba en las dos filas se conserva la copia con `raw_json` y
 *    el `ts` más antiguo (el del eco real de WhatsApp, no el del reloj local).
 *  - Vínculos con el CRM, etiquetas, marcas de campaña, auditoría de envíos y
 *    etiquetas IA se re-apuntan sin duplicar.
 *  - Idempotente: un par ya fundido desaparece del plan (`alias_of` puesto), así
 *    que re-ejecutar no hace nada.
 *  - `fusionInicial` (arranque) hace primero una COPIA CONSISTENTE de la base en
 *    el volumen (`db.backup`, correcta con WAL) y solo entonces aplica.
 */
import type Database from "better-sqlite3";
import path from "node:path";
import { config } from "../config";
import { getDb, getMeta, setMeta } from "./db";
import { esLid, jidPnDe, telefonoEs, claveTelefono } from "../wa/identidad";
import { previewDe } from "../wa/preview";

export interface ParFusion {
  lid: string;
  pn: string;
  phone: string | null;
  pnExiste: boolean;
  mensajesLid: number;
  mensajesPn: number;
  /** ids presentes en las dos filas (se quedarán en una sola). */
  repetidos: number;
  nombreLid: string | null;
  nombrePn: string | null;
  ultimoLid: number | null;
  ultimoPn: number | null;
}

export interface ResultadoPar {
  lid: string;
  pn: string;
  mensajesMovidos: number;
  repetidosUnificados: number;
  vinculosMovidos: number;
  etiquetasMovidas: number;
}

const ahora = () => Math.floor(Date.now() / 1000);

/** ¿Es un nombre de persona o el relleno de cuando no hay ninguno? */
export function esNombreReal(nombre: string | null | undefined): boolean {
  const n = (nombre ?? "").trim();
  if (!n) return false;
  if (n === "Número oculto" || n === "Contacto sin nombre") return false;
  return !/^\+?\d[\d\s]*$/.test(n);
}

function existeTabla(db: Database.Database, tabla: string): boolean {
  return !!db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(tabla);
}

/**
 * Todos los pares «@lid con teléfono conocido» que aún no están fundidos.
 * El teléfono se conoce por `wa_lid_map` (senderPn, onWhatsApp, agenda, history
 * sync). Incluye los @lid cuyo chat con teléfono todavía NO existe: también se
 * migran, para que la fila quede bajo el jid estable.
 */
export function planFusion(db: Database.Database = getDb()): ParFusion[] {
  const filas = db
    .prepare(
      `SELECT c.jid AS lid, m.pn AS pn, c.display_name AS nombreLid, c.last_message_at AS ultimoLid
         FROM chats c JOIN wa_lid_map m ON m.lid = c.jid
        WHERE c.jid LIKE '%@lid' AND c.alias_of IS NULL`
    )
    .all() as Array<{ lid: string; pn: string; nombreLid: string | null; ultimoLid: number | null }>;
  const cuenta = db.prepare("SELECT COUNT(*) AS n FROM messages WHERE chat_jid = ?");
  const repetidos = db.prepare(
    "SELECT COUNT(*) AS n FROM messages a WHERE a.chat_jid = ? AND EXISTS (SELECT 1 FROM messages b WHERE b.chat_jid = ? AND b.id = a.id)"
  );
  const chatPn = db.prepare("SELECT display_name, last_message_at FROM chats WHERE jid = ?");
  const plan: ParFusion[] = [];
  for (const f of filas) {
    const pn = jidPnDe(f.pn);
    if (!pn || !esLid(f.lid) || pn === f.lid) continue;
    const filaPn = chatPn.get(pn) as { display_name: string | null; last_message_at: number | null } | undefined;
    plan.push({
      lid: f.lid,
      pn,
      phone: claveTelefono(pn),
      pnExiste: !!filaPn,
      mensajesLid: (cuenta.get(f.lid) as { n: number }).n,
      mensajesPn: filaPn ? (cuenta.get(pn) as { n: number }).n : 0,
      repetidos: filaPn ? (repetidos.get(f.lid, pn) as { n: number }).n : 0,
      nombreLid: f.nombreLid,
      nombrePn: filaPn?.display_name ?? null,
      ultimoLid: f.ultimoLid,
      ultimoPn: filaPn?.last_message_at ?? null,
    });
  }
  return plan;
}

/**
 * Recalcula `last_message_at` y `last_message_preview` de un chat (o de todos)
 * a partir de los mensajes guardados. Es la única verdad del orden de la lista:
 * un chat está donde está su último mensaje real. Los chats sin mensajes
 * conservan lo que tuvieran (posición que dio el volcado de WhatsApp).
 */
export function recalcularUltimoMensaje(db: Database.Database = getDb(), jid?: string): number {
  const ultimo = db.prepare(
    "SELECT ts, type, text FROM messages WHERE chat_jid = ? ORDER BY ts DESC, rowid DESC LIMIT 1"
  );
  const fija = db.prepare(
    "UPDATE chats SET last_message_at = ?, last_message_preview = ? WHERE jid = ? AND (COALESCE(last_message_at, -1) <> ? OR COALESCE(last_message_preview, '') <> ?)"
  );
  const jids = jid
    ? [{ jid }]
    : (db.prepare("SELECT jid FROM chats WHERE alias_of IS NULL").all() as Array<{ jid: string }>);
  let cambiados = 0;
  const tx = db.transaction(() => {
    for (const { jid: j } of jids) {
      const u = ultimo.get(j) as { ts: number; type: string; text: string | null } | undefined;
      if (!u) continue;
      const preview = previewDe(u.type, u.text);
      cambiados += fija.run(u.ts, preview, j, u.ts, preview).changes;
    }
  });
  tx();
  return cambiados;
}

/** Funde el chat `lid` dentro del chat con teléfono `pn`. Una transacción. */
export function fusionarPar(db: Database.Database, lid: string, pn: string): ResultadoPar {
  const now = ahora();
  const tx = db.transaction((): ResultadoPar => {
    const filaLid = db.prepare("SELECT * FROM chats WHERE jid = ?").get(lid) as
      | {
          jid: string; phone: string | null; display_name: string | null; avatar_path: string | null;
          avatar_fetched_at: number | null; last_opened_at: number | null; wa_read_at: number | null;
          ignored: number; alias_of: string | null; created_at: number;
        }
      | undefined;
    if (!filaLid) throw new Error(`no existe el chat ${lid}`);
    if (filaLid.alias_of) return { lid, pn, mensajesMovidos: 0, repetidosUnificados: 0, vinculosMovidos: 0, etiquetasMovidas: 0 };

    // 1) La fila canónica existe sí o sí (los mensajes la referencian por FK).
    db.prepare(
      `INSERT INTO chats (jid, phone, display_name, avatar_path, avatar_fetched_at, last_opened_at, wa_read_at, ignored, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?, ?)
       ON CONFLICT(jid) DO NOTHING`
    ).run(pn, telefonoEs(pn), filaLid.display_name, filaLid.avatar_path, filaLid.avatar_fetched_at, filaLid.last_opened_at, filaLid.wa_read_at, filaLid.created_at, now);

    // 2) Mensajes repetidos (mismo id en las dos filas): la copia canónica se
    //    queda con el ts más antiguo y con el raw_json/media que le falten.
    const repetidos = db
      .prepare(
        `UPDATE messages SET
           ts = MIN(ts, (SELECT l.ts FROM messages l WHERE l.chat_jid = @lid AND l.id = messages.id)),
           raw_json = COALESCE(raw_json, (SELECT l.raw_json FROM messages l WHERE l.chat_jid = @lid AND l.id = messages.id)),
           media_path = COALESCE(media_path, (SELECT l.media_path FROM messages l WHERE l.chat_jid = @lid AND l.id = messages.id)),
           media_mime = COALESCE(media_mime, (SELECT l.media_mime FROM messages l WHERE l.chat_jid = @lid AND l.id = messages.id))
         WHERE chat_jid = @pn AND id IN (SELECT id FROM messages WHERE chat_jid = @lid)`
      )
      .run({ lid, pn }).changes;
    // 3) Mover el resto y vaciar la fila alias.
    const antes = (db.prepare("SELECT COUNT(*) AS n FROM messages WHERE chat_jid = ?").get(pn) as { n: number }).n;
    db.prepare(
      `INSERT OR IGNORE INTO messages (chat_jid, id, from_me, ts, type, text, media_path, media_mime, raw_json, participant)
       SELECT ?, id, from_me, ts, type, text, media_path, media_mime, raw_json, participant FROM messages WHERE chat_jid = ?`
    ).run(pn, lid);
    db.prepare("DELETE FROM messages WHERE chat_jid = ?").run(lid);
    const despues = (db.prepare("SELECT COUNT(*) AS n FROM messages WHERE chat_jid = ?").get(pn) as { n: number }).n;

    // 4) Vínculos con el CRM: se re-apuntan los que el canónico no tenga ya
    //    (UNIQUE chat_jid+source_row); los redundantes quedan 'removed'.
    const vinculosMovidos = db
      .prepare(
        `UPDATE chat_lead_links SET chat_jid = @pn, updated_at = @now
          WHERE chat_jid = @lid
            AND NOT EXISTS (SELECT 1 FROM chat_lead_links x WHERE x.chat_jid = @pn AND x.source_row = chat_lead_links.source_row)`
      )
      .run({ lid, pn, now }).changes;
    db.prepare("UPDATE chat_lead_links SET status = 'removed', updated_at = ? WHERE chat_jid = ?").run(now, lid);

    // 5) Etiquetas de WhatsApp (unión), etiquetas IA, marcas de campaña y auditoría.
    const etiquetasMovidas = db
      .prepare("INSERT OR IGNORE INTO wa_chat_labels (chat_jid, label_id) SELECT ?, label_id FROM wa_chat_labels WHERE chat_jid = ?")
      .run(pn, lid).changes;
    db.prepare("DELETE FROM wa_chat_labels WHERE chat_jid = ?").run(lid);
    db.prepare(
      `INSERT OR IGNORE INTO chat_tags (chat_jid, tag_id, source, status, confidence, proposed_at, decided_at)
       SELECT ?, tag_id, source, status, confidence, proposed_at, decided_at FROM chat_tags WHERE chat_jid = ?`
    ).run(pn, lid);
    db.prepare("DELETE FROM chat_tags WHERE chat_jid = ?").run(lid);
    for (const tabla of ["campana_marcas", "wa_send_audit", "wa_label_audit", "ai_artifacts", "ai_jobs"]) {
      if (existeTabla(db, tabla)) db.prepare(`UPDATE ${tabla} SET chat_jid = ? WHERE chat_jid = ?`).run(pn, lid);
    }

    // 6) Metadatos del canónico: lo mejor de los dos. El nombre que sea un
    //    nombre de verdad; el otro no se pierde (queda en wa_contacts por el lid).
    const filaPn = db.prepare("SELECT display_name, phone, avatar_path FROM chats WHERE jid = ?").get(pn) as {
      display_name: string | null; phone: string | null; avatar_path: string | null;
    };
    const nombre = esNombreReal(filaPn.display_name)
      ? filaPn.display_name
      : esNombreReal(filaLid.display_name)
        ? filaLid.display_name
        : filaPn.display_name || filaLid.display_name || null;
    if (esNombreReal(filaLid.display_name) && filaLid.display_name !== nombre) {
      db.prepare(
        `INSERT INTO wa_contacts (jid, notify, updated_at) VALUES (?, ?, ?)
         ON CONFLICT(jid) DO UPDATE SET notify = COALESCE(wa_contacts.notify, excluded.notify), updated_at = excluded.updated_at`
      ).run(lid, filaLid.display_name, now);
    }
    db.prepare(
      `UPDATE chats SET
         display_name = ?,
         phone = COALESCE(NULLIF(phone, ''), ?),
         avatar_path = COALESCE(avatar_path, ?),
         avatar_fetched_at = COALESCE(avatar_fetched_at, ?),
         last_opened_at = MAX(COALESCE(last_opened_at, 0), ?),
         wa_read_at = MAX(COALESCE(wa_read_at, 0), ?),
         updated_at = ?
       WHERE jid = ?`
    ).run(
      nombre, telefonoEs(pn) ?? filaLid.phone, filaLid.avatar_path, filaLid.avatar_fetched_at,
      filaLid.last_opened_at ?? 0, filaLid.wa_read_at ?? 0, now, pn
    );
    db.prepare("UPDATE chats SET last_opened_at = NULLIF(last_opened_at, 0), wa_read_at = NULLIF(wa_read_at, 0) WHERE jid = ?").run(pn);

    // 7) Orden y preview desde los mensajes reales.
    recalcularUltimoMensaje(db, pn);

    // 8) El @lid queda como alias: fuera de las listas, pero localizable.
    db.prepare(
      "UPDATE chats SET alias_of = ?, ignored = 1, last_message_at = NULL, last_message_preview = NULL, updated_at = ? WHERE jid = ?"
    ).run(pn, now, lid);

    return { lid, pn, mensajesMovidos: despues - antes, repetidosUnificados: repetidos, vinculosMovidos, etiquetasMovidas };
  });
  return tx();
}

export interface ResultadoFusionInicial {
  pares: number;
  mensajesAMover: number;
  repetidos: number;
  aplicados: number;
  errores: string[];
  copia: string | null;
  recalculados: number;
}

/**
 * Al ARRANCAR: informa del plan y, si `aplicar`, hace copia consistente de la
 * base en el volumen y funde todos los pares. Re-ejecutable: los pares ya
 * fundidos no vuelven a salir. También recalcula una vez el orden de todos los
 * chats desde sus mensajes (99 chats tenían la fecha de lista adelantada).
 */
export async function fusionInicial(opts: {
  aplicar: boolean;
  /** Copia adicional (p. ej. subir a Supabase). Best-effort: no bloquea la fusión. */
  copiaExtra?: () => Promise<unknown>;
}): Promise<ResultadoFusionInicial> {
  const db = getDb();
  const plan = planFusion(db);
  const res: ResultadoFusionInicial = {
    pares: plan.length,
    mensajesAMover: plan.reduce((s, p) => s + p.mensajesLid, 0),
    repetidos: plan.reduce((s, p) => s + p.repetidos, 0),
    aplicados: 0,
    errores: [],
    copia: null,
    recalculados: 0,
  };
  console.log(
    `[fusion] plan: ${res.pares} pares (@lid → teléfono), ${res.mensajesAMover} mensajes a mover, ${res.repetidos} repetidos a unificar` +
      (opts.aplicar ? "" : " · SOLO INFORME (no se aplica)")
  );
  if (opts.aplicar && plan.length > 0) {
    const sello = new Date().toISOString().replace(/[-:]/g, "").slice(0, 13);
    const copia = path.join(config.dataDir, `wa.sqlite3.pre-fusion-${sello}`);
    try {
      await db.backup(copia);
      res.copia = copia;
      console.log(`[fusion] copia consistente en ${copia}`);
    } catch (e) {
      res.errores.push(`copia local: ${(e as Error).message}`);
      console.error("[fusion] NO se aplica: la copia de seguridad falló:", (e as Error).message);
      return res;
    }
    if (opts.copiaExtra) {
      try {
        await Promise.race([opts.copiaExtra(), new Promise((r) => setTimeout(r, 30_000))]);
      } catch (e) {
        console.warn("[fusion] copia extra falló (se sigue, la local está hecha):", (e as Error).message);
      }
    }
    for (const p of plan) {
      try {
        const r = fusionarPar(db, p.lid, p.pn);
        res.aplicados++;
        console.log(
          `[fusion] ${p.lid} → ${p.pn}: ${r.mensajesMovidos} mensajes movidos, ${r.repetidosUnificados} repetidos, ${r.vinculosMovidos} vínculos, ${r.etiquetasMovidas} etiquetas`
        );
      } catch (e) {
        res.errores.push(`${p.lid}: ${(e as Error).message}`);
        console.error(`[fusion] par ${p.lid} → ${p.pn} FALLÓ (se deja como estaba):`, (e as Error).message);
      }
    }
    setMeta("fusion_gemelos_ultima", JSON.stringify({ en: new Date().toISOString(), pares: res.aplicados, errores: res.errores.length }));
  }
  // Orden desde los mensajes reales, una vez por base (idempotente igualmente).
  if (opts.aplicar && !getMeta("recalculo_ultimo_mensaje_v1")) {
    res.recalculados = recalcularUltimoMensaje(db);
    setMeta("recalculo_ultimo_mensaje_v1", String(ahora()));
    console.log(`[fusion] orden recalculado desde los mensajes: ${res.recalculados} chats corregidos`);
  }
  // Ticks del histórico: el estado de entrega viajaba en raw_json y nunca se
  // había volcado a una columna. Una sola pasada (5.400 mensajes propios en prod).
  if (opts.aplicar && !getMeta("estados_desde_raw_v1")) {
    const n = rellenarEstadosDesdeRaw(db);
    setMeta("estados_desde_raw_v1", String(ahora()));
    console.log(`[fusion] estado de entrega recuperado de raw_json en ${n} mensajes propios`);
  }
  return res;
}

/** `messages.status` a partir del `status` del proto guardado en raw_json (número o nombre). */
export function rellenarEstadosDesdeRaw(db: Database.Database = getDb()): number {
  return db
    .prepare(
      `UPDATE messages SET status = CASE json_extract(raw_json, '$.status')
         WHEN 'ERROR' THEN 0 WHEN 'PENDING' THEN 1 WHEN 'SERVER_ACK' THEN 2
         WHEN 'DELIVERY_ACK' THEN 3 WHEN 'READ' THEN 4 WHEN 'PLAYED' THEN 5
         WHEN 0 THEN 0 WHEN 1 THEN 1 WHEN 2 THEN 2 WHEN 3 THEN 3 WHEN 4 THEN 4 WHEN 5 THEN 5
         ELSE NULL END
       WHERE from_me = 1 AND status IS NULL AND raw_json IS NOT NULL
         AND json_extract(raw_json, '$.status') IS NOT NULL`
    )
    .run().changes;
}
