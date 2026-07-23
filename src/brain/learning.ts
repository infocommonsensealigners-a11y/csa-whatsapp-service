/**
 * BUCLE DE APRENDIZAJE (idea 5) — lógica reutilizable + scheduler.
 *
 * runLearning(): pide al dashboard las MÉTRICAS DE RESULTADO reales
 * (/api/fransua/learning-metrics) + la estrategia actual, y con la IA sintetiza
 * insights + PROPUESTAS de ajuste (con confianza), guardándolo en fransua_log
 * kind='learning'. NO cambia nada solo — son propuestas para el editor de
 * Estrategia (idea 1 las propaga).
 *
 * startLearningScheduler(): lo dispara solo (semanal + una pasada ~3 min tras el
 * arranque), best-effort — mismo molde que linkLeadsScheduler. Así el aprendizaje
 * se refresca sin que nadie lo pida.
 */
import { getSupabase, brainConfigured } from "./supabase";
import { runJson, suggestModel } from "../ai/agent";
import { getEstrategiaCSA } from "./estrategia";
import { config } from "../config";

const askModel = process.env.WA_AI_MODEL_ASK ?? suggestModel;

async function fetchLearningMetrics(): Promise<string | null> {
  const token = process.env.FRANSUA_INTERNAL_TOKEN;
  if (!token) return null;
  try {
    const res = await fetch(`${config.dashboardUrl}/api/fransua/learning-metrics`, {
      headers: { "x-fransua-token": token },
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) return null;
    const j = (await res.json()) as { ok?: boolean; texto?: string };
    return j?.ok && typeof j.texto === "string" ? j.texto : null;
  } catch {
    return null;
  }
}

export interface LearningResult {
  ok: boolean;
  error?: string;
  at?: string;
  resumen?: string;
  insights?: unknown[];
  propuestas?: unknown[];
}

/** Ejecuta el análisis de aprendizaje y lo persiste. Devuelve el payload. */
export async function runLearning(): Promise<LearningResult> {
  if (!brainConfigured()) return { ok: false, error: "brain-not-configured" };
  const [metricas, estrategia] = await Promise.all([fetchLearningMetrics(), getEstrategiaCSA().catch(() => "")]);
  if (!metricas) return { ok: false, error: "no se pudieron leer las métricas del dashboard" };

  const prompt = [
    "Eres Fransua, el cerebro comercial de Common Sense Aligners (CSA), que vende FORMACIÓN de alto",
    "ticket a dentistas. Tienes las MÉTRICAS DE RESULTADO reales y la ESTRATEGIA actual. Con criterio",
    "de venta de alto ticket, propón AJUSTES CONCRETOS de la estrategia que mejorarían el resultado,",
    "PERO solo si los datos lo respaldan: si una muestra es pequeña (n bajo) o no hay datos, dilo y NO",
    "propongas cambiarla. No inventes cifras que no estén abajo.",
    "",
    metricas,
    "",
    "=== ESTRATEGIA ACTUAL (valores vigentes que podrías sugerir ajustar) ===",
    estrategia,
    "",
    "Devuelve SOLO un objeto JSON con esta forma EXACTA:",
    "{",
    '  "resumen": "1-2 frases: qué dicen los datos ahora mismo",',
    '  "insights": ["observaciones concretas basadas en las métricas (máx 5)"],',
    '  "propuestas": [{"param":"dormido|speed-to-lead|cadencia|renovacion|otro","actual":"valor/estado actual","sugerido":"cambio propuesto","porque":"la evidencia en los datos","confianza":"alta|media|baja"}]',
    "}",
    "Si no hay evidencia suficiente para ninguna propuesta, devuelve propuestas: [] y dilo en el resumen.",
  ].join("\n");

  let out: { resumen?: string; insights?: unknown; propuestas?: unknown } | null = null;
  try {
    out = await runJson(prompt, askModel);
  } catch (e) {
    return { ok: false, error: "IA no disponible: " + (e as Error).message };
  }
  if (!out) return { ok: false, error: "la IA no devolvió un análisis válido" };

  const payload = {
    at: new Date().toISOString(),
    resumen: typeof out.resumen === "string" ? out.resumen : "",
    insights: Array.isArray(out.insights) ? out.insights.slice(0, 8) : [],
    propuestas: Array.isArray(out.propuestas) ? out.propuestas.slice(0, 10) : [],
  };
  const sb = getSupabase();
  const { error } = await sb.from("fransua_log").insert({ kind: "learning", payload });
  if (error) return { ok: false, error: error.message };
  return { ok: true, ...payload };
}

const INTERVAL_MS = 7 * 24 * 60 * 60_000; // semanal
const FIRST_RUN_DELAY_MS = 3 * 60_000; // 3 min tras el arranque (deja subir al dashboard)

/** Dispara runLearning() solo (semanal). No-op con aviso si falta el token. */
export function startLearningScheduler(): void {
  if (!process.env.FRANSUA_INTERNAL_TOKEN) {
    console.log("[learn] FRANSUA_INTERNAL_TOKEN no configurado → aprendizaje automático desactivado.");
    return;
  }
  const run = () =>
    void runLearning()
      .then((r) => console.log(r.ok ? `[learn] análisis actualizado (${(r.propuestas ?? []).length} propuestas).` : `[learn] sin análisis: ${r.error}`))
      .catch((e) => console.error("[learn] fallo:", (e as Error).message));
  setTimeout(run, FIRST_RUN_DELAY_MS);
  setInterval(run, INTERVAL_MS);
  console.log(`[learn] aprendizaje automático activo (semanal, 1ª pasada en ${FIRST_RUN_DELAY_MS / 60_000} min).`);
}
