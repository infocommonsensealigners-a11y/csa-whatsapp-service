/**
 * Guardián anti-envío: recorre TODO src/ y falla si aparece cualquier token
 * de la superficie de publicación de Baileys. Es la garantía mecánica de que
 * este servicio es de solo lectura: ni código ni comentarios pueden nombrar
 * estas APIs (así un futuro refactor no las cuela "solo para probar").
 *
 * Ejecutar: npm run check:nosend  (parte de la verificación de cada fase).
 */
import fs from "node:fs";
import path from "node:path";

const FORBIDDEN_TOKENS = [
  "sendMessage",
  "relayMessage",
  "sendReceipt",
  "readMessages",
  "chatModify",
  "sendPresenceUpdate",
] as const;

const SRC_DIR = path.resolve(process.cwd(), "src");

interface Violation {
  file: string;
  line: number;
  token: string;
  snippet: string;
}

function* walk(dir: string): Generator<string> {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) yield* walk(full);
    else if (entry.isFile() && /\.(ts|tsx|js|mjs)$/.test(entry.name)) yield full;
  }
}

const violations: Violation[] = [];

for (const file of walk(SRC_DIR)) {
  const lines = fs.readFileSync(file, "utf-8").split(/\r?\n/);
  lines.forEach((text, i) => {
    for (const token of FORBIDDEN_TOKENS) {
      if (text.includes(token)) {
        violations.push({
          file: path.relative(process.cwd(), file),
          line: i + 1,
          token,
          snippet: text.trim().slice(0, 120),
        });
      }
    }
  });
}

if (violations.length > 0) {
  console.error("✗ check:nosend FALLÓ — tokens de publicación WhatsApp encontrados en src/:\n");
  for (const v of violations) {
    console.error(`  ${v.file}:${v.line}  [${v.token}]  ${v.snippet}`);
  }
  process.exit(1);
}

console.log("✓ check:nosend OK — src/ no contiene ninguna API de publicación de WhatsApp.");
