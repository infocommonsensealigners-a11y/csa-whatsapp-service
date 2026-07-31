/**
 * Prueba el análisis de RENOVACIÓN contra una transcripción real y enseña lo que
 * saca (contento del alumno, mejoras del curso, estado de la renovación) ANTES de
 * desplegar el prompt. Mismo espíritu que diag-rubric.ts.
 *
 * Uso: npx tsx --env-file=.env scripts/diag-renewal.ts <fichero.txt>
 *
 * Usa la credencial de Claude de la suscripción igual que en producción
 * (ensureClaudeAuth la saca de Supabase si no está en el entorno).
 */
import fs from "node:fs";
import { analyzeRenewalTranscript } from "../src/http/routes/renewals";

const ruta = process.argv[2];
if (!ruta) {
  console.error("Falta la ruta de la transcripción.");
  process.exit(1);
}
const texto = fs.readFileSync(ruta, "utf8");

(async () => {
  console.log(`transcripción: ${texto.length} caracteres`);
  const t0 = Date.now();
  const a = await analyzeRenewalTranscript(texto);
  const seg = Math.round((Date.now() - t0) / 1000);
  if (!a) {
    console.error(`\n✗ la IA no devolvió un JSON usable (${seg}s)`);
    process.exit(1);
  }
  console.log(`\n✓ ${seg}s · confianza ${a.confianza} · diarizado ${a.diarizado}`);
  console.log(`alumno: ${a.alumno ?? "—"}${a.edicion ? ` · ${a.edicion}` : ""}`);
  console.log(`\nRESUMEN: ${a.resumen}`);
  console.log(`\nCONTENTO: ${a.satisfaccion.toUpperCase()} — ${a.satisfaccionPorQue ?? "sin motivo"}`);
  console.log(`  cita: ${a.satisfaccionCita ? `«${a.satisfaccionCita}»` : "—"}`);
  console.log(`\nVALORA (${a.loQueValora.length}):`);
  for (const v of a.loQueValora) console.log(`  · ${v.texto}${v.cita ? `  «${v.cita}»` : ""}`);
  console.log(`\nMEJORAS (${a.mejoras.length}):`);
  for (const m of a.mejoras) console.log(`  · [${m.area}/${m.severidad}] ${m.que}${m.cita ? `  «${m.cita}»` : ""}`);
  console.log(`\nRENOVACIÓN: ${a.intencion.toUpperCase()}${a.intencionCita ? ` — «${a.intencionCita}»` : ""}`);
  for (const f of a.frenos) console.log(`  freno: ${f.texto}${f.cita ? `  «${f.cita}»` : ""}`);
  console.log(`  próximo paso: ${a.proximoPaso ?? "ninguno"}`);
  console.log(`\nRESULTADOS: ${a.resultados ?? "—"}`);
  console.log(`\nCITAS CLAVE:`);
  for (const c of a.citasClave) console.log(`  «${c}»`);
})();
