/**
 * JID CANÓNICO — bajo qué fila se guarda (y se lee) un chat.
 *
 * Regla: una persona = una fila. Si un jid `@lid` tiene teléfono conocido, su
 * canónico es el jid con teléfono (`34…@s.whatsapp.net`). Si no se conoce
 * todavía, el propio `@lid` hace de canónico hasta que se aprenda: en ese
 * momento `aprenderMapeo` funde su historial en el jid con teléfono
 * (`fusionarPar`) y la fila `@lid` queda como alias.
 *
 * De dónde se aprende el teléfono de un `@lid` (todo lectura, Baileys 6.7.23):
 *  - `key.senderPn` de cada mensaje entrante;
 *  - `pnJid` / `lidJid` de los chats del history sync;
 *  - `contact.lid` de la agenda (`contacts.upsert` / `contacts.update`);
 *  - `chats.phoneNumberShare` cuando el contacto comparte su número;
 *  - la consulta `onWhatsApp` (teléfono → lid) antes de un envío en frío o desde
 *    `resolve-lids`.
 *
 * Todos los caminos pasan por aquí, así que el mapa `wa_lid_map` y la caché en
 * memoria son coherentes con la base.
 */
import type Database from "better-sqlite3";
import { getDb } from "../db/db";
import { fusionarPar } from "../db/fusion";
import { claveTelefono, esLid, esPn, jidPnDe, normalizarJid, telefonoEs } from "./identidad";

/** lid → jid con teléfono, para no consultar la base en cada mensaje. */
const cacheLidPn = new Map<string, string>();

export function olvidarCacheIdentidad(): void {
  cacheLidPn.clear();
}

/** Jid con teléfono de un `@lid`, o null si aún no se conoce. */
export function pnDeLid(lid: string, db: Database.Database = getDb()): string | null {
  const c = cacheLidPn.get(lid);
  if (c) return c;
  const row = db.prepare("SELECT pn FROM wa_lid_map WHERE lid = ?").get(lid) as { pn: string } | undefined;
  const pn = row ? jidPnDe(row.pn) : null;
  if (pn) cacheLidPn.set(lid, pn);
  return pn;
}

/**
 * Jid canónico de cualquier jid que llegue (mensaje, evento, ruta HTTP).
 * Devuelve "" si no es un jid.
 */
export function canonicoDe(jidCrudo: string | null | undefined, db: Database.Database = getDb()): string {
  const jid = normalizarJid(jidCrudo);
  if (!jid) return "";
  if (esLid(jid)) {
    const pn = pnDeLid(jid, db);
    if (pn) return pn;
    const fila = db.prepare("SELECT alias_of FROM chats WHERE jid = ?").get(jid) as { alias_of: string | null } | undefined;
    if (fila?.alias_of) return fila.alias_of;
    return jid;
  }
  // Un jid con teléfono nunca es alias de nadie; grupos y demás, tal cual.
  return jid;
}

export interface MapeoAprendido {
  pn: string | null;
  /** true si había un chat propio bajo el @lid y se ha fundido en el canónico. */
  fusionado: boolean;
}

/**
 * Aprende «este `@lid` es este teléfono». Si el `@lid` tenía chat propio, lo
 * funde en el chat con teléfono en el acto (transacción propia). Nunca lanza:
 * un fallo aquí no puede romper la ingesta.
 */
export function aprenderMapeo(
  lidCrudo: string | null | undefined,
  pnCrudo: string | null | undefined,
  source: string,
  db: Database.Database = getDb()
): MapeoAprendido {
  const lid = normalizarJid(lidCrudo);
  const pn = jidPnDe(pnCrudo);
  if (!esLid(lid) || !pn || !esPn(pn)) return { pn: null, fusionado: false };
  try {
    db.prepare(
      `INSERT INTO wa_lid_map (lid, pn, phone, source, created_at) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(lid) DO UPDATE SET pn = excluded.pn, phone = COALESCE(excluded.phone, wa_lid_map.phone)`
    ).run(lid, pn, claveTelefono(pn), source, Math.floor(Date.now() / 1000));
    cacheLidPn.set(lid, pn);
    // Si el chat con teléfono ya existe y no tiene teléfono canónico, se rellena.
    const es = telefonoEs(pn);
    if (es) db.prepare("UPDATE chats SET phone = ? WHERE jid = ? AND (phone IS NULL OR phone = '')").run(es, pn);
    const filaLid = db.prepare("SELECT alias_of FROM chats WHERE jid = ?").get(lid) as { alias_of: string | null } | undefined;
    if (filaLid && !filaLid.alias_of) {
      const r = fusionarPar(db, lid, pn);
      console.log(`[identidad] ${lid} es ${pn} (${source}): fundido, ${r.mensajesMovidos} mensajes movidos`);
      return { pn, fusionado: true };
    }
    return { pn, fusionado: false };
  } catch (e) {
    console.error("[identidad] no se pudo aprender el mapeo:", (e as Error).message);
    return { pn, fusionado: false };
  }
}

/** Todos los jids (canónico + alias) que WhatsApp puede usar para un chat. */
export function aliasDe(jidCanonico: string, db: Database.Database = getDb()): string[] {
  const alias = db.prepare("SELECT jid FROM chats WHERE alias_of = ?").all(jidCanonico) as Array<{ jid: string }>;
  const mapa = db.prepare("SELECT lid FROM wa_lid_map WHERE pn = ?").all(jidCanonico) as Array<{ lid: string }>;
  return Array.from(new Set([jidCanonico, ...alias.map((a) => a.jid), ...mapa.map((m) => m.lid)]));
}
