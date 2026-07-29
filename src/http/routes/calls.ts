/**
 * ANÁLISIS DE LLAMADAS — 2ª pata de la sección "Análisis de llamadas" (ex
 * Conectores). Mientras `/proposals/extract` saca la PROPUESTA (marketing), esto
 * EVALÚA la llamada de venta: cómo lo hizo el comercial y por qué convierte o no.
 *
 * Diseño: DOCS/ANALISIS-LLAMADAS-DISENO.md. Anclado al Playbook real de CSA
 * (CEREBRO-ESTRATEGICO-FRANSUA.md): argumentos de peso (mentoría Dr. Lozano,
 * sesiones en directo, estancia clínica, biomecánica), objeciones típicas
 * (precio, sistema propio, tiempo) y sus técnicas (financiación 325€×12, etc.),
 * y señales de compra reales. NO es coaching genérico.
 *
 * Claude vía la SUSCRIPCIÓN (ai/agent runJson), sin API key nueva, sin Supabase.
 * El cruce con el RESULTADO del lead (¿convirtió?) lo hace el dashboard con la
 * identidad-teléfono; aquí solo se analiza el texto.
 */
import type { FastifyInstance } from "fastify";
import { runJson, suggestModel } from "../../ai/agent";

const MAX_TRANSCRIPT_CHARS = 100_000;

export interface CallScores {
  cualificacion: number; // 0-100
  argumentacion: number;
  objeciones: number;
  cierre: number;
  rapport: number;
}
export interface CallObjecion {
  objecion: string;
  resuelta: boolean;
  tecnica: string | null; // cómo la resolvió (o intentó), si aplica
  cita: string | null;
}
export interface CallPunto {
  texto: string;
  cita: string | null; // evidencia textual de la transcripción
}
export type CallSentiment = "entusiasmo" | "interes" | "escepticismo" | "rechazo" | "neutro";

export interface CallAnalysis {
  resumen: string;
  producto: string | null;
  diarizado: boolean; // ¿la transcripción distingue quién habla?
  talkRatioComercial: number | null; // % del tiempo/turnos que habla el comercial (null si no diarizado)
  cualifico: boolean | null;
  dolorPrincipal: string | null;
  argumentosUsados: string[]; // del Playbook: mentoría Lozano, sesiones directo, estancia, biomecánica, prueba social…
  senalesCompra: string[];
  objeciones: CallObjecion[];
  objecionPrincipalAbierta: string | null; // la que más pesa sin resolver → alimenta leadOutcome.objecionPrincipal
  pidioCierre: boolean | null;
  proximoPaso: string | null; // compromiso concreto obtenido, o null
  sentimentLead: CallSentiment;
  scores: CallScores;
  scoreGlobal: number; // 0-100
  fortalezas: CallPunto[];
  debilidades: CallPunto[];
  recomendaciones: string[]; // 1-3 acciones para la próxima llamada
  confianza: "alta" | "media" | "baja";
}

const SCHEMA_KEYS = [
  "resumen", "producto", "diarizado", "talkRatioComercial", "cualifico", "dolorPrincipal",
  "argumentosUsados", "senalesCompra", "objeciones", "objecionPrincipalAbierta", "pidioCierre",
  "proximoPaso", "sentimentLead", "scores", "scoreGlobal", "fortalezas", "debilidades",
  "recomendaciones", "confianza",
] as const;

/** Ejemplos de calibración que manda el dashboard (lo que Fran etiquetó como score mal puesto). */
interface CalibracionHint {
  cerro?: boolean;
  score?: number;
  veredictoHumano?: "mejor" | "peor";
  debilidades?: string[];
  hint?: string;
  nota?: string | null;
}

/**
 * Bloque de RECALIBRACIÓN: casos pasados donde el comercial (Fran) dijo que el
 * score no encajaba con la realidad. Se inyecta en el prompt para que Fransua
 * ajuste su rubric (aprende de sus propios errores de puntuación).
 */
function buildCalibracionBlock(cals: CalibracionHint[]): string {
  const clean = cals.filter((c) => typeof c.hint === "string" && c.hint.trim()).slice(0, 8);
  if (clean.length === 0) return "";
  const lines = clean.map((c, i) => {
    const cerro = c.cerro === true ? "CERRÓ (compró)" : c.cerro === false ? "NO cerró" : "resultado desconocido";
    const score = Number.isFinite(Number(c.score)) ? `tú la puntuaste ${Math.round(Number(c.score))}` : "";
    const deb = Array.isArray(c.debilidades) && c.debilidades.length ? ` Debilidades que marcaste: ${c.debilidades.slice(0, 3).map((d) => `«${d}»`).join("; ")}.` : "";
    const nota = c.nota ? ` Nota de Fran: «${String(c.nota).slice(0, 300)}».` : "";
    return `${i + 1}. Una llamada que ${cerro}${score ? `, ${score}` : ""}. El comercial dice que en realidad fue ${c.veredictoHumano === "peor" ? "PEOR" : "MEJOR"} de lo que refleja ese score.${deb} Ajuste: ${String(c.hint).trim()}${nota}`;
  });
  return `\n\nRECALIBRACIÓN (aprende de tus errores de puntuación anteriores — el comercial ya te corrigió en estos casos; aplica el criterio, NO los copies):\n${lines.join("\n")}\n`;
}

/** Programa de la llamada (auditoría 2026-07-28): antes el prompt SIEMPRE
 *  hablaba de SBA y sus precios → en llamadas de la Certificación Invisalign el
 *  análisis evaluaba con la oferta equivocada (2.900€/241,66€/mes, SIN pronto
 *  pago) y el sesgo entraba además en la recalibración. Mismos datos que
 *  dashboard/lib/domain/conectoresProgramas.ts. */
type ProgramaKey = "sba" | "cert";
const PROGRAMA_BRIEF: Record<ProgramaKey, { nombre: string; oferta: string }> = {
  sba: {
    nombre: "SBA (Sistema de Biomecánica Avanzada)",
    oferta: "PRECIO (financiación 325€×12, 5.900→3.900, 10% dto. por pago único, ROI), estancia clínica incluida",
  },
  cert: {
    nombre: "Certificación en Ortodoncia Plástica (para doctores que ya usan Invisalign/Spark)",
    oferta: "PRECIO (financiación 241,66€×12, total 2.900€ — SIN descuento por pago único, ROI)",
  },
};
function normPrograma(v: unknown): ProgramaKey | null {
  const s = String(v ?? "").toLowerCase();
  if (/cert|invisalign|plastic/.test(s)) return "cert";
  if (/sba|biomec/.test(s)) return "sba";
  return null;
}

function buildPrompt(transcript: string, cals: CalibracionHint[] = [], programa: ProgramaKey | null = null): string {
  const prog = programa ? PROGRAMA_BRIEF[programa] : null;
  const contextoPrograma = prog
    ? `Esta llamada es del programa ${prog.nombre} — evalúa contra ESA oferta, no contra otro programa.`
    : `CSA vende DOS programas: ${PROGRAMA_BRIEF.sba.nombre} y ${PROGRAMA_BRIEF.cert.nombre}. Deduce cuál se está vendiendo y evalúa contra la oferta de ESE programa (no los mezcles).`;
  const objecionPrecio = prog ? prog.oferta : `según el programa — SBA: ${PROGRAMA_BRIEF.sba.oferta}; Certificación: ${PROGRAMA_BRIEF.cert.oferta}`;
  return `Eres analista comercial senior de Common Sense Aligners (CSA), que forma a dentistas con los programas del Dr. Javier Lozano. Fran es el comercial. ${contextoPrograma} Analiza esta transcripción de una LLAMADA DE VENTA (Plaud) y evalúa CÓMO condujo Fran la llamada: qué hizo bien, qué falló y por qué esa llamada acabaría (o no) convirtiendo. NO redactes propuesta; ESTO ES EVALUACIÓN.${buildCalibracionBlock(cals)}

Ánclate en el PLAYBOOK REAL de CSA (no coaching genérico):
- Argumentos de peso: la mentoría/revisión de casos con el Dr. Lozano, las SESIONES EN DIRECTO (martes/jueves), la estancia clínica, la biomecánica avanzada (curva de Spee, refinamientos, previsibilidad), casos reales, prueba social (testimonios de compañeros).
- Buena cualificación: ¿es dentista?, ¿qué sistema/marca usa (Invisalign/Spark…)?, ¿volumen de casos?, ¿es decisor?, ¿su dolor concreto? (descalifica limpio a protésicos/higienistas o sistemas incompatibles).
- Objeciones típicas y sus técnicas: ${objecionPrecio}; "me lo pienso", falta de tiempo/agenda, "ya hago Invisalign", sistema propio, desconfianza del método.
- Cierre bueno: pedir el cierre (ASK), ofrecer cita POR ELECCIÓN (2 franjas, no "¿cuándo te viene?"), dejar un próximo paso con FECHA concreta.
- Señales de compra: pregunta por pago/fechas, preguntas operativas, proyecta usarlo con un caso concreto, pide detalles del acceso.

REGLAS de salida:
- "resumen": 1-2 frases de qué pasó en la llamada y cómo quedó.
- "producto": SBA / Certificación / Estancia si se deduce, si no null.
- "diarizado": true SOLO si la transcripción distingue quién habla (hay marcas de interlocutor). Si es una masa de texto sin distinguir, false.
- "talkRatioComercial": si "diarizado" es true, % aproximado (0-100) del tiempo que habla FRAN (el comercial); si false, null. Ojo: en venta consultiva, hablar demasiado (>60%) suele ser señal débil.
- "cualifico": true/false/null — ¿cualificó de verdad al doctor/a (sistema, volumen, decisor, dolor)?
- "dolorPrincipal": el dolor/necesidad central detectado, o null.
- "argumentosUsados": array de los argumentos del Playbook que Fran usó (usa términos como "mentoría Dr. Lozano", "sesiones en directo", "estancia clínica", "biomecánica", "prueba social").
- "senalesCompra": array de señales de compra observadas (vacío si ninguna).
- "objeciones": array de {objecion, resuelta (bool), tecnica (cómo la manejó o null), cita (textual «…» o null)} con TODAS las objeciones/dudas que surgieron.
- "objecionPrincipalAbierta": la objeción sin resolver que más pesa para el no-cierre, o null si no quedó ninguna.
- "pidioCierre": true/false/null — ¿pidió explícitamente el siguiente paso/cierre?
- "proximoPaso": el compromiso concreto que quedó (con fecha si la hay), o null si la llamada quedó en el aire.
- "sentimentLead": uno de "entusiasmo", "interes", "escepticismo", "rechazo", "neutro".
- "scores": objeto {cualificacion, argumentacion, objeciones, cierre, rapport}, cada uno 0-100. NO puntúes "a ojo": usa el BAREMO de abajo y elige el tramo cuya conducta describa lo que pasó de verdad.
- "scoreGlobal": 0-100, valoración global. Debe quedar cerca de la media de las cinco dimensiones (±10): si te sale muy lejos, revisa las dimensiones.

BAREMO por conducta (elige el tramo que describa lo que pasó; interpola entre tramos). Es EL MISMO con el que Fran se autoevalúa en el dashboard y las dos notas se comparan lado a lado: cíñete a los tramos, no puntúes a ojo.
- CUALIFICACIÓN · 0 no preguntó, fue a contar el programa | 25 solo lo básico (qué sistema usa) | 50 sabe su situación y algún problema, no lo que le CUESTA | 75 situación + 2-3 problemas y su coste (casos que deriva, tiempo, dinero) | 100 + confirmó que DECIDE y le hizo verbalizar el coste de seguir igual.
- ARGUMENTACIÓN · 0 recitó el programa entero | 25 ventajas generales | 50 enlazó un par con su situación | 75 cada bloque respondía a un problema que él/ella contó | 100 + caso/testimonio parecido y le hizo proyectarse en un paciente suyo.
- OBJECIONES · 0 ninguna salió o las cortó | 25 las rebatió rápido para avanzar | 50 escuchó y contestó, sin comprobar si quedó conforme | 75 entendió la de fondo, la resolvió con datos/casos y VERIFICÓ el cierre | 100 + destapó la que no decía.
- CIERRE = AVANCE (no técnicas de presión, que en esta venta restan) · 0 nada ("te lo piensas") | 25 él volverá a llamar, sin fecha | 50 paso difuso ("esta semana") | 75 pidió el paso con DÍA Y HORA | 100 + cita por elección (2 franjas) y decisión encaminada.
- RAPPORT = ESCUCHA · 0 habló Fran casi todo | 25 ~dos tercios | 50 mitad y mitad | 75 habló más el doctor/a, le dejó terminar y recogió lo dicho | 100 + se abrió sin que le preguntaran. Referencia real: quien convierte habla ~46% del tiempo y por encima del 65% la conversión cae; si "talkRatioComercial" es null, puntúa por señales de escucha sin castigar la falta de dato.
- "fortalezas"/"debilidades": arrays de {texto (qué hizo bien / qué falló, 1 frase), cita (evidencia textual «…» o null)}. 2 a 4 de cada, las más relevantes.
- "recomendaciones": 1 a 3 acciones concretas para que Fran mejore la PRÓXIMA llamada de este tipo.
- "confianza": "alta" si la transcripción da material claro; "media" si falta contexto; "baja" si es pobre/corta o no se distingue bien la conversación.
- Español de España. NO inventes: si algo no está en la transcripción, dilo en la dimensión correspondiente (score bajo / campo null), no lo rellenes a ojo.

TRANSCRIPCIÓN (Plaud):
---
${transcript}
---

Responde ÚNICAMENTE con un objeto JSON con EXACTAMENTE estas claves: ${SCHEMA_KEYS.join(", ")}.`;
}

const SENTIMENTS: CallSentiment[] = ["entusiasmo", "interes", "escepticismo", "rechazo", "neutro"];
const clamp100 = (v: unknown): number => {
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? Math.max(0, Math.min(100, Math.round(n))) : 0;
};
const strOrNull = (v: unknown): string | null => {
  const s = typeof v === "string" ? v.trim() : "";
  return s ? s.slice(0, 500) : null;
};
const strArr = (v: unknown): string[] =>
  Array.isArray(v) ? v.map((x) => String(x ?? "").trim()).filter(Boolean).slice(0, 12) : [];
const boolOrNull = (v: unknown): boolean | null => (typeof v === "boolean" ? v : null);

function parsePuntos(raw: unknown): CallPunto[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .map((p): CallPunto | null => {
      if (typeof p === "string") return p.trim() ? { texto: p.trim().slice(0, 400), cita: null } : null;
      if (p && typeof p === "object") {
        const o = p as Record<string, unknown>;
        const texto = String(o.texto ?? "").trim();
        return texto ? { texto: texto.slice(0, 400), cita: strOrNull(o.cita) } : null;
      }
      return null;
    })
    .filter((p): p is CallPunto => p !== null)
    .slice(0, 5);
}

function parseObjeciones(raw: unknown): CallObjecion[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .map((r): CallObjecion | null => {
      if (!r || typeof r !== "object") return null;
      const o = r as Record<string, unknown>;
      const objecion = String(o.objecion ?? "").trim();
      if (!objecion) return null;
      return {
        objecion: objecion.slice(0, 300),
        resuelta: o.resuelta === true,
        tecnica: strOrNull(o.tecnica),
        cita: strOrNull(o.cita),
      };
    })
    .filter((r): r is CallObjecion => r !== null)
    .slice(0, 12);
}

function validate(obj: unknown): CallAnalysis | null {
  if (!obj || typeof obj !== "object") return null;
  const o = obj as Record<string, unknown>;
  if (typeof o.resumen !== "string" || !o.resumen.trim()) return null;
  const s = (o.scores && typeof o.scores === "object" ? o.scores : {}) as Record<string, unknown>;
  const diarizado = o.diarizado === true;
  return {
    resumen: o.resumen.trim().slice(0, 800),
    producto: strOrNull(o.producto),
    diarizado,
    talkRatioComercial: diarizado && Number.isFinite(Number(o.talkRatioComercial)) ? clamp100(o.talkRatioComercial) : null,
    cualifico: boolOrNull(o.cualifico),
    dolorPrincipal: strOrNull(o.dolorPrincipal),
    argumentosUsados: strArr(o.argumentosUsados),
    senalesCompra: strArr(o.senalesCompra),
    objeciones: parseObjeciones(o.objeciones),
    objecionPrincipalAbierta: strOrNull(o.objecionPrincipalAbierta),
    pidioCierre: boolOrNull(o.pidioCierre),
    proximoPaso: strOrNull(o.proximoPaso),
    sentimentLead: SENTIMENTS.includes(o.sentimentLead as CallSentiment) ? (o.sentimentLead as CallSentiment) : "neutro",
    scores: {
      cualificacion: clamp100(s.cualificacion),
      argumentacion: clamp100(s.argumentacion),
      objeciones: clamp100(s.objeciones),
      cierre: clamp100(s.cierre),
      rapport: clamp100(s.rapport),
    },
    scoreGlobal: clamp100(o.scoreGlobal),
    fortalezas: parsePuntos(o.fortalezas),
    debilidades: parsePuntos(o.debilidades),
    recomendaciones: strArr(o.recomendaciones).slice(0, 3),
    confianza: o.confianza === "alta" || o.confianza === "media" || o.confianza === "baja" ? o.confianza : "media",
  };
}

/**
 * Evalúa una transcripción con el baremo y devuelve el análisis validado (o null
 * si la IA no dio un JSON usable).
 *
 * Está fuera de la ruta a propósito: así se puede probar el BAREMO contra una
 * transcripción real sin levantar el servidor ni pasar por HTTP
 * (`npx tsx --env-file=.env scripts/diag-rubric.ts <fichero.txt>`), que es como
 * se comprobó el efecto del cambio de rubric antes de desplegarlo.
 */
export async function analyzeCallTranscript(
  transcript: string,
  programa: ProgramaKey | null = null,
  calibraciones: CalibracionHint[] = [],
): Promise<CallAnalysis | null> {
  const clipped = transcript.length > MAX_TRANSCRIPT_CHARS ? transcript.slice(0, MAX_TRANSCRIPT_CHARS) : transcript;
  const raw = await runJson<Record<string, unknown>>(buildPrompt(clipped, calibraciones, programa), suggestModel);
  return raw ? validate(raw) : null;
}

export function registerCallRoutes(app: FastifyInstance): void {
  // POST /calls/analyze { transcript } → evaluación de rendimiento de la llamada.
  app.post("/calls/analyze", async (req, reply) => {
    const body = (req.body ?? {}) as { transcript?: unknown; calibraciones?: unknown; programa?: unknown };
    const transcript = typeof body.transcript === "string" ? body.transcript.trim() : "";
    if (!transcript) return reply.status(400).send({ ok: false, error: 'Falta "transcript".' });
    if (transcript.length < 200) {
      return reply.status(422).send({ ok: false, error: "La transcripción es demasiado corta para analizar la llamada con rigor." });
    }
    const calibraciones: CalibracionHint[] = Array.isArray(body.calibraciones) ? (body.calibraciones as CalibracionHint[]) : [];
    try {
      const analysis = await analyzeCallTranscript(transcript, normPrograma(body.programa), calibraciones);
      if (!analysis) return reply.status(503).send({ ok: false, error: "La IA no pudo analizar la llamada. Reintenta." });
      return { ok: true, analysis };
    } catch (e) {
      return reply.status(503).send({ ok: false, error: "IA no disponible: " + (e as Error).message });
    }
  });
}
