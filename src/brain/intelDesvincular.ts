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
