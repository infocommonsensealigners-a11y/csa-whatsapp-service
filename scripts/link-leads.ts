/**
 * Vincula chats de WhatsApp ↔ leads del CRM por teléfono (determinista, sin IA).
 *
 * Lee los leads del dashboard (GET /api/dataset), rellena `lead_directory` y
 * recalcula `chat_lead_links` (method='auto', status='active') casando el
 * teléfono canónico ES (9 díg.) de cada chat con el de cada lead. Idempotente:
 * re-ejecutar actualiza; los enlaces 'manual' NO se tocan; los 'auto' que ya no
 * casen se marcan 'removed'.
 *
 * Uso (desde whatsapp-service/):
 *   DASH_PW=<contraseña> npx tsx scripts/link-leads.ts
 * Env opcional: DASH_URL (def http://localhost:3210), DASH_EMAIL (def miguelangel@…).
 *
 * NO envía nada a WhatsApp ni escribe en el Sheet: solo la SQLite local.
 */
import Database from "better-sqlite3";
import path from "node:path";

const DASH_URL = process.env.DASH_URL ?? "http://localhost:3210";
const DASH_EMAIL = process.env.DASH_EMAIL ?? "miguelangel@ortodoncialozano.es";
const DASH_PW = process.env.DASH_PW;
if (!DASH_PW) {
  console.error("Falta DASH_PW (contraseña del dashboard). Uso: DASH_PW=… npx tsx scripts/link-leads.ts");
  process.exit(1);
}

/** Móvil ES canónico (9 díg.) o null. Tolera +34 / 0034 / espacios. */
function canon(raw: unknown): string | null {
  const d = String(raw ?? "").replace(/\D/g, "");
  let x = d;
  if (x.length === 11 && x.startsWith("34")) x = x.slice(2);
  else if (x.length === 13 && x.startsWith("0034")) x = x.slice(4);
  return /^[6789]\d{8}$/.test(x) ? x : null;
}

interface Lead { sourceRow: number; telefono?: string; nombre?: string; estado?: { canonical?: string } }

async function main() {
  const now = Math.floor(Date.now() / 1000);

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
    csaLeads?: Lead[];
  };
  const leads = ds.csaLeads ?? [];
  console.log(`Leads recibidos del dashboard: ${leads.length}`);

  // Índice teléfono → leads (un teléfono puede repetirse en varias filas).
  const byPhone = new Map<string, { sourceRow: number; name: string; estado: string | null }[]>();
  const dirRows: { sourceRow: number; phone: string; name: string; estado: string | null }[] = [];
  for (const l of leads) {
    const phone = canon(l.telefono);
    if (!phone) continue;
    const name = (l.nombre ?? "").trim();
    const estado = l.estado?.canonical ?? null;
    dirRows.push({ sourceRow: l.sourceRow, phone, name, estado });
    const arr = byPhone.get(phone) ?? [];
    arr.push({ sourceRow: l.sourceRow, name, estado });
    byPhone.set(phone, arr);
  }
  console.log(`Leads con móvil ES válido: ${dirRows.length} · teléfonos distintos: ${byPhone.size}`);

  // 3) BD.
  const db = new Database(path.join(process.cwd(), "data", "wa.sqlite3"));
  db.pragma("busy_timeout = 8000");

  const upDir = db.prepare(
    `INSERT INTO lead_directory (source_row, phone, name, estado, synced_at)
     VALUES (@sourceRow, @phone, @name, @estado, @now)
     ON CONFLICT(source_row) DO UPDATE SET
       phone=excluded.phone, name=excluded.name, estado=excluded.estado, synced_at=excluded.synced_at`
  );
  const upLink = db.prepare(
    `INSERT INTO chat_lead_links
       (chat_jid, source_row, phone_snapshot, lead_name_snapshot, method, status, created_at, updated_at)
     VALUES (@jid, @sourceRow, @phone, @name, 'auto', 'active', @now, @now)
     ON CONFLICT(chat_jid, source_row) DO UPDATE SET
       phone_snapshot=excluded.phone_snapshot,
       lead_name_snapshot=excluded.lead_name_snapshot,
       status='active', updated_at=excluded.updated_at
     WHERE chat_lead_links.method='auto'`
  );
  // Enlaces 'auto' que ya no casan → 'removed' (self-healing). Los 'manual' intactos.
  const staleLinks = db.prepare(
    `SELECT chat_jid, source_row FROM chat_lead_links WHERE method='auto' AND status='active'`
  );
  const markRemoved = db.prepare(
    `UPDATE chat_lead_links SET status='removed', updated_at=@now WHERE chat_jid=@jid AND source_row=@sourceRow`
  );

  const chats = db.prepare("SELECT jid, phone FROM chats WHERE phone IS NOT NULL").all() as {
    jid: string; phone: string;
  }[];

  let dirCount = 0, linkCount = 0, chatsLinked = 0, chatsMulti = 0, chatsNoLead = 0;
  const wanted = new Set<string>(); // `${jid}|${sourceRow}` que deben quedar activos

  const tx = db.transaction(() => {
    for (const d of dirRows) {
      upDir.run({ ...d, now });
      dirCount++;
    }
    for (const c of chats) {
      const matches = byPhone.get(c.phone) ?? [];
      if (matches.length === 0) { chatsNoLead++; continue; }
      if (matches.length > 1) chatsMulti++;
      chatsLinked++;
      for (const m of matches) {
        upLink.run({ jid: c.jid, sourceRow: m.sourceRow, phone: c.phone, name: m.name, now });
        wanted.add(`${c.jid}|${m.sourceRow}`);
        linkCount++;
      }
    }
    // Self-healing: desactivar auto-links previos que ya no procedan.
    let removed = 0;
    for (const l of staleLinks.all() as { chat_jid: string; source_row: number }[]) {
      if (!wanted.has(`${l.chat_jid}|${l.source_row}`)) {
        markRemoved.run({ jid: l.chat_jid, sourceRow: l.source_row, now });
        removed++;
      }
    }
    return removed;
  });
  const removed = tx();

  console.log("\n== RESULTADO ==");
  console.log(`  lead_directory: ${dirCount} filas`);
  console.log(`  chats con teléfono: ${chats.length}`);
  console.log(`  chats vinculados a ≥1 lead: ${chatsLinked}`);
  console.log(`    · de ellos con VARIOS leads (mismo tel duplicado): ${chatsMulti}`);
  console.log(`  chats con teléfono pero SIN lead en CRM: ${chatsNoLead}`);
  console.log(`  enlaces auto activos escritos: ${linkCount}`);
  console.log(`  enlaces auto obsoletos desactivados: ${removed}`);

  const activos = (db.prepare("SELECT count(DISTINCT chat_jid) n FROM chat_lead_links WHERE status='active'").get() as { n: number }).n;
  console.log(`  → chats con enlace ACTIVO en BD: ${activos}`);
  db.close();
}

main().catch((e) => { console.error("[fatal]", e); process.exit(1); });
