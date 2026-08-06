/**
 * ¿SE LE ENVIÓ "EL PROGRAMA"? — detección sobre los documentos de WhatsApp.
 *
 * El programa es el dossier del producto que se manda AL INICIAR el contacto
 * (antes de la llamada de venta). Es distinto de la PROPUESTA personalizada, que
 * se manda DESPUÉS de la llamada y lleva el nombre del doctor.
 *
 * Se decide por el nombre/caption del documento (`messages.text`), que se guarda
 * desde el primer día — no hace falta el binario descargado, así que funciona
 * sobre TODO el histórico.
 *
 * ⚠️ DISEÑADO SOBRE LOS DATOS REALES, no sobre suposiciones: los 448 nombres
 * distintos de documento enviados en el histórico (1.905 envíos). Un `LIKE
 * '%SBA%'` ingenuo daría 599 aciertos de los que ~50 son PROPUESTAS
 * personalizadas ("Propuesta SBA Montse Sánchez.pdf"), y también colarían
 * facturas ("Fra. Irene García SBA.pdf"), diplomas ("Diploma SBA … Vertical"),
 * transcripciones de llamada ("DIEGO_MEDINA_SBA-transcript") y material de la
 * COMPETENCIA ("Método SAS", "Programa Angel Aligner"). De ahí que las
 * exclusiones se evalúen ANTES que las inclusiones.
 */

export type ProgramaKey = "sba" | "certificacion" | "estancia";

export type ProgramasEnviados = Record<ProgramaKey, boolean>;

/** Quita acentos y pasa a mayúsculas: los nombres reales mezclan "CERTIFICACIÓN"/"Certificación". */
function norm(s: string): string {
  return s
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toUpperCase()
    .replace(/[_\-.]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * NO es el programa, aunque mencione el producto. Se comprueba primero y manda
 * sobre cualquier inclusión. Cada entrada sale de un caso real del histórico.
 */
const EXCLUSIONES: Array<{ re: RegExp; motivo: string }> = [
  // La propuesta personalizada es justo lo que el usuario quiere distinguir.
  { re: /\bPROPUESTA\b/, motivo: "propuesta personalizada" },
  { re: /\bRESERVA\b/, motivo: "reserva de plaza" },
  // Administrativo / post-venta.
  { re: /\bFRA\b/, motivo: "factura" }, // "Fra. Irene García SBA.pdf"
  { re: /\bFACTURA\b/, motivo: "factura" },
  { re: /\bDIPLOMA\b/, motivo: "diploma de fin de curso" },
  { re: /\bCERTIFICADO\b/, motivo: "certificado emitido (no el programa)" },
  { re: /\bCONTRATO\b|\bCOMPROMISO\b|\bGARANTIA\b/, motivo: "documento contractual" },
  { re: /\bCESION DE DATOS\b/, motivo: "documento legal" },
  { re: /\bMANUAL\b|\bGUIA DEL DOCTOR\b/, motivo: "material del alumno ya matriculado" },
  // Transcripciones de llamada (se comparten por WhatsApp y llevan el producto en el nombre).
  { re: /TRANSCRIPT/, motivo: "transcripción de llamada" },
  // COMPETENCIA: nada de esto es un programa de CSA.
  { re: /\bSAS\b/, motivo: "material de la competencia (SAS)" },
  { re: /ANGEL ALIGNER/, motivo: "material de la competencia (Angel Aligner)" },
  { re: /SELF PACED/, motivo: "curso oficial de Align, no de CSA" },
];

/**
 * Patrones de cada programa. Deliberadamente ANCLADOS al nombre del producto:
 * un "Programa avanzado-4.pdf" o un "Programa de éxito Invisalign" no dicen de
 * qué producto son, así que NO cuentan (mejor no marcar que marcar de más).
 */
const PATRONES: Array<{ key: ProgramaKey; re: RegExp }> = [
  // "SBA" a secas es el envío más frecuente del histórico (342 veces), y también
  // "SBA PROGRAMA", "CONTENIDO PROGRAMA SBA", "SBA Programa.pdf.pdf"…
  { key: "sba", re: /\bSBA\b/ },
  // "CERTIFICACION INVISALIGN", "CONTENIDO CERTIFICACION INVISALIGN",
  // "CONTENIDO TEORICO CERTIFICACION DE INVISALIGN" y el frecuentísimo
  // "Certificación.pdf" (168 envíos), que en este negocio solo puede ser esa.
  { key: "certificacion", re: /\bCERTIFICACION\b/ },
  // "ESTANCIA CLINICA" con todas sus variantes (-2, Dossier, PROGRAMA, plural).
  { key: "estancia", re: /\bESTANCIAS?\b/ },
];

export function vacio(): ProgramasEnviados {
  return { sba: false, certificacion: false, estancia: false };
}

/**
 * Clasifica UN nombre de documento. Devuelve el programa detectado, o null si no
 * lo es (con el motivo, útil para depurar y para el script de validación).
 */
export function clasificarDocumento(texto: string | null | undefined): { key: ProgramaKey } | { key: null; motivo: string } {
  const t = norm(String(texto ?? ""));
  if (!t) return { key: null, motivo: "sin nombre" };
  for (const ex of EXCLUSIONES) {
    if (ex.re.test(t)) return { key: null, motivo: ex.motivo };
  }
  for (const p of PATRONES) {
    if (p.re.test(t)) return { key: p.key };
  }
  return { key: null, motivo: "no es un programa reconocible" };
}

/** Agrega los documentos de un chat en el mapa de programas enviados. */
export function programasDeDocumentos(textos: Array<string | null>): ProgramasEnviados {
  const out = vacio();
  for (const t of textos) {
    const r = clasificarDocumento(t);
    if (r.key) out[r.key] = true;
  }
  return out;
}

export function algunoEnviado(p: ProgramasEnviados): boolean {
  return p.sba || p.certificacion || p.estancia;
}
