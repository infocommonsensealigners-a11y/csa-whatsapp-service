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
export type ProposalAvisoCampo = "drNombre" | "hero" | "starBlock" | "needs" | "rea" | "fechas" | "general";

export interface ProposalAviso {
  campo: ProposalAvisoCampo;
  indice: number | null;
  mensaje: string;
}

/**
 * ¿Va a hacer la ESTANCIA presencial o se le sustituye por 3 meses más de
 * programa? Regla del usuario (2026-08-03): quien vive fuera —típico en
 * Latinoamérica— no viaja a España, y en vez de que pierda la estancia se
 * prolonga el curso a 13 meses, para que no sienta que el programa vale menos.
 */
export type ProposalModalidad = "estancia" | "extension";

export interface ExtractedProposal {
  modalidad: ProposalModalidad;
  drNombre: string;
  drNombreArt: string;
  heroLead1: string;
  heroLead2: string;
  needs: ProposalNeed[];
  rea: ProposalRea[];
  starBlock: ProposalStarBlock;
  giftDeadlineOverride: string | null;
  /** Beneficios concretos de ESTA edición que se prometieron en la llamada (p. ej.
   *  "el acceso a la plataforma durante agosto va de regalo"). Van como puntos
   *  del bloque "Beneficio adicional", NO dentro de la fecha límite. */
  regaloExtraOverride: string[] | null;
  planDescOverride: string | null;
  fechasOverride: string[] | null;
  confianza: "alta" | "media" | "baja";
  avisos: ProposalAviso[];
}

const SCHEMA_KEYS = [
  "modalidad", "drNombre", "drNombreArt", "heroLead1", "heroLead2", "needs", "rea", "starBlock",
  "giftDeadlineOverride", "regaloExtraOverride", "planDescOverride", "fechasOverride", "confianza", "avisos",
] as const;


/**
 * Los dos programas que se venden en las llamadas. La propuesta de cada uno es
 * DISTINTA (paleta, precios, regalo) y su discurso también: el SBA es multimarca
 * y la Certificación es 100% Invisalign. Aquí solo va lo que cambia el TEXTO que
 * redacta la IA; el resto (precios, enlaces, colores) lo pone el dashboard.
 */
type Programa = "sba" | "certificacion";

const PROGRAMA_BRIEF: Record<Programa, string> = {
  sba: `PROGRAMA: "Sistema de Biomecánica Avanzada" (SBA) — formación de CSA MULTIMARCA.
- El programa NO se casa con ninguna marca de alineador: lo que comparten todas es la biomecánica. Si el doctor/a usa Invisalign, Spark, Smartee, Angel o alineadores propios, todo aplica igual.
- Bloques: Teoría · Biomecánica mixta / Revisión de casos / Talleres de técnicas auxiliares / Estancia clínica.`,
  certificacion: `PROGRAMA: "Certificación en Invisalign" — la certificación oficial de CSA, 100% INVISALIGN.
- Enfoque EXCLUSIVO en Invisalign: NO es multimarca y NO se ofrecen alternativas de marca. Se parte de las bases de los brackets para empezar con los alineadores desde cero y llegar a un nivel muy avanzado de biomecánica; se habla de ClinCheck, ataches y protocolos de Invisalign. Tras el MARPE se CONTINÚA con alineadores Invisalign.
- El Dr. Javier Lozano es SPEAKER de Invisalign: es un argumento de autoridad, úsalo si encaja.
- Incluye CUENTA de Invisalign propia del doctor/a con 40% de descuento los 6 primeros meses (se puede activar más tarde, cuando tenga pacientes).
- Bloques: Teoría · Biomecánica mixta / Revisión de casos / Talleres de técnicas auxiliares / Estancia clínica.
- Es habitual que el lead sea alguien que ACABA la carrera o empieza: si aún no tiene pacientes, los 10 meses de revisión de casos se GUARDAN y se activan cuando entre en clínica (dilo así, es un argumento fuerte).
- NUNCA menciones otras marcas de alineador como opción del programa.`,
};

function buildPrompt(transcript: string, programa: Programa): string {
  return `Eres el redactor de propuestas comerciales de Common Sense Aligners (CSA), formación para dentistas impartida por el Dr. Javier Lozano. Fran es el comercial; acaba de tener una llamada de venta con un/a doctor/a y esta es su transcripción (Plaud). Tu trabajo es redactar el contenido PERSONALIZADO de la propuesta que se le enviará.

${PROGRAMA_BRIEF[programa]}

Escribe con el MISMO tono y estructura que estos dos ejemplos reales (no los copies, son solo referencia de tono y longitud):

EJEMPLO 1 (Dr. Saúco) — hero: "Desde el máster de Manuel Román llevas años tratando solo con Invisalign y hoy apenas un 5–10% de tus casos se te atraviesan. Lo que buscas ahora es otra cosa: [reducir el número de refinamientos, bajar el número de alineadores por caso y tener más pacientes en tratamiento]." NEEDS incluye cosas como {want: «Quiero reducir el número de refinamientos.», tag: "Revisión de casos", fix: "Subes el caso... y el Dr. Lozano revisa contigo el detallado movimiento a movimiento..."}. REA incluye {t: "Las sesiones son martes y jueves a las 9:30:", d: "si no puedes entrar en directo, todas quedan grabadas..."}.

EJEMPLO 2 (Dra. Sete) — mismo patrón, con needs y objeciones distintas según su llamada.

REGLAS (obligatorias):
- "drNombre": SIEMPRE tratamiento + nombre (regla FIJA — nunca el nombre a secas). Formato "Dr. <Nombre>" o "Dra. <Nombre>" (p. ej. "Dr. Juan José Saúco", "Dra. Sete", "Dra. Irene Molinos"). Deduce el género del trato en la llamada (doctora/doctor, "la Dra."), del nombre si no se dice, y usa el nombre COMPLETO (nombre y apellido) si aparece; si solo hay nombre de pila, "Dra./Dr. <NombrePila>", pero NUNCA sin el "Dr./Dra." delante. "drNombreArt": lo mismo con artículo ("el Dr. Juan José Saúco" / "la Dra. Sete"), para el pie de página.
- "heroLead1"/"heroLead2": 2 párrafos (HTML permitido). El 1º resume su situación actual y SU necesidad principal, con el tramo más importante envuelto en <span class="hl">...</span>. El 2º es puente hacia el programa, cerrando con dos puntos.
- "needs": 4 a 6 puntos de dolor REALES de la llamada. "want" = una frase citada ENTRE COMILLAS ANGULARES «» lo más textual posible a como lo dijo el/la doctor/a (no la inventes; si no hay cita textual clara, parafrasea en primera persona). "tag" = etiqueta corta (2-4 palabras) del bloque/tema al que corresponde. "fix" = cómo se resuelve en el programa (con el Dr. Lozano), 1-3 frases.
- "rea": 5 a 7 objeciones o dudas que salieron en la llamada (horario, nivel/experiencia previa, tiene clínica propia o colabora en varias, si aún no tiene pacientes, fechas/vacaciones, dónde es la estancia, etc.), resueltas. "t" = titular en pocas palabras terminado en ":". "d" = resolución en 1-2 frases.
- CONSISTENCIA: cualquier nombre propio que se repita (marca de alineador, técnica, nombre de persona, clínica...) debe escribirse EXACTAMENTE IGUAL cada vez que aparezca, tanto en "heroLead1"/"heroLead2" como en "needs"/"rea" — nunca dos grafías distintas del mismo dato en la misma propuesta. Si la transcripción (voz→texto de Plaud) lo transcribe de forma ambigua o dudosa (marca poco común, nombre extranjero), elige UNA sola grafía y úsala en todos los sitios, y genera un aviso de tipo "general" avisando de que ese nombre puede no estar bien transcrito.
- "modalidad": "estancia" (lo normal) o "extension". Pon "extension" SOLO si en la llamada queda claro que el doctor/a NO va a poder venir a la estancia clínica presencial en España — porque vive fuera (Latinoamérica: México, Colombia, Argentina, Chile, Perú, Ecuador…) o porque dice que no va a viajar. En ese caso el programa NO pierde la estancia sin más: se sustituye por 3 MESES EXTRA de formación (13 meses en total), y así se lo cuentas donde toque (hero y "rea"). Si vive en España o no se habla del tema, "estancia".
- "starBlock": cuál de estos 4 bloques FIJOS del programa es el dolor PRINCIPAL de este doctor/a — responde exactamente uno de: "biomecanica" (Teoría · Biomecánica mixta), "revision" (Revisión de casos — es el valor por DEFECTO salvo que otro bloque sea claramente el dolor principal), "tecnicas" (Talleres de técnicas auxiliares — microtornillos/MARPE/quirúrgicos), "estancia" (Estancia clínica — más casos/marketing/equipo).
- "giftDeadlineOverride": SOLO UNA FECHA, corta y tal como se diría en alto ("1 de septiembre", "viernes 31 de julio"). Se pinta detrás de "Beneficio adicional por inscribirte antes del", asi que una frase ahi deja el titular sin sentido (paso de verdad: salio "…antes del Si te matriculas durante estos dias de agosto…"). Si en la llamada se explica una CONDICION o un beneficio de la edicion, no lo metas aqui: va en "regaloExtraOverride".
- "regaloExtraOverride": array de beneficios concretos que se prometieron en la llamada, redactados como puntos cortos y naturales (p. ej. "Acceso a la plataforma durante agosto de regalo: no resta de los 10 meses de formacion."). null si no se prometio nada aparte de lo habitual.
- "planDescOverride"/"fechasOverride": antes de dejarlos en null, repasa TODA la transcripción buscando cualquier fecha, plazo o mes que el/la doctor/a o Fran mencionen (fecha límite de inscripción, inicio de curso, vacaciones, "para cuándo", pago aplazado, etc.) — si se menciona una fecha/plazo EXPLÍCITO distinto al habitual del programa, captúralo aquí en vez de dejarlo pasar; si hay una fecha mencionada pero no queda claro a qué corresponde exactamente, captúrala igualmente en "fechasOverride" y añade un aviso de campo "fechas" explicando la duda. Solo se queda todo en null si la llamada de verdad no menciona ninguna fecha. Nunca inventes precios ni IBAN.
- "confianza": "alta" si la llamada da material claro para todo lo anterior, "media" si falta algo, "baja" si la transcripción es pobre/corta.
- "avisos": lista de avisos ESTRUCTURADOS — cada uno es un objeto {campo, indice, mensaje} para que quien revise sepa EXACTAMENTE dónde mirar:
  - "campo": uno de "drNombre" (nombre/apellido del doctor/a incompleto o dudoso), "hero" (los 2 párrafos de intro), "starBlock" (el bloque destacado elegido), "needs" (un punto de dolor concreto — usa "indice"), "rea" (una objeción concreta — usa "indice"), "fechas" (fecha límite/pago/fechas clave pendientes de confirmar), o "general" (cualquier otra cosa que no encaje).
  - "indice": posición 0-based del elemento de "needs"/"rea" al que se refiere (null si no aplica o si "campo" no es "needs"/"rea").
  - "mensaje": explicación breve y concreta (p. ej. "No se recogió el apellido, solo el nombre de pila", "Cita parafraseada, no es literal porque no se dijo así exactamente", "Quedó pendiente de confirmar con el Dr. Lozano, no se ha aplicado como fecha").
  Genera UN aviso por cada cosa de la que no estés seguro/a al 100%: dato incompleto, cita no literal, información pendiente de confirmar, ambigüedad en el bloque estrella, etc. Si todo quedó claro, deja el array vacío.
- Si "modalidad" es "extension": NO prometas la estancia presencial en NINGÚN texto (ni hero, ni needs, ni rea) y NO elijas "estancia" como starBlock. Donde toque, di que se sustituye por 3 meses extra de formación —13 meses en total—, con las palabras del doctor/a sobre por qué no puede viajar.
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
  const modalidad: ProposalModalidad = o.modalidad === "extension" ? "extension" : "estancia";
  const starBlocks: ProposalStarBlock[] = ["biomecanica", "revision", "tecnicas", "estancia"];
  const starBlock = starBlocks.includes(o.starBlock as ProposalStarBlock) ? (o.starBlock as ProposalStarBlock) : "revision";
  const regaloExtra = Array.isArray(o.regaloExtraOverride)
    ? o.regaloExtraOverride.map((x) => String(x ?? "").trim()).filter(Boolean).slice(0, 4)
    : [];
  return {
    modalidad,
    regaloExtraOverride: regaloExtra.length ? regaloExtra : null,
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
    avisos: parseAvisos(o.avisos),
  };
}

const AVISO_CAMPOS: ProposalAvisoCampo[] = ["drNombre", "hero", "starBlock", "needs", "rea", "fechas", "general"];

/** Tolera avisos como string suelto (formato antiguo) o como objeto {campo,indice,mensaje}. */
function parseAvisos(raw: unknown): ProposalAviso[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .map((a): ProposalAviso | null => {
      if (typeof a === "string") {
        const mensaje = a.trim();
        return mensaje ? { campo: "general", indice: null, mensaje } : null;
      }
      if (a && typeof a === "object") {
        const o = a as Record<string, unknown>;
        const mensaje = String(o.mensaje ?? "").trim();
        if (!mensaje) return null;
        const campo = AVISO_CAMPOS.includes(o.campo as ProposalAvisoCampo) ? (o.campo as ProposalAvisoCampo) : "general";
        const indice = typeof o.indice === "number" && Number.isInteger(o.indice) && o.indice >= 0 ? o.indice : null;
        return { campo, indice, mensaje };
      }
      return null;
    })
    .filter((a): a is ProposalAviso => a !== null);
}

export interface CleanedTranscript {
  resumenPuntos: string[];
  transcripcionLimpia: string;
}

const CLEAN_SCHEMA_KEYS = ["resumenPuntos", "transcripcionLimpia"] as const;

function buildCleanPrompt(transcript: string): string {
  return `Limpia y organiza esta transcripción (Plaud) de una llamada de Common Sense Aligners (CSA, formación SBA para dentistas) para que Fran la lea cómodamente antes de generar una propuesta. NO resumas ni acortes el contenido real, NO omitas información — conserva TODO lo que se dijo. Solo:
- Corrige errores evidentes de transcripción automática (palabras cortadas, minúsculas donde debería haber mayúscula, tildes que faltan).
- Organiza el texto en párrafos por turno de conversación o por tema (no una sola masa de texto).
- Si se distingue quién habla, márcalo con "Fran:" / el nombre del doctor/a o "Doctor/a:" al inicio del párrafo correspondiente.

Además, extrae de 5 a 10 puntos clave (temas tratados, dudas/objeciones, decisiones o datos importantes) como lista corta para una lectura rápida antes de entrar al texto completo.

TRANSCRIPCIÓN ORIGINAL:
---
${transcript}
---

Responde ÚNICAMENTE con un objeto JSON con EXACTAMENTE estas claves: ${CLEAN_SCHEMA_KEYS.join(", ")}. "resumenPuntos" es un array de strings cortos. "transcripcionLimpia" es el texto completo limpio y organizado (puede ser largo, sin límite artificial).`;
}

function validateCleaned(obj: unknown): CleanedTranscript | null {
  if (!obj || typeof obj !== "object") return null;
  const o = obj as Record<string, unknown>;
  if (typeof o.transcripcionLimpia !== "string" || !o.transcripcionLimpia.trim()) return null;
  return {
    resumenPuntos: Array.isArray(o.resumenPuntos) ? (o.resumenPuntos as unknown[]).map((p) => String(p).trim()).filter(Boolean) : [],
    transcripcionLimpia: o.transcripcionLimpia.trim(),
  };
}

export function registerProposalRoutes(app: FastifyInstance): void {
  // POST /proposals/extract { transcript } → borrador de contenido para la propuesta SBA.
  app.post("/proposals/extract", async (req, reply) => {
    const body = (req.body ?? {}) as { transcript?: unknown; programa?: unknown };
    const transcript = typeof body.transcript === "string" ? body.transcript.trim() : "";
    // Qué propuesta se está redactando; lo decide el dashboard por la carpeta de
    // la llamada. Por defecto SBA (es el que existía antes de la Certificación).
    const programa: Programa = body.programa === "certificacion" ? "certificacion" : "sba";
    if (!transcript) return reply.status(400).send({ ok: false, error: 'Falta "transcript".' });
    if (transcript.length < 200) {
      return reply.status(422).send({ ok: false, error: "La transcripción es demasiado corta para extraer una propuesta fiable." });
    }
    const clipped = transcript.length > MAX_TRANSCRIPT_CHARS ? transcript.slice(0, MAX_TRANSCRIPT_CHARS) : transcript;

    try {
      const raw = await runJson<Record<string, unknown>>(buildPrompt(clipped, programa), suggestModel);
      const proposal = raw ? validate(raw) : null;
      if (!proposal) return reply.status(503).send({ ok: false, error: "La IA no pudo extraer un borrador válido. Reintenta." });
      return { ok: true, proposal };
    } catch (e) {
      return reply.status(503).send({ ok: false, error: "IA no disponible: " + (e as Error).message });
    }
  });

  // POST /proposals/clean-transcript { transcript } → versión limpia/organizada + puntos clave,
  // para la vista de lectura de Conectores (no toca el contenido, solo legibilidad).
  app.post("/proposals/clean-transcript", async (req, reply) => {
    const body = (req.body ?? {}) as { transcript?: unknown };
    const transcript = typeof body.transcript === "string" ? body.transcript.trim() : "";
    if (!transcript) return reply.status(400).send({ ok: false, error: 'Falta "transcript".' });
    const clipped = transcript.length > MAX_TRANSCRIPT_CHARS ? transcript.slice(0, MAX_TRANSCRIPT_CHARS) : transcript;

    try {
      const raw = await runJson<Record<string, unknown>>(buildCleanPrompt(clipped), suggestModel);
      const cleaned = raw ? validateCleaned(raw) : null;
      if (!cleaned) return reply.status(503).send({ ok: false, error: "La IA no pudo limpiar la transcripción. Reintenta." });
      return { ok: true, cleaned };
    } catch (e) {
      return reply.status(503).send({ ok: false, error: "IA no disponible: " + (e as Error).message });
    }
  });
}
