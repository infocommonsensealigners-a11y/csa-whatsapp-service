/**
 * Remate del build de producción (29-10-2026, ahorro de Railway): deja `dist/`
 * listo para `node dist/index.js`, sin tsx.
 *
 * Por qué hace falta: el código importa sin extensión (`from "./config"`), que
 * tsx resuelve pero Node en ESM no. En vez de tocar los ~150 imports de `src/`
 * (y chocar con el trabajo de otras ramas), se reescriben aquí, en la SALIDA:
 * `./x` → `./x.js` (o `./x/index.js`), comprobando que el fichero existe. Si un
 * import relativo no casa con nada, el build FALLA en vez de romper al arrancar.
 *
 * Además copia los ficheros no-TS que el código lee junto a su módulo
 * (`src/db/schema.sql`, vía `import.meta.url`); tsc no los copia.
 *
 * Arrancar con tsx costaba ~180 MB de RAM fija (npx + el tsx padre + esbuild),
 * y Railway cobra la RAM por minuto.
 */
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const RAIZ = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SRC = path.join(RAIZ, "src");
const DIST = path.join(RAIZ, "dist");

function recorrer(dir) {
  return readdirSync(dir).flatMap((n) => {
    const p = path.join(dir, n);
    return statSync(p).isDirectory() ? recorrer(p) : [p];
  });
}

if (!existsSync(path.join(DIST, "index.js"))) throw new Error("No hay dist/index.js: ¿ha corrido tsc -p tsconfig.build.json?");

const RE = /(\bfrom\s*|\bimport\s*\(\s*|\bimport\s+)(["'])(\.{1,2}\/[^"']+)\2/g;
let cambiados = 0;
const rotos = [];
for (const fichero of recorrer(DIST).filter((f) => f.endsWith(".js"))) {
  const dir = path.dirname(fichero);
  const antes = readFileSync(fichero, "utf8");
  const despues = antes.replace(RE, (todo, pre, q, spec) => {
    if (/\.(m?js|json|node)$/.test(spec)) return todo;
    if (existsSync(path.join(dir, `${spec}.js`))) return `${pre}${q}${spec}.js${q}`;
    if (existsSync(path.join(dir, spec, "index.js"))) return `${pre}${q}${spec}/index.js${q}`;
    rotos.push(`${path.relative(DIST, fichero)} → ${spec}`);
    return todo;
  });
  if (despues !== antes) {
    writeFileSync(fichero, despues);
    cambiados++;
  }
}
if (rotos.length) throw new Error(`Imports relativos sin destino en dist/:\n  ${rotos.join("\n  ")}`);

let copiados = 0;
for (const f of recorrer(SRC).filter((f) => !f.endsWith(".ts"))) {
  const destino = path.join(DIST, path.relative(SRC, f));
  mkdirSync(path.dirname(destino), { recursive: true });
  copyFileSync(f, destino);
  copiados++;
}
console.log(`[build] dist listo: ${cambiados} ficheros con imports reescritos, ${copiados} recursos copiados.`);
