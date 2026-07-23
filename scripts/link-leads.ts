/**
 * Vincula chats de WhatsApp ↔ leads del CRM por teléfono, y por NOMBRE cuando no
 * hay teléfono (determinista, sin IA) — wrapper manual sobre runLeadLinking()
 * (src/brain/linkLeads.ts, que también usa el scheduler automático — ver
 * src/brain/linkLeadsScheduler.ts). Este script solo se encarga de: login
 * contra el dashboard, traer el dataset, abrir la BD y pintar el resumen.
 *
 * Uso (desde whatsapp-service/):
 *   DASH_PW=<contraseña> npx tsx scripts/link-leads.ts
 * Env opcional: DASH_URL (def http://localhost:3210), DASH_EMAIL (def miguelangel@…).
 *
 * NO envía nada a WhatsApp ni escribe en el Sheet: solo la SQLite local.
 */
import Database from "better-sqlite3";
import path from "node:path";
import { runLeadLinking, type DatasetLead } from "../src/brain/linkLeads";

const DASH_URL = process.env.DASH_URL ?? "http://localhost:3210";
const DASH_EMAIL = process.env.DASH_EMAIL ?? "miguelangel@ortodoncialozano.es";
const DASH_PW = process.env.DASH_PW;
if (!DASH_PW) {
  console.error("Falta DASH_PW (contraseña del dashboard). Uso: DASH_PW=… npx tsx scripts/link-leads.ts");
  process.exit(1);
}

async function main() {
  // 1) Login → cookie de sesión.
  const login = await fetch(`${DASH_URL}/api/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email: DASH_EMAIL, password: DASH_PW }),
  });
  if (!login.ok) throw new Error(`login falló: HTTP ${login.status}`);
  const cookie = (login.headers.get("set-cookie") ?? "").split(";")[0];
  if (!cookie.startsWith("csa_session=")) throw new Error("no llegó la cookie de sesión");

  // 2) Dataset → leads.
  const ds = (await (await fetch(`${DASH_URL}/api/dataset`, { headers: { cookie } })).json()) as {
    csaLeads?: DatasetLead[];
  };
  const leads = ds.csaLeads ?? [];
  console.log(`Leads recibidos del dashboard: ${leads.length}`);

  // 3) Matching (teléfono + nombre) sobre la BD local.
  const db = new Database(path.join(process.cwd(), "data", "wa.sqlite3"));
  db.pragma("busy_timeout = 8000");
  const r = runLeadLinking(db, leads);

  console.log("\n== RESULTADO ==");
  console.log(`  lead_directory: ${r.dirCount} filas`);
  console.log(`  chats totales: ${r.chatsTotal}`);
  console.log(`  · por teléfono → vinculados: ${r.chatsLinked} (con VARIOS leads mismo tel: ${r.chatsMulti}) · sin lead: ${r.chatsNoLead}`);
  console.log(`  · sin teléfono (@lid/intl), por NOMBRE → vinculados: ${r.chatsLinkedByName} · sin lead: ${r.chatsNoLeadByName} · AMBIGUOS (sin linkar): ${r.chatsAmbiguousByName}`);
  console.log(`  enlaces auto activos escritos: ${r.linkCount}`);
  console.log(`  enlaces auto obsoletos desactivados: ${r.removed}`);
  if (r.ambiguous.length) {
    console.log(`\n  Ambiguos por nombre (pendientes de resolver a mano):`);
    for (const a of r.ambiguous.slice(0, 30)) {
      console.log(`    - ${a.jid} ("${a.display_name}") → ${a.candidatos.join(" | ")}`);
    }
    if (r.ambiguous.length > 30) console.log(`    ...y ${r.ambiguous.length - 30} más.`);
  }

  const activos = (db.prepare("SELECT count(DISTINCT chat_jid) n FROM chat_lead_links WHERE status='active'").get() as { n: number }).n;
  console.log(`  → chats con enlace ACTIVO en BD: ${activos}`);
  db.close();
}

main().catch((e) => { console.error("[fatal]", e); process.exit(1); });
