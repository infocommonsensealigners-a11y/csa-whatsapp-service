/**
 * Extracción del borrador de la propuesta de la INMERSIÓN CLÍNICA MARPE: el
 * prompt y, sobre todo, el saneo de lo que devuelve el modelo antes de que
 * llegue al dashboard.
 *
 *   npx tsx scripts/test-proposals-inmersion-marpe.ts
 */
import { buildPromptInmersionMarpe, validateInmersionMarpe } from "../src/http/routes/proposalsInmersionMarpe";

let fallos = 0;
let pasadas = 0;
function ok(cond: unknown, msg: string): void {
  if (cond) pasadas++;
  else {
    fallos++;
    console.error(`  ✗ ${msg}`);
  }
}

const prompt = buildPromptInmersionMarpe("Fran: Hola Lucía, te cuento la Inmersión Clínica MARPE.");
ok(prompt.includes("Fran: Hola Lucía, te cuento la Inmersión Clínica MARPE."), "el prompt lleva la transcripción");
ok(/Nunca escribas precios/.test(prompt), "el prompt prohíbe precios, fechas de edición y plazas (los pone el dashboard)");
ok(!/2\.000|3\.000|222,22|400 ?€/.test(prompt), "y no los menciona él mismo");
ok(/EXACTAMENTE 3 objetos/.test(prompt) && /LITERAL/.test(prompt), "pide tres necesidades con frase literal");
ok(/NO es el Sistema de Biomecánica Avanzada/.test(prompt), "deja claro que no es el SBA");
ok(/doctor, lead, necesidades, dudas, confianza, avisos/.test(prompt), "pide las claves de la plantilla");

ok(validateInmersionMarpe(null) === null && validateInmersionMarpe({}) === null, "sin doctor no hay borrador");

const v = validateInmersionMarpe({
  doctor: "  Dra. Lucía Ferrer ",
  lead: 'Llevas doce años en Valencia y <b>derivas</b> los adultos. Por eso quieres <span class="hl">colocarlo tú, con alguien al lado.',
  necesidades: [
    { dice: '"Me da miedo elegir mal el caso"', tag: "Elegir el caso", fix: "El primer día ves con Javier y Enrique quién sí y quién no." },
    { dice: "[Frase literal del doctor en la llamada.]", tag: "Seguridad en gabinete", fix: "El segundo día colocas tú el MARPE." },
    { dice: "«Nunca he puesto uno»", tag: "", fix: "sin tema" },
    { dice: "«Y si se suelta un minitornillo»", tag: "Las complicaciones", fix: "Ves qué hacer cuando un minitornillo se suelta." },
    { dice: "«cuarta»", tag: "Otra", fix: "Sobra." },
  ],
  dudas: [
    { t: "¿El hotel va incluido?", d: "No: te lo confirma Fran." },
    { t: "¿Sin respuesta?:", d: "" },
  ],
  confianza: "rarísima",
  avisos: ["Plaud escribe «Ferré»", { campo: "needs", indice: 1, mensaje: "Sin frase literal" }, { campo: "inventado", mensaje: "va a general" }],
});
ok(!!v, "con doctor sí hay borrador");
if (v) {
  ok(v.drNombre === "Dra. Lucía Ferrer" && v.drNombreArt === v.drNombre, "el doctor, recortado (y su «art» igual)");
  ok(v.marpe.lead.includes('<span class="hl">colocarlo tú, con alguien al lado.</span>'), "el lead conserva el subrayado y lo cierra si venía abierto");
  ok(!/<b>|<\/b>/.test(v.marpe.lead), "y quita cualquier otro HTML");
  ok(v.marpe.necesidades.length === 3, "como mucho tres necesidades, y solo completas (con tema y cómo)");
  ok(v.marpe.necesidades[0].dice === "«Me da miedo elegir mal el caso»", "las comillas rectas pasan a «»");
  ok(v.marpe.necesidades[1].dice === "", "un marcador entre corchetes no se imprime: queda vacío");
  ok(v.marpe.necesidades.every((n) => n.tag && n.fix), "ninguna tarjeta sin tema o sin «cómo lo trabajamos»");
  ok(v.marpe.dudas.length === 1 && v.marpe.dudas[0].t === "¿El hotel va incluido?:", "dudas completas, con su «:»");
  ok(v.confianza === "media", "confianza desconocida → media");
  ok(v.avisos.some((a) => a.campo === "needs" && a.indice === 1) && v.avisos.some((a) => a.campo === "general" && /Ferré/.test(a.mensaje)), "avisos con su campo");
  ok(v.avisos.find((a) => a.mensaje === "va a general")?.campo === "general", "un campo desconocido va a «general»");
  ok(![v.marpe.lead, ...v.marpe.necesidades.flatMap((n) => [n.dice, n.tag, n.fix]), ...v.marpe.dudas.flatMap((d) => [d.t, d.d])].some((t) => /\[[^\]]*\]/.test(t)), "nada entre corchetes en lo que se devuelve");
}
const corta = validateInmersionMarpe({ doctor: "Dr. Pablo Ruiz", lead: "", necesidades: [{ dice: "«x x x x x x»", tag: "A", fix: "B" }], dudas: [] });
ok(!!corta && corta.avisos.some((a) => a.campo === "needs" && /Solo salen 1/.test(a.mensaje)), "con menos de tres necesidades, avisa");

console.log(fallos ? `\n❌ ${fallos} fallo(s), ${pasadas} bien` : `\n✅ Extracción de la Inmersión: ${pasadas} comprobaciones bien`);
process.exit(fallos ? 1 : 0);
