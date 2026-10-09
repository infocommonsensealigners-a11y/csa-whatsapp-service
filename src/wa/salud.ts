/**
 * SALUD de WhatsApp: lo que hace falta para que alguien se ENTERE de que el
 * teléfono flotante no está recibiendo bien.
 *
 * ⚠️ Por qué existe (09-10-2026): del 05 al 09-10 el 100 % de los mensajes
 * entrantes se guardó como «esperando el mensaje…» (Baileys no los descifraba)
 * y nadie lo vio en cuatro días: el estado decía «open» porque la conexión
 * estaba viva. Estar conectado no es lo mismo que recibir bien.
 *
 * Se mira la última ventana de 2 h: cuántos mensajes 1-a-1 entraron y cuántos
 * se quedaron sin descifrar. Memorizado 60 s (el estado se consulta cada 10 s).
 */
import { getDb } from "../db/db";
import { contadoresSignal } from "./silenciarSignal";

export interface SaludWa {
  /** Ventana de 2 h: entrantes 1-a-1 y cuántos siguen como «esperando…». */
  ventana2h: { entrantes: number; cifrados: number };
  /** Último entrante 1-a-1 LEGIBLE (epoch s), o null. */
  ultimoEntranteLegible: number | null;
  /** «Esperando…» pendientes de los últimos 45 días (los que el rescate puede recuperar). */
  cifradosPendientes: number;
  /** true si más de la mitad de lo que entra no se puede leer (con un mínimo de 5). */
  descifradoRoto: boolean;
  /** Contadores de libsignal desde el arranque. */
  signal: Record<string, number>;
}

let cache: { at: number; v: SaludWa } | null = null;

export function saludWa(): SaludWa {
  if (cache && Date.now() - cache.at < 60_000) return cache.v;
  const db = getDb();
  const ahora = Math.floor(Date.now() / 1000);
  const v2 = db
    .prepare(
      `SELECT COUNT(*) AS entrantes, SUM(stub = 'CIPHERTEXT') AS cifrados FROM messages
        WHERE from_me = 0 AND ts >= ? AND chat_jid NOT LIKE '%@g.us' AND (stub IS NULL OR stub = 'CIPHERTEXT')`
    )
    .get(ahora - 2 * 3600) as { entrantes: number; cifrados: number | null };
  const ultimo = db
    .prepare(`SELECT MAX(ts) AS t FROM messages WHERE from_me = 0 AND stub IS NULL AND chat_jid NOT LIKE '%@g.us' AND ts >= ?`)
    .get(ahora - 30 * 86_400) as { t: number | null };
  const pend = db
    .prepare(`SELECT COUNT(*) AS n FROM messages WHERE stub = 'CIPHERTEXT' AND ts >= ? AND chat_jid NOT LIKE '%@g.us'`)
    .get(ahora - 45 * 86_400) as { n: number };
  const cifrados = v2.cifrados ?? 0;
  const v: SaludWa = {
    ventana2h: { entrantes: v2.entrantes, cifrados },
    ultimoEntranteLegible: ultimo.t,
    cifradosPendientes: pend.n,
    descifradoRoto: v2.entrantes >= 5 && cifrados * 2 > v2.entrantes,
    signal: contadoresSignal(),
  };
  cache = { at: Date.now(), v };
  return v;
}
