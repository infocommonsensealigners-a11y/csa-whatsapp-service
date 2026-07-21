/**
 * Ingesta de conversaciones → SQLite. Escucha dos fuentes:
 *  - "messaging-history.set": volcado que el móvil comparte al emparejar
 *    (historial reciente; best-effort, puede llegar en varios lotes).
 *  - "messages.upsert": mensajes en vivo.
 *
 * Todo es idempotente (PK (chat_jid, id) + ON CONFLICT DO NOTHING), así que
 * reconexiones y re-entregas no duplican nada. Solo chats 1-a-1: cualquier
 * otro JID se descarta aquí además del shouldIgnoreJid del socket.
 */
import type { Chat, Contact, WAMessage } from "baileys";
import { getDb, setMeta } from "../db/db";
import { emitSse } from "../http/sse";
import { isStorableChatJid, jidToPhone } from "./jidPhone";
import { onWaEvent } from "./socket";
import { analyzeChat } from "../brain/analyzeChat";

type MsgType = "text" | "image" | "audio" | "video" | "document" | "other";

interface ExtractedContent {
  type: MsgType;
  text: string | null;
}

/** Desenvuelve wrappers (efímeros, view-once) y clasifica el contenido. */
function extractContent(msg: WAMessage): ExtractedContent | null {
  const m = msg.message;
  if (!m) return null;
  const inner =
    m.ephemeralMessage?.message ??
    m.viewOnceMessage?.message ??
    m.viewOnceMessageV2?.message ??
    m.documentWithCaptionMessage?.message ??
    m;

  if (inner.conversation) return { type: "text", text: inner.conversation };
  if (inner.extendedTextMessage?.text) return { type: "text", text: inner.extendedTextMessage.text };
  if (inner.imageMessage) return { type: "image", text: inner.imageMessage.caption ?? null };
  if (inner.videoMessage) return { type: "video", text: inner.videoMessage.caption ?? null };
  if (inner.audioMessage) return { type: "audio", text: null };
  if (inner.documentMessage) {
    return { type: "document", text: inner.documentMessage.caption ?? inner.documentMessage.fileName ?? null };
  }
  if (inner.stickerMessage) return { type: "other", text: null };
  // Plumbing del protocolo (reacciones, borrados, claves…): no es contenido.
  if (
    inner.protocolMessage ||
    inner.reactionMessage ||
    inner.pollUpdateMessage ||
    inner.senderKeyDistributionMessage
  ) {
    return null;
  }
  return { type: "other", text: null };
}

function previewOf(content: ExtractedContent): string {
  if (content.text) return content.text.slice(0, 120);
  switch (content.type) {
    case "image":
      return "📷 Foto";
    case "audio":
      return "🎤 Audio";
    case "video":
      return "🎬 Vídeo";
    case "document":
      return "📄 Documento";
    default:
      return "…";
  }
}

/** messageTimestamp puede ser number | Long | bigint según la ruta de entrada. */
function tsOf(v: unknown): number {
  if (typeof v === "number") return v;
  if (typeof v === "bigint") return Number(v);
  if (v && typeof (v as { toNumber?: () => number }).toNumber === "function") {
    return (v as { toNumber: () => number }).toNumber();
  }
  return Math.floor(Date.now() / 1000);
}

/* ------------------------------ statements -------------------------------- */

function statements() {
  const db = getDb();
  return {
    upsertMessage: db.prepare(
      `INSERT INTO messages(chat_jid, id, from_me, ts, type, text, media_path, media_mime, raw_json)
       VALUES (@chat_jid, @id, @from_me, @ts, @type, @text, NULL, NULL, @raw_json)
       ON CONFLICT(chat_jid, id) DO NOTHING`
    ),
    upsertChat: db.prepare(
      `INSERT INTO chats(jid, phone, display_name, last_message_at, last_message_preview, created_at, updated_at)
       VALUES (@jid, @phone, @display_name, @last_message_at, @last_message_preview, @now, @now)
       ON CONFLICT(jid) DO UPDATE SET
         display_name = COALESCE(NULLIF(excluded.display_name, ''), chats.display_name),
         last_message_at = MAX(COALESCE(chats.last_message_at, 0), COALESCE(excluded.last_message_at, 0)),
         last_message_preview = CASE
           WHEN COALESCE(excluded.last_message_at, 0) >= COALESCE(chats.last_message_at, 0)
             AND excluded.last_message_preview IS NOT NULL
           THEN excluded.last_message_preview
           ELSE chats.last_message_preview END,
         updated_at = excluded.updated_at`
    ),
    updateName: db.prepare(
      `UPDATE chats SET display_name = @name, updated_at = @now
       WHERE jid = @jid AND (display_name IS NULL OR display_name = '' OR @overwrite = 1)`
    ),
  };
}

/* -------------------------------- ingesta --------------------------------- */

interface IngestResult {
  /** JIDs con mensajes nuevos realmente insertados. */
  touched: Set<string>;
}

function ingestMessages(messages: WAMessage[]): IngestResult {
  const db = getDb();
  const stmts = statements();
  const touched = new Set<string>();
  const now = Math.floor(Date.now() / 1000);

  const run = db.transaction((batch: WAMessage[]) => {
    for (const msg of batch) {
      const jid = msg.key?.remoteJid;
      if (!jid || !isStorableChatJid(jid) || msg.broadcast) continue;
      const content = extractContent(msg);
      if (!content) continue;

      const ts = tsOf(msg.messageTimestamp);
      const preview = previewOf(content);
      stmts.upsertChat.run({
        jid,
        phone: jidToPhone(jid),
        display_name: !msg.key.fromMe ? (msg.pushName ?? "") : "",
        last_message_at: ts,
        last_message_preview: preview,
        now,
      });
      const inserted = stmts.upsertMessage.run({
        chat_jid: jid,
        id: msg.key.id ?? `${ts}-${Math.random().toString(36).slice(2)}`,
        from_me: msg.key.fromMe ? 1 : 0,
        ts,
        type: content.type,
        text: content.text,
        raw_json: JSON.stringify(msg),
      });
      if (inserted.changes > 0) touched.add(jid);
    }
  });
  run(messages);
  return { touched };
}

/** Crea filas de chat "vacías" a partir del listado del history-sync, aunque
 *  ese chat no traiga mensajes en el mismo lote (así el chat aparece igual). */
function ingestChatShells(chats: Chat[]): number {
  const db = getDb();
  const stmts = statements();
  const now = Math.floor(Date.now() / 1000);
  let n = 0;
  const run = db.transaction((batch: Chat[]) => {
    for (const chat of batch) {
      const jid = chat.id;
      if (!jid || !isStorableChatJid(jid)) continue;
      const ts =
        typeof chat.conversationTimestamp === "number"
          ? chat.conversationTimestamp
          : chat.conversationTimestamp
            ? Number(chat.conversationTimestamp)
            : null;
      stmts.upsertChat.run({
        jid,
        phone: jidToPhone(jid),
        display_name: chat.name ?? "",
        last_message_at: ts,
        last_message_preview: null,
        now,
      });
      n++;
    }
  });
  run(chats);
  return n;
}

function applyContactNames(contacts: Array<Partial<Contact>>, overwrite: boolean): void {
  const stmts = statements();
  const now = Math.floor(Date.now() / 1000);
  for (const c of contacts) {
    const jid = c.id;
    if (!jid || !isStorableChatJid(jid)) continue;
    const name = c.name ?? c.verifiedName ?? c.notify;
    if (!name) continue;
    stmts.updateName.run({ jid, name, now, overwrite: overwrite ? 1 : 0 });
  }
}

/* ------------- Fransua EN DIRECTO: re-análisis al llegar mensaje ------------- */
// Cuando entra un mensaje NUEVO en vivo (type "notify", NO el backfill de
// historial), re-analizamos ese chat tras un pequeño anti-rebote: deja que la
// ráfaga se asiente (WhatsApp llega a golpes) y evita saturar la IA. Un timer por
// jid; si llegan más mensajes, se reinicia y solo analiza cuando la charla pausa.
const LIVE_ANALYZE_DEBOUNCE_MS = 20_000;
const liveAnalyzeTimers = new Map<string, NodeJS.Timeout>();

function scheduleLiveAnalyze(jid: string): void {
  const prev = liveAnalyzeTimers.get(jid);
  if (prev) clearTimeout(prev);
  liveAnalyzeTimers.set(
    jid,
    setTimeout(() => {
      liveAnalyzeTimers.delete(jid);
      analyzeChat(jid)
        .then((r) => {
          if (r.ok) console.log(`[intel] re-análisis en vivo OK: ${jid}`);
        })
        .catch((e) => console.error("[intel] re-análisis en vivo falló:", (e as Error).message));
    }, LIVE_ANALYZE_DEBOUNCE_MS)
  );
}

/** Registra los listeners de ingesta en la fachada (sobreviven reconexiones). */
export function registerIngest(): void {
  onWaEvent("messaging-history.set", (payload) => {
    try {
      const { chats, contacts, messages, isLatest, progress, syncType } = payload as typeof payload & {
        isLatest?: boolean;
        progress?: number | null;
        syncType?: number;
      };
      const shells = ingestChatShells((chats as Chat[]) ?? []);
      const result = ingestMessages(messages ?? []);
      applyContactNames(contacts ?? [], false);
      const now = Math.floor(Date.now() / 1000);
      setMeta("last_history_sync", String(now));
      console.log(
        `[ingest] history.set syncType=${syncType ?? "?"} isLatest=${isLatest ?? "?"} ` +
          `progress=${progress ?? "?"} chats=${(chats ?? []).length} contacts=${(contacts ?? []).length} ` +
          `messages=${(messages ?? []).length} → chatsGuardados=${shells} conMsg=${result.touched.size}`
      );
      // Cualquier volcado (chats o mensajes) refresca la lista entera.
      emitSse({ type: "chats.synced" });
    } catch (err) {
      console.error("[ingest] error procesando history.set:", (err as Error).message);
    }
  });

  onWaEvent("messages.upsert", ({ messages, type }) => {
    if (type !== "notify" && type !== "append") return;
    try {
      const result = ingestMessages(messages);
      console.log(
        `[ingest] upsert type=${type} recibidos=${messages.length} guardados=${result.touched.size}` +
          (messages[0]?.key?.remoteJid ? ` primer=${messages[0].key.remoteJid}` : "")
      );
      for (const jid of result.touched) emitSse({ type: "message.new", jid });
      // Fransua EN DIRECTO: solo mensajes nuevos reales ("notify"), no el backfill.
      if (type === "notify") {
        for (const jid of result.touched) scheduleLiveAnalyze(jid);
      }
    } catch (err) {
      console.error("[ingest] error procesando upsert:", (err as Error).message);
    }
  });

  onWaEvent("contacts.upsert", (contacts) => applyContactNames(contacts, false));
  onWaEvent("contacts.update", (contacts) => applyContactNames(contacts, true));

  // Etiquetas de WhatsApp Business (las del usuario en la app) — read-only.
  onWaEvent("labels.edit", (label) => {
    try {
      getDb()
        .prepare(
          `INSERT INTO wa_labels(id, name, color, deleted) VALUES (@id, @name, @color, @deleted)
           ON CONFLICT(id) DO UPDATE SET name = excluded.name, color = excluded.color, deleted = excluded.deleted`
        )
        .run({
          id: label.id,
          name: label.name ?? "",
          color: typeof label.color === "number" ? label.color : 0,
          deleted: label.deleted ? 1 : 0,
        });
    } catch (err) {
      console.error("[ingest] labels.edit:", (err as Error).message);
    }
  });

  onWaEvent("labels.association", ({ association, type }) => {
    try {
      const assoc = association as { type?: string; chatId?: string; labelId?: string; messageId?: string };
      // Solo asociaciones de CHAT (no de mensaje): type "label_jid".
      if (assoc?.type !== "label_jid" || !assoc.chatId || !assoc.labelId) return;
      const db = getDb();
      if (type === "add") {
        db.prepare(`INSERT OR IGNORE INTO wa_chat_labels(chat_jid, label_id) VALUES (?, ?)`).run(assoc.chatId, assoc.labelId);
      } else {
        db.prepare(`DELETE FROM wa_chat_labels WHERE chat_jid = ? AND label_id = ?`).run(assoc.chatId, assoc.labelId);
      }
    } catch (err) {
      console.error("[ingest] labels.association:", (err as Error).message);
    }
  });
}
