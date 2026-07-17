/**
 * POST /import/chat — importa una exportación de WhatsApp (.txt) a un chat.
 * Body: { text, leadName, myName?, sourceRow? }
 *   - text: contenido del .txt exportado.
 *   - leadName: nombre del lead (el OTRO participante) — da nombre e id al chat.
 *   - myName: nombre exacto con el que aparecen TUS mensajes (para fromMe).
 *   - sourceRow: (opcional) fila del CRM a la que pertenece, si ya se conoce.
 *
 * Crea/rellena un chat con jid sintético `import:<slug>` (nunca choca con los
 * jids reales) y guarda los mensajes de forma idempotente. Devuelve un resumen.
 */
import type { FastifyInstance } from "fastify";
import { getDb } from "../../db/db";
import { emitSse } from "../sse";
import { parseWhatsappExport } from "../../import/parseExport";

function slug(s: string): string {
  return s
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40) || "sin-nombre";
}

export function registerImportRoutes(app: FastifyInstance): void {
  app.post("/import/chat", async (request, reply) => {
    const body = request.body as {
      text?: unknown;
      leadName?: unknown;
      myName?: unknown;
      sourceRow?: unknown;
    } | null;

    if (typeof body?.text !== "string" || !body.text.trim()) {
      return reply.status(400).send({ ok: false, error: 'Falta "text" (contenido del .txt).' });
    }
    const leadName = typeof body.leadName === "string" && body.leadName.trim() ? body.leadName.trim() : "Importado";
    const myName = typeof body.myName === "string" ? body.myName.trim() : undefined;

    const parsed = parseWhatsappExport(body.text, myName);
    if (parsed.messages.length === 0) {
      return reply.status(422).send({
        ok: false,
        error: "No se reconoció ningún mensaje. ¿Es un .txt exportado de WhatsApp?",
        senders: parsed.senders,
      });
    }

    const jid = `import:${slug(leadName)}`;
    const db = getDb();
    const now = Math.floor(Date.now() / 1000);
    const last = parsed.messages[parsed.messages.length - 1];
    const preview =
      last.text?.slice(0, 120) ??
      (last.type === "image" ? "📷 Foto" : last.type === "audio" ? "🎤 Audio" : "Adjunto");

    db.prepare(
      `INSERT INTO chats(jid, phone, display_name, last_message_at, last_message_preview, last_opened_at, ignored, backfill_status, created_at, updated_at)
       VALUES (@jid, NULL, @name, @ts, @preview, @ts, 0, 'done', @now, @now)
       ON CONFLICT(jid) DO UPDATE SET
         display_name = excluded.display_name,
         last_message_at = MAX(chats.last_message_at, excluded.last_message_at),
         last_message_preview = excluded.last_message_preview,
         updated_at = excluded.updated_at`
    ).run({ jid, name: leadName, ts: last.ts, preview, now });

    const insMsg = db.prepare(
      `INSERT INTO messages(chat_jid, id, from_me, ts, type, text, media_path, media_mime, raw_json)
       VALUES (@jid, @id, @from, @ts, @type, @text, NULL, NULL, NULL)
       ON CONFLICT(chat_jid, id) DO NOTHING`
    );
    let stored = 0;
    const run = db.transaction(() => {
      parsed.messages.forEach((m, i) => {
        // id determinista por (ts, índice): reimportar el mismo .txt no duplica.
        const r = insMsg.run({
          jid,
          id: `imp_${m.ts}_${i}`,
          from: m.fromMe ? 1 : 0,
          ts: m.ts,
          type: m.type,
          text: m.text,
        });
        if (r.changes > 0) stored++;
      });
    });
    run();

    emitSse({ type: "chats.synced" });
    return {
      ok: true,
      jid,
      leadName,
      parsed: parsed.messages.length,
      stored,
      senders: parsed.senders,
      skippedSystem: parsed.skippedSystem,
      oldest: parsed.messages[0]?.ts ?? null,
      newest: last.ts,
    };
  });
}
