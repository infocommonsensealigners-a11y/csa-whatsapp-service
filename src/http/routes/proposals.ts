/**
 * CONECTORES — Plaud → Propuesta SBA. Convierte la transcripción de una llamada
 * de venta de Fran en el contenido personalizado de la propuesta (mismo esquema
 * que `PLAUD A PROPUESTA/contenido_APELLIDO.py`: hero, NEEDS, REA, bloque
 * estrella). Usa Claude vía la SUSCRIPCIÓN (ai/agent runJson), igual que
 * /intel/extract-fiscal — sin ANTHROPIC_API_KEY nuevo y sin tocar Supabase.
 *
 * Fechas/regalo/precio NO se inventan aquí: el dashboard los pre-rellena con
 * los valores fijos de la edición vigente (los conoce Fran) y esta IA solo
 * sugiere un override si la transcripción declara explícitamente un cambio
 * (p. ej. una fecha límite distinta que Fran ya pactó en la llamada).
 */
import type { FastifyInstance } from "fastify";
import { runJson, suggestModel } from "../../ai/agent";

const MAX_TRANSCRIPT_CHARS = 100_000;

export interface ProposalNeed {
  want: string;
  tag: string;
  fix: string;
}
export interface ProposalRea {
  t: string;
  d: string;
}
export type ProposalStarBlock = "biomecanica" | "revision" | "tecnicas" | "estancia";

export interface ExtractedProposal {
  drNombre: string;
  drNombreArt: string;
  heroLead1: string;
  heroLead2: string;
  needs: ProposalNeed[];
  rea: ProposalRea[];
  starBlock: ProposalStarBlock;
  giftDeadlineOverride: string | null;
  planDescOverride: string | null;
  fechasOverride: string[] | null;
  confianza: "alta" | "media" | "baja";
  avisos: string[];
}

const SCHEMA_KEYS = [
  "drNombre", "drNombreArt", "heroLead1", "heroLead2", "needs", "rea", "starBlock",
  "giftDeadlineOverride", "planDescOverride", "fechasOverride", "confianza", "avisos",
] as const;

function buildPrompt(transcript: string): string {
  return `Eres el redactor de propuestas comerciales de Common Sense Aligners (CSA), programa de formación SBA (Sistema de Biomecánica Avanzada) para dentistas — impartido por el Dr. Javier Lozano. Fran es el comercial; acaba de tener una llamada de venta con un/a doctor/a y esta es su transcripción (Plaud). Tu trabajo es redactar el contenido PERSONALIZADO de la propuesta que se le enviará, con el MISMO tono y estructura que estos dos ejemplos reales (no los copies, son solo referencia de tono y longitud):

EJEMPLO 1 (Dr. Saúco) — hero: "Desde el máster de Manuel Román llevas años tratando solo con Invisalign y hoy apenas un 5–10% de tus casos se te atraviesan. Lo que buscas ahora es otra cosa: [reducir el número de refinamientos, bajar el número de alineadores por caso y tener más pacientes en tratamiento]." NEEDS incluye cosas como {want: «Quiero reducir el número de refinamientos.», tag: "Revisión de casos", fix: "Subes el caso... y el Dr. Lozano revisa contigo el detallado movimiento a movimiento..."}. REA incluye {t: "Las sesiones son martes y jueves a las 9:30:", d: "si no puedes entrar en directo, todas quedan grabadas..."}.

EJEMPLO 2 (Dra. Sete) — mismo patrón, con needs y objeciones distintas según su llamada.

REGLAS (obligatorias):
- "drNombre": tratamiento + nombre tal como se dirige Fran al doctor/a en la llamada (p. ej. "Dr. Juan José Saúco" o "Dra. Sete"). "drNombreArt": lo mismo con artículo ("el Dr. Juan José Saúco" / "la Dra. Sete"), para el pie de página.
- "heroLead1"/"heroLead2": 2 párrafos (HTML permitido). El 1º resume su situación actual y SU necesidad principal, con el tramo más importante envuelto en <span class="hl">...</span>. El 2º es puente hacia el programa, cerrando con dos puntos.
- "needs": 4 a 6 puntos de dolor REALES de la llamada. "want" = una frase citada ENTRE COMILLAS ANGULARES «» lo más textual posible a como lo dijo el/la doctor/a (no la inventes; si no hay cita textual clara, parafrasea en primera persona). "tag" = etiqueta corta (2-4 palabras) del bloque/tema al que corresponde. "fix" = cómo se resuelve en el programa (con el Dr. Lozano), 1-3 frases.
- "rea": 5 a 6 objeciones o dudas que salieron en la llamada (horario, marca de alineador que usa, nivel/experiencia previa, tiene clínica propia o colabora en varias, fechas/vacaciones, etc.), resueltas. "t" = titular en pocas palabras terminado en ":". "d" = resolución en 1-2 frases.
- "starBlock": cuál de estos 4 bloques FIJOS del programa es el dolor PRINCIPAL de este doctor/a — responde exactamente uno de: "biomecanica" (Teoría · Biomecánica mixta), "revision" (Revisión de casos — es el valor por DEFECTO salvo que otro bloque sea claramente el dolor principal), "tecnicas" (Talleres de técnicas auxiliares — microtornillos/MARPE/quirúrgicos), "estancia" (Estancia clínica — más casos/marketing/equipo).
- "giftDeadlineOverride"/"planDescOverride"/"fechasOverride": deja TODOS en null salvo que la transcripción declare EXPLÍCITAMENTE una fecha límite, condición de pago o fecha de inicio DISTINTA a la habitual del programa — nunca inventes precios, IBAN ni fechas que no se hayan dicho.
- "confianza": "alta" si la llamada da material claro para todo lo anterior, "media" si falta algo, "baja" si la transcripción es pobre/corta.
- "avisos": lista corta de avisos para quien revise (p. ej. "Solo se detectaron 3 needs claras", "No quedó clara la objeción de horario").
- Español de España, sin inventar datos que no estén en la transcripción. Nunca menciones precios, el IBAN ni enlaces (van fijos en la plantilla, no los tocas).

TRANSCRIPCIÓN (Plaud):
---
${transcript}
---

Responde ÚNICAMENTE con un objeto JSON con EXACTAMENTE estas claves: ${SCHEMA_KEYS.join(", ")}.`;
}

function validate(obj: unknown): ExtractedProposal | null {
  if (!obj || typeof obj !== "object") return null;
  const o = obj as Record<string, unknown>;
  if (typeof o.drNombre !== "string" || !o.drNombre.trim()) return null;
  if (!Array.isArray(o.needs) || !Array.isArray(o.rea)) return null;
  const starBlocks: ProposalStarBlock[] = ["biomecanica", "revision", "tecnicas", "estancia"];
  const starBlock = starBlocks.includes(o.starBlock as ProposalStarBlock) ? (o.starBlock as ProposalStarBlock) : "revision";
  return {
    drNombre: o.drNombre.trim(),
    drNombreArt: typeof o.drNombreArt === "string" && o.drNombreArt.trim() ? o.drNombreArt.trim() : o.drNombre.trim(),
    heroLead1: typeof o.heroLead1 === "string" ? o.heroLead1.trim() : "",
    heroLead2: typeof o.heroLead2 === "string" ? o.heroLead2.trim() : "",
    needs: (o.needs as unknown[])
      .map((n) => (n && typeof n === "object" ? (n as Record<string, unknown>) : {}))
      .map((n) => ({ want: String(n.want ?? "").trim(), tag: String(n.tag ?? "").trim(), fix: String(n.fix ?? "").trim() }))
      .filter((n) => n.want && n.fix),
    rea: (o.rea as unknown[])
      .map((r) => (r && typeof r === "object" ? (r as Record<string, unknown>) : {}))
      .map((r) => ({ t: String(r.t ?? "").trim(), d: String(r.d ?? "").trim() }))
      .filter((r) => r.t && r.d),
    starBlock,
    giftDeadlineOverride: typeof o.giftDeadlineOverride === "string" && o.giftDeadlineOverride.trim() ? o.giftDeadlineOverride.trim() : null,
    planDescOverride: typeof o.planDescOverride === "string" && o.planDescOverride.trim() ? o.planDescOverride.trim() : null,
    fechasOverride: Array.isArray(o.fechasOverride) && o.fechasOverride.length
      ? (o.fechasOverride as unknown[]).map((f) => String(f)).filter(Boolean)
      : null,
    confianza: o.confianza === "alta" || o.confianza === "media" || o.confianza === "baja" ? o.confianza : "media",
    avisos: Array.isArray(o.avisos) ? (o.avisos as unknown[]).map((a) => String(a)).filter(Boolean) : [],
  };
}

export function registerProposalRoutes(app: FastifyInstance): void {
  // POST /proposals/extract { transcript } → borrador de contenido para la propuesta SBA.
  app.post("/proposals/extract", async (req, reply) => {
    const body = (req.body ?? {}) as { transcript?: unknown };
    const transcript = typeof body.transcript === "string" ? body.transcript.trim() : "";
    if (!transcript) return reply.status(400).send({ ok: false, error: 'Falta "transcript".' });
    if (transcript.length < 200) {
      return reply.status(422).send({ ok: false, error: "La transcripción es demasiado corta para extraer una propuesta fiable." });
    }
    const clipped = transcript.length > MAX_TRANSCRIPT_CHARS ? transcript.slice(0, MAX_TRANSCRIPT_CHARS) : transcript;

    try {
      const raw = await runJson<Record<string, unknown>>(buildPrompt(clipped), suggestModel);
      const proposal = raw ? validate(raw) : null;
      if (!proposal) return reply.status(503).send({ ok: false, error: "La IA no pudo extraer un borrador válido. Reintenta." });
      return { ok: true, proposal };
    } catch (e) {
      return reply.status(503).send({ ok: false, error: "IA no disponible: " + (e as Error).message });
    }
  });
}
