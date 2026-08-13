/**
 * Resolución MANUAL de los chats "ambiguos" del matching WhatsApp↔CRM (ver
 * src/brain/linkLeads.ts) — nombres de WhatsApp con más de una fila candidata
 * en el Sheet (p.ej. "Daniel" con 3 leads distintos), que el matcher
 * automático deja deliberadamente sin linkar para no adivinar mal.
 *
 *  - GET  /link-leads/ambiguous → última lista calculada por linkLeadsScheduler
 *    (persistida en `meta`, no recalcula nada al vuelo).
 *  - POST /link-leads/manual    → fija a mano {jid, sourceRow} como
 *    method='manual' en chat_lead_links (el scheduler automático nunca toca
 *    los enlaces 'manual' — ver el guard WHERE method='auto' en linkLeads.ts).
 */
import type { FastifyInstance } from "fastify";
import { getDb, getMeta, setMeta } from "../../db/db";
import { AMBIGUOUS_META_KEY } from "../../brain/linkLeadsScheduler";
import type { AmbiguousMatch } from "../../brain/linkLeads";

export function registerLinkLeadsRoutes(app: FastifyInstance): void {
  app.get("/link-leads/ambiguous", async () => {
    const raw = getMeta(AMBIGUOUS_META_KEY);
    const ambiguous = raw ? (JSON.parse(raw) as AmbiguousMatch[]) : [];
    return { ok: true, ambiguous };
  });

  app.post("/link-leads/manual", async (req, reply) => {
    const body = req.body as { jid?: string; sourceRow?: number } | null;
    const jid = body?.jid;
    const sourceRow = body?.sourceRow;
    if (!jid || typeof sourceRow !== "number" || !Number.isFinite(sourceRow)) {
      return reply.status(400).send({ ok: false, error: "jid y sourceRow (número) son obligatorios" });
    }
    const now = Math.floor(Date.now() / 1000);
    const db = getDb();
    /**
     * INSTANTÁNEA del lead al vincular. Antes se guardaba `NULL, NULL` y eso
     * dejaba el vínculo mudo: el chat quedaba atado a un número de fila y a nada
     * más, así que si la fila se movía el vínculo apuntaba a otra persona y
     * nadie podía notarlo. Con nombre y teléfono guardados, el chat se puede
     * volver a casar por teléfono (identidad estable) y además se puede ENSEÑAR
     * el nombre — es lo que hacía que el teléfono flotante rotulara un chat con
     * el identificador interno del `@lid` aunque acabaras de vincularlo.
     */
    const lead = db
      .prepare("SELECT name, phone FROM lead_directory WHERE source_row = ?")
      .get(sourceRow) as { name: string | null; phone: string | null } | undefined;
    db.prepare(
      `INSERT INTO chat_lead_links
           (chat_jid, source_row, phone_snapshot, lead_name_snapshot, method, status, created_at, updated_at)
         VALUES (@jid, @sourceRow, @phone, @name, 'manual', 'active', @now, @now)
         ON CONFLICT(chat_jid, source_row) DO UPDATE SET
           method='manual', status='active', updated_at=excluded.updated_at,
           phone_snapshot = COALESCE(excluded.phone_snapshot, chat_lead_links.phone_snapshot),
           lead_name_snapshot = COALESCE(excluded.lead_name_snapshot, chat_lead_links.lead_name_snapshot)`
    ).run({
      jid,
      sourceRow,
      phone: (lead?.phone ?? "").trim() || null,
      name: (lead?.name ?? "").trim() || null,
      now,
    });

    // Ya no es ambiguo: lo quita de la lista persistida para que no reaparezca
    // en la UI hasta que el matcher automático lo recalcule (no debería, al
    // estar ya linkado a mano).
    const raw = getMeta(AMBIGUOUS_META_KEY);
    if (raw) {
      const list = JSON.parse(raw) as AmbiguousMatch[];
      setMeta(AMBIGUOUS_META_KEY, JSON.stringify(list.filter((a) => a.jid !== jid)));
    }
    return { ok: true };
  });
}
