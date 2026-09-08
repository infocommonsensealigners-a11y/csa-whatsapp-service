/**
 * Valida contra SQLite REAL las consultas de `src/campanas/manual.ts` — la
 * detección de que un compañero ha cogido a mano un chat de campaña.
 *
 * ⚠️ Por qué se prueba el SQL y no solo la lógica: en este mismo módulo ya se
 * perdió una vez un `ON CONFLICT` contra un índice parcial que SQLite rechazaba
 * en silencio (la marca de agua no se registró ni una vez, ver marcas.ts). Aquí
 * un fallo tiene dos caras y las dos son malas: si se detecta de menos, la
 * automatización sigue escribiendo encima de Fran; si de más, se paran
 * conversaciones vivas con una nota que además miente.
 *
 *   npx tsx scripts/test-toma-manual.ts
 */
import Database from "better-sqlite3";

const MARGEN_MISMO_ENVIO_S = 90;
const ACTOR_AUTOMATICO = "campaña:";

const db = new Database(":memory:");
db.exec(`
  CREATE TABLE messages (chat_jid TEXT, id TEXT, from_me INTEGER, ts INTEGER, PRIMARY KEY (chat_jid, id));
  CREATE TABLE campana_marcas (id INTEGER PRIMARY KEY, chat_jid TEXT NOT NULL, wa_msg_id TEXT, campana TEXT, campana_id TEXT, nota TEXT, created_at INTEGER NOT NULL);
  CREATE UNIQUE INDEX idx_m ON campana_marcas (wa_msg_id) WHERE wa_msg_id IS NOT NULL;
  CREATE TABLE wa_send_audit (id INTEGER PRIMARY KEY, chat_jid TEXT, actor TEXT, wa_msg_id TEXT, created_at INTEGER);
`);

const msg = db.prepare(`INSERT INTO messages VALUES (?,?,?,?)`);
const marca = db.prepare(
  `INSERT INTO campana_marcas (chat_jid, wa_msg_id, campana, campana_id, nota, created_at) VALUES (?,?,'CRM TADS JAVI','c1',NULL,?)`
);
const audit = db.prepare(`INSERT INTO wa_send_audit (chat_jid, actor, wa_msg_id, created_at) VALUES (?,?,?,?)`);

/** Un envío de la automatización, con su marca y su auditoría. */
function automatico(jid: string, id: string, ts: number): void {
  msg.run(jid, id, 1, ts);
  marca.run(jid, id, ts);
  audit.run(jid, `${ACTOR_AUTOMATICO}CRM TADS JAVI`, id, ts);
}

// A) La automatización abrió y DESPUÉS escribió Fran desde su móvil → TOMA.
automatico("A", "a1", 1000);
msg.run("A", "a2", 0, 1100);
msg.run("A", "a3", 1, 1200); // a mano: sin marca y sin auditoría

// B) Solo la automatización, y el doctor contestó → no es toma.
automatico("B", "b1", 1000);
msg.run("B", "b2", 0, 1100);

// C) Fran escribió hace meses y la automatización estrenó después → NO es toma.
//    Es el caso que obliga a mirar el ÚLTIMO saliente y no "alguno".
msg.run("C", "c0", 1, 10);
automatico("C", "c1", 1000);

// D) A mano en el MISMO segundo que un envío automático → NO se detecta ahora,
//    y es correcto: es el coste conocido del margen de 90 s de la tercera
//    comprobación, que existe para no pararse sola. Lo caza el siguiente
//    mensaje que escriba, el repaso del arranque, o —si escribe desde el
//    teléfono flotante— el aviso inmediato de send.ts, que no pasa por aquí.
automatico("D", "d1", 2000);
msg.run("D", "d2", 1, 2000);

// E) Desde el TELÉFONO FLOTANTE: hay auditoría, pero con actor humano → TOMA.
automatico("E", "e1", 1000);
msg.run("E", "e2", 1, 2000);
audit.run("E", "miguelangel@ortodoncialozano.es", "e2", 2000);

// F) Chat sin campaña: no debe ni entrar en los candidatos.
msg.run("F", "f1", 1, 1000);

// G) EL FALSO POSITIVO CARO: la marca se guardó con un id sintético porque
//    Baileys no devolvió key.id, y el eco llega con el id real. No casa por id,
//    pero salió de la automatización hace 3 segundos → NO es toma.
msg.run("G", "g-real", 1, 3003);
marca.run("G", "sent-3000-abc", 3000);
audit.run("G", `${ACTOR_AUTOMATICO}CRM TADS JAVI`, "sent-3000-abc", 3000);

// H) Igual que G pero 10 minutos después: ahí ya es Fran de verdad → TOMA.
automatico("H", "h1", 1000);
msg.run("H", "h2", 1, 1600);

// I) Varios salientes a mano, lejos de cualquier automático → TOMA.
automatico("I", "i1", 1000);
msg.run("I", "i2", 1, 5000);
msg.run("I", "i3", 1, 5000);

// J) EL CASO DE JULIO, que es el que originó todo el arreglo y el que la primera
//    versión de este repaso NO cazaba: la automatización habló ÚLTIMA, encima de
//    lo que Fran había escrito a mano. Mirando solo el último saliente parecía
//    que el chat lo llevaba la automatización — justo al revés. → TOMA.
automatico("J", "apertura", 46800);      // 13:00
msg.run("J", "julio-1", 0, 46920);       // 13:02 «si correcto estoy apuntado»
automatico("J", "recon1", 46920);        // 13:02
msg.run("J", "fran-1", 1, 54780);        // 15:13 A MANO
msg.run("J", "fran-2", 1, 54840);        // 15:14 A MANO
msg.run("J", "julio-2", 0, 55680);       // 15:28 «a que costo?»
automatico("J", "recon1-otra-vez", 55680);
msg.run("J", "julio-3", 0, 56700);       // 15:45 «si, de acuerdo»
automatico("J", "paso2", 56700);         // 15:45 — la automatización habla ÚLTIMA

// K) Fran escribió hace meses, la automatización estrenó DESPUÉS y sigue sola.
//    Es el caso que impide usar «algún saliente sin marca» sin ventana. → NO.
msg.run("K", "hace-meses", 1, 100);
automatico("K", "k1", 90000);
msg.run("K", "doctor", 0, 90100);

const candidatos = db
  .prepare(`SELECT DISTINCT chat_jid AS jid FROM campana_marcas WHERE wa_msg_id IS NOT NULL`)
  .all() as { jid: string }[];
const primerAutomatico = db.prepare(
  `SELECT MIN(created_at) AS ts FROM campana_marcas WHERE chat_jid = ? AND wa_msg_id IS NOT NULL`
);
const salientesDesde = db.prepare(
  `SELECT id, ts FROM messages
    WHERE chat_jid = ? AND from_me = 1 AND ts >= ?
    ORDER BY ts DESC, rowid DESC LIMIT ?`
);

/** Réplica exacta de `esDeLaAutomatizacion` (mismas tres consultas, mismo orden). */
function esDeLaAutomatizacion(waMsgId: string, jid: string, ts: number): boolean {
  if (db.prepare(`SELECT 1 AS x FROM campana_marcas WHERE wa_msg_id = ? LIMIT 1`).get(waMsgId)) return true;
  const a = db
    .prepare(`SELECT actor FROM wa_send_audit WHERE wa_msg_id = ? ORDER BY id DESC LIMIT 1`)
    .get(waMsgId) as { actor: string | null } | undefined;
  if (a && (a.actor ?? "").startsWith(ACTOR_AUTOMATICO)) return true;
  const cerca = db
    .prepare(
      `SELECT 1 AS x FROM wa_send_audit
        WHERE chat_jid = ? AND actor LIKE ? AND ABS(created_at - ?) <= ?
        LIMIT 1`
    )
    .get(jid, `${ACTOR_AUTOMATICO}%`, ts, MARGEN_MISMO_ENVIO_S);
  return !!cerca;
}

/** Réplica de `escribioUnHumanoEnLaConversacion`. */
function laLlevaUnHumano(jid: string): boolean {
  const desde = (primerAutomatico.get(jid) as { ts: number | null }).ts;
  if (desde === null) return false;
  const salientes = salientesDesde.all(jid, desde, 50) as { id: string; ts: number }[];
  const humanos = salientes.filter((m) => !esDeLaAutomatizacion(m.id, jid, m.ts));
  console.log(
    `  ${jid}: ${salientes.length} saliente(s) desde el primer automático (ts ${desde})` +
      ` · escritos a mano: ${humanos.map((h) => h.id).join(", ") || "ninguno"}`
  );
  return humanos.length > 0;
}

const tomados: string[] = [];
for (const { jid } of candidatos) {
  if (laLlevaUnHumano(jid)) tomados.push(jid);
}

const ESPERADO = "A,E,H,I,J";
const real = tomados.slice().sort().join(",");
console.log(`\ncandidatos: ${candidatos.map((c) => c.jid).join(",")}  (F no está: no tiene campaña ✓)`);
console.log(`tomados:    ${real || "(ninguno)"}`);
const ok = real === ESPERADO;
console.log(ok ? "\n✓ TODO OK" : `\n✗ FALLO: esperaba ${ESPERADO}`);
process.exit(ok ? 0 : 1);
