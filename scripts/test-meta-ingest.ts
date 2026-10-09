/**
 * Red de seguridad de Meta + ingesta de Baileys: UNA FILA POR MENSAJE, contra la
 * base REAL del servicio (en una carpeta temporal).
 *
 *   npx tsx scripts/test-meta-ingest.ts
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "meta-ingest-"));
process.env.WA_DATA_DIR = dir;

let fallos = 0;
let oks = 0;
function ok(cond: unknown, que: string): void {
  if (cond) oks++;
  else {
    fallos++;
    console.error("✗", que);
  }
}

/** Un wamid como los de Meta: base64 de un protobuf con el teléfono y el id del mensaje. */
function wamidDe(telefono: string, id: string): string {
  const bytes = Buffer.concat([
    Buffer.from([0x1c, 0x18, telefono.length]), Buffer.from(telefono, "latin1"),
    Buffer.from([0x15, 0x02, 0x00, 0x12, 0x18, id.length]), Buffer.from(id, "latin1"), Buffer.from([0x00]),
  ]);
  return "wamid." + bytes.toString("base64");
}

async function main(): Promise<void> {
  const { openDb, getDb } = await import("../src/db/db");
  openDb();
  const { ingestarDesdeMeta, idInternoDeWamid } = await import("../src/wa/metaIngest");
  const { ingestMessages } = await import("../src/wa/ingestCore");
  const { canonicoDe } = await import("../src/wa/canonico");
  const db = getDb();
  const now = Math.floor(Date.now() / 1000);
  const filas = (id: string) => db.prepare(`SELECT chat_jid AS jid, type, text, stub, raw_json AS raw FROM messages WHERE id = ?`).all(id) as Array<{ jid: string; type: string; text: string | null; stub: string | null; raw: string }>;
  const cifrado = (jid: string, id: string, ts: number) => {
    db.prepare(`INSERT OR IGNORE INTO chats(jid, phone, created_at, updated_at) VALUES (?,?,?,?)`).run(jid, null, now, now);
    db.prepare(`INSERT INTO messages(chat_jid,id,from_me,ts,type,text,raw_json,stub) VALUES (?,?,0,?,'other',NULL,'{}','CIPHERTEXT')`).run(jid, id, ts);
  };
  const baileys = (remoteJid: string, id: string, texto: string, extra: Record<string, unknown> = {}) =>
    ingestMessages([{ key: { remoteJid, fromMe: false, id, ...extra }, messageTimestamp: now, message: { conversation: texto } } as never], { modo: "notify", now });

  // 0) El id interno del wamid.
  const ID0 = "3EB0ABCDEF0123456789AB";
  ok(idInternoDeWamid(wamidDe("34693909824", ID0)) === ID0, "wamid → id interno");
  ok(idInternoDeWamid(ID0) === ID0, "un id que no es wamid se queda igual");

  // 1) «Esperando el mensaje…» en el chat del teléfono → Meta lo rellena.
  cifrado("34611000001@s.whatsapp.net", "AAAA000000000000000001", now - 100);
  const r1 = ingestarDesdeMeta([{ wamid: wamidDe("34611000001", "AAAA000000000000000001"), telefono: "34611000001", fromMe: false, ts: now - 100, tipo: "text", texto: "Hola, me interesa" }], now);
  const f1 = filas("AAAA000000000000000001");
  ok(r1.rellenados === 1 && f1.length === 1 && f1[0].text === "Hola, me interesa" && f1[0].stub === null, "cifrado en chat PN → rellenado");

  // 2) «Esperando…» en un @lid sin teléfono → Meta lo rellena Y dice de quién es (se funden).
  cifrado("99000000000002@lid", "BBBB000000000000000002", now - 90);
  const r2 = ingestarDesdeMeta([{ wamid: wamidDe("34611000002", "BBBB000000000000000002"), telefono: "34611000002", fromMe: false, ts: now - 90, tipo: "text", texto: "¿Precio?" }], now);
  const f2 = filas("BBBB000000000000000002");
  ok(r2.rellenados === 1 && f2.length === 1 && f2[0].text === "¿Precio?", "cifrado en @lid → rellenado " + JSON.stringify({ r2, f2 }));
  ok(canonicoDe("99000000000002@lid") === "34611000002@s.whatsapp.net", "el @lid aprende su teléfono");
  ok(f2[0].jid === "34611000002@s.whatsapp.net", "y el mensaje acaba en el chat del teléfono");

  // 3) Meta PRIMERO (no estaba) y luego Baileys por un @lid desconocido → una fila, enriquecida.
  const r3 = ingestarDesdeMeta([{ wamid: wamidDe("34611000003", "CCCC000000000000000003"), telefono: "34611000003", fromMe: false, ts: now - 80, tipo: "text", texto: "Vale", nombre: "Dra. Pérez" }], now);
  ok(r3.nuevos === 1, "Meta guarda lo que no estaba");
  let f3 = filas("CCCC000000000000000003");
  ok(f3.length === 1 && f3[0].jid === "34611000003@s.whatsapp.net" && f3[0].raw.startsWith('{"origen":"meta"'), "en el chat del teléfono, marcado origen meta");
  const b3 = baileys("99000000000003@lid", "CCCC000000000000000003", "Vale");
  f3 = filas("CCCC000000000000000003");
  ok(f3.length === 1, "Baileys no lo duplica");
  ok(f3[0].raw.includes('"conversation":"Vale"'), "Baileys lo enriquece con su raw_json");
  ok(b3.entrantes.length === 1 && b3.entrantes[0].telefono === "611000003", "y para Baileys cuenta como nuevo (campañas)");
  ok(canonicoDe("99000000000003@lid") === "34611000003@s.whatsapp.net", "el @lid de Baileys aprende su teléfono");
  const b3bis = baileys("99000000000003@lid", "CCCC000000000000000003", "Vale");
  ok(b3bis.entrantes.length === 0 && filas("CCCC000000000000000003").length === 1, "una segunda vez ya no avisa ni duplica");

  // 4) Baileys PRIMERO y luego Meta → no se toca.
  const b4 = baileys("34611000004@s.whatsapp.net", "DDDD000000000000000004", "Buenas");
  ok(b4.entrantes.length === 1, "Baileys normal: avisa");
  const r4 = ingestarDesdeMeta([{ wamid: wamidDe("34611000004", "DDDD000000000000000004"), telefono: "34611000004", fromMe: false, ts: now, tipo: "text", texto: "Buenas" }], now);
  ok(r4.yaEstaban === 1 && r4.nuevos === 0 && filas("DDDD000000000000000004").length === 1, "Meta después: ya estaba");

  // 5) Meta primero y Baileys en el MISMO chat del teléfono → enriquece, sin duplicar.
  ingestarDesdeMeta([{ wamid: wamidDe("34611000005", "EEEE000000000000000005"), telefono: "34611000005", fromMe: false, ts: now, tipo: "text", texto: "Sí" }], now);
  const b5 = baileys("34611000005@s.whatsapp.net", "EEEE000000000000000005", "Sí");
  ok(filas("EEEE000000000000000005").length === 1 && b5.entrantes.length === 1, "mismo chat: una fila y aviso a campañas");

  // 6) Eco de lo que Fran manda desde su app (fromMe) y basura.
  const r6 = ingestarDesdeMeta([
    { wamid: wamidDe("34611000006", "FFFF000000000000000006"), telefono: "34611000006", fromMe: true, ts: now, tipo: "text", texto: "Te mando el programa" },
    { wamid: "", telefono: "34611000006", fromMe: false, ts: now, tipo: "text", texto: "x" },
    { wamid: "wamid.x", telefono: "abc", fromMe: false, ts: now, tipo: "text", texto: "x" },
  ], now);
  const f6 = db.prepare(`SELECT from_me FROM messages WHERE id = 'FFFF000000000000000006'`).get() as { from_me: number } | undefined;
  ok(r6.nuevos === 1 && r6.descartados === 2 && f6?.from_me === 1, "eco saliente guardado como nuestro; basura descartada");

  // 7) La lista se ordena por lo nuevo y la vista previa deja de decir «Esperando…».
  const c1 = db.prepare(`SELECT last_message_preview AS p FROM chats WHERE jid = '34611000003@s.whatsapp.net'`).get() as { p: string };
  ok(c1.p === "Vale", "vista previa del chat con el texto de Meta");

  db.close();
  fs.rmSync(dir, { recursive: true, force: true });
  console.log(fallos ? `✗ ${fallos} fallos, ${oks} OK` : `✓ meta-ingest: ${oks} OK`);
  process.exit(fallos ? 1 : 0);
}
void main();
