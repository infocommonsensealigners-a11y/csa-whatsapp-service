/**
 * Pruebas del historial del móvil (src/wa/historial.ts) sobre SQLite en memoria
 * y sin socket: quién es nuestra cuenta, detección de huecos, decodificación de
 * un volcado (comprimido y en claro), procesado idempotente y el aviso visto por
 * `messages.upsert` (propio / ajeno / tipo no procesable).
 *
 * Ejecutar: npx tsx scripts/test-historial.ts
 */
import { openDbAt } from "../src/db/db";
openDbAt(":memory:");

import { deflateSync } from "node:zlib";
import { proto, type WAMessage } from "baileys";
import { getDb } from "../src/db/db";
import {
  decodificarVolcado,
  detectarHueco,
  esMismaCuenta,
  estadoHistorial,
  mayorSilencio,
  nombreTipo,
  procesarVolcado,
  verMensajeDeProtocolo,
  SILENCIO_HUECO_S,
} from "../src/wa/historial";
import { ingestMessages } from "../src/wa/ingestCore";

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
const AHORA = Math.floor(Date.now() / 1000);
const PN = "34611222333@s.whatsapp.net";
const PN2 = "34622333444@s.whatsapp.net";
const YO = { jid: "34678175707:48@s.whatsapp.net", lid: "152089187643632:48@lid" };

/* ---------- 1. Nuestra cuenta, por teléfono o por @lid, con o sin dispositivo ---------- */
eq("misma cuenta por teléfono", esMismaCuenta("34678175707@s.whatsapp.net", YO), true);
eq("misma cuenta por @lid con dispositivo", esMismaCuenta("152089187643632:3@lid", YO), true);
eq("otra persona", esMismaCuenta(PN, YO), false);
eq("otro @lid", esMismaCuenta("999999999999999@lid", YO), false);
eq("sin remitente", esMismaCuenta(null, YO), false);
eq("sin saber nuestro lid, el lid no se reconoce", esMismaCuenta("152089187643632@lid", { jid: YO.jid, lid: null }), false);

/* ---------- 2. Mayor silencio ---------- */
eq("sin silencio largo", mayorSilencio([1000, 2000, 3000], 5000), null);
eq("silencio de 2 días entre mensajes", mayorSilencio([AHORA - 300_000, AHORA - 200_000, AHORA - 27_000, AHORA - 100], SILENCIO_HUECO_S), { desde: AHORA - 200_000, hasta: AHORA - 27_000 });
eq("gana el silencio más largo", mayorSilencio([0, 100_000, 100_100, 300_000], SILENCIO_HUECO_S), { desde: 100_100, hasta: 300_000 });
eq("nombres de tipo", [nombreTipo(0), nombreTipo(3), nombreTipo(6), nombreTipo(null)], ["INITIAL_BOOTSTRAP", "RECENT", "ON_DEMAND", "?"]);

/* ---------- 3. Volcado: codificar como lo manda el móvil y decodificar ---------- */
const volcado = proto.HistorySync.encode({
  syncType: proto.HistorySync.HistorySyncType.RECENT,
  progress: 40,
  conversations: [
    {
      id: PN,
      name: "Gisell",
      lidJid: "111111111111111@lid",
      unreadCount: 2,
      conversationTimestamp: AHORA - 50,
      messages: [
        { message: { key: { remoteJid: PN, id: "H1", fromMe: false }, messageTimestamp: AHORA - 60, message: { conversation: "Hola, sí" } } },
        { message: { key: { remoteJid: PN, id: "H2", fromMe: true }, messageTimestamp: AHORA - 50, status: proto.WebMessageInfo.Status.READ, message: { conversation: "Genial" } } },
      ],
    },
    {
      id: PN2,
      name: "Elena",
      messages: [{ message: { key: { remoteJid: PN2, id: "H3", fromMe: false }, messageTimestamp: AHORA - 40, message: { conversation: "Me interesa" } } }],
    },
  ],
}).finish();

const nMsgs = (jid: string) => (db.prepare("SELECT COUNT(*) AS n FROM messages WHERE chat_jid = ?").get(jid) as { n: number }).n;

(async () => {
  const comprimido = await decodificarVolcado(deflateSync(Buffer.from(volcado)));
  eq("volcado comprimido: mensajes y chats", [comprimido.messages.length, comprimido.chats.length, comprimido.syncType], [3, 2, 3]);
  const claro = await decodificarVolcado(volcado);
  eq("volcado en claro: mismo resultado", [claro.messages.length, claro.chats.length], [3, 2]);
  eq("contacto con lid salido del chat", comprimido.contacts.find((c) => c.id === PN)?.lid ?? null, "111111111111111@lid");

  /* ---------- 4. Procesar: entra en la base, idempotente, aprende el lid ---------- */
  const r1 = procesarVolcado(comprimido, "propio");
  eq("primer procesado: 2 chats con mensajes nuevos", [r1.chats, r1.conMensajes, nMsgs(PN), nMsgs(PN2)], [2, 2, 2, 1]);
  const r2 = procesarVolcado(claro, "baileys");
  eq("segundo procesado (mismo volcado): nada nuevo", [r2.conMensajes, nMsgs(PN), nMsgs(PN2)], [0, 2, 1]);
  const chat = db.prepare("SELECT display_name AS n, last_message_at AS lma FROM chats WHERE jid = ?").get(PN) as { n: string; lma: number };
  eq("nombre del volcado y posición por el último mensaje", [chat.n, chat.lma], ["Gisell", AHORA - 50]);
  const lid = db.prepare("SELECT pn FROM wa_lid_map WHERE lid = ?").get("111111111111111@lid") as { pn: string } | undefined;
  eq("lidJid del volcado aprendido", lid?.pn ?? null, PN);
  const est = estadoHistorial();
  eq("estado: 2 volcados, 1 descargado aquí", [est.total, est.processedHere, est.pending, est.lastAt !== null], [2, 1, 0, true]);

  /* ---------- 5. Hueco: silencio largo en la base ---------- */
  eq("sin hueco con mensajes recientes seguidos", detectarHueco(), null);
  ingestMessages(
    [
      { key: { remoteJid: PN2, id: "V1", fromMe: false }, messageTimestamp: AHORA - 3 * 86_400, message: { conversation: "antes del hueco" } } as unknown as WAMessage,
    ],
    { modo: "history", now: AHORA }
  );
  const hueco = detectarHueco();
  eq("hueco de ~3 días detectado", hueco ? [hueco.desde, hueco.hasta] : null, [AHORA - 3 * 86_400, AHORA - 60]);

  /* ---------- 6. Avisos vistos en messages.upsert ---------- */
  const aviso = (o: { id: string; remoteJid: string; fromMe: boolean; tipo: number; enLinea?: boolean }): WAMessage =>
    ({
      key: { remoteJid: o.remoteJid, id: o.id, fromMe: o.fromMe },
      messageTimestamp: AHORA,
      message: {
        protocolMessage: {
          type: proto.Message.ProtocolMessage.Type.HISTORY_SYNC_NOTIFICATION,
          historySyncNotification: {
            syncType: o.tipo,
            chunkOrder: 1,
            progress: 100,
            fileLength: 12345,
            directPath: "/v/t62.x/fake",
            mediaKey: Buffer.alloc(32, 1),
            ...(o.enLinea ? { initialHistBootstrapInlinePayload: deflateSync(Buffer.from(volcado)) } : {}),
          },
        },
      },
    }) as unknown as WAMessage;

  // Sin socket no hay `getMe()`: solo el fromMe identifica la cuenta propia.
  eq("mensaje normal no es protocolo", verMensajeDeProtocolo({ key: { remoteJid: PN, id: "N1", fromMe: false }, message: { conversation: "hola" } } as unknown as WAMessage), false);
  eq("aviso ajeno: se ve pero se rechaza", verMensajeDeProtocolo(aviso({ id: "A1", remoteJid: "999999999999999@lid", fromMe: false, tipo: 0 })), true);
  eq("aviso propio de tipo no procesable (estados)", verMensajeDeProtocolo(aviso({ id: "A2", remoteJid: YO.lid, fromMe: true, tipo: 1 })), true);
  eq("aviso propio procesable queda pendiente", verMensajeDeProtocolo(aviso({ id: "A3", remoteJid: YO.lid, fromMe: true, tipo: 0, enLinea: true })), true);
  eq("otro protocolo propio (clave de sincronización)", verMensajeDeProtocolo({ key: { remoteJid: YO.lid, id: "P1", fromMe: true }, message: { protocolMessage: { type: 6 } } } as unknown as WAMessage), true);
  const est2 = estadoHistorial();
  eq("estado: un aviso pendiente y hora del último aviso", [est2.pending, est2.notifiedAt !== null], [1, true]);
  eq("el mismo aviso dos veces no duplica", [verMensajeDeProtocolo(aviso({ id: "A3", remoteJid: YO.lid, fromMe: true, tipo: 0 })), estadoHistorial().pending], [true, 1]);
  // Baileys entrega el volcado del aviso pendiente: deja de estar pendiente.
  procesarVolcado({ ...claro, syncType: 0 }, "baileys");
  eq("volcado de Baileys cierra el aviso pendiente", estadoHistorial().pending, 0);

  console.log(`\nhistorial: ${ok} OK, ${ko} fallos`);
  process.exit(ko ? 1 : 0);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
