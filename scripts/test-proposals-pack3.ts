/** Test de la extracción del Pack 3 Estancias: npx tsx scripts/test-proposals-pack3.ts */
import assert from "node:assert/strict";
import { buildPromptPack3, validatePack3 } from "../src/http/routes/proposalsPack3";

const r = validatePack3({
  doctor: "Dra. Neus Puertes",
  lead: 'Llevas 17 años con tu clínica. <span class="hl">el pack completo</span> <b>x</b>',
  necesidades: [
    { dice: "no me gustan las redes sociales", tag: "Publicidad y marketing", fix: "El primer día ves por qué…" },
    { dice: "«me encanta la cirugía»", tag: "MARPE y microtornillos", fix: "El segundo día…" },
    { dice: "[frase]", tag: "Gestión clínica", fix: "El tercer día…" },
    { dice: "x", tag: "", fix: "sin tema" },
  ],
  bloqueClave: "3",
  dudas: [{ t: "Mejor en lunes", d: "Te recomendamos lunes." }, { t: "", d: "coja" }],
  fechas: ["Tres lunes separados, uno al mes.", "[relleno]"],
  confianza: "alta",
  avisos: ["revisa el nombre"],
});
assert.ok(r);
assert.equal(r!.drNombre, "Dra. Neus Puertes");
assert.equal(r!.pack3.lead.includes('<span class="hl">el pack completo</span>'), true);
assert.equal(r!.pack3.lead.includes("<b>"), false);
assert.equal(r!.pack3.necesidades.length, 3);
assert.equal(r!.pack3.necesidades[0].dice, "«no me gustan las redes sociales»");
assert.equal(r!.pack3.necesidades[1].dice, "«me encanta la cirugía»");
assert.equal(r!.pack3.necesidades[2].dice, "");
assert.equal(r!.pack3.bloqueClave, 3);
assert.deepEqual(r!.pack3.dudas, [{ t: "Mejor en lunes:", d: "Te recomendamos lunes." }]);
assert.deepEqual(r!.pack3.fechas, ["Tres lunes separados, uno al mes."]);
assert.equal(validatePack3({ lead: "sin doctor" }), null);
assert.match(buildPromptPack3("hola"), /PACK 3 ESTANCIAS/);
assert.doesNotMatch(buildPromptPack3("hola"), /\$\{/);
console.log("✓ extracción del Pack 3: 13 comprobaciones OK");
