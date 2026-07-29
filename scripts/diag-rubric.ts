/**
 * Prueba el BAREMO de evaluación de llamadas contra una transcripción real y
 * enseña las notas que salen, para poder compararlas con las que dio el rubric
 * anterior ANTES de desplegar.
 *
 * Uso: npx tsx --env-file=.env scripts/diag-rubric.ts <fichero.txt> [sba|cert]
 *
 * Usa la credencial de Claude de la suscripción igual que en producción
 * (ensureClaudeAuth la saca de Supabase si no está en el entorno).
 */
import fs from "node:fs";
import { analyzeCallTranscript } from "../src/http/routes/calls";

const ruta = process.argv[2];
if (!ruta) {
  console.error("Falta la ruta de la transcripción.");
  process.exit(1);
}
const programa = process.argv[3] === "cert" ? "cert" : "sba";
const texto = fs.readFileSync(ruta, "utf8");

(async () => {
  console.log(`transcripción: ${texto.length} caracteres · programa: ${programa}`);
  const t0 = Date.now();
  const a = await analyzeCallTranscript(texto, programa as "sba" | "cert");
  const segs = ((Date.now() - t0) / 1000).toFixed(1);
  if (!a) {
    console.error("La IA no devolvió análisis.");
    process.exit(1);
  }
  console.log(`\n=== NOTAS CON EL BAREMO NUEVO (en ${segs}s) ===`);
  const s = a.scores;
  const dims: [string, number][] = [
    ["cualificación", s.cualificacion],
    ["argumentación", s.argumentacion],
    ["objeciones", s.objeciones],
    ["cierre (avance)", s.cierre],
    ["rapport (escucha)", s.rapport],
  ];
  for (const [k, v] of dims) console.log(`  ${k.padEnd(20)} ${String(v).padStart(3)}`);
  const media = Math.round(dims.reduce((acc, [, v]) => acc + v, 0) / dims.length);
  console.log(`  ${"—".padEnd(20)} ---`);
  console.log(`  ${"media de las 5".padEnd(20)} ${String(media).padStart(3)}`);
  console.log(`  ${"scoreGlobal".padEnd(20)} ${String(a.scoreGlobal).padStart(3)}`);
  console.log(`\n  coherencia global vs media: ${Math.abs(a.scoreGlobal - media)} puntos ${Math.abs(a.scoreGlobal - media) <= 10 ? "✅ (dentro de ±10)" : "❌ (fuera de ±10)"}`);
  console.log(`\n  talkRatioComercial: ${a.talkRatioComercial ?? "null (no diarizada)"} · diarizado: ${a.diarizado}`);
  console.log(`  pidióCierre: ${a.pidioCierre} · próximoPaso: ${a.proximoPaso ?? "—"}`);
  console.log(`  cualificó: ${a.cualifico} · dolor: ${a.dolorPrincipal ?? "—"}`);
  console.log(`\n  debilidades:`);
  for (const d of a.debilidades) console.log(`   · ${d.texto}`);
})();
