/**
 * Guarda el token de SUSCRIPCIÓN de Claude (`claude setup-token`, 1 año) en
 * Supabase para que Fransua interprete GRATIS en prod (sin ANTHROPIC_API_KEY).
 *
 * Uso (dos formas):
 *   1) Fichero (recomendado, no expone el token en el historial):
 *        - pega el token en  whatsapp-service/.secrets/oauth-token.txt
 *        - ejecuta:  npx tsx --env-file=.env scripts/set-oauth-token.ts
 *      (el fichero se borra al terminar; .secrets/ está en .gitignore)
 *   2) Argumento:
 *        npx tsx --env-file=.env scripts/set-oauth-token.ts "sk-ant-oat-..."
 *
 * Verifica que quede guardado y muestra si Fransua ya puede interpretar.
 */
import fs from "node:fs";
import path from "node:path";
import { storeSecret, loadSecret, deleteSecret } from "../src/brain/secrets";

const FILE = path.resolve(process.cwd(), ".secrets/oauth-token.txt");

function readToken(): string | null {
  const arg = process.argv[2]?.trim();
  if (arg) return arg;
  try {
    return fs.readFileSync(FILE, "utf8").trim();
  } catch {
    return null;
  }
}

async function main() {
  const token = readToken();
  if (!token || token.length < 20) {
    console.error(
      "No hay token. Genera uno con `claude setup-token`, pégalo en\n" +
        `  ${FILE}\n` +
        "o pásalo como argumento. (Debe empezar por sk-ant-oat...)"
    );
    process.exit(1);
  }
  if (!token.startsWith("sk-ant-oat")) {
    console.warn("⚠ El token no empieza por 'sk-ant-oat' — ¿seguro que es el de `claude setup-token`? Continúo igualmente.");
  }

  // Rota: borra tokens anteriores y guarda el nuevo (el más reciente gana igualmente).
  const removed = await deleteSecret("CLAUDE_CODE_OAUTH_TOKEN");
  if (removed) console.log(`(rotado: ${removed} token(s) anterior(es) borrado(s))`);
  await storeSecret("CLAUDE_CODE_OAUTH_TOKEN", token);

  // Verifica que se lee de vuelta.
  const back = await loadSecret("CLAUDE_CODE_OAUTH_TOKEN");
  if (back === token) {
    console.log("✅ Token guardado en Supabase. El sidecar (local y Railway) lo cargará al arrancar o en la próxima nota.");
  } else {
    console.error("❌ No se pudo verificar el token guardado.");
    process.exit(1);
  }

  // Borra el fichero por seguridad si se usó.
  try {
    if (fs.existsSync(FILE)) {
      fs.rmSync(FILE);
      console.log("(fichero .secrets/oauth-token.txt borrado)");
    }
  } catch {}
  process.exit(0);
}

main().catch((e) => {
  console.error("Error:", (e as Error).message);
  process.exit(1);
});
