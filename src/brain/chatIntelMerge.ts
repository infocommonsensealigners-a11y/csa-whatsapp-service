/**
 * Fusión ADITIVA de la inteligencia de un chat (chat_intel). REGLA DEL USUARIO
 * (2026-07-22): "siempre se suma, nunca se resta" — un re-análisis (en vivo o
 * en el barrido masivo) NUNCA debe borrar/vaciar un resumen, temperatura,
 * interés o etiqueta que ya existía. Antes, `analyzeChat.ts`/`assimilate.ts`
 * hacían un `upsert` de fila completa con `ai.campo ?? null`: si la IA
 * devolvía un JSON parcial (o fallaba del todo), esos `null` PISABAN datos
 * buenos ya guardados en Supabase — esa era la causa real de "el análisis
 * desaparece al reabrir el programa".
 *
 * Con este módulo: los campos escalares (resumen/temperatura/…) solo se
 * ACTUALIZAN si la IA trae un valor nuevo no vacío — si no, se conserva el
 * anterior. Los campos de lista (intereses/etiquetas) se UNEN (nunca se
 * reemplazan), así una etiqueta o interés detectado una vez no desaparece.
 */
import { getSupabase } from "./supabase";

export interface ChatIntelAiFields {
  producto?: string | null;
  temperatura?: string | null;
  temperatura_motivo?: string | null;
  resumen?: string | null;
  intereses?: Array<{ label: string; evidence?: string }> | null;
  etiquetas?: string[] | null;
}

const norm = (s: unknown): string => String(s ?? "").trim().toLowerCase();

/** Unión de intereses por `label` normalizado — conserva el primero visto de cada uno. */
function mergeIntereses(
  prev: ChatIntelAiFields["intereses"],
  next: ChatIntelAiFields["intereses"]
): ChatIntelAiFields["intereses"] {
  const out: NonNullable<ChatIntelAiFields["intereses"]> = [];
  const seen = new Set<string>();
  for (const it of [...(prev ?? []), ...(next ?? [])]) {
    const key = norm(it?.label);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(it);
  }
  return out.length ? out : null;
}

/** Unión de etiquetas — sin duplicados (comparación normalizada). */
function mergeEtiquetas(prev: string[] | null | undefined, next: string[] | null | undefined): string[] | null {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const e of [...(prev ?? []), ...(next ?? [])]) {
    const key = norm(e);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(String(e));
  }
  return out.length ? out : null;
}

/** Trae SOLO los campos de inteligencia ya guardados para este jid (o null si no hay fila aún). */
export async function fetchExistingChatIntel(jid: string): Promise<ChatIntelAiFields | null> {
  const sb = getSupabase();
  const { data } = await sb
    .from("chat_intel")
    .select("producto,temperatura,temperatura_motivo,resumen,intereses,etiquetas")
    .eq("jid", jid)
    .maybeSingle();
  return (data as ChatIntelAiFields) ?? null;
}

/**
 * Combina lo existente con el análisis nuevo. Escalares: el nuevo valor gana
 * SOLO si viene no vacío; si no, se conserva el anterior. Listas: unión.
 */
export function mergeAiFields(existing: ChatIntelAiFields | null, next: ChatIntelAiFields): ChatIntelAiFields {
  return {
    producto: next.producto || existing?.producto || null,
    temperatura: next.temperatura || existing?.temperatura || null,
    temperatura_motivo: next.temperatura_motivo || existing?.temperatura_motivo || null,
    resumen: next.resumen || existing?.resumen || null,
    intereses: mergeIntereses(existing?.intereses, next.intereses),
    etiquetas: mergeEtiquetas(existing?.etiquetas, next.etiquetas),
  };
}
