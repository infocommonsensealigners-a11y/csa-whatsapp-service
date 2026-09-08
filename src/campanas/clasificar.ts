/**
 * CLASIFICA con IA lo que ha contestado un doctor a la campaña.
 *
 * ⚠️ POR QUÉ EXISTE. El clasificador del dashboard son expresiones regulares, y
 * el usuario lo dijo con razón el 08-09-2026 viendo las primeras respuestas
 * reales: «contestamos a través de una inteligencia artificial, no puede ser que
 * no sepa diferenciar entre si y siiii». Y era verdad que se liaba: «Siiii»,
 * «Buenas,creo que si» y «Hola Frank, si correcto estoy apuntado» salían todas
 * CONFUSAS, así que a quien decía SÍ se le mandaba la reconducción en vez de la
 * oferta del libro. Nadie avanzaba y no se conseguía ninguna dirección.
 *
 * Las reglas se han arreglado, pero una lista de patrones sigue fallando en la
 * cola larga de cómo escribe la gente. Esto la cubre.
 *
 * ⚠️ LO QUE ESTO **NO** HACE, y es deliberado:
 *
 *  1. **No escribe ni una palabra al doctor.** Solo devuelve una CLASE. Los
 *     textos que salen siguen siendo los fijos del guion. La decisión del
 *     usuario de que «Fransua nunca improvisa con un doctor» sigue intacta: la
 *     IA lee, el guion habla.
 *  2. **No puede decidir una BAJA ni una DIRECCIÓN.** Esas dos las resuelve el
 *     dashboard con reglas ANTES de mirar esta pista, porque no pueden depender
 *     de que un modelo esté disponible ni de acuerdo. Una baja que no se detecta
 *     es una denuncia.
 *  3. **No puede contradecir a las reglas.** El dashboard solo usa esta pista
 *     cuando sus reglas dicen «confuso». Así esto únicamente puede RESCATAR
 *     casos, nunca convertir un «no» detectado en un «sí».
 *  4. Si falla o tarda, devuelve null y el guion sigue con las reglas de
 *     siempre. Nunca bloquea una respuesta.
 */

import { runJson, bulkModel } from "../ai/agent";

export type ClaseIA = "afirmativo" | "negativo" | "confuso";

interface Respuesta {
  clase?: unknown;
  porque?: unknown;
}

/** Tope de texto: una respuesta de WhatsApp no necesita más para clasificarse. */
const MAX = 600;

export async function clasificarConIA(
  texto: string,
  pregunta: string,
): Promise<{ clase: ClaseIA; porque: string } | null> {
  const t = String(texto ?? "").trim().slice(0, MAX);
  if (!t) return null;

  const prompt = `Eres un clasificador. Un comercial ha preguntado esto por WhatsApp a un ortodoncista:

PREGUNTA: "${pregunta}"

El ortodoncista ha contestado:

RESPUESTA: "${t}"

Clasifica la RESPUESTA en una de estas tres clases, desde el punto de vista de si
contesta a la pregunta:

- "afirmativo": confirma, dice que sí, está de acuerdo o lo da por hecho. Cuenta
  aunque venga con un saludo delante, con faltas, con letras repetidas ("siiii"),
  con dudas leves ("creo que sí") o acompañado de una pregunta suya.
- "negativo": dice que no, lo niega o lo rechaza.
- "confuso": ni una cosa ni otra. Por ejemplo solo una pregunta, un "no lo sé",
  un "ahora no puedo", algo que no se entiende, o algo que no responde a lo
  preguntado.

REGLAS:
- Si duda de verdad y no se puede saber, es "confuso". No adivines.
- "No lo sé", "no me acuerdo", "no estoy seguro" son "confuso", NO "negativo".
- Un "sí" acompañado de una pregunta sigue siendo "afirmativo".
- No inventes nada más. No escribas ningún mensaje para el ortodoncista.

Responde SOLO con este JSON:
{"clase":"afirmativo|negativo|confuso","porque":"seis palabras como máximo"}`;

  try {
    const j = await runJson<Respuesta>(prompt, bulkModel);
    const clase = String(j?.clase ?? "");
    if (clase !== "afirmativo" && clase !== "negativo" && clase !== "confuso") return null;
    return { clase, porque: String(j?.porque ?? "").slice(0, 120) };
  } catch {
    // Que falle la IA no puede dejar a un doctor sin respuesta: se sigue con las
    // reglas del dashboard, que es lo que había antes de existir esto.
    return null;
  }
}
