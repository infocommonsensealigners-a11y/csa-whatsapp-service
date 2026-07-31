/**
 * ANÁLISIS DE RENOVACIÓN — 3ª pata de "Análisis de llamadas" (pedido del usuario
 * 2026-07-31). `/proposals/extract` saca la PROPUESTA y `/calls/analyze` evalúa
 * cómo vendió Fran; esto es distinto: la llamada es con un alumno que YA ESTÁ
 * DENTRO del programa y de lo que se trata es de saber
 *
 *   1) cómo de contento está con el curso (con la cita literal que lo prueba), y
 *   2) qué PUNTOS DE MEJORA deja de los 10 meses vividos, clasificados por área
 *      del programa para poder agregarlos entre alumnos y arreglar lo que falla.
 *
 * A propósito NO devuelve ningún score 0-100: un número de "satisfacción" salido
 * de una conversación sería precisión fingida (misma lección que la recalibración
 * del baremo de venta). Se usan NIVELES anclados a lo que el alumno dice, y
 * `no_consta` cuando la llamada no habla de su experiencia.
 *
 * Las anclas y las áreas son las MISMAS que en
 * dashboard/lib/domain/renewalAnalysis.ts (allí las consume la UI); si cambian
 * aquí, cámbialas allí.
 */
import type { FastifyInstance } from "fastify";
import { runJson, suggestModel } from "../../ai/agent";

const MAX_TRANSCRIPT_CHARS = 100_000;

export type SatisfaccionNivel = "entusiasta" | "satisfecho" | "reservas" | "descontento" | "no_consta";
export type IntencionRenovar = "renueva" | "probable" | "dudosa" | "no" | "no_consta";
export type MejoraArea =
  | "contenido" | "tutorizacion" | "directos" | "estancia" | "plataforma"
  | "organizacion" | "comunidad" | "ritmo" | "precio" | "otro";
export type Severidad = "alta" | "media" | "baja";

export interface RenewalPunto {
  texto: string;
  cita: string | null;
}
export interface RenewalMejora {
  area: MejoraArea;
  que: string;
  cita: string | null;
  severidad: Severidad;
}
export interface RenewalAnalysis {
  resumen: string;
  alumno: string | null;
  edicion: string | null;
  diarizado: boolean;
  satisfaccion: SatisfaccionNivel;
  satisfaccionCita: string | null;
  satisfaccionPorQue: string | null;
  loQueValora: RenewalPunto[];
  mejoras: RenewalMejora[];
  intencion: IntencionRenovar;
  intencionCita: string | null;
  frenos: RenewalPunto[];
  proximoPaso: string | null;
  resultados: string | null;
  citasClave: string[];
  confianza: "alta" | "media" | "baja";
}

const SCHEMA_KEYS = [
  "resumen", "alumno", "edicion", "diarizado", "satisfaccion", "satisfaccionCita",
  "satisfaccionPorQue", "loQueValora", "mejoras", "intencion", "intencionCita",
  "frenos", "proximoPaso", "resultados", "citasClave", "confianza",
] as const;

const NIVELES: SatisfaccionNivel[] = ["entusiasta", "satisfecho", "reservas", "descontento", "no_consta"];
const INTENCIONES: IntencionRenovar[] = ["renueva", "probable", "dudosa", "no", "no_consta"];
const AREAS: MejoraArea[] = [
  "contenido", "tutorizacion", "directos", "estancia", "plataforma",
  "organizacion", "comunidad", "ritmo", "precio", "otro",
];
const SEVERIDADES: Severidad[] = ["alta", "media", "baja"];

function buildPrompt(transcript: string): string {
  return `Eres analista de formación de Common Sense Aligners (CSA), que forma a dentistas/ortodoncistas con los programas del Dr. Javier Lozano. El SBA dura 10 meses e incluye sesiones en directo, tutorización de los casos del alumno, estancia clínica, campus con vídeos y comunidad. Fran es el comercial.

Esta transcripción (Plaud) es una LLAMADA DE RENOVACIÓN: el alumno YA ESTÁ DENTRO —acaba o va avanzado— y se habla de que siga otra edición. NO evalúes cómo vendió Fran. Saca DOS cosas que CSA necesita, y de paso el estado de la renovación:
  A) CÓMO DE CONTENTO está el alumno con el curso, con la frase literal que lo prueba.
  B) Los PUNTOS DE MEJORA de lo que ha vivido en el programa, para arreglarlo.

REGLAS DURAS
- Las citas van SIEMPRE en literal (copia el fragmento tal cual de la transcripción, sin retocar ni resumir) y SOLO de lo que dice el ALUMNO. Lo que afirme Fran no cuenta como opinión del alumno.
- Si la llamada no habla de su experiencia en el curso, "satisfaccion" es "no_consta", "loQueValora" y "mejoras" van vacíos y lo dices en "resumen". NO rellenes a ojo.
- La cortesía NO es satisfacción: "muy bien, gracias", "todo perfecto" al saludar o un elogio a Fran no valen como contento con el curso. Hace falta que hable del programa.
- No inventes áreas ni conviertas una duda sobre el futuro ("¿qué incluye la siguiente edición?") en un punto de mejora.
- Español de España.

CAMPOS
- "resumen": 2-3 frases: en qué punto está el alumno, cómo de contento y cómo quedó la renovación.
- "alumno": nombre del alumno tal como suena en la llamada, o null. "edicion": la edición/promoción que cursa si se dice (p. ej. "3ª edición", "grupo de enero"), o null.
- "diarizado": true SOLO si la transcripción distingue quién habla; si es una masa de texto sin marcas de interlocutor, false (y entonces baja "confianza", porque atribuir frases es menos fiable).
- "satisfaccion": uno de ${NIVELES.join(" | ")}. Elige por lo que DICE, no por el tono:
   · entusiasta = dice sin que se le pregunte que el curso le ha cambiado la forma de trabajar, recomienda a otros, o quiere seguir sin poner condiciones.
   · satisfecho = nombra cosas concretas que le han servido y no plantea carencias de fondo.
   · reservas = valora parte del curso pero expresa carencias concretas: le faltó algo, esperaba más de algo.
   · descontento = dice que no ha obtenido lo que esperaba o critica el núcleo del programa.
   · no_consta = la llamada no habla de su experiencia.
- "satisfaccionCita": la frase literal del alumno que sostiene ese nivel (null si no hay ninguna limpia). "satisfaccionPorQue": 1 frase de por qué ese nivel y no el de al lado.
- "loQueValora": array de {texto, cita} con lo que le ha funcionado del curso (hasta 6). Sirve para no romper lo que ya va bien.
- "mejoras": array de {area, que, cita, severidad} (hasta 8, [] si no dice nada).
   · "area": una de ${AREAS.join(" | ")} — contenido=temario/material; tutorizacion=revisión de SUS casos, feedback, mentoría; directos=clases en vivo; estancia=estancia clínica presencial; plataforma=campus/vídeos/acceso; organizacion=calendario, avisos, coordinación; comunidad=grupo y compañeros; ritmo=duración/velocidad/compaginar con la clínica; precio=coste y condiciones; otro=lo que no encaje.
   · "que": qué habría que mejorar, en ACCIONABLE y en una frase (no "se queja de los directos" sino "grabar los directos: no puede asistir a la hora en que se dan").
   · "severidad": alta si le hizo dudar de seguir o le impidió aprovechar el curso; media si le restó valor; baja si es un comentario de pasada.
   · Cuenta también lo que echó de menos y lo que pide para la próxima edición ("estaría bien que…"), aunque lo diga de buenas.
- "intencion": uno de ${INTENCIONES.join(" | ")}: renueva=lo dice explícitamente o acepta el siguiente paso concreto (pago, fecha, firma); probable=quiere seguir pero deja algo pendiente; dudosa=no se compromete y hay una objeción viva; no=dice que no sigue; no_consta=no se llega a tratar. "intencionCita": la frase literal que lo sostiene o null.
- "frenos": array de {texto, cita} con lo que frena la renovación (precio, agenda, dudas del siguiente nivel…). [] si ninguno.
- "proximoPaso": el compromiso concreto que queda (con fecha si la hay), o null si quedó en el aire.
- "resultados": qué cuenta que ha CONSEGUIDO con el curso (casos que ya resuelve, cambios en su clínica, facturación), o null.
- "citasClave": 2 a 4 frases literales del alumno que merezca leer tal cual (las más reveladoras, buenas o malas).
- "confianza": "alta" si la transcripción da material claro; "media" si falta contexto; "baja" si es corta, pobre o no se distingue quién habla.

TRANSCRIPCIÓN (Plaud):
---
${transcript}
---

Responde ÚNICAMENTE con un objeto JSON con EXACTAMENTE estas claves: ${SCHEMA_KEYS.join(", ")}.`;
}

const strOrNull = (v: unknown, max = 500): string | null => {
  const s = typeof v === "string" ? v.trim() : "";
  return s ? s.slice(0, max) : null;
};

function parsePuntos(raw: unknown, max: number): RenewalPunto[] {
  if (!Array.isArray(raw)) return [];
  const out: RenewalPunto[] = [];
  for (const p of raw) {
    if (typeof p === "string") {
      const t = strOrNull(p, 400);
      if (t) out.push({ texto: t, cita: null });
      continue;
    }
    if (!p || typeof p !== "object") continue;
    const o = p as Record<string, unknown>;
    const texto = strOrNull(o.texto ?? o.que, 400);
    if (texto) out.push({ texto, cita: strOrNull(o.cita) });
  }
  return out.slice(0, max);
}

function parseMejoras(raw: unknown): RenewalMejora[] {
  if (!Array.isArray(raw)) return [];
  const out: RenewalMejora[] = [];
  for (const m of raw) {
    if (!m || typeof m !== "object") continue;
    const o = m as Record<string, unknown>;
    const que = strOrNull(o.que ?? o.texto, 400);
    if (!que) continue;
    const area = String(o.area ?? "").trim().toLowerCase() as MejoraArea;
    const sev = String(o.severidad ?? "").trim().toLowerCase() as Severidad;
    out.push({
      area: AREAS.includes(area) ? area : "otro",
      que,
      cita: strOrNull(o.cita),
      severidad: SEVERIDADES.includes(sev) ? sev : "media",
    });
  }
  return out.slice(0, 8);
}

function validate(obj: unknown): RenewalAnalysis | null {
  if (!obj || typeof obj !== "object") return null;
  const o = obj as Record<string, unknown>;
  if (typeof o.resumen !== "string" || !o.resumen.trim()) return null;
  const nivel = String(o.satisfaccion ?? "").trim().toLowerCase() as SatisfaccionNivel;
  const intencion = String(o.intencion ?? "").trim().toLowerCase() as IntencionRenovar;
  return {
    resumen: o.resumen.trim().slice(0, 900),
    alumno: strOrNull(o.alumno, 120),
    edicion: strOrNull(o.edicion, 80),
    diarizado: o.diarizado === true,
    satisfaccion: NIVELES.includes(nivel) ? nivel : "no_consta",
    satisfaccionCita: strOrNull(o.satisfaccionCita),
    satisfaccionPorQue: strOrNull(o.satisfaccionPorQue, 400),
    loQueValora: parsePuntos(o.loQueValora, 6),
    mejoras: parseMejoras(o.mejoras),
    intencion: INTENCIONES.includes(intencion) ? intencion : "no_consta",
    intencionCita: strOrNull(o.intencionCita),
    frenos: parsePuntos(o.frenos, 5),
    proximoPaso: strOrNull(o.proximoPaso, 300),
    resultados: strOrNull(o.resultados, 600),
    citasClave: Array.isArray(o.citasClave)
      ? o.citasClave.map((c) => strOrNull(c, 400)).filter((c): c is string => !!c).slice(0, 4)
      : [],
    confianza: o.confianza === "alta" || o.confianza === "baja" ? o.confianza : "media",
  };
}

/**
 * Analiza una transcripción de renovación. Fuera de la ruta a propósito: así se
 * puede probar el prompt contra una transcripción real sin levantar el servidor
 * (`npx tsx --env-file=.env scripts/diag-renewal.ts <fichero.txt>`), que es como
 * se comprobó antes de desplegar.
 */
export async function analyzeRenewalTranscript(transcript: string): Promise<RenewalAnalysis | null> {
  const clipped = transcript.length > MAX_TRANSCRIPT_CHARS ? transcript.slice(0, MAX_TRANSCRIPT_CHARS) : transcript;
  const raw = await runJson<Record<string, unknown>>(buildPrompt(clipped), suggestModel);
  return raw ? validate(raw) : null;
}

export function registerRenewalRoutes(app: FastifyInstance): void {
  // POST /calls/analyze-renewal { transcript } → contento del alumno + mejoras del curso.
  app.post("/calls/analyze-renewal", async (req, reply) => {
    const body = (req.body ?? {}) as { transcript?: unknown };
    const transcript = typeof body.transcript === "string" ? body.transcript.trim() : "";
    if (!transcript) return reply.status(400).send({ ok: false, error: 'Falta "transcript".' });
    if (transcript.length < 200) {
      return reply.status(422).send({ ok: false, error: "La transcripción es demasiado corta para analizar la renovación con rigor." });
    }
    try {
      const analysis = await analyzeRenewalTranscript(transcript);
      if (!analysis) return reply.status(503).send({ ok: false, error: "La IA no pudo analizar la renovación. Reintenta." });
      return { ok: true, analysis };
    } catch (e) {
      return reply.status(503).send({ ok: false, error: "IA no disponible: " + (e as Error).message });
    }
  });
}
