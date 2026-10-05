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
 *  - GET  /link-leads/manuales  → MIDE los vínculos manuales contra el CRM de
 *    hoy: cuáles siguen en la fila de su persona, cuáles se han quedado en la
 *    de otra (y a cuál irían) y cuáles no se pueden comprobar. No escribe nada.
 *  - POST /link-leads/manuales/reapuntar → lo mismo y, con `aplicar: true`,
 *    mueve los que tienen arreglo claro. Acepta un `mapa` de filas para los
 *    vínculos antiguos sin instantánea. Ver src/brain/reapuntarVinculos.ts.
 */
import type { FastifyInstance } from "fastify";
import { getDb, getMeta, setMeta } from "../../db/db";
import { AMBIGUOUS_META_KEY, getUltimosLeads } from "../../brain/linkLeadsScheduler";
import type { AmbiguousMatch, DatasetLead } from "../../brain/linkLeads";
import { reapuntarVinculosManuales } from "../../brain/reapuntarVinculos";
import { reapuntarEnIntel } from "../../brain/intelDesvincular";

/**
 * Los leads contra los que se comprueban los vínculos: los de la última pasada
 * del emparejador (traen los teléfonos alternativos de las personas fusionadas)
 * o, si el proceso acaba de arrancar y aún no ha habido ninguna, el directorio
 * local, que es la foto de esa misma pasada guardada en disco.
 */
function leadsDeHoy(): DatasetLead[] {
  const enMemoria = getUltimosLeads();
  if (enMemoria) return enMemoria;
  const dir = getDb().prepare("SELECT source_row, phone, name FROM lead_directory").all() as { source_row: number; phone: string | null; name: string | null }[];
  return dir.map((d) => ({ sourceRow: d.source_row, telefono: d.phone ?? undefined, nombre: d.name ?? undefined }));
}

export function registerLinkLeadsRoutes(app: FastifyInstance): void {
  app.get("/link-leads/ambiguous", async () => {
    const raw = getMeta(AMBIGUOUS_META_KEY);
    const ambiguous = raw ? (JSON.parse(raw) as AmbiguousMatch[]) : [];
    return { ok: true, ambiguous };
  });

  app.post("/link-leads/manual", async (req, reply) => {
    const body = req.body as { jid?: string; sourceRow?: number; phone?: string; name?: string } | null;
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
      // ⚠️ Si quien vincula manda el teléfono y el nombre del lead que TIENE
      // DELANTE, mandan ellos (05-10-2026). El directorio local se rehace cada 20
      // min: justo después de borrar filas de la hoja, la fila N del directorio
      // todavía es la persona de antes, y la instantánea guardaría a otro — que
      // es precisamente el dato con el que luego se reencuentra el vínculo.
      phone: (body?.phone ?? "").trim() || (lead?.phone ?? "").trim() || null,
      name: (body?.name ?? "").trim() || (lead?.name ?? "").trim() || null,
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

  app.get("/link-leads/manuales", async () => {
    const r = reapuntarVinculosManuales(getDb(), leadsDeHoy(), { aplicar: false });
    return { ok: true, ...r };
  });

  app.post("/link-leads/manuales/reapuntar", async (req, reply) => {
    const body = (req.body ?? {}) as { aplicar?: unknown; mapa?: unknown; antesDe?: unknown };
    // El mapa «fila de antes → fila de hoy» solo sirve para los vínculos SIN
    // instantánea, y solo para los que no se han tocado desde `antesDe`.
    let mapa: Map<number, number> | undefined;
    if (body.mapa != null) {
      if (!Array.isArray(body.mapa)) return reply.status(400).send({ ok: false, error: "mapa debe ser una lista de { de, a }" });
      mapa = new Map();
      for (const p of body.mapa as { de?: unknown; a?: unknown }[]) {
        const de = Number(p?.de);
        const a = Number(p?.a);
        if (!Number.isInteger(de) || !Number.isInteger(a) || de < 1 || a < 1) {
          return reply.status(400).send({ ok: false, error: "mapa: cada elemento es { de, a } con números de fila" });
        }
        mapa.set(de, a);
      }
      if (!Number.isFinite(Number(body.antesDe))) {
        return reply.status(400).send({ ok: false, error: "con mapa hace falta antesDe (epoch en segundos de la primera tanda de borrado)" });
      }
    }
    const r = reapuntarVinculosManuales(getDb(), leadsDeHoy(), {
      aplicar: body.aplicar === true,
      mapa,
      antesDe: mapa ? Number(body.antesDe) : undefined,
    });
    // La copia en chat_intel de los que se han movido (la ficha lee de ahí).
    const copia = r.movedPairs.length > 0 ? await reapuntarEnIntel(r.movedPairs).catch(() => 0) : 0;
    return { ok: true, ...r, copiaEnIntel: copia };
  });
}
