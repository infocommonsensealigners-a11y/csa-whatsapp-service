/**
 * LECCIONES DE FRANSUA — aprendizaje POR INTERACCIÓN (distinto del aprendizaje
 * semanal de métricas, kind='learning'). Cuando Fran corrige a Fransua, le enseña
 * algo, o Fransua admite un fallo, se guarda una LECCIÓN duradera en fransua_log
 * kind='leccion'. Esas lecciones se INYECTAN en el prompt de Fransua para que no
 * repita el error la próxima vez → aprendizaje que de verdad cambia su conducta.
 *
 * Dos vías de captura, complementarias:
 *  1) EXPLÍCITA: Fransua llama a la herramienta `aprender` (agentTools) cuando
 *     reconoce que ha aprendido algo (o Fran le dice "recuerda que…").
 *  2) AUTOMÁTICA: tras cada turno del chat, `extractAndStoreLessons` mira el
 *     intercambio y, SOLO si hubo corrección/enseñanza/fallo admitido, extrae la
 *     lección (best-effort, async, no bloquea la respuesta).
 */
import { getSupabase, brainConfigured } from "./supabase";
import { runJson, suggestModel } from "../ai/agent";

const askModel = process.env.WA_AI_MODEL_ASK ?? suggestModel;

export interface LeccionEntry {
  leccion: string;
  contexto?: string | null;
  actor?: string | null;
  origen?: "tool" | "auto";
  sourceRow?: number | null;
}

/** Guarda una lección. Fire-and-forget friendly (devuelve ok/err, no lanza). */
export async function storeLeccion(entry: LeccionEntry): Promise<{ ok: boolean; error?: string }> {
  const leccion = String(entry.leccion ?? "").trim();
  if (!leccion) return { ok: false, error: "lección vacía" };
  if (!brainConfigured()) return { ok: false, error: "brain-not-configured" };
  try {
    const sb = getSupabase();
    const { error } = await sb.from("fransua_log").insert({
      kind: "leccion",
      source_row: entry.sourceRow ?? null,
      payload: {
        at: new Date().toISOString(),
        leccion: leccion.slice(0, 500),
        contexto: entry.contexto ? String(entry.contexto).slice(0, 500) : null,
        actor: entry.actor ?? "Fran",
        origen: entry.origen ?? "tool",
      },
    });
    if (error) return { ok: false, error: error.message };
    leccionesCache = null; // invalida la caché para que la lección surta efecto ya
    return { ok: true };
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  }
}

let leccionesCache: { texto: string; at: number } | null = null;
const TTL_MS = 90_000;
const MAX_LECCIONES = 20;

/** Bloque de lecciones aprendidas para inyectar en el prompt (cacheado ~90s).
 *  Devuelve "" si no hay lecciones. Dedupe por texto (última gana). */
export async function getLeccionesTexto(): Promise<string> {
  if (leccionesCache && Date.now() - leccionesCache.at < TTL_MS) return leccionesCache.texto;
  if (!brainConfigured()) return "";
  try {
    const sb = getSupabase();
    const { data, error } = await sb
      .from("fransua_log")
      .select("payload,created_at")
      .eq("kind", "leccion")
      .order("created_at", { ascending: false })
      .limit(80);
    if (error || !data?.length) {
      leccionesCache = { texto: "", at: Date.now() };
      return "";
    }
    const seen = new Set<string>();
    const lineas: string[] = [];
    for (const r of data) {
      const l = String((r.payload as any)?.leccion ?? "").trim();
      if (!l) continue;
      const key = l.toLowerCase().replace(/\s+/g, " ");
      if (seen.has(key)) continue;
      seen.add(key);
      lineas.push(`- ${l}`);
      if (lineas.length >= MAX_LECCIONES) break;
    }
    const texto = lineas.length
      ? "=== LECCIONES QUE HAS APRENDIDO (respétalas SIEMPRE; son correcciones de Fran, no las repitas) ===\n" +
        lineas.join("\n")
      : "";
    leccionesCache = { texto, at: Date.now() };
    return texto;
  } catch {
    return "";
  }
}

/** GET crudo de las últimas lecciones (para UI/depuración). */
export async function listLecciones(limit = 30): Promise<Array<{ at: string; leccion: string; contexto: string | null; actor: string; origen: string }>> {
  if (!brainConfigured()) return [];
  const sb = getSupabase();
  const { data, error } = await sb
    .from("fransua_log")
    .select("payload,created_at")
    .eq("kind", "leccion")
    .order("created_at", { ascending: false })
    .limit(Math.min(limit, 100));
  if (error || !data) return [];
  return data.map((r: any) => ({
    at: r.payload?.at ?? r.created_at,
    leccion: r.payload?.leccion ?? "",
    contexto: r.payload?.contexto ?? null,
    actor: r.payload?.actor ?? "Fran",
    origen: r.payload?.origen ?? "auto",
  }));
}

/**
 * Extrae (y guarda) lecciones de UN intercambio del chat — SOLO si hubo una
 * corrección de Fran, una enseñanza, o Fransua admitió un error. Best-effort:
 * async, cualquier fallo se traga (no debe afectar a la conversación).
 */
export async function extractAndStoreLessons(franMsg: string, fransuaAnswer: string, actor: string): Promise<void> {
  if (!brainConfigured()) return;
  const fran = String(franMsg ?? "").trim();
  const fransua = String(fransuaAnswer ?? "").trim();
  if (!fran || !fransua) return;
  const prompt = [
    "Analiza este intercambio entre Fran (comercial de CSA) y Fransua (su asistente IA).",
    "Extrae SOLO lecciones DURADERAS que Fransua deba recordar para no repetir un fallo o para",
    "servir mejor a Fran. Cuenta como lección: (a) Fran corrige a Fransua o le dice que se equivocó,",
    "(b) Fran le enseña un dato/regla del negocio o una preferencia suya, (c) Fransua reconoce un fallo",
    "propio y cómo evitarlo. NO es lección: charla normal, respuestas correctas, datos efímeros de un",
    "lead concreto, o cosas que ya son obvias.",
    "",
    `FRAN: ${fran.slice(0, 1500)}`,
    `FRANSUA: ${fransua.slice(0, 1500)}`,
    "",
    "Devuelve SOLO un objeto JSON: {\"lecciones\": [\"lección concisa en imperativo, máx 1 frase\", …]}.",
    "Máximo 2 lecciones. Si no hay ninguna lección duradera, devuelve {\"lecciones\": []}.",
    "Escribe cada lección como una REGLA para el futuro (p.ej. \"Verifica con las herramientas antes de",
    "afirmar que un lead está en una lista; no des por buenos cruces de datos sin comprobar\").",
  ].join("\n");
  try {
    const out = await runJson<{ lecciones?: unknown }>(prompt, askModel);
    const lecciones = Array.isArray(out?.lecciones) ? out!.lecciones : [];
    for (const l of lecciones.slice(0, 2)) {
      const txt = String(l ?? "").trim();
      if (txt.length >= 8) await storeLeccion({ leccion: txt, contexto: fran.slice(0, 200), actor, origen: "auto" });
    }
  } catch {
    /* best-effort: si la IA falla, no pasa nada */
  }
}
