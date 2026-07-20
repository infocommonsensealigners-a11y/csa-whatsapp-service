/**
 * upload-avatars-to-prod.ts — sube los avatares locales (data/avatars/*.jpg) al
 * volumen de producción por el proxy autenticado del dashboard, usando el
 * endpoint /admin/upload-avatars (base64, por lotes). Idempotente (sobrescribe).
 *
 * Uso: DASH_EMAIL=... DASH_PASS=... npx tsx scripts/upload-avatars-to-prod.ts
 */
import fs from "node:fs";
import path from "node:path";

const PROD = (process.env.PROD_URL ?? "https://csa-dashboard-production.up.railway.app").replace(/\/$/, "");
const EMAIL = process.env.DASH_EMAIL ?? "";
const PASS = process.env.DASH_PASS ?? "";
const TOKEN = (process.env.WA_ADMIN_TOKEN ?? "csa-migrate-2026").trim();
const DIR = path.resolve(process.cwd(), "data", "avatars");
const BATCH = 6;

async function login(): Promise<string> {
  const res = await fetch(`${PROD}/api/auth/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email: EMAIL, password: PASS }),
  });
  if (!res.ok) throw new Error(`login HTTP ${res.status}`);
  const sc =
    typeof (res.headers as any).getSetCookie === "function"
      ? (res.headers as any).getSetCookie().join(";")
      : res.headers.get("set-cookie") ?? "";
  const m = sc.match(/csa_session=[^;]+/);
  if (!m) throw new Error("sin cookie de sesión");
  return m[0];
}

async function main() {
  if (!EMAIL || !PASS) throw new Error("faltan DASH_EMAIL / DASH_PASS");
  const names = fs.readdirSync(DIR).filter((n) => n.endsWith(".jpg"));
  console.log(`${names.length} avatares locales → ${PROD}`);
  const cookie = await login();

  let sent = 0;
  let written = 0;
  for (let i = 0; i < names.length; i += BATCH) {
    const slice = names.slice(i, i + BATCH);
    const files = slice.map((name) => ({ name, b64: fs.readFileSync(path.join(DIR, name)).toString("base64") }));
    const res = await fetch(`${PROD}/api/whatsapp/admin/upload-avatars`, {
      method: "POST",
      headers: { "content-type": "application/json", cookie },
      body: JSON.stringify({ token: TOKEN, files }),
    });
    const j = (await res.json().catch(() => ({}))) as any;
    if (!res.ok || j?.ok === false) {
      console.error(`lote ${i / BATCH + 1} FALLÓ: HTTP ${res.status} ${JSON.stringify(j).slice(0, 150)}`);
      throw new Error("abortado");
    }
    written += j.written ?? 0;
    sent += slice.length;
    if (i % (BATCH * 10) === 0 || i + BATCH >= names.length)
      console.log(`  ${sent}/${names.length} enviados (escritos acum: ${written})`);
  }
  console.log(`\n✅ Avatares subidos: ${written} escritos de ${names.length}.`);
}

main().catch((e) => {
  console.error("✗", e.message);
  process.exit(1);
});
