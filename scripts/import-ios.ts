/**
 * Importa TODO el historial desde la ChatStorage.sqlite del iPhone (extraída con
 * ios_extract.py) a la base del sidecar (wa.sqlite3). Solo chats individuales
 * (1-a-1) con número real → se podrán enlazar al CRM por teléfono.
 *
 * Uso: npx tsx scripts/import-ios.ts   (con el sidecar PARADO para evitar locks)
 * Idempotente: reejecutar no duplica (PK (chat_jid, id) con id = ios_<Z_PK>).
 */
import Database from "better-sqlite3";
import path from "node:path";
import { openDb } from "../src/db/db";
import { jidToPhone } from "../src/wa/jidPhone";

const APPLE_EPOCH = 978307200; // Core Data: segundos desde 2001-01-01
const CHAT_DB = path.join("data", "ios", "ChatStorage.sqlite");

// ZMESSAGETYPE (WhatsApp iOS) → nuestro tipo.
const TYPE_MAP: Record<number, "text" | "image" | "audio" | "video" | "document" | "other"> = {
  0: "text",
  1: "image",
  2: "video",
  3: "audio",
  8: "document",
};

interface Session {
  Z_PK: number;
  ZCONTACTJID: string;
  ZPARTNERNAME: string | null;
  ZLASTMESSAGEDATE: number | null;
  ZLASTMESSAGETEXT: string | null;
}
interface Msg {
  Z_PK: number;
  ZISFROMME: number | null;
  ZMESSAGEDATE: number | null;
  ZMESSAGETYPE: number | null;
  ZTEXT: string | null;
  ZMEDIAITEM: number | null;
}

function toTs(coreData: number | null): number | null {
  if (coreData == null) return null;
  return Math.round(coreData + APPLE_EPOCH);
}

function previewOf(type: string, text: string | null): string {
  if (text && text.trim()) return text.trim().slice(0, 120);
  switch (type) {
    case "image": return "📷 Foto";
    case "audio": return "🎤 Audio";
    case "video": return "🎬 Vídeo";
    case "document": return "📄 Documento";
    default: return "…";
  }
}

function main(): void {
  const src = new Database(CHAT_DB, { readonly: true });
  const db = openDb();
  const now = Math.floor(Date.now() / 1000);

  const sessions = src
    .prepare(
      `SELECT Z_PK, ZCONTACTJID, ZPARTNERNAME, ZLASTMESSAGEDATE, ZLASTMESSAGETEXT
       FROM ZWACHATSESSION
       WHERE ZCONTACTJID LIKE '%@s.whatsapp.net'`
    )
    .all() as Session[];

  const msgStmt = src.prepare(
    `SELECT Z_PK, ZISFROMME, ZMESSAGEDATE, ZMESSAGETYPE, ZTEXT, ZMEDIAITEM
     FROM ZWAMESSAGE WHERE ZCHATSESSION = ? ORDER BY ZMESSAGEDATE ASC`
  );

  const upsertChat = db.prepare(
    `INSERT INTO chats(jid, phone, display_name, last_message_at, last_message_preview,
                       last_opened_at, ignored, backfill_status, created_at, updated_at)
     VALUES (@jid, @phone, @name, @ts, @preview, @ts, 0, 'done', @now, @now)
     ON CONFLICT(jid) DO UPDATE SET
       display_name = COALESCE(NULLIF(excluded.display_name, ''), chats.display_name),
       last_message_at = MAX(COALESCE(chats.last_message_at,0), COALESCE(excluded.last_message_at,0)),
       last_message_preview = COALESCE(excluded.last_message_preview, chats.last_message_preview),
       backfill_status = 'done',
       updated_at = excluded.updated_at`
  );
  const insMsg = db.prepare(
    `INSERT INTO messages(chat_jid, id, from_me, ts, type, text, media_path, media_mime, raw_json)
     VALUES (@jid, @id, @from, @ts, @type, @text, NULL, NULL, NULL)
     ON CONFLICT(chat_jid, id) DO NOTHING`
  );

  let chatsN = 0;
  let msgsN = 0;

  const touchChat = db.prepare(
    `UPDATE chats SET last_message_at = @ts, last_message_preview = @preview, updated_at = @now
     WHERE jid = @jid AND (last_message_at IS NULL OR @ts > last_message_at)`
  );

  const importAll = db.transaction(() => {
    for (const s of sessions) {
      const jid = s.ZCONTACTJID;

      // 1) El chat PRIMERO (FK: los mensajes referencian chats.jid).
      const sessTs = toTs(s.ZLASTMESSAGEDATE);
      const sessPreview = s.ZLASTMESSAGETEXT?.trim() ? s.ZLASTMESSAGETEXT.trim().slice(0, 120) : null;
      upsertChat.run({
        jid,
        phone: jidToPhone(jid),
        name: s.ZPARTNERNAME ?? "",
        ts: sessTs,
        preview: sessPreview,
        now,
      });
      chatsN++;

      // 2) Sus mensajes.
      const rows = msgStmt.all(s.Z_PK) as Msg[];
      let lastTs: number | null = null;
      let lastPreview: string | null = null;
      for (const m of rows) {
        const ts = toTs(m.ZMESSAGEDATE);
        if (ts == null) continue;
        const hasMedia = m.ZMEDIAITEM != null;
        const text = m.ZTEXT && m.ZTEXT.trim() ? m.ZTEXT : null;
        if (!text && !hasMedia) continue; // salta sistema/protocolo
        const type = TYPE_MAP[m.ZMESSAGETYPE ?? 0] ?? (hasMedia ? "other" : "text");
        const r = insMsg.run({ jid, id: `ios_${m.Z_PK}`, from: m.ZISFROMME ? 1 : 0, ts, type, text });
        if (r.changes > 0) {
          msgsN++;
          if (lastTs == null || ts >= lastTs) {
            lastTs = ts;
            lastPreview = previewOf(type, text);
          }
        }
      }

      // 3) Si el último mensaje real es más nuevo que lo de la sesión, ajusta.
      if (lastTs != null) touchChat.run({ jid, ts: lastTs, preview: lastPreview, now });
    }
  });

  importAll();
  console.log(`[import-ios] chats individuales=${chatsN}  mensajes nuevos=${msgsN}`);
  const totalChats = (db.prepare("SELECT COUNT(*) n FROM chats").get() as { n: number }).n;
  const totalMsgs = (db.prepare("SELECT COUNT(*) n FROM messages").get() as { n: number }).n;
  console.log(`[import-ios] BD total: ${totalChats} chats, ${totalMsgs} mensajes`);
}

main();
process.exit(0);
