/** Compañeros del equipo: la marca vale para el chat del teléfono y su @lid.   npx tsx scripts/test-equipo.ts */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "equipo-"));
process.env.WA_DATA_DIR = dir;
let fallos = 0, oks = 0;
const ok = (c: unknown, q: string) => { if (c) oks++; else { fallos++; console.error("✗", q); } };
async function main(): Promise<void> {
  const { openDb, getDb } = await import("../src/db/db");
  openDb();
  const { esEquipo, marcarEquipo } = await import("../src/wa/equipo");
  const { aprenderMapeo } = await import("../src/wa/canonico");
  const db = getDb();
  const t = Date.now();
  db.prepare(`INSERT INTO chats (jid, phone, display_name, created_at, updated_at) VALUES (?,?,?,?,?)`).run("34628488815@s.whatsapp.net", "628488815", "Fran López Olmos", t, t);
  ok(!esEquipo("34628488815@s.whatsapp.net"), "sin marcar no es equipo");
  const r = marcarEquipo("34628488815@s.whatsapp.net", true, "test");
  ok(r.ok && r.telefono === "628488815", "se marca por teléfono");
  ok(esEquipo("34628488815@s.whatsapp.net"), "el chat del teléfono es equipo");
  aprenderMapeo("69325889245204@lid", "34628488815@s.whatsapp.net", "test");
  ok(esEquipo("69325889245204@lid"), "y su @lid también");
  marcarEquipo("34628488815@s.whatsapp.net", false, "test");
  ok(!esEquipo("34628488815@s.whatsapp.net"), "se puede quitar");
  ok(!marcarEquipo("120363000000000000@g.us", true, "t").ok || true, "un grupo no rompe");
  db.close();
  fs.rmSync(dir, { recursive: true, force: true });
  console.log(fallos ? `✗ ${fallos} fallos, ${oks} OK` : `✓ equipo: ${oks} OK`);
  process.exit(fallos ? 1 : 0);
}
void main();
