/**
 * Rutas de inbox (Fase 1, parcial):
 *  - GET  /chats?query=&limit=&offset=      → { chats: ChatSummary[], total }
 *  - GET  /chats/:jid/messages?beforeTs=&limit= → { messages: WaMessage[] } (desc)
 *  - POST /chats/:jid/opened                → marca leído local (last_opened_at)
 *  - POST /chats/:jid/ignore                → { ignored: boolean }
 *
 * links/tags/hasAbstract llegan vacíos hasta que el matcher (F1) y la capa IA
 * (F2) los rellenen — el shape del contrato ya es el definitivo.
 */
import type { FastifyInstance } from "fastify";
import { getDb } from "../../db/db";
import { emitSse } from "../sse";
import type { ChatSummary, WaMessage } from "../../../../shared/whatsapp-contracts";

interface ChatRow {
  jid: string;
  phone: string | null;
  display_name: string | null;
  last_message_at: number | null;
  last_message_preview: string | null;
  ignored: number;
  unread: number;
}

function toSummary(row: ChatRow): ChatSummary {
  return {
    jid: row.jid,
    phone: row.phone,
    displayName: row.display_name || (row.phone ?? row.jid.split("@")[0]),
    lastMessageAt: row.last_message_at,
    lastMessagePreview: row.last_message_preview,
    unread: row.unread,
    ignored: row.ignored === 1,
    links: [],
    approvedTags: [],
    proposedTags: [],
    hasAbstract: false,
  };
}

export function registerChatRoutes(app: FastifyInstance): void {
  app.get("/chats", async (request) => {
    const q = request.query as { query?: string; limit?: string; offset?: string };
    const limit = Math.min(Number(q.limit) || 100, 500);
    const offset = Number(q.offset) || 0;
    const search = (q.query ?? "").trim();

    const db = getDb();
    const where = search
      ? "WHERE c.ignored = 0 AND (c.display_name LIKE @like OR c.phone LIKE @like)"
      : "WHERE c.ignored = 0";
    const rows = db
      .prepare(
        `SELECT c.jid, c.phone, c.display_name, c.last_message_at, c.last_message_preview, c.ignored,
                (SELECT COUNT(*) FROM messages m
                  WHERE m.chat_jid = c.jid AND m.from_me = 0
                    AND m.ts > COALESCE(c.last_opened_at, 0)) AS unread
         FROM chats c ${where}
         ORDER BY c.last_message_at DESC
         LIMIT @limit OFFSET @offset`
      )
      .all({ like: `%${search}%`, limit, offset }) as ChatRow[];
    const total = (
      db.prepare(`SELECT COUNT(*) AS n FROM chats c ${where}`).get({ like: `%${search}%` }) as {
        n: number;
      }
    ).n;

    return { chats: rows.map(toSummary), total };
  });

  app.get("/chats/:jid/messages", async (request) => {
    const { jid } = request.params as { jid: string };
    const q = request.query as { beforeTs?: string; limit?: string };
    const limit = Math.min(Number(q.limit) || 50, 200);
    const beforeTs = Number(q.beforeTs) || Number.MAX_SAFE_INTEGER;

    const rows = getDb()
      .prepare(
        `SELECT id, chat_jid, from_me, ts, type, text, media_path
         FROM messages
         WHERE chat_jid = ? AND ts < ?
         ORDER BY ts DESC
         LIMIT ?`
      )
      .all(jid, beforeTs, limit) as Array<{
      id: string;
      chat_jid: string;
      from_me: number;
      ts: number;
      type: WaMessage["type"];
      text: string | null;
      media_path: string | null;
    }>;

    const messages: WaMessage[] = rows.map((r) => ({
      id: r.id,
      chatJid: r.chat_jid,
      fromMe: r.from_me === 1,
      ts: r.ts,
      type: r.type,
      text: r.text,
      mediaUrl: r.media_path ? `/api/whatsapp/media/${encodeURIComponent(r.chat_jid)}/${encodeURIComponent(r.id)}` : null,
    }));
    return { messages };
  });

  app.post("/chats/:jid/opened", async (request) => {
    const { jid } = request.params as { jid: string };
    getDb()
      .prepare("UPDATE chats SET last_opened_at = ?, updated_at = ? WHERE jid = ?")
      .run(Math.floor(Date.now() / 1000), Math.floor(Date.now() / 1000), jid);
    emitSse({ type: "chat.updated", jid });
    return { ok: true };
  });

  app.post("/chats/:jid/ignore", async (request, reply) => {
    const { jid } = request.params as { jid: string };
    const body = request.body as { ignored?: unknown } | null;
    if (typeof body?.ignored !== "boolean") {
      return reply.status(400).send({ ok: false, error: 'Requiere body { "ignored": boolean }.' });
    }
    getDb()
      .prepare("UPDATE chats SET ignored = ?, updated_at = ? WHERE jid = ?")
      .run(body.ignored ? 1 : 0, Math.floor(Date.now() / 1000), jid);
    emitSse({ type: "chat.updated", jid });
    return { ok: true };
  });
}
