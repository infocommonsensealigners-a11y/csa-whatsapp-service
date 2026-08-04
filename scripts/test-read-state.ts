/**
 * Prueba de la marca de agua de lectura (src/wa/readState.ts) sobre una SQLite
 * de verdad en memoria. Verifica lo que es fácil equivocarse por uno: que tras
 * aplicar `unreadCount = N` queden EXACTAMENTE N globos verdes.
 *
 * Ejecutar: npx tsx scripts/test-read-state.ts
 */
import Database from "better-sqlite3";

const db = new Database(":memory:");
db.exec(`
  CREATE TABLE chats (
    jid TEXT PRIMARY KEY,
    last_message_at INTEGER,
    last_opened_at INTEGER,
    wa_read_at INTEGER
  );
  CREATE TABLE messages (
    chat_jid TEXT NOT NULL,
    id TEXT NOT NULL,
    from_me INTEGER NOT NULL,
    ts INTEGER NOT NULL,
    PRIMARY KEY (chat_jid, id)
  );
`);

const JID = "34600111222@s.whatsapp.net";
// 10 entrantes (ts 100..109) + 3 salientes intercalados: los salientes NUNCA
// cuentan como pendientes, y no deben descuadrar el conteo por posición.
db.prepare("INSERT INTO chats(jid, last_message_at) VALUES (?, 109)").run(JID);
for (let i = 0; i < 10; i++) {
  db.prepare("INSERT INTO messages VALUES (?, ?, 0, ?)").run(JID, `in-${i}`, 100 + i);
}
for (let i = 0; i < 3; i++) {
  db.prepare("INSERT INTO messages VALUES (?, ?, 1, ?)").run(JID, `out-${i}`, 101 + i * 3);
}

/** Copia EXACTA de la lógica de applyWaRead (misma SQL, sin depender del socket). */
function applyWaRead(jid: string, unreadCount: number): boolean {
  let marca: number;
  if (unreadCount === 0) {
    const row = db.prepare("SELECT MAX(ts) AS ts FROM messages WHERE chat_jid = ?").get(jid) as { ts: number | null };
    marca = row?.ts ?? 0;
  } else {
    const row = db
      .prepare("SELECT ts FROM messages WHERE chat_jid = ? AND from_me = 0 ORDER BY ts DESC LIMIT 1 OFFSET ?")
      .get(jid, unreadCount - 1) as { ts: number } | undefined;
    if (!row) return false;
    marca = row.ts - 1;
  }
  return (
    db.prepare("UPDATE chats SET wa_read_at = ? WHERE jid = ? AND COALESCE(wa_read_at, 0) < ?").run(marca, jid, marca)
      .changes > 0
  );
}

/** La MISMA expresión que sirve routes/chats.ts. */
function badge(jid: string): number {
  return (
    db
      .prepare(
        `SELECT COUNT(*) AS n FROM messages m JOIN chats c ON c.jid = m.chat_jid
          WHERE m.chat_jid = ? AND m.from_me = 0
            AND m.ts > MAX(COALESCE(c.last_opened_at, 0), COALESCE(c.wa_read_at, 0))`
      )
      .get(jid) as { n: number }
  ).n;
}

let fallos = 0;
const check = (etiqueta: string, real: unknown, esperado: unknown) => {
  const ok = JSON.stringify(real) === JSON.stringify(esperado);
  if (!ok) fallos++;
  console.log(`${ok ? "✓" : "✗"} ${etiqueta}: ${JSON.stringify(real)}${ok ? "" : ` (esperado ${JSON.stringify(esperado)})`}`);
};

check("sin marcas, cuenta todo el historial (el bug de hoy)", badge(JID), 10);

applyWaRead(JID, 3);
check("WhatsApp dice 3 pendientes -> el globo pone 3", badge(JID), 3);

applyWaRead(JID, 0);
check("leído en el móvil (0) -> globo apagado", badge(JID), 0);

// Llegan 2 entrantes nuevos DESPUÉS de leer.
db.prepare("INSERT INTO messages VALUES (?, 'in-10', 0, 200)").run(JID);
db.prepare("INSERT INTO messages VALUES (?, 'in-11', 0, 201)").run(JID);
check("2 mensajes nuevos tras leer -> globo 2", badge(JID), 2);

// Un evento desordenado/inflado NO puede resucitar globos ya apagados.
const movio = applyWaRead(JID, 9);
check("unreadCount inflado y viejo -> ignorado (marca monótona)", movio, false);
check("el globo sigue en 2", badge(JID), 2);

// Leer AQUÍ (last_opened_at) también apaga, sin tocar WhatsApp.
db.prepare("UPDATE chats SET last_opened_at = 201 WHERE jid = ?").run(JID);
check("abierto en el teléfono flotante -> globo apagado", badge(JID), 0);

// WhatsApp conoce más historial del que tenemos guardado: no se toca nada.
db.prepare("INSERT INTO chats(jid, last_message_at) VALUES ('otro@s.whatsapp.net', 50)").run();
db.prepare("INSERT INTO messages VALUES ('otro@s.whatsapp.net', 'x', 0, 50)").run();
check("unreadCount mayor que los mensajes guardados -> no toca", applyWaRead("otro@s.whatsapp.net", 99), false);

console.log(fallos === 0 ? "\nTODO OK" : `\n${fallos} FALLOS`);
process.exit(fallos === 0 ? 0 : 1);
