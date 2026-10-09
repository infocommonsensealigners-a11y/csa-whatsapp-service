/**
 * Un lote que falla al guardarse NO pierde mensajes: se reintenta uno a uno, lo
 * que sigue fallando se aparta y entra en el siguiente reintento.
 *   npx tsx scripts/test-ingesta-fallida.ts
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ingesta-fallida-"));
process.env.WA_DATA_DIR = dir;
let fallos = 0;
let oks = 0;
const ok = (c: unknown, q: string, d?: unknown) => { if (c) oks++; else { fallos++; console.error("✗", q, d ?? ""); } };

async function main(): Promise<void> {
  const { openDb, getDb } = await import("../src/db/db");
  openDb();
  const { ingestMessages, ingestaPendiente, reintentarIngestaFallida } = await import("../src/wa/ingestCore");
  const db = getDb();
  const now = Math.floor(Date.now() / 1000);
  const m = (id: string, texto: string) => ({ key: { remoteJid: "34611000009@s.whatsapp.net", fromMe: false, id }, messageTimestamp: now, message: { conversation: texto } }) as never;

  // Un mensaje "envenenado": la base lo rechaza (simula disco lleno / dato raro).
  db.exec(`CREATE TRIGGER veneno BEFORE INSERT ON messages WHEN NEW.id = 'MALO' BEGIN SELECT RAISE(ABORT, 'simulado'); END;`);
  const r = ingestMessages([m("BUENO1", "uno"), m("MALO", "dos"), m("BUENO2", "tres")], { modo: "notify", now });
  const ids = (db.prepare(`SELECT id FROM messages ORDER BY id`).all() as Array<{ id: string }>).map((x) => x.id);
  ok(ids.includes("BUENO1") && ids.includes("BUENO2") && !ids.includes("MALO"), "los buenos del lote entran aunque uno falle", ids);
  ok(r.entrantes.length === 2, "y avisan a campañas (2, sin repetir)", r.entrantes.length);
  ok(ingestaPendiente() === 1, "el malo queda apartado, no perdido");

  // Sigue fallando: suma intento, no se duplica.
  const r1 = reintentarIngestaFallida();
  ok(r1.ok === 0 && r1.siguen === 1 && ingestaPendiente() === 1, "reintento con el fallo aún presente: sigue apartado, sin duplicar", r1);

  // Se arregla la causa: entra.
  db.exec(`DROP TRIGGER veneno`);
  const r2 = reintentarIngestaFallida();
  ok(r2.ok === 1 && ingestaPendiente() === 0, "arreglado: entra y se borra de apartados", r2);
  ok((db.prepare(`SELECT text FROM messages WHERE id='MALO'`).get() as { text: string } | undefined)?.text === "dos", "con su texto");

  db.close();
  fs.rmSync(dir, { recursive: true, force: true });
  console.log(fallos ? `✗ ${fallos} fallos, ${oks} OK` : `✓ ingesta-fallida: ${oks} OK`);
  process.exit(fallos ? 1 : 0);
}
void main();
