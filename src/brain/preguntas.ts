/**
 * REGISTRO DE PREGUNTAS a Fransua — el "banco de preguntas" del que va
 * aprendiendo a responder.
 *
 * Motivación (usuario 2026-07-24): Fran le hace preguntas al chat que Fransua
 * hoy NO sabe resolver ("¿cuántas conversaciones he tenido con X?", "¿qué leads
 * dormidos de 2025 son reactivables según su conversación?"). Antes esas
 * preguntas se PERDÍAN. Ahora se registran TODAS (kind='pregunta' en
 * fransua_log — sin migración), marcando cuáles quedaron SIN RESOLVER, para:
 *   1) tener un listado recuperable (GET /intel/preguntas) y revisarlas,
 *   2) que Fran/Miguel escriban la respuesta/regla → se guarda como LECCIÓN
 *      (ver lecciones.ts), que se inyecta en el prompt y hace que Fransua SÍ
 *      sepa responder ese tipo de pregunta la próxima vez.
 *
 * La detección de "sin resolver" es una heurística sobre la respuesta (frases
 * de rechazo típicas + "no usó ninguna herramienta"), no perfecta pero útil
 * para que la lista de revisión suba lo que de verdad falló arriba. Best-effort
 * y async: registrar una pregunta NUNCA debe afectar a la respuesta del chat.
 */
import { getSupabase, brainConfigured } from "./supabase";

/** Frases con las que Fransua reconoce que NO puede resolver algo. */
const RECHAZO = [
  "no tengo esa métrica",
  "no tengo esa",
  "no puedo darte",
  "no puedo darlo",
  "no me permite",
  "no permiten",
  "no lo puedo",
  "no puedo verificar",
  "sin rigor",
  "no con rigor",
  "no tengo forma de",
  "mis herramientas no",
  "no dispongo de",
  "no sé", // "no sé cuántas…"
  "no tengo acceso",
  "no puedo sacar",
  "no puedo filtrar",
  "no está desglosad",
];

/**
 * Heurística: ¿la respuesta parece un "no puedo resolverlo"? Mira frases de
 * rechazo y el nº de herramientas usadas (si no consultó datos y encima hay
 * frase de rechazo, casi seguro que no resolvió).
 */
export function parecerNoResuelta(answer: string, toolsUsed = 0): boolean {
  const a = String(answer ?? "").toLowerCase();
  if (!a) return true;
  const hayRechazo = RECHAZO.some((f) => a.includes(f));
  if (!hayRechazo) return false;
  // Con frase de rechazo: si además no usó herramientas, es no-resuelta segura;
  // si usó herramientas puede ser un "no puedo con ESE dato pero te doy lo que sí"
  // → lo marcamos igualmente para revisión (mejor sobre-listar que perder).
  return true;
}

export interface PreguntaEntry {
  pregunta: string;
  respuesta: string;
  toolsUsed?: number;
  actor?: string;
}

/** Registra UNA pregunta del chat. Fire-and-forget (no lanza). */
export async function logPregunta(entry: PreguntaEntry): Promise<void> {
  if (!brainConfigured()) return;
  const pregunta = String(entry.pregunta ?? "").trim();
  if (!pregunta) return;
  const respuesta = String(entry.respuesta ?? "").trim();
  const toolsUsed = entry.toolsUsed ?? 0;
  try {
    const sb = getSupabase();
    await sb.from("fransua_log").insert({
      kind: "pregunta",
      payload: {
        at: new Date().toISOString(),
        pregunta: pregunta.slice(0, 800),
        respuesta: respuesta.slice(0, 800),
        resuelta: !parecerNoResuelta(respuesta, toolsUsed),
        toolsUsed,
        actor: entry.actor ?? "Fran",
      },
    });
  } catch {
    /* best-effort: si falla el registro, la conversación no se entera */
  }
}

export interface PreguntaRow {
  id: string;
  at: string;
  pregunta: string;
  respuesta: string;
  resuelta: boolean;
  toolsUsed: number;
  actor: string;
}

/**
 * Lista de preguntas para revisión (más recientes primero). `soloSinResolver`
 * filtra a las que Fransua no supo responder. Dedupe suave por texto de
 * pregunta (conserva la más reciente) para que la misma pregunta repetida no
 * inunde la lista, pero cuenta las repeticiones en `veces`.
 */
export async function listPreguntas(opts: { limit?: number; soloSinResolver?: boolean } = {}): Promise<Array<PreguntaRow & { veces: number }>> {
  if (!brainConfigured()) return [];
  const limit = Math.min(opts.limit ?? 50, 200);
  try {
    const sb = getSupabase();
    const { data, error } = await sb
      .from("fransua_log")
      .select("id,payload,created_at")
      .eq("kind", "pregunta")
      .order("created_at", { ascending: false })
      .limit(500);
    if (error || !data) return [];
    const porTexto = new Map<string, PreguntaRow & { veces: number }>();
    for (const r of data) {
      const p = (r.payload ?? {}) as Record<string, unknown>;
      const pregunta = String(p.pregunta ?? "").trim();
      if (!pregunta) continue;
      const resuelta = Boolean(p.resuelta);
      if (opts.soloSinResolver && resuelta) continue;
      const key = pregunta.toLowerCase().replace(/\s+/g, " ").slice(0, 120);
      const prev = porTexto.get(key);
      if (prev) {
        prev.veces += 1; // ya tenemos la más reciente (orden desc); solo contamos
        continue;
      }
      porTexto.set(key, {
        id: String(r.id),
        at: String(p.at ?? r.created_at),
        pregunta,
        respuesta: String(p.respuesta ?? ""),
        resuelta,
        toolsUsed: Number(p.toolsUsed ?? 0),
        actor: String(p.actor ?? "Fran"),
        veces: 1,
      });
    }
    return [...porTexto.values()].slice(0, limit);
  } catch {
    return [];
  }
}
