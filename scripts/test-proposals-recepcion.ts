/**
 * Extracción del borrador de la PROPUESTA RECEPCIÓN: el prompt y, sobre todo, el
 * saneo de lo que devuelve el modelo antes de que llegue al dashboard.
 *
 *   npx tsx scripts/test-proposals-recepcion.ts
 */
import { buildPromptRecepcion, validateRecepcion } from "../src/http/routes/proposalsRecepcion";

let fallos = 0;
let pasadas = 0;
function ok(cond: unknown, msg: string): void {
  if (cond) pasadas++;
  else {
    fallos++;
    console.error(`  ✗ ${msg}`);
  }
}

const prompt = buildPromptRecepcion("Hola, soy Ana, la recepcionista de Dental Mayo.");
ok(prompt.includes("Hola, soy Ana, la recepcionista de Dental Mayo."), "el prompt lleva la transcripción");
ok(/Nunca escribas precios/.test(prompt), "el prompt prohíbe los precios (van fijos en la plantilla)");
ok(!/1\.090|1\.650/.test(prompt), "y no los menciona él mismo");
ok(/clinica, ciudadEspecialidad, destinatario, origen, pares, focos/.test(prompt), "pide las claves de las zonas variables");

ok(validateRecepcion(null) === null && validateRecepcion({}) === null, "sin clínica no hay borrador");

const v = validateRecepcion({
  clinica: "  Dental Mayo ",
  ciudadEspecialidad: "Córdoba · Odontología general",
  destinatario: "[Nombre y cargo]",
  origen: "En vuestra estancia clínica visteis <b>por encima</b> cómo trabaja nuestra recepción.",
  pares: [
    { hoy: "Clinic Cloud sin configurar", despues: "Clinic Cloud con segmentos" },
    { hoy: "Sin reagenda", despues: "" },
    "basura",
    ...new Array(8).fill({ hoy: "a", despues: "b" }),
  ],
  focos: [
    { bloque: 2, titulo: "Clinic Cloud a fondo", texto: "Segmentar contactos." },
    { bloque: 42, titulo: "Presupuestos", texto: "Donde más se escapa." },
    { bloque: 6, titulo: "", texto: "sin título" },
    { bloque: 6, titulo: "Recordatorios", texto: "A 48 y 24 h." },
    { bloque: 1, titulo: "Sobra", texto: "La cuarta no entra." },
  ],
  canales: "Teléfono, WhatsApp y Doctoralia",
  software: "Clinic Cloud",
  nivel: "premium",
  recomendacion: "Por qué Comercial 360º: aún no tenéis nada montado en Clinic Cloud.",
  fechaJornada: "",
  seguimiento: "al mes y a los dos meses",
  confianza: "muy alta",
  avisos: ["Plaud escribe «Clíniquer»: comprobar el software.", { mensaje: "El nombre del director no queda claro." }, 7],
});
ok(!!v, "un borrador razonable se acepta");
if (v) {
  ok(v.drNombre === "Dental Mayo" && v.drNombreArt === "Dental Mayo", "la clínica llega como drNombre, sin espacios");
  ok(v.recepcion.destinatario === "", "un marcador entre corchetes no es un dato: se vacía");
  ok(!/[<>]/.test(v.recepcion.origen), "se quita el HTML");
  ok(v.recepcion.pares.length === 5, "como mucho 5 filas");
  ok(v.recepcion.pares.every((p) => p.hoy && p.despues), "y ninguna a medias");
  ok(v.recepcion.focos.length === 3, "como mucho 3 focos, y los incompletos fuera");
  ok(v.recepcion.focos[1].bloque === 3, "un bloque fuera de 1–6 cae en el 3");
  ok(v.recepcion.nivel === "comercial360", "un nivel desconocido cae en Comercial 360º");
  ok(v.recepcion.recomendacion.startsWith("aún no tenéis"), "se quita el «Por qué …:» que ya pone la plantilla");
  ok(v.confianza === "media", "una confianza desconocida cae en media");
  ok(v.avisos.length === 2 && v.avisos.every((a) => a.campo === "general"), "los avisos llegan como texto, en «general»");
}

console.log(`\n${fallos === 0 ? "✓" : "✗"} extracción de recepción: ${pasadas} pasadas, ${fallos} fallos`);
process.exit(fallos === 0 ? 0 : 1);
