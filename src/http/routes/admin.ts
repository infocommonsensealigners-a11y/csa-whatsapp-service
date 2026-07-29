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
import fs from "node:fs";
import path from "node:path";
import { getDb, statusCounts } from "../../db/db";
import { config } from "../../config";
import { backfillLidPhones, resolvePhonesToLids } from "../../wa/lidMap";

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
  /**
   * RESCATE de los chats `@lid`: recupera su teléfono real de `key.senderPn`
   * (ya guardado en messages.raw_json) → tabla wa_lid_map + rellena chats.phone
   * cuando está vacío. Idempotente y no destructivo: nunca sobrescribe un
   * teléfono existente. Devuelve además los pares "misma persona, dos chats"
   * (el @lid de Baileys y el <phone>@s.whatsapp.net del webhook) para decidir.
   */
  app.post("/admin/lid-backfill", async (request, reply) => {
    const body = request.body as { token?: string } | null;
    const q = request.query as { t?: string } | undefined;
    const provided = String(body?.token ?? q?.t ?? request.headers["x-wa-admin"] ?? "");
    if (provided !== TOKEN) return reply.status(401).send({ ok: false, error: "token inválido" });
    try {
      return { ok: true, ...backfillLidPhones() };
    } catch (e) {
      return reply.status(500).send({ ok: false, error: (e as Error).message });
    }
  });

  /**
   * Localiza la conversación OCULTA de unos teléfonos: pregunta a WhatsApp el LID
   * de cada número (solo lectura) y lo cruza con nuestros chats `@lid`. Es la
   * última vía para los que no traían el teléfono en senderPn. Máximo 100 por
   * llamada (son consultas a WhatsApp; nada de ráfagas).
   */
  app.post("/admin/resolve-lids", async (request, reply) => {
    const body = request.body as { token?: string; phones?: unknown } | null;
    const q = request.query as { t?: string } | undefined;
    const provided = String(body?.token ?? q?.t ?? request.headers["x-wa-admin"] ?? "");
    if (provided !== TOKEN) return reply.status(401).send({ ok: false, error: "token inválido" });
    const phones = Array.isArray(body?.phones) ? body!.phones.map((p) => String(p)) : [];
    if (phones.length === 0) return reply.status(400).send({ ok: false, error: "phones vacío" });
    if (phones.length > 100) return reply.status(400).send({ ok: false, error: "máximo 100 teléfonos por llamada" });
    try {
      const rows = await resolvePhonesToLids(phones);
      return {
        ok: true,
        consultados: rows.length,
        enWhatsapp: rows.filter((r) => r.enWhatsapp).length,
        conLid: rows.filter((r) => r.lid).length,
        chatsLocalizados: rows.filter((r) => r.chatLocalizado).length,
        rellenados: rows.filter((r) => r.rellenado).length,
        rows,
      };
    } catch (e) {
      return reply.status(500).send({ ok: false, error: (e as Error).message });
    }
  });

  /**
   * FUSIÓN de chats gemelos @lid (auditoría 2026-07-28 → decisión del usuario
   * 2026-07-29: "hazlo ahora"). `backfillLidPhones().duplicados` ya detecta los
   * pares "misma persona, dos chats" (el @lid de Baileys y el
   * <phone>@s.whatsapp.net) pero antes solo los REPORTABA — fusionar el
   * historial es destructivo, así que quedó para una decisión explícita.
   *
   * Por cada par: se elige CANÓNICO el chat con `last_message_at` más reciente
   * (donde Fran ha estado escribiendo de verdad); los mensajes del otro se
   * MUEVEN (nunca se copian ni se pierden — `INSERT OR IGNORE` + `DELETE`,
   * dedupe por `id` de Baileys) y sus vínculos de lead (`chat_lead_links`) y
   * etiquetas se re-apuntan al canónico sin duplicar. El perdedor NO se borra:
   * queda con `ignored=1` y sin `last_message_at` (desaparece de las listas,
   * pero la fila sigue ahí por si hace falta auditar).
   *
   * `dryRun` (por defecto true): calcula y devuelve el plan SIN escribir nada.
   * Solo con `{"dryRun":false}` explícito se ejecuta la fusión, y TODO el lote
   * va en una única transacción (si algo falla, no se toca nada).
   */
  app.post("/admin/merge-lid-chats", async (request, reply) => {
    const body = request.body as { token?: string; dryRun?: boolean } | null;
    const q = request.query as { t?: string } | undefined;
    const provided = String(body?.token ?? q?.t ?? request.headers["x-wa-admin"] ?? "");
    if (provided !== TOKEN) return reply.status(401).send({ ok: false, error: "token inválido" });
    const dryRun = body?.dryRun !== false;
    try {
      const { duplicados } = backfillLidPhones();
      const db = getDb();
      type ChatFull = {
        jid: string; phone: string | null; display_name: string | null;
        avatar_path: string | null; avatar_fetched_at: number | null;
        last_message_at: number | null; last_message_preview: string | null;
        last_opened_at: number | null; ignored: number;
      };
      const getChat = (jid: string): ChatFull | undefined =>
        db.prepare("SELECT * FROM chats WHERE jid = ?").get(jid) as ChatFull | undefined;

      const plan = duplicados.map((d) => {
        const a = getChat(d.lid);
        const b = getChat(d.pn);
        if (!a || !b) return null;
        const [canonical, loser] = (a.last_message_at ?? 0) >= (b.last_message_at ?? 0) ? [a, b] : [b, a];
        const mensajesAMover = (db.prepare("SELECT COUNT(*) AS n FROM messages WHERE chat_jid = ?").get(loser.jid) as { n: number }).n;
        const linksAMover = (db.prepare("SELECT COUNT(*) AS n FROM chat_lead_links WHERE chat_jid = ? AND status = 'active'").get(loser.jid) as { n: number }).n;
        return { lid: d.lid, pn: d.pn, phone: d.phone, canonical: canonical.jid, loser: loser.jid, mensajesAMover, linksAMover };
      }).filter((p): p is NonNullable<typeof p> => p !== null);

      if (dryRun) {
        return {
          ok: true, dryRun: true, pares: plan.length,
          totalMensajes: plan.reduce((s, p) => s + p.mensajesAMover, 0),
          plan,
        };
      }

      const now = Math.floor(Date.now() / 1000);
      const resultados: Array<{ canonical: string; loser: string; mensajesMovidos: number; linksActualizados: number; tagsActualizados: number }> = [];
      const tx = db.transaction(() => {
        for (const p of plan) {
          const canonical = getChat(p.canonical)!;
          const loser = getChat(p.loser)!;

          // 1) Mensajes: mover, deduplicando por id de Baileys (PK compuesta).
          const antes = (db.prepare("SELECT COUNT(*) AS n FROM messages WHERE chat_jid = ?").get(canonical.jid) as { n: number }).n;
          db.prepare(
            `INSERT OR IGNORE INTO messages (chat_jid, id, from_me, ts, type, text, media_path, media_mime, raw_json)
             SELECT ?, id, from_me, ts, type, text, media_path, media_mime, raw_json FROM messages WHERE chat_jid = ?`
          ).run(canonical.jid, loser.jid);
          db.prepare("DELETE FROM messages WHERE chat_jid = ?").run(loser.jid);
          const despues = (db.prepare("SELECT COUNT(*) AS n FROM messages WHERE chat_jid = ?").get(canonical.jid) as { n: number }).n;

          // 2) Metadatos del chat canónico: lo mejor de los dos.
          const masReciente = (loser.last_message_at ?? 0) > (canonical.last_message_at ?? 0) ? loser : canonical;
          db.prepare(
            `UPDATE chats SET
               phone = COALESCE(phone, ?),
               display_name = COALESCE(display_name, ?),
               avatar_path = COALESCE(avatar_path, ?),
               avatar_fetched_at = COALESCE(avatar_fetched_at, ?),
               last_message_at = ?,
               last_message_preview = ?,
               updated_at = ?
             WHERE jid = ?`
          ).run(
            loser.phone, loser.display_name, loser.avatar_path, loser.avatar_fetched_at,
            masReciente.last_message_at, masReciente.last_message_preview, now, canonical.jid
          );

          // 3) chat_lead_links activos del perdedor: re-apuntar si el canónico
          // no tiene ya ese mismo link activo (evita violar el UNIQUE).
          const links = db.prepare("SELECT * FROM chat_lead_links WHERE chat_jid = ? AND status = 'active'").all(loser.jid) as Array<{
            id: number; source_row: number; phone_snapshot: string | null; lead_name_snapshot: string | null; method: string;
          }>;
          let linksActualizados = 0;
          for (const link of links) {
            const yaExiste = db
              .prepare("SELECT 1 FROM chat_lead_links WHERE chat_jid = ? AND source_row = ? AND status = 'active'")
              .get(canonical.jid, link.source_row);
            if (!yaExiste) {
              db.prepare(
                `INSERT INTO chat_lead_links (chat_jid, source_row, phone_snapshot, lead_name_snapshot, method, status, created_at, updated_at)
                 VALUES (?, ?, ?, ?, ?, 'active', ?, ?)`
              ).run(canonical.jid, link.source_row, link.phone_snapshot, link.lead_name_snapshot, link.method, now, now);
              linksActualizados++;
            }
            db.prepare("UPDATE chat_lead_links SET status = 'removed', updated_at = ? WHERE id = ?").run(now, link.id);
          }

          // 4) Etiquetas del perdedor: re-apuntar si el canónico no la tiene ya.
          const tags = db.prepare("SELECT * FROM chat_tags WHERE chat_jid = ?").all(loser.jid) as Array<{
            tag_id: number; source: string; status: string; confidence: number | null;
          }>;
          let tagsActualizados = 0;
          for (const t of tags) {
            const yaExiste = db.prepare("SELECT 1 FROM chat_tags WHERE chat_jid = ? AND tag_id = ?").get(canonical.jid, t.tag_id);
            if (!yaExiste) {
              db.prepare(
                "INSERT INTO chat_tags (chat_jid, tag_id, source, status, confidence) VALUES (?, ?, ?, ?, ?)"
              ).run(canonical.jid, t.tag_id, t.source, t.status, t.confidence);
              tagsActualizados++;
            }
          }
          db.prepare("DELETE FROM chat_tags WHERE chat_jid = ?").run(loser.jid);

          // 5) El perdedor NO se borra: se apaga (ignored=1, sin last_message_at)
          // para que desaparezca de las listas activas sin perder la fila.
          db.prepare(
            "UPDATE chats SET ignored = 1, last_message_at = NULL, last_message_preview = NULL, updated_at = ? WHERE jid = ?"
          ).run(now, loser.jid);

          resultados.push({ canonical: canonical.jid, loser: loser.jid, mensajesMovidos: despues - antes, linksActualizados, tagsActualizados });
        }
      });
      tx();

      return { ok: true, dryRun: false, pares: resultados.length, resultados };
    } catch (e) {
      return reply.status(500).send({ ok: false, error: (e as Error).message });
    }
  });

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

  // Subida de AVATARES al volumen (migración puntual, mismo token). Los ficheros
  // llegan en base64 por lotes (el proxy del dashboard no deja usar SSH/railway
  // files). Se escriben en config.avatarsDir con el nombre determinista
  // <jid_con__>.jpg que espera la ruta /avatars/:jid.
  app.post("/admin/upload-avatars", async (request, reply) => {
    const body = request.body as { token?: string; files?: { name: string; b64: string }[] } | null;
    if (String(body?.token ?? "") !== TOKEN) {
      return reply.status(401).send({ ok: false, error: "token inválido" });
    }
    fs.mkdirSync(config.avatarsDir, { recursive: true });
    let written = 0;
    for (const f of body?.files ?? []) {
      const safe = path.basename(String(f?.name ?? ""));
      if (!/^[a-zA-Z0-9_.-]+\.jpg$/.test(safe) || typeof f?.b64 !== "string") continue;
      try {
        fs.writeFileSync(path.join(config.avatarsDir, safe), Buffer.from(f.b64, "base64"));
        written++;
      } catch {
        /* ignora fichero suelto que falle */
      }
    }
    return { ok: true, written };
  });
}

// (histórico migrado 2026-07-20; endpoint de ingesta puntual, retirable)
