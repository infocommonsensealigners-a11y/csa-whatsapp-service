/**
 * Valida el matching WhatsApp ↔ CRM (`src/brain/linkLeads.ts`) contra SQLite
 * REAL en memoria.
 *
 * ⚠️ EL CASO QUE LO ORIGINA (usuario, 9-sep-2026). En la ficha de «Ramon»
 * (fila 2286 del CRM, teléfono 659544123, lead nuevo de PUBLI ESTAN) apareció
 * una conversación de **abril de 2024 sobre la certificación de Invisalign**
 * que era de OTRA persona: el chat es `34631317185`.
 *
 * Cómo pasó: el chat tiene teléfono conocido (631317185), ese número no está en
 * el Sheet, y el matcher entonces «rescata» por NOMBRE — sin comprobar que el
 * teléfono del lead candidato es OTRO. Con un solo «Ramon» en el CRM, casó.
 *
 * Aquí un fallo no es un pixel: enseña la conversación de un desconocido en la
 * ficha de un cliente, y Fransua razona sobre ella (su resumen ya hablaba de una
 * propuesta de 2024 que este Ramon nunca recibió). Es peor que no tener enlace.
 *
 *   npx tsx scripts/test-link-leads.ts
 */
import Database from "better-sqlite3";
import { runLeadLinking, type DatasetLead } from "../src/brain/linkLeads";

let fallos = 0;
function esperar(caso: string, real: unknown, esperado: unknown): void {
  const a = JSON.stringify(real);
  const b = JSON.stringify(esperado);
  const ok = a === b;
  if (!ok) fallos++;
  console.log(`${ok ? "✓" : "✗"} ${caso}`);
  if (!ok) console.log(`    esperado: ${b}\n    real:     ${a}`);
}

/** BD mínima con lo que toca `runLeadLinking`. */
function nuevaDb(chats: { jid: string; phone: string | null; display_name: string | null }[]) {
  const db = new Database(":memory:");
  db.exec(`
    CREATE TABLE chats (jid TEXT PRIMARY KEY, phone TEXT, display_name TEXT);
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
  const ins = db.prepare("INSERT INTO chats (jid, phone, display_name) VALUES (?,?,?)");
  for (const c of chats) ins.run(c.jid, c.phone, c.display_name);
  return db;
}

/** Enlaces ACTIVOS que quedan, como "jid→fila". */
function enlaces(db: Database.Database): string[] {
  return (
    db
      .prepare("SELECT chat_jid, source_row FROM chat_lead_links WHERE status='active' ORDER BY chat_jid, source_row")
      .all() as { chat_jid: string; source_row: number }[]
  ).map((r) => `${r.chat_jid}→${r.source_row}`);
}

const lead = (sourceRow: number, telefono: string, nombre: string): DatasetLead => ({
  sourceRow,
  telefono,
  nombre,
  estado: { canonical: "Sin contactar" },
});

/* ── EL CASO RAMON ────────────────────────────────────────────────────────── */
console.log("── el caso Ramon: teléfono conocido y DISTINTO ──");
{
  const db = nuevaDb([
    // Chat @lid con el teléfono ya rescatado de senderPn: 631317185.
    { jid: "152089187643632@lid", phone: "631317185", display_name: "Ramon" },
  ]);
  const r = runLeadLinking(db, [lead(2286, "659544123", "Ramon")]);
  esperar("NO se casa un chat con teléfono que no es el del lead", enlaces(db), []);
  esperar("y se reporta para revisión, no en silencio", r.chatsAmbiguousByName, 1);
  esperar("no cuenta como casado por nombre", r.chatsLinkedByName, 0);
}

/* ── que el arreglo no rompa lo que SÍ funcionaba ─────────────────────────── */
console.log("\n── el teléfono sigue mandando cuando coincide ──");
{
  const db = nuevaDb([{ jid: "34659544123@s.whatsapp.net", phone: "659544123", display_name: "Ramon" }]);
  runLeadLinking(db, [lead(2286, "659544123", "Ramon")]);
  esperar("mismo teléfono → casa por teléfono", enlaces(db), ["34659544123@s.whatsapp.net→2286"]);
}
{
  const db = nuevaDb([{ jid: "34600111222@s.whatsapp.net", phone: "600111222", display_name: "cualquier cosa" }]);
  runLeadLinking(db, [lead(10, "+34 600 111 222", "María Teresa Rodríguez")]);
  esperar("el teléfono manda aunque el nombre no se parezca", enlaces(db), ["34600111222@s.whatsapp.net→10"]);
}
{
  // Internacional: el número completo con prefijo, igualdad exacta.
  const db = nuevaDb([{ jid: "5491133445566@s.whatsapp.net", phone: null, display_name: "Sofía" }]);
  runLeadLinking(db, [lead(11, "5491133445566", "Sofía Giménez")]);
  esperar("un internacional casa por su número completo", enlaces(db), ["5491133445566@s.whatsapp.net→11"]);
}

console.log("\n── el rescate por NOMBRE, solo cuando no hay contradicción ──");
{
  // @lid SIN teléfono rescatado y nombre COMPLETO: es el caso para el que se
  // hizo la vía por nombre, y tiene que seguir funcionando.
  const db = nuevaDb([{ jid: "9988776655@lid", phone: null, display_name: "María Teresa Rodríguez" }]);
  const r = runLeadLinking(db, [lead(12, "600999888", "María Teresa Rodríguez")]);
  esperar("sin teléfono y con nombre completo: casa", enlaces(db), ["9988776655@lid→12"]);
  esperar("y se cuenta como casado por nombre", r.chatsLinkedByName, 1);
}
{
  /**
   * ⚠️ UN NOMBRE DE PILA SOLO NO BASTA, aunque no haya teléfono en el chat. Es
   * la otra mitad del caso Ramon: hoy hay un «Ramon» en el CRM y mañana dos, y
   * el enlace ya estaría hecho a ciegas sobre el primero.
   */
  const db = nuevaDb([{ jid: "1122334455@lid", phone: null, display_name: "Ramon" }]);
  const r = runLeadLinking(db, [lead(2286, "659544123", "Ramon")]);
  esperar("un solo nombre de pila NO casa a ciegas", enlaces(db), []);
  esperar("va a revisión manual", r.chatsAmbiguousByName, 1);
}
{
  // Dos homónimos: nunca a ciegas (esto ya funcionaba, se blinda con un test).
  const db = nuevaDb([{ jid: "5566778899@lid", phone: null, display_name: "Ana Ruiz" }]);
  const r = runLeadLinking(db, [lead(20, "600000001", "Ana Ruiz"), lead(21, "600000002", "Ana Ruiz")]);
  esperar("dos leads con el mismo nombre: ninguno", enlaces(db), []);
  esperar("y los dos se reportan", r.chatsAmbiguousByName, 1);
}
{
  // El lead ya tiene SU conversación por teléfono: no se le cuelga otra.
  const db = nuevaDb([
    { jid: "34600555444@s.whatsapp.net", phone: "600555444", display_name: "Luis Prieto" },
    { jid: "7766554433@lid", phone: null, display_name: "Luis Prieto" },
  ]);
  runLeadLinking(db, [lead(30, "600555444", "Luis Prieto")]);
  esperar("solo su chat de verdad", enlaces(db), ["34600555444@s.whatsapp.net→30"]);
}

/* ── el enlace erróneo se AUTO-LIMPIA en la siguiente pasada ──────────────── */
console.log("\n── un enlace ya escrito por error se retira solo ──");
{
  const db = nuevaDb([{ jid: "152089187643632@lid", phone: "631317185", display_name: "Ramon" }]);
  // Se siembra el enlace malo tal como estaba en producción.
  db.prepare(
    `INSERT INTO chat_lead_links (chat_jid, source_row, method, status, created_at, updated_at)
     VALUES ('152089187643632@lid', 2286, 'auto', 'active', 0, 0)`
  ).run();
  esperar("estaba puesto", enlaces(db), ["152089187643632@lid→2286"]);
  runLeadLinking(db, [lead(2286, "659544123", "Ramon")]);
  esperar("y la pasada siguiente lo retira", enlaces(db), []);
}
{
  // Y un enlace MANUAL no se toca nunca, ni siquiera si contradice el teléfono:
  // lo puso una persona a sabiendas.
  const db = nuevaDb([{ jid: "152089187643632@lid", phone: "631317185", display_name: "Ramon" }]);
  db.prepare(
    `INSERT INTO chat_lead_links (chat_jid, source_row, method, status, created_at, updated_at)
     VALUES ('152089187643632@lid', 2286, 'manual', 'active', 0, 0)`
  ).run();
  runLeadLinking(db, [lead(2286, "659544123", "Ramon")]);
  esperar("el enlace MANUAL sobrevive", enlaces(db), ["152089187643632@lid→2286"]);
}

console.log(`\n${fallos === 0 ? "✓ TODO OK" : `✗ ${fallos} FALLOS`}`);
process.exit(fallos === 0 ? 0 : 1);
