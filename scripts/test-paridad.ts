/**
 * Pruebas de PARIDAD con WhatsApp Web sobre una SQLite en memoria con el esquema
 * real: ticks (estado de entrega, nunca hacia atrás), borrado para todos,
 * edición, reacciones, borrado para mí, mensajes de sistema (grupos, llamadas,
 * «esperando el mensaje…» que luego se rellena), estado del chat que sincroniza
 * el móvil (archivado, fijado, silenciado, borrado) y grupos.
 *
 * Ejecutar: npx tsx scripts/test-paridad.ts
 */
import { openDbAt } from "../src/db/db";
openDbAt(":memory:");

import type { WAMessage } from "baileys";
import { getDb } from "../src/db/db";
import { canonicoDe } from "../src/wa/canonico";
import {
  aplicarBorradosParaMi,
  aplicarContenidoTardio,
  aplicarEstadoDeChats,
  aplicarEstadoMensajes,
  aplicarGrupos,
  aplicarReacciones,
  borrarChats,
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
const AHORA = 1_789_200_000;
const PN = "34611222333@s.whatsapp.net";
const GRUPO = "120363000000000001@g.us";

const msg = (o: { jid: string; id: string; fromMe?: boolean; ts: number; text?: string; status?: unknown; participant?: string; pushName?: string; stub?: number; params?: string[]; participantPn?: string }): WAMessage =>
  ({
    key: { remoteJid: o.jid, id: o.id, fromMe: !!o.fromMe, ...(o.participant ? { participant: o.participant } : {}), ...(o.participantPn ? { participantPn: o.participantPn } : {}) },
    messageTimestamp: o.ts,
    pushName: o.pushName,
    status: o.status,
    ...(o.stub ? { messageStubType: o.stub, messageStubParameters: o.params ?? [] } : { message: { conversation: o.text ?? "hola" } }),
  }) as unknown as WAMessage;

const fila = (jid: string, id: string) =>
  db.prepare("SELECT status, revoked, edited, deleted_for_me AS dfm, stub, text, type, participant FROM messages WHERE chat_jid = ? AND id = ?").get(jid, id) as
    | { status: number | null; revoked: number; edited: number; dfm: number; stub: string | null; text: string | null; type: string; participant: string | null }
    | undefined;
const chat = (jid: string) =>
  db.prepare("SELECT display_name AS n, last_message_at AS lma, last_message_preview AS prev, archived, pinned, mute_until AS mute, deleted_at AS del FROM chats WHERE jid = ?").get(jid) as
    | { n: string | null; lma: number | null; prev: string | null; archived: number; pinned: number | null; mute: number | null; del: number | null }
    | undefined;

/* ---------- 1. Ticks: estado al insertar y por messages.update, nunca hacia atrás ---------- */
{
  ingestMessages([msg({ jid: PN, id: "T1", ts: AHORA - 100, fromMe: true, text: "enviado", status: 2 })], { modo: "append", now: AHORA });
  eq("estado al insertar (SERVER_ACK=2)", fila(PN, "T1")?.status, 2);
  ingestMessages([msg({ jid: PN, id: "T2", ts: AHORA - 90, fromMe: true, text: "x", status: "READ" })], { modo: "append", now: AHORA });
  eq("estado como texto del proto (READ=4)", fila(PN, "T2")?.status, 4);
  let t = aplicarEstadoMensajes([{ key: { remoteJid: PN, id: "T1", fromMe: true }, update: { status: 3 } as never }]);
  eq("entregado (3)", [fila(PN, "T1")?.status, Array.from(t)], [3, [PN]]);
  t = aplicarEstadoMensajes([{ key: { remoteJid: PN, id: "T1", fromMe: true }, update: { status: 2 } as never }]);
  eq("nunca hacia atrás", [fila(PN, "T1")?.status, t.size], [3, 0]);
  aplicarEstadoMensajes([{ key: { remoteJid: PN, id: "T1", fromMe: true }, update: { status: "READ" } as never }]);
  eq("leído (4) por nombre", fila(PN, "T1")?.status, 4);
  eq("registrarMensajePropio nace pendiente (1)", (() => { registrarMensajePropio({ jid: PN, id: "T3", ts: AHORA - 80, type: "text", text: "p" }); return fila(PN, "T3")?.status; })(), 1);
  eq("un entrante no tiene estado", (() => { ingestMessages([msg({ jid: PN, id: "T4", ts: AHORA - 70, text: "de ella", status: 2 })], { modo: "notify", now: AHORA }); return fila(PN, "T4")?.status; })(), null);
}

/* ---------- 2. Borrado para todos (REVOKE) y edición ---------- */
{
  ingestMessages([msg({ jid: PN, id: "R1", ts: AHORA - 60, text: "me arrepiento" })], { modo: "notify", now: AHORA });
  eq("preview antes", chat(PN)?.prev, "me arrepiento");
  const t = aplicarEstadoMensajes([{ key: { remoteJid: PN, id: "R1", fromMe: false }, update: { message: null, messageStubType: 1 } as never }]);
  eq("marcado como borrado para todos", [fila(PN, "R1")?.revoked, Array.from(t)], [1, [PN]]);
  eq("el preview de la lista lo dice", chat(PN)?.prev, "🚫 Se eliminó este mensaje");
  eq("el texto sigue en la base (no se pierde dato)", fila(PN, "R1")?.text, "me arrepiento");
  ingestMessages([msg({ jid: PN, id: "E1", ts: AHORA - 50, text: "texto original" })], { modo: "notify", now: AHORA });
  aplicarContenidoTardio([{ key: { remoteJid: PN, id: "E1", fromMe: false }, update: { message: { protocolMessage: { key: { id: "E1" }, editedMessage: { conversation: "texto editado" } } } } as never }], AHORA);
  eq("edición: texto nuevo y marca 'edited'", [fila(PN, "E1")?.text, fila(PN, "E1")?.edited], ["texto editado", 1]);
  eq("contenido tardío normal no marca edited", (() => {
    ingestMessages([msg({ jid: PN, id: "E2", ts: AHORA - 45, text: "a" })], { modo: "notify", now: AHORA });
    aplicarContenidoTardio([{ key: { remoteJid: PN, id: "E2", fromMe: false }, update: { message: { conversation: "b" } } as never }], AHORA);
    return [fila(PN, "E2")?.text, fila(PN, "E2")?.edited];
  })(), ["b", 0]);
}

/* ---------- 3. Reacciones ---------- */
{
  const reac = (emoji: string | null, fromMe: boolean) => aplicarReacciones([{ key: { remoteJid: PN, id: "E1", fromMe: false }, reaction: { text: emoji, key: { remoteJid: PN, fromMe, id: "r" } } }]);
  reac("👍", true);
  reac("❤️", false);
  const lista = () => db.prepare("SELECT sender, emoji FROM wa_reactions WHERE chat_jid = ? AND msg_id = 'E1' ORDER BY sender").all(PN);
  eq("dos reacciones, una nuestra y una suya", lista(), [{ sender: PN, emoji: "❤️" }, { sender: "me", emoji: "👍" }]);
  reac("😂", true);
  eq("cambiar la nuestra la sustituye", lista(), [{ sender: PN, emoji: "❤️" }, { sender: "me", emoji: "😂" }]);
  reac("", false);
  eq("texto vacío = quitar la suya", lista(), [{ sender: "me", emoji: "😂" }]);
}

/* ---------- 4. Borrado para mí / vaciar chat ---------- */
{
  aplicarBorradosParaMi({ keys: [{ remoteJid: PN, id: "E2", fromMe: false }] });
  eq("eliminar para mí", fila(PN, "E2")?.dfm, 1);
  const t = aplicarBorradosParaMi({ jid: PN, all: true });
  eq("vaciar chat oculta todo", [Array.from(t), (db.prepare("SELECT COUNT(*) AS n FROM messages WHERE chat_jid = ? AND deleted_for_me = 0").get(PN) as { n: number }).n], [[PN], 0]);
  eq("…pero nada se borra de la base", (db.prepare("SELECT COUNT(*) AS n FROM messages WHERE chat_jid = ?").get(PN) as { n: number }).n, 7);
}

/* ---------- 5. Mensajes de sistema: «esperando…» que luego se rellena, llamadas ---------- */
{
  const PN2 = "34622333444@s.whatsapp.net";
  ingestMessages([msg({ jid: PN2, id: "C1", ts: AHORA - 40, stub: 2 })], { modo: "notify", now: AHORA });
  eq("CIPHERTEXT guardado como sistema", [fila(PN2, "C1")?.stub, chat(PN2)?.prev], ["CIPHERTEXT", "Esperando el mensaje…"]);
  const r = ingestMessages([msg({ jid: PN2, id: "C1", ts: AHORA - 40, text: "ya descifrado" })], { modo: "notify", now: AHORA });
  eq("al llegar el contenido se rellena en su sitio", [fila(PN2, "C1")?.stub, fila(PN2, "C1")?.text, Array.from(r.touched)], [null, "ya descifrado", [PN2]]);
  ingestMessages([msg({ jid: PN2, id: "C2", ts: AHORA - 30, stub: 40 })], { modo: "notify", now: AHORA });
  eq("llamada perdida", [fila(PN2, "C2")?.stub, chat(PN2)?.prev], ["CALL_MISSED_VOICE", "📞 Llamada de voz perdida"]);
  eq("un stub desconocido no se guarda", (() => { const rr = ingestMessages([msg({ jid: PN2, id: "C3", ts: AHORA - 20, stub: 39 })], { modo: "notify", now: AHORA }); return [rr.touched.size, fila(PN2, "C3")]; })(), [0, undefined]);
  eq("un stub no avisa a campañas ni es media", (() => { const rr = ingestMessages([msg({ jid: PN2, id: "C4", ts: AHORA - 10, stub: 41 })], { modo: "notify", now: AHORA }); return [rr.entrantes.length, rr.mediaCandidates.length, rr.vivos.size]; })(), [0, 0, 0]);
}

/* ---------- 6. Grupos: mensajes con participante, asunto, sistema, sin campañas ---------- */
{
  const P1 = "34633444555@s.whatsapp.net";
  const P1LID = "999999999999999@lid";
  const r = ingestMessages([msg({ jid: GRUPO, id: "G1", ts: AHORA - 100, text: "hola grupo", participant: P1, pushName: "Carla" })], { modo: "notify", now: AHORA });
  eq("mensaje de grupo guardado con participante", [fila(GRUPO, "G1")?.participant, Array.from(r.touched)], [P1, [GRUPO]]);
  eq("el pushName va a la agenda del participante, no al grupo", [
    (db.prepare("SELECT notify FROM wa_contacts WHERE jid = ?").get(P1) as { notify: string } | undefined)?.notify,
    chat(GRUPO)?.n || null,
  ], ["Carla", null]);
  eq("un grupo no avisa a campañas ni es toma manual", [r.entrantes.length, r.salientes.length], [0, 0]);
  ingestMessages([msg({ jid: GRUPO, id: "G2", ts: AHORA - 90, text: "por lid", participant: P1LID, participantPn: P1 })], { modo: "notify", now: AHORA });
  eq("participante @lid con participantPn → canónico del teléfono", [fila(GRUPO, "G2")?.participant, canonicoDe(P1LID)], [P1, P1]);
  aplicarGrupos([{ id: GRUPO, subject: "Ortodoncia 2026", participants: [{ id: P1, admin: "admin" }, { id: "34644555666@s.whatsapp.net" }] } as never]);
  eq("asunto y participantes", [chat(GRUPO)?.n, (db.prepare("SELECT COUNT(*) AS n FROM wa_group_participants WHERE group_jid = ?").get(GRUPO) as { n: number }).n], ["Ortodoncia 2026", 2]);
  ingestMessages([msg({ jid: GRUPO, id: "G3", ts: AHORA - 80, stub: 27, participant: P1, params: ["34644555666@s.whatsapp.net"] })], { modo: "notify", now: AHORA });
  eq("stub de grupo guardado", [fila(GRUPO, "G3")?.stub, chat(GRUPO)?.prev], ["GROUP_PARTICIPANT_ADD", "ℹ️ Cambio en el grupo"]);
  aplicarEstadoDeChats([{ id: GRUPO, name: "Ortodoncia 2027" }], false);
  eq("chats.update renombra el grupo", chat(GRUPO)?.n, "Ortodoncia 2027");
}

/* ---------- 7. Estado del chat que sincroniza el móvil ---------- */
{
  const PN3 = "34655666777@s.whatsapp.net";
  ingestMessages([msg({ jid: PN3, id: "S1", ts: AHORA - 100, text: "x" })], { modo: "notify", now: AHORA });
  let t = aplicarEstadoDeChats([{ id: PN3, archived: true, pinned: AHORA - 50, muteEndTime: AHORA + 3600 }], false);
  eq("archivado, fijado y silenciado", [chat(PN3)?.archived, chat(PN3)?.pinned, chat(PN3)?.mute, t], [1, AHORA - 50, AHORA + 3600, [PN3]]);
  t = aplicarEstadoDeChats([{ id: PN3, archived: true }], false);
  eq("sin cambio no se avisa", t, []);
  aplicarEstadoDeChats([{ id: PN3, archived: false, pinned: null, muteEndTime: null }], false);
  eq("desarchivado, desfijado, sonando", [chat(PN3)?.archived, chat(PN3)?.pinned, chat(PN3)?.mute], [0, null, null]);
  eq("chats.update de un chat desconocido no lo crea", (() => { aplicarEstadoDeChats([{ id: "34600000009@s.whatsapp.net", archived: true }], false); return chat("34600000009@s.whatsapp.net"); })(), undefined);
  eq("chats.upsert sí lo crea", (() => { aplicarEstadoDeChats([{ id: "34600000008@s.whatsapp.net", name: "Nuevo" }], true); return chat("34600000008@s.whatsapp.net")?.n; })(), "Nuevo");
  eq("chat borrado en el móvil se oculta", (() => { borrarChats([PN3]); return chat(PN3)?.del != null; })(), true);
  ingestMessages([msg({ jid: PN3, id: "S2", ts: AHORA - 5, text: "vuelvo" })], { modo: "notify", now: AHORA });
  eq("…y renace al llegar un mensaje", chat(PN3)?.del, null);
  eq("unreadCount sigue funcionando por el mismo camino", (() => {
    aplicarEstadoDeChats([{ id: PN3, unreadCount: 0 }], false);
    return (db.prepare("SELECT wa_read_at AS w FROM chats WHERE jid = ?").get(PN3) as { w: number }).w;
  })(), AHORA - 5);
}

console.log(`paridad: ${ok} OK, ${ko} fallos`);
if (ko) process.exit(1);
