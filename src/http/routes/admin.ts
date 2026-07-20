/**
 * POST /admin/ingest — ingesta idempotente de histórico (chats + messages +
 * chat_lead_links) para MIGRAR la base local al volumen de producción SIN CLI de
 * Railway: el driver local (scripts/migrate-to-prod.ts) lee `wa.sqlite3` y sube
 * lotes a través del proxy PÚBLICO autenticado del dashboard (/api/whatsapp/*).
 *
 * SEGURIDAD: solo se llega aquí vía el proxy (que exige sesión del dashboard) y
 * la red privada de Railway; además exige el token `WA_ADMIN_TOKEN` (o el
 * fallback), que se pasa en el CUERPO (`token`) o en query (`?t=`) — NO en
 * cabecera, porque el proxy del dashboard descarta cabeceras personalizadas.
 * READ-ONLY respecto a WhatsApp: solo escribe en el sqlite, no envía nada.
 * Endpoint pensado para migración puntual (se puede retirar después).
 *
 * Orden importante (foreign_keys=ON): el driver manda CHATS antes que messages y
 * links, que referencian chats(jid).
 */
import type { FastifyInstance } from "fastify";
import { getDb, statusCounts } from "../../db/db";

const TOKEN = (process.env.WA_ADMIN_TOKEN ?? "csa-migrate-2026").trim();

type ChatRow = {
  jid: string;
  phone?: string | null;
  display_name?: string | null;
  avatar_path?: string | null;
  avatar_fetched_at?: number | null;
  last_message_at?: number | null;
  last_message_preview?: string | null;
  last_opened_at?: number | null;
  ignored?: number;
  backfill_status?: string | null;
  created_at?: number;
  updated_at?: number;
};
type MsgRow = {
  chat_jid: string;
  id: string;
  from_me?: number;
  ts: number;
  type?: string;
  text?: string | null;
  media_path?: string | null;
  media_mime?: string | null;
  raw_json?: string | null;
};
type LinkRow = {
  chat_jid: string;
  source_row: number;
  phone_snapshot?: string | null;
  lead_name_snapshot?: string | null;
  method?: string;
  status?: string;
  created_at?: number;
  updated_at?: number;
};

export function registerAdminRoutes(app: FastifyInstance): void {
  app.post("/admin/ingest", async (request, reply) => {
    const body = request.body as {
      token?: string;
      chats?: ChatRow[];
      messages?: MsgRow[];
      links?: LinkRow[];
    } | null;
    const q = request.query as { t?: string } | undefined;
    // El token va en el cuerpo o en query (el proxy descarta cabeceras custom);
    // se acepta también la cabecera por si se llama directo al sidecar.
    const provided = String(body?.token ?? q?.t ?? request.headers["x-wa-admin"] ?? "");
    if (provided !== TOKEN) {
      return reply.status(401).send({ ok: false, error: "token inválido" });
    }
    const db = getDb();
    const now = Math.floor(Date.now() / 1000);

    const insChat = db.prepare(
      `INSERT OR IGNORE INTO chats
       (jid,phone,display_name,avatar_path,avatar_fetched_at,last_message_at,last_message_preview,last_opened_at,ignored,backfill_status,created_at,updated_at)
       VALUES (@jid,@phone,@display_name,@avatar_path,@avatar_fetched_at,@last_message_at,@last_message_preview,@last_opened_at,@ignored,@backfill_status,@created_at,@updated_at)`
    );
    const insMsg = db.prepare(
      `INSERT OR IGNORE INTO messages
       (chat_jid,id,from_me,ts,type,text,media_path,media_mime,raw_json)
       VALUES (@chat_jid,@id,@from_me,@ts,@type,@text,@media_path,@media_mime,@raw_json)`
    );
    const insLink = db.prepare(
      `INSERT OR IGNORE INTO chat_lead_links
       (chat_jid,source_row,phone_snapshot,lead_name_snapshot,method,status,created_at,updated_at)
       VALUES (@chat_jid,@source_row,@phone_snapshot,@lead_name_snapshot,@method,@status,@created_at,@updated_at)`
    );

    let ic = 0,
      im = 0,
      il = 0;
    const run = db.transaction(() => {
      for (const c of body?.chats ?? []) {
        ic += insChat.run({
          jid: c.jid,
          phone: c.phone ?? null,
          display_name: c.display_name ?? null,
          avatar_path: c.avatar_path ?? null,
          avatar_fetched_at: c.avatar_fetched_at ?? null,
          last_message_at: c.last_message_at ?? null,
          last_message_preview: c.last_message_preview ?? null,
          last_opened_at: c.last_opened_at ?? null,
          ignored: c.ignored ?? 0,
          backfill_status: c.backfill_status ?? null,
          created_at: c.created_at ?? now,
          updated_at: c.updated_at ?? now,
        }).changes;
      }
      for (const m of body?.messages ?? []) {
        im += insMsg.run({
          chat_jid: m.chat_jid,
          id: m.id,
          from_me: m.from_me ?? 0,
          ts: m.ts,
          type: m.type ?? "text",
          text: m.text ?? null,
          media_path: m.media_path ?? null,
          media_mime: m.media_mime ?? null,
          raw_json: m.raw_json ?? null,
        }).changes;
      }
      for (const l of body?.links ?? []) {
        il += insLink.run({
          chat_jid: l.chat_jid,
          source_row: l.source_row,
          phone_snapshot: l.phone_snapshot ?? null,
          lead_name_snapshot: l.lead_name_snapshot ?? null,
          method: l.method ?? "auto",
          status: l.status ?? "active",
          created_at: l.created_at ?? now,
          updated_at: l.updated_at ?? now,
        }).changes;
      }
    });

    try {
      run();
    } catch (e) {
      return reply.status(500).send({ ok: false, error: (e as Error).message });
    }

    return { ok: true, inserted: { chats: ic, messages: im, links: il }, counts: statusCounts() };
  });
}

// (histórico migrado 2026-07-20; endpoint de ingesta puntual, retirable)
