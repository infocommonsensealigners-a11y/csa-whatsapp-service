/**
 * Valida el índice y el buscador del conocimiento de Fransua
 * (`src/brain/conocimiento.ts`) y la ficha real de `conocimiento/`.
 *
 * ⚠️ EL CASO QUE LO ORIGINA (07-10-2026): el playbook de ventas B2B y marca
 * personal (método Haynes adaptado a CSA) se sirve por secciones con
 * `consultar_conocimiento` en vez de ir entero en el prompt. Si el buscador
 * devuelve la sección equivocada, Fransua aconseja con la regla equivocada.
 *
 *   npx tsx scripts/test-conocimiento.ts
 */
import fs from "node:fs";
import path from "node:path";
import { buscar, indexar, palabras, raiz, temas } from "../src/brain/conocimiento";
import { buscarConocimiento, temasConocimiento } from "../src/brain/conocimientoFuente";

let fallos = 0;
function esperar(caso: string, real: unknown, esperado: unknown): void {
  const a = JSON.stringify(real);
  const b = JSON.stringify(esperado);
  const ok = a === b;
  if (!ok) fallos++;
  console.log(`${ok ? "✓" : "✗"} ${caso}`);
  if (!ok) console.log(`    esperado: ${b}\n    real:     ${a}`);
}

/* ── palabras y raíces ─────────────────────────────────────────────────────── */
console.log("── palabras y raíces ──");
esperar("quita tildes, relleno y palabras cortas", palabras("¿Qué le mando a la Dra. antes?"), ["mando", "dra", "antes"]);
esperar("«vídeos» y «vídeo» casan", raiz(palabras("vídeos")[0]), raiz(palabras("vídeo")[0]));
esperar("«mando» y «manda» casan", raiz("mando"), raiz("manda"));
esperar("las cortas no se tocan", raiz("vio"), "vio");

/* ── el indexador ──────────────────────────────────────────────────────────── */
console.log("\n── el indexador ──");
const DOC = [
  "# Manual de prueba",
  "",
  "Preámbulo con las reglas para leer este manual, que también es una sección.",
  "",
  "## Llamadas",
  "- La llamada se agenda con dos franjas concretas para el doctor.",
  "",
  "## Corto",
  "nada",
  "",
  "## Seguimiento",
  "### Tras la propuesta",
  "- La propuesta sale en menos de 48 horas y con fecha de decisión.",
].join("\n");
const idx = indexar([{ fuente: "prueba.md", texto: DOC }]);
esperar(
  "una sección por título; la de menos de 40 caracteres no cuenta",
  idx.map((s) => s.titulo),
  ["Manual de prueba", "Manual de prueba · Llamadas", "Manual de prueba · Tras la propuesta"],
);
esperar("el preámbulo es una sección con el título del documento", idx[0].tema, "Manual de prueba");
esperar("cada sección sabe de qué documento es", idx.map((s) => s.documento), ["Manual de prueba", "Manual de prueba", "Manual de prueba"]);
esperar("el texto no arrastra el título", idx[1].texto, "- La llamada se agenda con dos franjas concretas para el doctor.");
esperar("temas: documento y sus secciones, sin repetir el título", temas(idx), "Manual de prueba: Llamadas · Tras la propuesta");
esperar("acepta CRLF", indexar([{ fuente: "w.md", texto: DOC.replace(/\n/g, "\r\n") }]).length, 3);
esperar("sin documentos, sin índice", indexar([]), []);

/* ── el buscador ───────────────────────────────────────────────────────────── */
console.log("\n── el buscador ──");
esperar("gana la sección que contesta", buscar(idx, "¿cuándo sale la propuesta?")[0]?.titulo, "Manual de prueba · Tras la propuesta");
esperar("una consulta solo de relleno no devuelve nada", buscar(idx, "que de la"), []);
esperar("sin coincidencias, nada", buscar(idx, "facturación seQura"), []);
esperar("respeta el número pedido", buscar(idx, "llamada propuesta doctor", 1).length, 1);

/* ── la ficha real ─────────────────────────────────────────────────────────── */
console.log("\n── la ficha real (conocimiento/) ──");
const CARPETA = path.resolve(process.cwd(), "conocimiento");
const ficheros = fs.readdirSync(CARPETA).filter((f) => f.endsWith(".md"));
esperar("hay al menos un documento", ficheros.length >= 1, true);
for (const f of ficheros) {
  const texto = fs.readFileSync(path.join(CARPETA, f), "utf-8");
  const largas = texto.split(/\n(?=## )/).filter((s) => s.length > 1500).map((s) => s.split("\n")[0]);
  esperar(`${f}: ninguna sección pasa de 1.500 caracteres`, largas, []);
  // El `#` va en el título de cada resultado: es la fuente que Fransua cita al ofrecerlo («según Haynes…»).
  esperar(`${f}: empieza por un título # que nombra la fuente`, /^# \S/.test(texto), true);
  // Precios y financiación salen SOLO del catálogo: un importe aquí acabaría en boca de Fransua.
  esperar(`${f}: sin importes ni cuotas`, /€|\d+[.,]\d{2}\s*(€|eur)|\bcuotas?\b/i.test(texto), false);
}
const ignorado = fs.readFileSync(path.resolve(process.cwd(), ".dockerignore"), "utf-8").split(/\r?\n/).map((l) => l.trim());
esperar("el .dockerignore no deja fuera conocimiento/", ignorado.some((l) => l && /^\/?conocimiento\b/.test(l)), false);

const primera = (q: string) => buscarConocimiento(q, 3)[0]?.titulo.split(" · ").pop();
esperar("«doctor que no vio los vídeos» → tipo 1 y tipo 2", primera("doctor que no vio los vídeos"), "Doctor tipo 1 y tipo 2");
esperar("«interés bajo o no cualifica» → su sección", primera("interés bajo o no cualifica"), "«No cualifica» frente a «interés bajo»");
esperar("«qué mando antes de la llamada» → entre la reserva y la llamada", primera("qué mando antes de la llamada"), "Entre la reserva y la llamada: qué mandar antes");
esperar("«urgencia» → urgencia honesta", primera("urgencia"), "Urgencia honesta");
esperar("«guion de la llamada» → pasos de acuerdo", primera("guion de la llamada"), "Pasos de acuerdo: guion de la llamada");
// Secciones de Sales Mastery y Messaging Mastery (07-10-2026).
esperar("«lo ve con su socio» → objeciones de aplazamiento", primera("el doctor dice que lo ve con su socio"), "Objeciones de aplazamiento del doctor: socio, asesor, congreso, «más adelante»");
esperar("«primer contacto» → fase 0", primera("cómo hago el primer contacto"), "Primer contacto con un doctor (fase 0, primeras 24 h)");
esperar("«qué pregunto si duda en la llamada» → la llamada", primera("qué pregunto si el doctor duda en la llamada"), "La llamada: qué preguntar cuando el doctor duda");
esperar("«hablar con el Dr. Lozano» → objeciones de confianza", primera("puedo hablar con el Dr. Lozano"), "Objeciones de confianza: el Dr. Lozano, por qué CSA y garantías");
esperar("la línea de temas del prompt nombra el documento", temasConocimiento().startsWith("Ventas B2B y marca personal de CSA"), true);

console.log(`\n${fallos === 0 ? "✓ TODO OK" : `✗ ${fallos} FALLOS`}`);
process.exit(fallos === 0 ? 0 : 1);
