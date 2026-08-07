/**
 * Caché en memoria del listado de chat_intel — el corte de la FUGA DE EGRESS de
 * Supabase (auditoría 2026-08-06).
 *
 * El problema medido: SIETE componentes del dashboard piden
 * `/intel/list?limit=2000` (CRM, Seguimiento, Playbook, Renovaciones, Embudo,
 * resumen de WhatsApp y teléfono flotante), cada respuesta pesa ~1,9 MB y toda
 * carga de pestaña relanzaba la consulta a Supabase → 10,1 GB de egress al mes
 * con el plan gratuito en 5 GB. La lectura desde Supabase se paga; servirla
 * desde la memoria del sidecar, no.
 *
 * Diseño:
 *  - Una sola entrada (el fetch "amplio" de la ventana de estrategia completa,
 *    que es lo que piden los 7 llamantes). Los filtros (temp, since, limit) se
 *    aplican EN MEMORIA sobre esa foto.
 *  - TTL corto + INVALIDACIÓN explícita cuando algo escribe en chat_intel
 *    (analyzeChat tras asimilar, y la edición de etiquetas de notes.ts), así el
 *    dato nunca se queda viejo más de unos segundos tras un cambio real.
 *  - Si Supabase falla, se sirve la última foto aunque haya caducado (stale
 *    mejor que error) y se reintenta en la siguiente petición.
 */

export interface IntelCacheEntry<T> {
  rows: T[];
  at: number;
}

/**
 * 30 min. NO es el mecanismo de frescura — de eso se encarga
 * `invalidateIntelCache()`, que llaman TODOS los escritores de chat_intel del
 * sidecar (analyzeChat tras asimilar, la edición de intereses/etiquetas de
 * notes.ts y el marcado de clientes de intel.ts): un cambio real se ve al
 * instante, no dentro de media hora.
 *
 * El TTL es solo la red por si algo escribe FUERA de este proceso (los scripts
 * de mantenimiento, p. ej. `scripts/sync-clientes-brain`), y por eso puede ser
 * largo. Y tiene que serlo: con 5 min, un dashboard abierto toda la jornada daba
 * 12 refrescos/hora × ~2 MB ≈ 4,7 GB/mes, otra vez rozando los 5 GB del plan
 * gratuito. Con 30 min son ~2 refrescos/hora → menos de 1 GB/mes.
 */
const TTL_MS = 30 * 60_000;

let entry: IntelCacheEntry<unknown> | null = null;
let inflight: Promise<unknown[]> | null = null;

/**
 * Otras cachés derivadas de chat_intel que viven en sus propios módulos (la
 * cartera que Fransua usa para responder, en http/routes/notes.ts). Se apuntan
 * aquí para que un ÚNICO `invalidateIntelCache()` las tire todas: si no, un
 * escritor tendría que acordarse de cada una y la que se olvide sirve dato viejo.
 */
const derivadas: Array<() => void> = [];
export function onIntelInvalidate(fn: () => void): void {
  derivadas.push(fn);
}

/** Borra la foto: la siguiente lectura irá a Supabase. La llaman los ESCRITORES. */
export function invalidateIntelCache(): void {
  entry = null;
  for (const fn of derivadas) fn();
}

/**
 * Devuelve las filas de la caché, o las carga con `fetcher` si no hay foto
 * fresca. Deduplica cargas concurrentes (si 7 componentes llegan a la vez en la
 * misma carga de página, solo UNA consulta viaja a Supabase).
 */
export async function getIntelRows<T>(fetcher: () => Promise<T[]>): Promise<T[]> {
  const now = Date.now();
  if (entry && now - entry.at < TTL_MS) return entry.rows as T[];
  if (inflight) return (await inflight) as T[];

  inflight = (async () => {
    try {
      const rows = await fetcher();
      entry = { rows, at: Date.now() };
      return rows;
    } catch (e) {
      // Supabase caído o cuota: sirve la última foto aunque esté caducada.
      if (entry) return entry.rows;
      throw e;
    } finally {
      inflight = null;
    }
  })();
  return (await inflight) as T[];
}

/**
 * Columnas de la foto. Es el SUPERCONJUNTO de lo que piden todos los lectores
 * de chat_intel del sidecar (el listado y el resumen de intel.ts, los leads
 * candidatos de agendaPlaybook y las tres tools de Fransua en ai/agentTools),
 * para que todos puedan servirse de la misma lectura. Si algún lector necesita
 * una columna nueva, se añade AQUÍ.
 */
const SNAPSHOT_COLS =
  "jid,phone,display_name,source_row,producto,first_ts,last_ts,msg_count,from_me_count,temperatura,temperatura_motivo,resumen,intereses,intervalos,etiquetas,model,updated_at";

/**
 * LA foto de chat_intel: la única consulta a Supabase que baja la tabla.
 *
 * SIN filtro de fecha a propósito. Los consumidores de ESTRATEGIA (/intel/list,
 * /intel/summary, los leads candidatos de la agenda) recortan luego en memoria a
 * su ventana — abril de 2025 en adelante—, pero dos tools de Fransua leían la
 * tabla ENTERA, y hay 504 chats anteriores a esa fecha (de 1.400). Filtrar aquí
 * le habría quitado a Fransua un tercio de su memoria sin que se notara.
 *
 * El tope de 4.000 es un cortafuegos por si la tabla crece mucho.
 */
export async function getIntelSnapshot<T = any>(): Promise<T[]> {
  return getIntelRows<T>(async () => {
    const { getSupabase } = await import("./supabase");
    const { data, error } = await getSupabase()
      .from("chat_intel")
      .select(SNAPSHOT_COLS)
      .order("last_ts", { ascending: false })
      .limit(4000);
    if (error) throw new Error(error.message);
    return (data ?? []) as unknown as T[];
  });
}

/** Para diagnóstico (/intel/cache-stats si algún día hace falta). */
export function intelCacheInfo(): { cached: boolean; ageMs: number | null } {
  return { cached: !!entry, ageMs: entry ? Date.now() - entry.at : null };
}
