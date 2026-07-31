/**
 * Guardián del envío: recorre TODO src/ y falla si aparece cualquier token de
 * la superficie de publicación de Baileys FUERA del único módulo autorizado.
 *
 * HISTORIA: hasta el 29-07-2026 este servicio era 100% solo-lectura y ningún
 * fichero podía nombrar estas APIs. Ese día el usuario decidió poder RESPONDER
 * a mano desde el teléfono flotante del dashboard. La garantía mecánica no se
 * borra, se ACOTA: `sendMessage` solo puede existir en `src/wa/send.ts` (envío
 * manual, auditado y con límite de ritmo). Todo lo demás — incluido TODO el
 * cerebro de Fransua (src/ai/, src/brain/) — sigue sin poder ni nombrarlo: el
 * agente puede SUGERIR texto, jamás enviarlo. El resto de tokens (receipts,
 * presencia, chatModify) siguen prohibidos en TODAS partes: no los usamos.
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
  // Etiquetado (2026-07-30): puerta ESTRECHA para poner/quitar etiquetas de
  // WhatsApp Business. No envía nada ni toca acuses de lectura, pero sigue
  // siendo escritura hacia la cuenta → mismo trato que el envío: un único
  // fichero autorizado, y Fransua (src/ai, src/brain) sin acceso.
  "addChatLabel",
  "removeChatLabel",
] as const;

/**
 * Token → único fichero donde ese token está permitido. Todo lo demás, y
 * cualquier otro token, sigue prohibido en TODO src/.
 * ⚠️ `chatModify` NO tiene excepción a propósito: es la puerta ancha (marcar
 * leído, archivar, silenciar) y no la usamos ni para etiquetar — para eso están
 * addChatLabel/removeChatLabel, que Baileys implementa por debajo.
 */
const TOKEN_ALLOWLIST = new Map<string, string>([
  ["sendMessage", "src/wa/send.ts".replace(/\//g, path.sep)],
  ["addChatLabel", "src/wa/labels.ts".replace(/\//g, path.sep)],
  ["removeChatLabel", "src/wa/labels.ts".replace(/\//g, path.sep)],
]);

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
  const rel = path.relative(process.cwd(), file);
  const lines = fs.readFileSync(file, "utf-8").split(/\r?\n/);
  lines.forEach((text, i) => {
    for (const token of FORBIDDEN_TOKENS) {
      if (!text.includes(token)) continue;
      // Única excepción: ese token, en SU fichero autorizado (y solo ahí).
      if (TOKEN_ALLOWLIST.get(token) === rel) continue;
      violations.push({
        file: rel,
        line: i + 1,
        token,
        snippet: text.trim().slice(0, 120),
      });
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

console.log(
  "✓ check:nosend OK — publicar texto solo en src/wa/send.ts y etiquetar solo en src/wa/labels.ts; " +
    "el resto de src/ (incluido Fransua) no puede ni nombrarlas."
);
