/**
 * COMPAÑEROS DEL EQUIPO (09-10-2026). Petición del usuario al ver la franja de
 * Fransua sobre Fran López Olmos («cliente… temperatura»): es un compañero, no
 * un lead. Marcado aquí, su chat no se analiza como lead (sin temperatura, sin
 * resumen comercial) y la interfaz lo enseña como equipo.
 *
 * Por TELÉFONO, no por jid: la misma persona puede tener chat `@lid` y chat de
 * teléfono, y la marca tiene que valer para los dos.
 */
import { getDb } from "../db/db";
import { canonicoDe } from "./canonico";
import { digitosDeJid, telefonoEs } from "./identidad";

let lista = false;
function asegurar(): void {
  if (lista) return;
  getDb().exec(
    `CREATE TABLE IF NOT EXISTS wa_equipo (
       telefono TEXT PRIMARY KEY,
       nombre TEXT,
       actor TEXT,
       created_at INTEGER NOT NULL
     )`
  );
  lista = true;
}

/** Clave de teléfono de un chat: móvil ES de 9 dígitos, o los dígitos con prefijo. */
export function telefonoDeJid(jid: string): string | null {
  const canon = canonicoDe(jid) || jid;
  const d = digitosDeJid(canon);
  if (d) return telefonoEs(d) ?? d;
  try {
    const row = getDb().prepare(`SELECT phone FROM chats WHERE jid = ?`).get(jid) as { phone: string | null } | undefined;
    return row?.phone ?? null;
  } catch {
    return null;
  }
}

let cache: { at: number; tels: Set<string> } | null = null;
function telefonosEquipo(): Set<string> {
  if (cache && Date.now() - cache.at < 30_000) return cache.tels;
  try {
    asegurar();
    const tels = new Set((getDb().prepare(`SELECT telefono FROM wa_equipo`).all() as Array<{ telefono: string }>).map((r) => r.telefono));
    cache = { at: Date.now(), tels };
    return tels;
  } catch {
    return new Set();
  }
}

export function esEquipoTelefono(telefono: string | null | undefined): boolean {
  return !!telefono && telefonosEquipo().has(telefono);
}

export function esEquipo(jid: string): boolean {
  return esEquipoTelefono(telefonoDeJid(jid));
}

export function marcarEquipo(jid: string, on: boolean, actor: string | null): { ok: true; telefono: string } | { ok: false; error: string } {
  const tel = telefonoDeJid(jid);
  if (!tel) return { ok: false, error: "Este chat no tiene teléfono: no se puede marcar." };
  asegurar();
  const db = getDb();
  if (on) {
    const nombre = (db.prepare(`SELECT display_name AS n FROM chats WHERE jid = ?`).get(canonicoDe(jid) || jid) as { n: string | null } | undefined)?.n ?? null;
    db.prepare(
      `INSERT INTO wa_equipo (telefono, nombre, actor, created_at) VALUES (?, ?, ?, ?)
       ON CONFLICT(telefono) DO UPDATE SET nombre = COALESCE(excluded.nombre, wa_equipo.nombre)`
    ).run(tel, nombre, actor, Math.floor(Date.now() / 1000));
  } else {
    db.prepare(`DELETE FROM wa_equipo WHERE telefono = ?`).run(tel);
  }
  cache = null;
  return { ok: true, telefono: tel };
}
