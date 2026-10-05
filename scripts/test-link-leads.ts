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

/* ── PERSONA FUSIONADA: varios teléfonos en una sola ficha ────────────────── */
/**
 * 02-10-2026. El dashboard funde las filas repetidas del CRM en una persona, y
 * los números de las filas absorbidas llegan en `telefonosAlt` (objetos
 * `{ telefono }`). Antes de esto, al fundirse la fila el chat del SEGUNDO número
 * se quedaba sin lead: su teléfono ya no estaba en ninguna fila, caía al rescate
 * por nombre y lo vetaba la barrera 1 («su teléfono es otro»).
 *
 * Lo que NO puede pasar es lo contrario: que tener dos números afloje el veto.
 * Todos los teléfonos de este bloque son inventados (salvo los del caso Ramon).
 */
const fusionado = (sourceRow: number, telefono: string, alt: string[], nombre: string): DatasetLead => ({
  ...lead(sourceRow, telefono, nombre),
  telefonosAlt: alt.map((t, i) => ({ telefono: t, fila: sourceRow + 100 + i })),
});
/** El teléfono que queda en el directorio para una fila. */
const telDirectorio = (db: Database.Database, fila: number): string | null =>
  (db.prepare("SELECT phone FROM lead_directory WHERE source_row = ?").get(fila) as { phone: string | null } | undefined)
    ?.phone ?? null;

console.log("\n── persona fusionada: el chat del SEGUNDO número es suyo ──");
{
  const db = nuevaDb([{ jid: "34600222333@s.whatsapp.net", phone: "600222333", display_name: "Clínica Dental Sol" }]);
  const r = runLeadLinking(db, [fusionado(40, "600111000", ["600222333"], "Marta Soler Gil")]);
  esperar("el chat del teléfono alternativo se enlaza al lead", enlaces(db), ["34600222333@s.whatsapp.net→40"]);
  esperar("casa por TELÉFONO, no por nombre", [r.chatsLinked, r.chatsLinkedByName], [1, 0]);
  esperar("y no queda pendiente de revisar", r.chatsAmbiguousByName, 0);
  esperar("el directorio guarda el teléfono PRINCIPAL", telDirectorio(db, 40), "600111000");
}
{
  // Los dos números tienen conversación: las dos son de la misma persona.
  const db = nuevaDb([
    { jid: "34600111000@s.whatsapp.net", phone: "600111000", display_name: "Marta" },
    { jid: "34600222333@s.whatsapp.net", phone: "600222333", display_name: "Marta Soler" },
  ]);
  const r = runLeadLinking(db, [fusionado(40, "600111000", ["600222333"], "Marta Soler Gil")]);
  esperar("los dos chats cuelgan de la misma fila", enlaces(db), [
    "34600111000@s.whatsapp.net→40",
    "34600222333@s.whatsapp.net→40",
  ]);
  esperar("no es un teléfono repetido en dos filas", r.chatsMulti, 0);
}
{
  // El alternativo llega con prefijo y espacios, o es extranjero: misma clave que el principal.
  const db = nuevaDb([
    { jid: "34600222333@s.whatsapp.net", phone: "600222333", display_name: null },
    { jid: "5491133445566@s.whatsapp.net", phone: null, display_name: null },
  ]);
  runLeadLinking(db, [fusionado(41, "600111000", ["+34 600 22 23 33", "+54 9 11 3344-5566"], "Sofía Giménez")]);
  esperar("alternativo con prefijo / internacional: casa igual", enlaces(db), [
    "34600222333@s.whatsapp.net→41",
    "5491133445566@s.whatsapp.net→41",
  ]);
}
{
  // La fila principal no tiene teléfono y la absorbida sí: es el único que hay.
  const db = nuevaDb([{ jid: "34600222333@s.whatsapp.net", phone: "600222333", display_name: null }]);
  runLeadLinking(db, [fusionado(42, "", ["600222333"], "Nuria Vidal")]);
  esperar("sin teléfono principal, el alternativo enlaza", enlaces(db), ["34600222333@s.whatsapp.net→42"]);
  esperar("y es el que queda en el directorio", telDirectorio(db, 42), "600222333");
}
{
  // Datos sucios: el alternativo repite el principal, viene vacío, enmascarado o nulo.
  const db = nuevaDb([{ jid: "34600111000@s.whatsapp.net", phone: "600111000", display_name: null }]);
  const sucio: DatasetLead = {
    ...lead(43, "600111000", "Pablo Rey"),
    telefonosAlt: [{ telefono: "+34 600 111 000" }, { telefono: "" }, { telefono: "6•• ••• •00" }, { telefono: null }, {}],
  };
  const r = runLeadLinking(db, [sucio]);
  esperar("un alternativo que repite el principal no duplica el enlace", enlaces(db), ["34600111000@s.whatsapp.net→43"]);
  esperar("ni cuenta como teléfono compartido", [r.linkCount, r.chatsMulti], [1, 0]);
  const db2 = nuevaDb([]);
  runLeadLinking(db2, [{ ...lead(44, "600111000", "Pablo Rey"), telefonosAlt: null }]);
  esperar("telefonosAlt nulo no rompe la pasada", telDirectorio(db2, 44), "600111000");
}

console.log("\n── al fundirse la fila, el enlace se MUDA a la principal ──");
{
  // Antes de la fusión: dos filas (40 y 2300), cada una con su número y su chat.
  const db = nuevaDb([
    { jid: "34600111000@s.whatsapp.net", phone: "600111000", display_name: "Marta" },
    { jid: "34600222333@s.whatsapp.net", phone: "600222333", display_name: "Marta Soler" },
  ]);
  runLeadLinking(db, [lead(40, "600111000", "Marta Soler Gil"), lead(2300, "600222333", "Marta Soler")]);
  esperar("antes: cada chat en su fila", enlaces(db), [
    "34600111000@s.whatsapp.net→40",
    "34600222333@s.whatsapp.net→2300",
  ]);
  // Después: el dashboard ya manda UNA persona con los dos números.
  const r = runLeadLinking(db, [fusionado(40, "600111000", ["600222333"], "Marta Soler Gil")]);
  esperar("después: los dos chats en la fila principal", enlaces(db), [
    "34600111000@s.whatsapp.net→40",
    "34600222333@s.whatsapp.net→40",
  ]);
  esperar("y el enlace a la fila absorbida se avisa para limpiar su copia", r.removedPairs, [
    { jid: "34600222333@s.whatsapp.net", sourceRow: 2300 },
  ]);
}

console.log("\n── tener dos teléfonos NO afloja el veto (Ramon otra vez) ──");
{
  // El mismo chat del caso Ramon, contra un Ramon que ahora tiene DOS números:
  // el del chat sigue sin ser ninguno de los suyos.
  const db = nuevaDb([{ jid: "152089187643632@lid", phone: "631317185", display_name: "Ramon" }]);
  const r = runLeadLinking(db, [fusionado(2286, "659544123", ["600222333"], "Ramon")]);
  esperar("un tercer teléfono sigue vetado", enlaces(db), []);
  esperar("y va a revisión", [r.chatsAmbiguousByName, r.chatsLinkedByName], [1, 0]);
  esperar(
    "el aviso enseña TODOS sus teléfonos",
    r.ambiguous[0]?.candidatos[0],
    "Ramon (fila 2286) — NO se casa: sus teléfonos son 659544123 y 600222333 y el de este chat es 631317185"
  );
}
{
  // Y con nombre COMPLETO tampoco: el teléfono discordante manda sobre el nombre.
  const db = nuevaDb([{ jid: "34600999111@s.whatsapp.net", phone: "600999111", display_name: "Marta Soler Gil" }]);
  const r = runLeadLinking(db, [fusionado(40, "600111000", ["600222333"], "Marta Soler Gil")]);
  esperar("nombre completo + teléfono que no es ninguno de los suyos: no casa", enlaces(db), []);
  esperar("queda como ambiguo, no como contacto nuevo", [r.chatsAmbiguousByName, r.noMatch.length], [1, 0]);
}
{
  // El texto del veto con UN solo teléfono no cambia: Ajustes → Vincular WhatsApp lo lee.
  const db = nuevaDb([{ jid: "152089187643632@lid", phone: "631317185", display_name: "Ramon" }]);
  const r = runLeadLinking(db, [lead(2286, "659544123", "Ramon")]);
  esperar(
    "con un teléfono, el aviso es el de siempre",
    r.ambiguous[0]?.candidatos[0],
    "Ramon (fila 2286) — NO se casa: su teléfono es 659544123 y el de este chat es 631317185"
  );
}
{
  // Su conversación está en el número ALTERNATIVO: ya tiene la suya, así que un
  // @lid homónimo sin teléfono no se le cuelga a ciegas.
  const db = nuevaDb([
    { jid: "34600222333@s.whatsapp.net", phone: "600222333", display_name: "Marta" },
    { jid: "7766554400@lid", phone: null, display_name: "Marta Soler Gil" },
  ]);
  const r = runLeadLinking(db, [fusionado(40, "600111000", ["600222333"], "Marta Soler Gil")]);
  esperar("solo el chat de su segundo número", enlaces(db), ["34600222333@s.whatsapp.net→40"]);
  esperar(
    "el homónimo sin teléfono va a revisión",
    r.ambiguous[0]?.candidatos[0],
    "Marta Soler Gil (fila 40) — ya tiene otra conversación por teléfono"
  );
}

console.log(`\n${fallos === 0 ? "✓ TODO OK" : `✗ ${fallos} FALLOS`}`);
process.exit(fallos === 0 ? 0 : 1);
