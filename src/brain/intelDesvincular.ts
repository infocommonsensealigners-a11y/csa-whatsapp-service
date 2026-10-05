/**
 * Limpia en Supabase la COPIA de un enlace chat↔lead que ya se ha retirado.
 *
 * ⚠️ POR QUÉ EXISTE. La asociación vive en dos sitios y solo uno se mantenía:
 *
 *   `chat_lead_links` (SQLite)  ──analyzeChat──▶  `chat_intel.source_row` (Supabase)
 *                                                        │
 *                            la ficha del lead lee de AQUÍ ◀── GET /intel/by-lead/:sourceRow
 *
 * `runLeadLinking` desactiva un enlace equivocado en cuanto deja de casar, pero
 * eso NO toca la copia: `analyzeChat` solo la reescribe la próxima vez que ese
 * chat se analice, y un chat muerto —el de «Ramon» era de abril de 2024— puede
 * no volver a analizarse nunca. Sin esto, el enlace se quita de la base y la
 * ficha sigue enseñando la conversación de un desconocido para siempre.
 *
 * Caso real que lo motiva (usuario, 9-sep-2026): ver `scripts/test-link-leads.ts`.
 *
 * Es best-effort y no lanza: si Supabase no está configurado o falla, el enlace
 * local ya está retirado y la próxima pasada lo reintenta.
 */

import { brainConfigured, getSupabase } from "./supabase";
import { invalidateIntelCache } from "./intelCache";

export interface ParDesvinculado {
  jid: string;
  sourceRow: number;
}

/**
 * Pone `source_row = NULL` en las filas de `chat_intel` de esos chats.
 *
 * ⚠️ Solo si el valor SIGUE SIENDO el que se retiró (`.eq("source_row", …)`).
 * Sin esa condición, una pasada lenta podría borrar un enlace nuevo y correcto
 * que se hubiera escrito en medio — el clásico «leer, decidir, escribir» sobre
 * un dato que ya cambió.
 *
 * Devuelve cuántas filas se limpiaron de verdad.
 */
export async function desvincularEnIntel(pares: readonly ParDesvinculado[]): Promise<number> {
  if (pares.length === 0) return 0;
  if (!brainConfigured()) return 0;

  const sb = getSupabase();
  let limpiadas = 0;

  for (const p of pares) {
    try {
      const { data, error } = await sb
        .from("chat_intel")
        .update({ source_row: null })
        .eq("jid", p.jid)
        .eq("source_row", p.sourceRow)
        .select("jid");
      if (error) {
        console.warn(`[link-leads] no se pudo desvincular ${p.jid} de la fila ${p.sourceRow}: ${error.message}`);
        continue;
      }
      limpiadas += (data ?? []).length;
    } catch (e) {
      console.warn(`[link-leads] error desvinculando ${p.jid}: ${(e as Error).message}`);
    }
  }

  /**
   * La foto de `chat_intel` está cacheada 30 min en memoria (ver intelCache.ts,
   * puesto para cortar una fuga de egress). Sin invalidarla, la ficha seguiría
   * viendo el enlace viejo media hora más — que es justo el síntoma que venimos
   * a quitar. Regla del proyecto: todo escritor de `chat_intel` invalida.
   */
  if (limpiadas > 0) invalidateIntelCache();

  return limpiadas;
}

/**
 * Deja `chat_intel.source_row` como dice `chat_lead_links` (ver
 * `planIntelDesdeVinculos` en reapuntarVinculos.ts, que calcula los cambios).
 *
 * Hace falta cuando las filas de la hoja se MUEVEN (05-10-2026: la fusión de
 * duplicados borró 212): `desvincularEnIntel` solo quita la copia de los pares
 * que se retiran en ESA pasada; no pone la fila nueva, ni arregla las copias que
 * ya venían movidas de borrados anteriores, ni las de un vínculo manual.
 *
 * ⚠️ Cada cambio se escribe solo si la copia SIGUE teniendo el valor que se leyó
 * (mismo cuidado que arriba): si `analyzeChat` la ha reescrito entretanto, gana él.
 *
 * `tope` acota cuántas escrituras se hacen de una vez (la primera pasada tras
 * desplegar son más de mil); devuelve cuántas quedan para la siguiente.
 */
export async function aplicarCambiosIntel(
  cambios: readonly { jid: string; de: number | null; a: number | null }[],
  tope = 400
): Promise<{ hechos: number; pendientes: number }> {
  if (cambios.length === 0 || !brainConfigured()) return { hechos: 0, pendientes: 0 };
  const sb = getSupabase();
  let hechos = 0;
  const tanda = cambios.slice(0, tope);
  for (const c of tanda) {
    try {
      const q = sb.from("chat_intel").update({ source_row: c.a }).eq("jid", c.jid);
      const { data, error } = await (c.de == null ? q.is("source_row", null) : q.eq("source_row", c.de)).select("jid");
      if (error) {
        console.warn(`[link-leads] no se pudo reapuntar la copia de ${c.jid}: ${error.message}`);
        continue;
      }
      hechos += (data ?? []).length;
    } catch (e) {
      console.warn(`[link-leads] error reapuntando la copia de ${c.jid}: ${(e as Error).message}`);
    }
  }
  // Regla del proyecto: todo escritor de `chat_intel` invalida la foto en memoria.
  if (hechos > 0) invalidateIntelCache();
  return { hechos, pendientes: cambios.length - tanda.length };
}

/**
 * Mueve la copia de unos vínculos concretos: `chat_intel.source_row` pasa de la
 * fila vieja a la nueva, solo donde sigue siendo la vieja. Para cuando se mueve
 * un vínculo manual a mano (ruta `/link-leads/manuales/reapuntar`); la pasada
 * periódica usa el repaso completo de arriba.
 */
export async function reapuntarEnIntel(pares: readonly { jid: string; de: number; a: number }[]): Promise<number> {
  const { hechos } = await aplicarCambiosIntel(pares, pares.length);
  return hechos;
}
