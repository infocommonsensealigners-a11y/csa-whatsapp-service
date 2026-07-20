/**
 * migrate-to-prod.ts — sube el histórico local (chats + messages +
 * chat_lead_links de data/wa.sqlite3) al sidecar de PRODUCCIÓN a través del
 * proxy autenticado del dashboard, usando el endpoint /admin/ingest (idempotente).
 *
 * NO necesita CLI de Railway: habla con la URL pública del dashboard, que hace
 * de proxy a la red privada del sidecar. Reanudable (INSERT OR IGNORE): si se
 * corta, se relanza y continúa sin duplicar.
 *
 * Uso (PowerShell):
 *   $env:DASH_EMAIL="miguelangel@ortodoncialozano.es"; $env:DASH_PASS="..."; `
 *   npx tsx scripts/migrate-to-prod.ts            # migra de verdad
 *   npx tsx scripts/migrate-to-prod.ts --dry-run  # solo lee y cuenta local
 *
 * Env: PROD_URL (def. prod Railway), DASH_EMAIL, DASH_PASS, WA_ADMIN_TOKEN
 *      (def. "csa-migrate-2026", debe coincidir con el del endpoint).
 */
import Database from "better-sqlite3";
import path from "node:path";

const PROD_URL = (process.env.PROD_URL ?? "https://csa-dashboard-production.up.railway.app").replace(/\/$/, "");
const EMAIL = process.env.DASH_EMAIL ?? "";
const PASS = process.env.DASH_PASS ?? "";
const TOKEN = (process.env.WA_ADMIN_TOKEN ?? "csa-migrate-2026").trim();
const DRY = process.argv.includes("--dry-run");

const DB_PATH = path.resolve(process.cwd(), "data", "wa.sqlite3");
const CHAT_BATCH = 300;
const MSG_BATCH = 800;
const LINK_BATCH = 400;

function chunk<T>(arr: T[], n: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += n) out.push(arr.slice(i, i + n));
  return out;
}

async function login(): Promise<string> {
  if (!EMAIL || !PASS) throw new Error("Faltan DASH_EMAIL / DASH_PASS en el entorno.");
  const res = await fetch(`${PROD_URL}/api/auth/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email: EMAIL, password: PASS }),
  });
  if (!res.ok) throw new Error(`login falló: HTTP ${res.status}`);
  const setCookies =
    typeof (res.headers as unknown as { getSetCookie?: () => string[] }).getSetCookie === "function"
      ? (res.headers as unknown as { getSetCookie: () => string[] }).getSetCookie()
      : [res.headers.get("set-cookie") ?? ""];
  const m = setCookies.join(";").match(/csa_session=[^;]+/);
  if (!m) throw new Error("login OK pero no llegó la cookie csa_session.");
  return m[0];
}

async function post(cookie: string, payload: object): Promise<{ inserted?: { chats: number; messages: number; links: number }; counts?: unknown }> {
  const res = await fetch(`${PROD_URL}/api/whatsapp/admin/ingest`, {
    method: "POST",
    headers: { "content-type": "application/json", cookie, "x-wa-admin": TOKEN },
    body: JSON.stringify(payload),
  });
  const j = (await res.json().catch(() => ({}))) as any;
  if (!res.ok || j?.ok === false) throw new Error(`ingest falló: HTTP ${res.status} ${JSON.stringify(j).slice(0, 200)}`);
  return j;
}

async function main() {
  const db = new Database(DB_PATH, { readonly: true });
  const chats = db.prepare("SELECT jid,phone,display_name,avatar_path,avatar_fetched_at,last_message_at,last_message_preview,last_opened_at,ignored,backfill_status,created_at,updated_at FROM chats").all() as any[];
  const messages = db.prepare("SELECT chat_jid,id,from_me,ts,type,text,media_path,media_mime,raw_json FROM messages").all() as any[];
  const links = db.prepare("SELECT chat_jid,source_row,phone_snapshot,lead_name_snapshot,method,status,created_at,updated_at FROM chat_lead_links").all() as any[];
  console.log(`Local: ${chats.length} chats · ${messages.length} messages · ${links.length} links`);

  if (DRY) {
    console.log("— DRY RUN — no se sube nada. Ejemplo de chat:");
    console.log(JSON.stringify(chats[0], null, 1));
    console.log(`Lotes que se enviarían: ${chunk(chats, CHAT_BATCH).length} de chats, ${chunk(messages, MSG_BATCH).length} de messages, ${chunk(links, LINK_BATCH).length} de links.`);
    return;
  }

  console.log(`→ Destino: ${PROD_URL}`);
  const cookie = await login();
  console.log("✓ sesión iniciada en prod");

  const tot = { chats: 0, messages: 0, links: 0 };

  // 1) CHATS primero (messages y links referencian chats por FK).
  const chatChunks = chunk(chats, CHAT_BATCH);
  for (let i = 0; i < chatChunks.length; i++) {
    const r = await post(cookie, { chats: chatChunks[i] });
    tot.chats += r.inserted?.chats ?? 0;
    console.log(`chats ${i + 1}/${chatChunks.length} (+${r.inserted?.chats ?? 0}, acum ${tot.chats})`);
  }
  // 2) MESSAGES.
  const msgChunks = chunk(messages, MSG_BATCH);
  for (let i = 0; i < msgChunks.length; i++) {
    const r = await post(cookie, { messages: msgChunks[i] });
    tot.messages += r.inserted?.messages ?? 0;
    if (i % 10 === 0 || i === msgChunks.length - 1)
      console.log(`messages ${i + 1}/${msgChunks.length} (acum ${tot.messages})`);
  }
  // 3) LINKS.
  const linkChunks = chunk(links, LINK_BATCH);
  for (let i = 0; i < linkChunks.length; i++) {
    const r = await post(cookie, { links: linkChunks[i] });
    tot.links += r.inserted?.links ?? 0;
  }

  console.log(`\n✅ Migración terminada. Insertados NUEVOS: ${tot.chats} chats · ${tot.messages} messages · ${tot.links} links.`);
  console.log("(Los ya existentes se ignoran — reanudable/idempotente.)");
}

main().catch((e) => {
  console.error("✗", e.message);
  process.exit(1);
});
