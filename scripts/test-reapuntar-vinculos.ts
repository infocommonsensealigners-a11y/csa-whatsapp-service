/**
 * Valida que los vínculos MANUALES chat ↔ lead se reencuentran cuando la hoja
 * se mueve (`src/brain/reapuntarVinculos.ts`), contra SQLite REAL en memoria.
 *
 * ⚠️ EL CASO QUE LO ORIGINA (05-10-2026): la fusión de duplicados borró 212
 * filas de la hoja. Todo lo de debajo subió de número y los vínculos manuales,
 * que el emparejador automático no toca, se quedaron señalando a la persona de
 * la fila de al lado.
 *
 *   npx tsx scripts/test-reapuntar-vinculos.ts
 */
import Database from "better-sqlite3";
import { runLeadLinking, type DatasetLead } from "../src/brain/linkLeads";
import { planIntelDesdeVinculos, reapuntarVinculosManuales } from "../src/brain/reapuntarVinculos";

let fallos = 0;
function esperar(caso: string, real: unknown, esperado: unknown): void {
  const a = JSON.stringify(real);
  const b = JSON.stringify(esperado);
  const ok = a === b;
  if (!ok) fallos++;
  console.log(`${ok ? "✓" : "✗"} ${caso}`);
  if (!ok) console.log(`    esperado: ${b}\n    real:     ${a}`);
}

function nuevaDb(chats: { jid: string; phone: string | null; display_name: string | null; alias_of?: string | null }[]) {
  const db = new Database(":memory:");
  db.exec(`
    CREATE TABLE chats (jid TEXT PRIMARY KEY, phone TEXT, display_name TEXT, alias_of TEXT);
    CREATE TABLE lead_directory (source_row INTEGER PRIMARY KEY, phone TEXT, name TEXT, estado TEXT, synced_at INTEGER);
    CREATE TABLE chat_lead_links (
      id INTEGER PRIMARY KEY, chat_jid TEXT NOT NULL, source_row INTEGER NOT NULL,
      phone_snapshot TEXT, lead_name_snapshot TEXT,
      method TEXT NOT NULL CHECK (method IN ('auto','manual')),
      status TEXT NOT NULL CHECK (status IN ('active','removed')),
      created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
      UNIQUE (chat_jid, source_row)
    );
  `);
  const ins = db.prepare("INSERT INTO chats (jid, phone, display_name, alias_of) VALUES (?,?,?,?)");
  for (const c of chats) ins.run(c.jid, c.phone, c.display_name, c.alias_of ?? null);
  return db;
}
function manual(db: Database.Database, jid: string, fila: number, phone: string | null, name: string | null, updatedAt = 1000): void {
  db.prepare(
    "INSERT INTO chat_lead_links (chat_jid, source_row, phone_snapshot, lead_name_snapshot, method, status, created_at, updated_at) VALUES (?,?,?,?,'manual','active',?,?)",
  ).run(jid, fila, phone, name, updatedAt, updatedAt);
}
const activos = (db: Database.Database): string[] =>
  (db.prepare("SELECT chat_jid, source_row, method FROM chat_lead_links WHERE status='active' ORDER BY chat_jid, source_row").all() as { chat_jid: string; source_row: number; method: string }[]).map(
    (r) => `${r.chat_jid}→${r.source_row}(${r.method})`,
  );

/** Un CRM de relleno (hace falta un mínimo de filas para que la foto se dé por buena) + los leads del caso. */
function crm(extra: DatasetLead[]): DatasetLead[] {
  const relleno: DatasetLead[] = Array.from({ length: 120 }, (_, i) => ({ sourceRow: 2 + i, telefono: `6${String(10000000 + i)}`, nombre: `Relleno Número ${i}` }));
  return [...relleno, ...extra];
}

/* ── 1. La fila sigue siendo la persona: no se toca ───────────────────────── */
{
  const db = nuevaDb([{ jid: "lid1@lid", phone: null, display_name: "Marta" }]);
  manual(db, "lid1@lid", 500, "611222333", "Marta Cuadra Ruiz");
  const r = reapuntarVinculosManuales(db, crm([{ sourceRow: 500, telefono: "+34 611 222 333", nombre: "Marta Cuadra Ruiz" }]), { aplicar: true });
  esperar("fila con el teléfono guardado → bien, no se mueve", [r.bien, r.movidos, activos(db)], [1, 0, ["lid1@lid→500(manual)"]]);
}

/* ── 2. EL CASO: se borran filas por encima y la persona sube ─────────────── */
{
  const db = nuevaDb([{ jid: "lid1@lid", phone: null, display_name: "Marta" }]);
  manual(db, "lid1@lid", 500, "611222333", "Marta Cuadra Ruiz");
  // Tras borrar 20 filas: Marta está en la 480 y en la 500 hay otra persona.
  const hoy = crm([
    { sourceRow: 480, telefono: "611222333", nombre: "Marta Cuadra Ruiz" },
    { sourceRow: 500, telefono: "699000111", nombre: "Nerea Lobe" },
  ]);
  const medir = reapuntarVinculosManuales(db, hoy, { aplicar: false });
  esperar("solo medir: lo detecta y NO escribe", [medir.movidos, medir.dryRun, activos(db)], [1, true, ["lid1@lid→500(manual)"]]);
  const r = reapuntarVinculosManuales(db, hoy, { aplicar: true });
  esperar("aplicar: el vínculo pasa a la fila de hoy y sigue siendo manual", [r.movedPairs, activos(db)], [[{ jid: "lid1@lid", de: 500, a: 480 }], ["lid1@lid→480(manual)"]]);
  // Y el emparejador automático no lo deshace en la pasada siguiente.
  runLeadLinking(db, hoy);
  esperar("…y runLeadLinking lo respeta", activos(db), ["lid1@lid→480(manual)"]);
  esperar("segunda pasada: ya está bien, nada que mover", reapuntarVinculosManuales(db, hoy, { aplicar: true }).movidos, 0);
}

/* ── 3. El par de destino ya existía como auto: se asciende, no se duplica ── */
{
  const db = nuevaDb([{ jid: "34611222333@s.whatsapp.net", phone: "611222333", display_name: "Marta" }]);
  manual(db, "34611222333@s.whatsapp.net", 500, "611222333", "Marta Cuadra Ruiz");
  const hoy = crm([
    { sourceRow: 480, telefono: "611222333", nombre: "Marta Cuadra Ruiz" },
    { sourceRow: 500, telefono: "699000111", nombre: "Nerea Lobe" },
  ]);
  runLeadLinking(db, hoy); // crea el auto (chat → 480) por teléfono
  const r = reapuntarVinculosManuales(db, hoy, { aplicar: true });
  esperar("destino ya enlazado en auto → queda UN vínculo, manual, en la fila buena", [r.movidos, activos(db)], [1, ["34611222333@s.whatsapp.net→480(manual)"]]);
}

/* ── 4. Dudas: no se toca ─────────────────────────────────────────────────── */
{
  const db = nuevaDb([{ jid: "a@lid", phone: null, display_name: "x" }, { jid: "b@lid", phone: null, display_name: "y" }, { jid: "c@lid", phone: null, display_name: "z" }]);
  manual(db, "a@lid", 500, "611222333", "Ana"); // teléfono en DOS filas, y el nombre no desempata
  manual(db, "b@lid", 501, null, "Ramon"); // solo un nombre de pila, y ya no está en su fila
  manual(db, "c@lid", 502, null, null); // sin instantánea
  const hoy = crm([
    { sourceRow: 300, telefono: "611222333", nombre: "Ana López" },
    { sourceRow: 301, telefono: "611222333", nombre: "Clínica López" },
    { sourceRow: 400, telefono: "600111222", nombre: "Ramon" },
    { sourceRow: 500, telefono: "699000111", nombre: "Otra Persona" },
    { sourceRow: 501, telefono: "699000112", nombre: "Otra Más" },
    { sourceRow: 502, telefono: "699000113", nombre: "Y Otra" },
  ]);
  const r = reapuntarVinculosManuales(db, hoy, { aplicar: true });
  esperar("teléfono repetido / nombre de pila / sin instantánea → nada se mueve", [r.movidos, r.revisar, r.sinInstantanea, activos(db)], [0, 2, 1, ["a@lid→500(manual)", "b@lid→501(manual)", "c@lid→502(manual)"]]);
}

/* ── 5. Teléfono repetido, pero el nombre guardado señala a una ───────────── */
{
  const db = nuevaDb([{ jid: "a@lid", phone: null, display_name: "x" }]);
  manual(db, "a@lid", 500, "611222333", "Ana López García");
  const hoy = crm([
    { sourceRow: 300, telefono: "611222333", nombre: "Ana López García" },
    { sourceRow: 301, telefono: "611222333", nombre: "Clínica López" },
    { sourceRow: 500, telefono: "699000111", nombre: "Otra Persona" },
  ]);
  esperar("el nombre desempata entre dos filas con el mismo teléfono", reapuntarVinculosManuales(db, hoy, { aplicar: true }).movedPairs, [{ jid: "a@lid", de: 500, a: 300 }]);
}

/* ── 6. Persona fusionada: el teléfono guardado es uno de sus alternativos ── */
{
  const db = nuevaDb([{ jid: "a@lid", phone: null, display_name: "x" }]);
  manual(db, "a@lid", 500, "622333444", "Marta Cuadra");
  // La fila 500 (segundo número de Marta) se fundió en la 480: su teléfono viaja en `telefonosAlt`.
  const hoy = crm([
    { sourceRow: 480, telefono: "611222333", telefonosAlt: [{ telefono: "622333444", fila: null }], nombre: "Marta Cuadra Ruiz" },
    { sourceRow: 500, telefono: "699000111", nombre: "Nerea Lobe" },
  ]);
  esperar("fila absorbida en una fusión → el vínculo va a la principal", reapuntarVinculosManuales(db, hoy, { aplicar: true }).movedPairs, [{ jid: "a@lid", de: 500, a: 480 }]);
}

/* ── 7. Solo nombre completo guardado ─────────────────────────────────────── */
{
  const db = nuevaDb([{ jid: "a@lid", phone: null, display_name: "x" }]);
  manual(db, "a@lid", 500, null, "María Teresa Rodríguez");
  const hoy = crm([
    { sourceRow: 470, telefono: "", nombre: "Maria Teresa Rodriguez" },
    { sourceRow: 500, telefono: "699000111", nombre: "Nerea Lobe" },
  ]);
  esperar("sin teléfono: un nombre COMPLETO único sí reencuentra", reapuntarVinculosManuales(db, hoy, { aplicar: true }).movedPairs, [{ jid: "a@lid", de: 500, a: 470 }]);
}

/* ── 8. Sin instantánea + mapa de filas de la fusión ──────────────────────── */
{
  const db = nuevaDb([{ jid: "viejo@lid", phone: null, display_name: "x" }, { jid: "nuevo@lid", phone: null, display_name: "y" }]);
  manual(db, "viejo@lid", 500, null, null, 1000); // de antes de la fusión
  manual(db, "nuevo@lid", 510, null, null, 9000); // creado después: ya nació con la fila nueva
  const hoy = crm([
    { sourceRow: 480, telefono: "611222333", nombre: "Marta" },
    { sourceRow: 490, telefono: "611222334", nombre: "Otra" },
    { sourceRow: 500, telefono: "699000111", nombre: "Nerea" },
    { sourceRow: 510, telefono: "699000112", nombre: "Lucía" },
  ]);
  const mapa = new Map([[500, 480], [510, 490]]);
  const r = reapuntarVinculosManuales(db, hoy, { aplicar: true, mapa, antesDe: 5000 });
  esperar("el mapa mueve el vínculo anterior a la fusión y NO el posterior", [r.movedPairs, r.sinInstantanea, activos(db)], [[{ jid: "viejo@lid", de: 500, a: 480 }], 1, ["nuevo@lid→510(manual)", "viejo@lid→480(manual)"]]);
}

/* ── 9. Foto del CRM rota: no se decide nada ──────────────────────────────── */
{
  const db = nuevaDb([{ jid: "a@lid", phone: null, display_name: "x" }]);
  manual(db, "a@lid", 500, "611222333", "Marta Cuadra");
  const r = reapuntarVinculosManuales(db, [{ sourceRow: 480, telefono: "611222333", nombre: "Marta Cuadra" }], { aplicar: true });
  esperar("con media hoja no se mueve ningún vínculo", [r.movidos, r.dryRun, activos(db)], [0, true, ["a@lid→500(manual)"]]);
}

/* ── 10. Se completa la instantánea cuando la fila es la buena ────────────── */
{
  const db = nuevaDb([{ jid: "a@lid", phone: null, display_name: "x" }]);
  manual(db, "a@lid", 500, null, "Marta Cuadra Ruiz");
  const r = reapuntarVinculosManuales(db, crm([{ sourceRow: 500, telefono: "611222333", nombre: "Marta Cuadra Ruiz" }]), { aplicar: true });
  const fila = db.prepare("SELECT phone_snapshot FROM chat_lead_links WHERE chat_jid='a@lid'").get() as { phone_snapshot: string | null };
  esperar("faltaba el teléfono y la fila es la buena → se guarda", [r.completados, fila.phone_snapshot], [1, "611222333"]);
}

/* ── 11. La copia en chat_intel ───────────────────────────────────────────── */
{
  const db = nuevaDb([
    { jid: "tel@s.whatsapp.net", phone: "611222333", display_name: "Marta" },
    { jid: "lid@lid", phone: null, display_name: "Marta", alias_of: "tel@s.whatsapp.net" },
    { jid: "suelto@s.whatsapp.net", phone: "600000000", display_name: "Nadie" },
    { jid: "doble@s.whatsapp.net", phone: "655000000", display_name: "Dos" },
  ]);
  const link = db.prepare("INSERT INTO chat_lead_links (chat_jid, source_row, method, status, created_at, updated_at) VALUES (?,?,?,?,1,1)");
  link.run("tel@s.whatsapp.net", 480, "auto", "active");
  link.run("doble@s.whatsapp.net", 300, "auto", "active");
  link.run("doble@s.whatsapp.net", 700, "manual", "active"); // el manual manda, como en analyzeChat
  link.run("doble@s.whatsapp.net", 200, "auto", "removed");
  const plan = planIntelDesdeVinculos(db, [
    { jid: "tel@s.whatsapp.net", source_row: 500 }, // movida → 480
    { jid: "lid@lid", source_row: null }, // alias: hereda el vínculo del chat del teléfono
    { jid: "suelto@s.whatsapp.net", source_row: 900 }, // sin vínculo activo → fuera la fila
    { jid: "doble@s.whatsapp.net", source_row: 700 }, // ya está bien
    { jid: "import:alguien", source_row: 123 }, // chat que la base local no conoce → no se toca
  ]);
  esperar("plan de la copia: mueve, hereda del alias, quita y respeta", plan, [
    { jid: "tel@s.whatsapp.net", de: 500, a: 480 },
    { jid: "lid@lid", de: null, a: 480 },
    { jid: "suelto@s.whatsapp.net", de: 900, a: null },
  ]);
}

console.log(fallos === 0 ? "\n✓ test-reapuntar-vinculos: todo bien" : `\n✗ ${fallos} fallo(s)`);
process.exit(fallos === 0 ? 0 : 1);
