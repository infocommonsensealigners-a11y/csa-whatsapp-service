/**
 * El encargo de los DOS PLANES del SBA ("sba_planes", octubre de 2026): de una
 * llamada salen la propuesta Estándar (1 día de estancia) y la Premium (3 días).
 * Se comprueba el prompt y, sobre todo, el saneo de lo que devuelve el modelo:
 *  · el encargo conoce los dos planes, pide las variantes `_ESTANDAR`/`_PREMIUM`
 *    y 5-6 objeciones, y prohíbe la estancia como regalo y los 3 meses extra;
 *  · una variante vacía (null, "", []) NO se devuelve: el dashboard la tomaría
 *    por «este plan no tiene necesidades»;
 *  · la modalidad de un plan es siempre "estancia";
 *  · los encargos de SBA, Certificación y Estancia no llevan nada de esto.
 *
 *   npx tsx scripts/test-proposals-planes.ts
 */
import { buildPrompt, validate } from "../src/http/routes/proposals";

let fallos = 0;
let pasadas = 0;
function ok(cond: unknown, msg: string, extra?: unknown): void {
  if (cond) pasadas++;
  else {
    fallos++;
    console.error(`  ✗ ${msg}${extra !== undefined ? ` — ${JSON.stringify(extra)}` : ""}`);
  }
}

const T = "Transcripción de prueba: el doctor quiere ver casos de MARPE y le interesa la gestión de la clínica.";

/* --------------------------------- el prompt --------------------------------- */
const planes = buildPrompt(T, "sba_planes");
ok(planes.includes(T), "el prompt de los planes lleva la transcripción");
ok(/DOS PLANES/.test(planes) && /Plan ESTÁNDAR/.test(planes) && /Plan PREMIUM/.test(planes), "conoce los dos planes");
ok(/UN \(1\) DÍA/.test(planes) && /TRES \(3\) DÍAS/.test(planes), "con sus días de estancia (1 y 3)");
ok(/publicidad y marketing · casos prácticos \(MARPE y minitornillos\) · gestión clínica/.test(planes), "con los tres enfoques de la Premium");
ok(/NUNCA la presentes como regalo/.test(planes), "prohíbe presentar la estancia como regalo");
ok(/siempre "estancia"/.test(planes) && /no escribas «3 meses extra» ni «13 meses»/.test(planes), "en los planes no hay 3 meses extra");
ok(/"rea": 5 a 6 objeciones/.test(planes), "pide 5-6 objeciones, como el kit");
for (const k of ["heroLead1_ESTANDAR", "heroLead2_PREMIUM", "needs_PREMIUM", "rea_ESTANDAR"]) {
  ok(planes.includes(k), `pide la variante ${k}`);
}
ok(/variantes por plan: heroLead1_ESTANDAR/.test(planes.slice(-600)), "y la última línea pide las claves de variante");
ok(!/\d\s*€|3\.900|5\.900|ES\d{2}/.test(planes), "no lleva importes ni IBAN (van fijos en la plantilla)");

for (const p of ["sba", "certificacion", "estancia"] as const) {
  const pr = buildPrompt(T, p);
  ok(!/DOS PLANES|_ESTANDAR|_PREMIUM/.test(pr), `${p}: el encargo de siempre no lleva nada de los planes`);
  ok(/"rea": 5 a 7 objeciones/.test(pr), `${p}: sigue pidiendo 5-7 objeciones`);
}

/* --------------------------------- el saneo --------------------------------- */
const crudo = {
  modalidad: "extension",
  drNombre: "  Dra. Prueba ",
  drNombreArt: "la Dra. Prueba",
  heroLead1: "h1",
  heroLead2: "h2 común",
  heroLead2_PREMIUM: "  h2 premium ",
  heroLead2_ESTANDAR: "",
  heroLead1_PREMIUM: null,
  needs: [{ want: "«a»", tag: "t", fix: "f" }],
  needs_PREMIUM: null,
  needs_ESTANDAR: [],
  rea: [{ t: "x:", d: "y" }],
  rea_ESTANDAR: [{ t: "e:", d: "un día" }, { t: "", d: "" }, "basura"],
  starBlock: "estancia",
  confianza: "alta",
  avisos: [],
};
const v = validate(crudo, "sba_planes") as Record<string, unknown> | null;
ok(!!v, "un borrador de planes válido pasa");
ok(v?.modalidad === "estancia", "la modalidad de un plan es siempre «estancia» (aunque el modelo diga extension)", v?.modalidad);
ok(v?.heroLead2_PREMIUM === "h2 premium", "una variante con texto se devuelve (limpia)", v?.heroLead2_PREMIUM);
ok(!("heroLead2_ESTANDAR" in (v ?? {})) && !("heroLead1_PREMIUM" in (v ?? {})), "una variante vacía o nula NO se devuelve");
ok(!("needs_PREMIUM" in (v ?? {})) && !("needs_ESTANDAR" in (v ?? {})), "ni una lista de necesidades nula o vacía");
ok(JSON.stringify(v?.rea_ESTANDAR) === JSON.stringify([{ t: "e:", d: "un día" }]), "las objeciones de la variante se limpian como las comunes", v?.rea_ESTANDAR);
ok(v?.drNombre === "Dra. Prueba", "lo común se sanea como siempre");

const sba = validate(crudo, "sba") as Record<string, unknown> | null;
ok(sba?.modalidad === "extension", "el SBA normal conserva «extension» (sus 3 meses extra)");
ok(!Object.keys(sba ?? {}).some((k) => /_(ESTANDAR|PREMIUM)$/.test(k)), "y no devuelve variantes de plan");
ok(validate({ ...crudo, drNombre: "" }, "sba_planes") === null, "sin nombre no hay borrador, tampoco en los planes");

console.log(`  ${pasadas} pasadas · ${fallos} fallos`);
process.exit(fallos ? 1 : 0);
