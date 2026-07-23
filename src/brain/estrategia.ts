/**
 * ESTRATEGIA COMERCIAL de CSA — el MODELO de pipeline con el que razona Fransua.
 *
 * FUENTE ÚNICA: el dashboard DERIVA este texto desde su motor (lib/domain/*) y lo
 * PUBLICA en Supabase (fransua_log, kind='strategy_context'). Aquí lo LEEMOS —
 * así no se duplica el modelo a mano: cambiar un umbral en el editor de
 * Estrategia del dashboard se propaga a Fransua solo (cacheado ~15 min).
 *
 * Si Supabase no está disponible o aún no hay contexto publicado, se usa el
 * FALLBACK de abajo (copia de resguardo; puede quedar algo desfasada, pero
 * Fransua nunca se queda sin estrategia).
 */
import { getSupabase, brainConfigured } from "./supabase";

export const ESTRATEGIA_CSA_FALLBACK = `ESTRATEGIA COMERCIAL DE CSA — cómo se mueve un lead y cómo actuar (síguela):
- Embudo: Sin contactar → Contactado → En conversación → Propuesta enviada → (Compra | No cualifica | No interesa). Además hay dos estados de "más adelante": "Futuro con propuesta" (quiere para más adelante PERO ya tiene precio sobre la mesa → recordatorio en la fecha prometida) y "Futuro sin propuesta" (más adelante y aún sin precio → nutrir con valor).
- SPEED-TO-LEAD es la palanca nº1 en formación de alto ticket: a un lead recién entrado hay que contactarlo en MINUTOS, no en horas ni días. Un lead nuevo aún sin contactar es lo más urgente del día, por encima de casi todo.
- PIPELINE ACTIVO vs BASE A REACTIVAR: el trabajo 1-a-1 del día es SOLO el pipeline activo (conversación viva, decisión a la vista, menos de ~30 días de silencio). A partir de ~30 días de silencio el lead pasa a la BASE a reactivar: no se persigue a diario, se trabaja por tandas.
- REACTIVAR a un dormido: reintentos espaciados a 7, 15, 30 y 60 días (máximo 3-4). Agotados, solo campaña estacional (Black Friday, vuelta al cole). El ángulo que funciona: aportar VALOR nuevo (contenido gratis, una masterclass/clase) + una oferta con gancho de temporada. NUNCA un "¿sigues interesado?" a secas.
- El "más adelante" (Futuro) es de lo que MÁS se pierde: no lo aparques sin más. Cierra siempre con un próximo paso concreto + FECHA; ancla urgencia (plazas, fecha de la próxima edición, oferta que caduca) y baja el riesgo (financiación, homologación/ROI).`;

let cache: { texto: string; at: number } | null = null;
const TTL_MS = 15 * 60 * 1000;

/** Devuelve la estrategia VIVA publicada por el dashboard (Supabase), cacheada.
 *  Cae al FALLBACK si no hay Supabase / contexto / ante cualquier error. */
export async function getEstrategiaCSA(): Promise<string> {
  if (cache && Date.now() - cache.at < TTL_MS) return cache.texto;
  if (brainConfigured()) {
    try {
      const sb = getSupabase();
      const { data, error } = await sb
        .from("fransua_log")
        .select("payload")
        .eq("kind", "strategy_context")
        .order("created_at", { ascending: false })
        .limit(1)
        .maybeSingle();
      const texto = (data?.payload as { texto?: string } | undefined)?.texto;
      if (!error && typeof texto === "string" && texto.trim()) {
        cache = { texto, at: Date.now() };
        return texto;
      }
    } catch {
      /* cae al fallback */
    }
  }
  return ESTRATEGIA_CSA_FALLBACK;
}
