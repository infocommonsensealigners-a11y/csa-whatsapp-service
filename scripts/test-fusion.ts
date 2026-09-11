/**
 * Pruebas de IDENTIDAD + FUSIÓN + INGESTA sobre una SQLite en memoria con el
 * esquema y las migraciones REALES (openDbAt). Cubre lo que pide la Fase 3:
 *  - deduplicación idempotente: el mismo evento tres veces = un mensaje;
 *  - una persona = una fila: el @lid con teléfono cae en el chat del teléfono;
 *  - fusión de gemelos ya guardados sin perder ni un mensaje, con los ids
 *    repetidos unificados (ts más antiguo + raw_json);
 *  - el orden solo se mueve cuando se inserta de verdad;
 *  - `append` reciente = en vivo; `append` viejo = historial;
 *  - envío propio + eco de WhatsApp = un solo mensaje.
 *
 * Ejecutar: npx tsx scripts/test-fusion.ts
 */
import { openDbAt } from "../src/db/db";
openDbAt(":memory:");

import type { WAMessage } from "baileys";
import { getDb } from "../src/db/db";
import { fusionarPar, planFusion, recalcularUltimoMensaje } from "../src/db/fusion";
import { aprenderMapeo, canonicoDe, olvidarCacheIdentidad } from "../src/wa/canonico";
import {
  aplicarContenidoTardio,
  applyContactNames,
  ingestChatShells,
  ingestMessages,
  registrarMensajePropio,
} from "../src/wa/ingestCore";

let ok = 0;
let ko = 0;
function eq<T>(nombre: string, real: T, esperado: T): void {
  if (JSON.stringify(real) === JSON.stringify(esperado)) ok++;
  else {
    ko++;
    console.error(`✗ ${nombre}: esperado ${JSON.stringify(esperado)}, real ${JSON.stringify(real)}`);
  }
}

const db = getDb();
const PN = "34611222333@s.whatsapp.net";
const LID = "123456789012345@lid";
const AHORA = 1_789_200_000;

const msg = (o: {
  jid: string; id: string; fromMe?: boolean; ts: number; text?: string; senderPn?: string; pushName?: string; image?: boolean;
}): WAMessage =>
  ({
    key: { remoteJid: o.jid, id: o.id, fromMe: !!o.fromMe, ...(o.senderPn ? { senderPn: o.senderPn } : {}) },
    messageTimestamp: o.ts,
    pushName: o.pushName,
    message: o.image ? { imageMessage: { caption: o.text ?? "", mimetype: "image/jpeg" } } : { conversation: o.text ?? "hola" },
  }) as unknown as WAMessage;

const chat = (jid: string) =>
  db.prepare("SELECT jid, phone, display_name, last_message_at AS lma, last_message_preview AS prev, ignored, alias_of FROM chats WHERE jid = ?").get(jid) as
    | { jid: string; phone: string | null; display_name: string | null; lma: number | null; prev: string | null; ignored: number; alias_of: string | null }
    | undefined;
const nMsgs = (jid: string) => (db.prepare("SELECT COUNT(*) AS n FROM messages WHERE chat_jid = ?").get(jid) as { n: number }).n;
const visibles = () => (db.prepare("SELECT jid FROM chats WHERE ignored = 0 AND alias_of IS NULL ORDER BY last_message_at DESC, jid").all() as Array<{ jid: string }>).map((r) => r.jid);

/* ---------- 1. Idempotencia: el mismo evento tres veces = un mensaje ---------- */
{
  const m = msg({ jid: PN, id: "A1", ts: AHORA - 100, text: "primero", pushName: "Ana" });
  for (let i = 0; i < 3; i++) ingestMessages([m], { modo: "notify", now: AHORA });
  eq("1 mensaje tras 3 entregas", nMsgs(PN), 1);
  eq("chat creado con pushName", chat(PN)?.display_name, "Ana");
  eq("teléfono ES canónico", chat(PN)?.phone, "611222333");
  eq("orden = ts del mensaje", chat(PN)?.lma, AHORA - 100);
  eq("preview = texto", chat(PN)?.prev, "primero");
  // Re-entrega del MISMO id con un timestamp posterior: no puede mover el chat.
  ingestMessages([msg({ jid: PN, id: "A1", ts: AHORA + 5000, text: "primero" })], { modo: "notify", now: AHORA });
  eq("re-entrega no adelanta el chat", chat(PN)?.lma, AHORA - 100);
}

/* ---------- 2. El @lid con senderPn cae en el chat del teléfono ---------- */
{
  const r = ingestMessages([msg({ jid: LID, id: "B1", ts: AHORA - 50, text: "por lid", senderPn: PN, pushName: "Ana" })], { modo: "notify", now: AHORA });
  eq("no se crea fila @lid", chat(LID), undefined);
  eq("el mensaje está en el teléfono", nMsgs(PN), 2);
  eq("touched es el canónico", Array.from(r.touched), [PN]);
  eq("entrante para campañas con el teléfono de 9 dígitos", r.entrantes.map((e) => e.telefono), ["611222333"]);
  eq("canonicoDe(lid) = pn", canonicoDe(LID), PN);
  // Un segundo mensaje por el lid SIN senderPn ya se resuelve por el mapa.
  ingestMessages([msg({ jid: LID, id: "B2", ts: AHORA - 40, text: "otra vez sin pn" })], { modo: "notify", now: AHORA });
  eq("segundo mensaje también en el teléfono", nMsgs(PN), 3);
  eq("chat adelantado al último insertado", chat(PN)?.lma, AHORA - 40);
  // Nuestro envío al mismo LID (fromMe) también cae en el teléfono.
  ingestMessages([msg({ jid: LID, id: "B3", ts: AHORA - 30, text: "respuesta", fromMe: true })], { modo: "append", now: AHORA });
  eq("saliente por lid en el teléfono", nMsgs(PN), 4);
}

/* ---------- 3. Fusión de gemelos ya guardados (el caso de producción) ---------- */
{
  olvidarCacheIdentidad();
  const PN2 = "34622333444@s.whatsapp.net";
  const LID2 = "222222222222222@lid";
  const now = AHORA;
  // Fila del teléfono con 3 mensajes (uno, "X", persistido por send.ts con ts tardío y sin raw_json)
  db.prepare("INSERT INTO chats (jid, phone, display_name, last_message_at, last_message_preview, wa_read_at, last_opened_at, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?)").run(PN2, "622333444", "Pablo", now - 10, "tres", 100, 200, now, now);
  db.prepare("INSERT INTO messages (chat_jid, id, from_me, ts, type, text) VALUES (?,?,?,?,?,?)").run(PN2, "P1", 0, now - 300, "text", "uno");
  db.prepare("INSERT INTO messages (chat_jid, id, from_me, ts, type, text) VALUES (?,?,?,?,?,?)").run(PN2, "X", 1, now - 190, "text", "dos (send.ts)");
  db.prepare("INSERT INTO messages (chat_jid, id, from_me, ts, type, text) VALUES (?,?,?,?,?,?)").run(PN2, "P3", 0, now - 10, "text", "tres");
  // Fila @lid con 2 mensajes: el eco real de "X" (ts real, con raw_json) y una respuesta más nueva
  db.prepare("INSERT INTO chats (jid, phone, display_name, last_message_at, last_message_preview, wa_read_at, last_opened_at, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?)").run(LID2, null, "+34622333444", now - 5, "cuatro", 300, 50, now, now);
  db.prepare("INSERT INTO messages (chat_jid, id, from_me, ts, type, text, raw_json) VALUES (?,?,?,?,?,?,?)").run(LID2, "X", 1, now - 200, "text", "dos (send.ts)", '{"eco":true}');
  db.prepare("INSERT INTO messages (chat_jid, id, from_me, ts, type, text) VALUES (?,?,?,?,?,?)").run(LID2, "L2", 0, now - 5, "text", "cuatro");
  // Vínculos, etiquetas y marcas en la fila @lid
  db.prepare("INSERT INTO chat_lead_links (chat_jid, source_row, method, status, created_at, updated_at) VALUES (?,?,?,?,?,?)").run(LID2, 77, "auto", "active", now, now);
  db.prepare("INSERT INTO chat_lead_links (chat_jid, source_row, method, status, created_at, updated_at) VALUES (?,?,?,?,?,?)").run(PN2, 77, "manual", "active", now, now);
  db.prepare("INSERT INTO chat_lead_links (chat_jid, source_row, method, status, created_at, updated_at) VALUES (?,?,?,?,?,?)").run(LID2, 78, "auto", "active", now, now);
  db.prepare("INSERT INTO wa_labels (id, name, color) VALUES ('9', 'Lead', 1)").run();
  db.prepare("INSERT INTO wa_chat_labels (chat_jid, label_id) VALUES (?, '9')").run(LID2);
  db.prepare("INSERT INTO wa_chat_labels (chat_jid, label_id) VALUES (?, '9')").run(PN2);
  db.exec("CREATE TABLE IF NOT EXISTS campana_marcas (id INTEGER PRIMARY KEY, chat_jid TEXT NOT NULL, wa_msg_id TEXT, campana TEXT, campana_id TEXT, nota TEXT, created_at INTEGER NOT NULL)");
  db.prepare("INSERT INTO campana_marcas (chat_jid, wa_msg_id, campana, campana_id, created_at) VALUES (?,?,?,?,?)").run(LID2, "X", "Taller", "t1", now);

  eq("sin mapeo no hay plan", planFusion(db).length, 0);
  db.prepare("INSERT INTO wa_lid_map (lid, pn, phone, source) VALUES (?,?,?,?)").run(LID2, PN2, "622333444", "test");
  const plan = planFusion(db);
  eq("plan: 1 par", plan.length, 1);
  eq("plan: mensajes a mover / repetidos", [plan[0].mensajesLid, plan[0].mensajesPn, plan[0].repetidos], [2, 3, 1]);

  const r = fusionarPar(db, LID2, PN2);
  eq("1 mensaje movido (el otro era repetido)", r.mensajesMovidos, 1);
  eq("1 repetido unificado", r.repetidosUnificados, 1);
  eq("el teléfono tiene los 4 mensajes", nMsgs(PN2), 4);
  eq("la fila @lid queda vacía", nMsgs(LID2), 0);
  const x = db.prepare("SELECT ts, raw_json FROM messages WHERE chat_jid = ? AND id = 'X'").get(PN2) as { ts: number; raw_json: string | null };
  eq("el repetido conserva el ts real del eco", x.ts, now - 200);
  eq("…y su raw_json", x.raw_json, '{"eco":true}');
  eq("@lid es alias del teléfono", chat(LID2)?.alias_of, PN2);
  eq("@lid fuera de la lista", chat(LID2)?.ignored, 1);
  eq("canonicoDe(lid2) = pn2", canonicoDe(LID2), PN2);
  eq("orden del canónico = último mensaje real", chat(PN2)?.lma, now - 5);
  eq("preview del canónico", chat(PN2)?.prev, "cuatro");
  eq("nombre real gana al número", chat(PN2)?.display_name, "Pablo");
  eq("marca de lectura = la mayor", (db.prepare("SELECT wa_read_at w, last_opened_at o FROM chats WHERE jid = ?").get(PN2) as { w: number; o: number }), { w: 300, o: 200 });
  const links = db.prepare("SELECT chat_jid, source_row, status FROM chat_lead_links ORDER BY source_row, chat_jid").all() as Array<{ chat_jid: string; source_row: number; status: string }>;
  eq("vínculo 78 movido; 77 redundante queda removed en el lid", links, [
    { chat_jid: LID2, source_row: 77, status: "removed" },
    { chat_jid: PN2, source_row: 77, status: "active" },
    { chat_jid: PN2, source_row: 78, status: "active" },
  ]);
  eq("etiqueta sin duplicar", (db.prepare("SELECT COUNT(*) AS n FROM wa_chat_labels WHERE chat_jid = ?").get(PN2) as { n: number }).n, 1);
  eq("etiquetas del lid vaciadas", (db.prepare("SELECT COUNT(*) AS n FROM wa_chat_labels WHERE chat_jid = ?").get(LID2) as { n: number }).n, 0);
  eq("marca de campaña re-apuntada", (db.prepare("SELECT chat_jid FROM campana_marcas WHERE wa_msg_id = 'X'").get() as { chat_jid: string }).chat_jid, PN2);
  eq("plan vacío tras fundir (idempotente)", planFusion(db).length, 0);
  eq("fundir de nuevo no hace nada", fusionarPar(db, LID2, PN2).mensajesMovidos, 0);
  eq("lista visible sin alias", visibles().includes(LID2), false);
}

/* ---------- 4. Fusión TARDÍA: el @lid tenía chat propio y luego se aprende el teléfono ---------- */
{
  const PN3 = "34633444555@s.whatsapp.net";
  const LID3 = "333333333333333@lid";
  // Fran escribió desde el móvil a un contacto por LID: solo salientes, sin senderPn.
  ingestMessages([msg({ jid: LID3, id: "S1", ts: AHORA - 500, text: "hola desde el móvil", fromMe: true })], { modo: "notify", now: AHORA });
  eq("nace como @lid canónico", canonicoDe(LID3), LID3);
  eq("fila @lid visible mientras no se sabe el teléfono", visibles().includes(LID3), true);
  // La persona contesta: llega senderPn → se aprende y se funde en el acto.
  const r = ingestMessages([msg({ jid: LID3, id: "S2", ts: AHORA - 400, text: "hola!", senderPn: PN3, pushName: "Carla" })], { modo: "notify", now: AHORA });
  eq("respuesta guardada en el teléfono", nMsgs(PN3), 2);
  eq("el saliente anterior se ha movido", nMsgs(LID3), 0);
  eq("@lid es alias", chat(LID3)?.alias_of, PN3);
  eq("nombre del canónico", chat(PN3)?.display_name, "Carla");
  eq("evento para el canónico", Array.from(r.touched), [PN3]);
  // Otra vía: la agenda del móvil trae {id: pn, lid}.
  const PN4 = "34644555666@s.whatsapp.net";
  const LID4 = "444444444444444@lid";
  ingestMessages([msg({ jid: LID4, id: "T1", ts: AHORA - 500, text: "x", fromMe: true })], { modo: "notify", now: AHORA });
  applyContactNames([{ id: PN4, name: "Diego Agenda", lid: LID4 }], false);
  eq("agenda: lid fundido en el teléfono", [canonicoDe(LID4), nMsgs(PN4), chat(LID4)?.alias_of], [PN4, 1, PN4]);
  eq("agenda: nombre de agenda pisa al pushName", chat(PN4)?.display_name, "Diego Agenda");
  // Y la del history sync: chat @lid con pnJid.
  const PN5 = "34655666777@s.whatsapp.net";
  const LID5 = "555555555555555@lid";
  ingestMessages([msg({ jid: LID5, id: "U1", ts: AHORA - 500, text: "x", fromMe: true })], { modo: "notify", now: AHORA });
  ingestChatShells([{ id: LID5, pnJid: PN5, name: "Elena", conversationTimestamp: AHORA - 100, unreadCount: 0 } as never]);
  eq("history sync: pnJid funde el lid", [canonicoDe(LID5), nMsgs(PN5)], [PN5, 1]);
  eq("history sync: un chat sin mensajes toma la posición de WhatsApp", (() => {
    ingestChatShells([{ id: "34666777888@s.whatsapp.net", name: "Sin mensajes", conversationTimestamp: AHORA - 7 } as never]);
    return chat("34666777888@s.whatsapp.net")?.lma;
  })(), AHORA - 7);
}

/* ---------- 5. `append` reciente = en vivo; viejo = historial ---------- */
{
  const PN6 = "34677888999@s.whatsapp.net";
  const viejo = ingestMessages([msg({ jid: PN6, id: "V1", ts: AHORA - 10 * 86400, text: "de hace 10 días", image: true })], { modo: "append", now: AHORA });
  eq("append viejo: no es vivo", [viejo.vivos.size, viejo.mediaCandidates.length, viejo.entrantes.length], [0, 0, 0]);
  const reciente = ingestMessages([msg({ jid: PN6, id: "V2", ts: AHORA - 3600, text: "de hace 1 h" })], { modo: "append", now: AHORA });
  eq("append reciente: vivo, avisa a campañas", [reciente.vivos.size, reciente.entrantes.length], [1, 1]);
  const hist = ingestMessages([msg({ jid: PN6, id: "V3", ts: AHORA - 60, text: "history", fromMe: true })], { modo: "history", now: AHORA });
  eq("history: nunca vivo ni toma manual", [hist.vivos.size, hist.salientes.length], [0, 0]);
  eq("aun así se guarda y ordena", [nMsgs(PN6), chat(PN6)?.lma], [3, AHORA - 60]);
}

/* ---------- 6. Envío propio + eco = un mensaje; el ts es el de WhatsApp ---------- */
{
  const PN7 = "34688999000@s.whatsapp.net";
  eq("registrarMensajePropio inserta", registrarMensajePropio({ jid: PN7, id: "E1", ts: AHORA - 20, type: "text", text: "enviado" }), true);
  ingestMessages([msg({ jid: PN7, id: "E1", ts: AHORA - 20, text: "enviado", fromMe: true })], { modo: "append", now: AHORA });
  eq("eco no duplica", nMsgs(PN7), 1);
  eq("orden = ts del envío", chat(PN7)?.lma, AHORA - 20);
  // El eco puede llegar ANTES por el @lid de la persona: mismo id, misma fila.
  const LID7 = "777777777777777@lid";
  aprenderMapeo(LID7, PN7, "test");
  ingestMessages([msg({ jid: LID7, id: "E2", ts: AHORA - 15, text: "segundo", fromMe: true })], { modo: "append", now: AHORA });
  eq("send.ts detrás del eco: no inserta", registrarMensajePropio({ jid: PN7, id: "E2", ts: AHORA - 8, type: "text", text: "segundo" }), false);
  eq("un solo E2 en el teléfono", (db.prepare("SELECT COUNT(*) AS n FROM messages WHERE id = 'E2'").get() as { n: number }).n, 1);
  eq("el chat no se adelanta al reloj local", chat(PN7)?.lma, AHORA - 15);
}

/* ---------- 7. Contenido tardío / edición ---------- */
{
  const PN8 = "34699000111@s.whatsapp.net";
  ingestMessages([msg({ jid: PN8, id: "F1", ts: AHORA - 30, text: "texto original" })], { modo: "notify", now: AHORA });
  const t = aplicarContenidoTardio([
    { key: { remoteJid: PN8, id: "F1", fromMe: false }, update: { message: { protocolMessage: { key: { id: "F1" }, editedMessage: { conversation: "texto editado" } } } } as never },
  ], AHORA);
  eq("edición aplicada al original", (db.prepare("SELECT text FROM messages WHERE chat_jid = ? AND id = 'F1'").get(PN8) as { text: string }).text, "texto editado");
  eq("preview de la lista sigue a la edición", chat(PN8)?.prev, "texto editado");
  eq("tocado el canónico", Array.from(t), [PN8]);
  eq("una edición no crea mensajes", nMsgs(PN8), 1);
}

/* ---------- 8. Recalcular el orden desde los mensajes ---------- */
{
  const PN9 = "34600111222@s.whatsapp.net";
  ingestMessages([msg({ jid: PN9, id: "G1", ts: AHORA - 1000, text: "único" })], { modo: "notify", now: AHORA });
  db.prepare("UPDATE chats SET last_message_at = ?, last_message_preview = 'fantasma' WHERE jid = ?").run(AHORA, PN9);
  const n = recalcularUltimoMensaje(db);
  eq("chat adelantado corregido", [n >= 1, chat(PN9)?.lma, chat(PN9)?.prev], [true, AHORA - 1000, "único"]);
}

console.log(`fusion/identidad/ingesta: ${ok} OK, ${ko} fallos`);
if (ko) process.exit(1);
