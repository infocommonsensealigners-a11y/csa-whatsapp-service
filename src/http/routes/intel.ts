/**
 * Rutas de INTELIGENCIA (cerebro de Fransua). Leen chat_intel de Supabase —
 * la salida del worker de asimilación — y la sirven al dashboard vía el proxy.
 *
 *  - GET /intel/summary?since=YYYY-MM-DD  → digest "Fransua sugiere hoy"
 *  - GET /intel/list?temp=&since=&limit=  → lista filtrable
 *  - GET /intel/by-lead/:sourceRow        → inteligencia de un lead del CRM
 *  - GET /intel/:jid                      → inteligencia de un chat concreto
 *
 * Ventanas (criterio del usuario): APRENDIZAJE desde 2024 (ya asimilado);
 * ESTRATEGIA/acciones desde abril 2025 (inicio de Fran) → default de `since`.
 */
import type { FastifyInstance } from "fastify";
import { brainConfigured, getSupabase } from "../../brain/supabase";

const STRATEGY_SINCE = "2025-04-01";
const COLS =
  "jid,phone,display_name,source_row,producto,first_ts,last_ts,msg_count,from_me_count,temperatura,temperatura_motivo,resumen,intereses,intervalos,etiquetas,model,updated_at";

function sinceToTs(since?: string): number {
  const d = since && /^\d{4}-\d{2}-\d{2}$/.test(since) ? since : STRATEGY_SINCE;
  return Math.floor(new Date(d + "T00:00:00Z").getTime() / 1000);
}
const daysSince = (ts: number | null) => (ts ? Math.floor(Date.now() / 1000 - ts) / 86400 : Infinity);

type IntelRow = {
  jid: string; phone: string | null; display_name: string | null; source_row: number | null;
  producto: string | null; first_ts: number | null; last_ts: number | null; msg_count: number;
  from_me_count: number; temperatura: string | null; temperatura_motivo: string | null;
  resumen: string | null; intereses: unknown; intervalos: any; etiquetas: unknown; updated_at: string;
};

/** Añade campos derivados en vivo (silencio real desde last_ts, pendiente de respuesta). */
function enrich(r: IntelRow) {
  const silencioDias = Math.round(daysSince(r.last_ts));
  const ultimoEmisor = r.intervalos?.ultimo_emisor ?? null;
  return { ...r, silencio_dias: silencioDias, ultimo_emisor: ultimoEmisor, esperando_respuesta: ultimoEmisor === "lead" };
}

export function registerIntelRoutes(app: FastifyInstance): void {
  app.get("/intel/summary", async (req, reply) => {
    if (!brainConfigured()) return reply.status(503).send({ ok: false, error: "brain-not-configured" });
    const since = (req.query as any)?.since as string | undefined;
    const sinceTs = sinceToTs(since);
    const sb = getSupabase();

    const { data, error } = await sb
      .from("chat_intel")
      .select(COLS)
      .gte("last_ts", sinceTs)
      .order("last_ts", { ascending: false })
      .limit(2000);
    if (error) return reply.status(502).send({ ok: false, error: error.message });

    const rows = (data as IntelRow[]).map(enrich);
    const byTemp = { caliente: 0, templado: 0, frio: 0, sin_dato: 0 };
    for (const r of rows) {
      if (r.temperatura === "caliente") byTemp.caliente++;
      else if (r.temperatura === "templado") byTemp.templado++;
      else if (r.temperatura === "frio") byTemp.frio++;
      else byTemp.sin_dato++;
    }

    // Acciones priorizadas para HOY:
    // 1) leads que escribieron ellos y siguen sin respuesta (esperando a Fran).
    const esperando = rows
      .filter((r) => r.esperando_respuesta && r.silencio_dias >= 0)
      .sort((a, b) => tempRank(b.temperatura) - tempRank(a.temperatura) || a.silencio_dias - b.silencio_dias)
      .slice(0, 25);
    // 2) calientes que se están enfriando (sin actividad ≥ 2 días).
    const calientesEnfriando = rows
      .filter((r) => r.temperatura === "caliente" && r.silencio_dias >= 2)
      .sort((a, b) => a.silencio_dias - b.silencio_dias)
      .slice(0, 25);
    // 3) templados a reactivar (7–45 días de silencio).
    const templadosReactivar = rows
      .filter((r) => r.temperatura === "templado" && r.silencio_dias >= 7 && r.silencio_dias <= 45)
      .sort((a, b) => a.silencio_dias - b.silencio_dias)
      .slice(0, 25);

    return {
      generatedAt: new Date().toISOString(),
      since: since ?? STRATEGY_SINCE,
      total: rows.length,
      byTemp,
      esperandoRespuesta: esperando,
      calientesEnfriando,
      templadosReactivar,
    };
  });

  app.get("/intel/list", async (req, reply) => {
    if (!brainConfigured()) return reply.status(503).send({ ok: false, error: "brain-not-configured" });
    const q = req.query as any;
    const sinceTs = sinceToTs(q?.since);
    const limit = Math.min(Number(q?.limit) || 200, 2000);
    const sb = getSupabase();
    let query = sb.from("chat_intel").select(COLS).gte("last_ts", sinceTs).order("last_ts", { ascending: false }).limit(limit);
    if (q?.temp) query = query.eq("temperatura", String(q.temp));
    const { data, error } = await query;
    if (error) return reply.status(502).send({ ok: false, error: error.message });
    return { items: (data as IntelRow[]).map(enrich) };
  });

  app.get("/intel/by-lead/:sourceRow", async (req, reply) => {
    if (!brainConfigured()) return reply.status(503).send({ ok: false, error: "brain-not-configured" });
    const sourceRow = Number((req.params as any).sourceRow);
    if (!Number.isFinite(sourceRow)) return reply.status(400).send({ ok: false, error: "sourceRow inválido" });
    const sb = getSupabase();
    const { data, error } = await sb.from("chat_intel").select(COLS).eq("source_row", sourceRow).order("last_ts", { ascending: false });
    if (error) return reply.status(502).send({ ok: false, error: error.message });
    const items = (data as IntelRow[]).map(enrich);
    return { sourceRow, found: items.length > 0, items };
  });

  // Resolución ESTABLE por teléfono. El source_row es la fila del Google Sheet y
  // se desplaza cuando se editan filas; el teléfono canónico (9 díg) NO. La ficha
  // y el panel deben resolver por aquí para no mostrar el lead equivocado.
  app.get("/intel/by-phone/:phone", async (req, reply) => {
    if (!brainConfigured()) return reply.status(503).send({ ok: false, error: "brain-not-configured" });
    const phone = String((req.params as any).phone).replace(/\D/g, "").slice(-9);
    if (phone.length < 9) return reply.status(400).send({ ok: false, error: "phone inválido" });
    const sb = getSupabase();
    const { data, error } = await sb.from("chat_intel").select(COLS).eq("phone", phone).order("last_ts", { ascending: false });
    if (error) return reply.status(502).send({ ok: false, error: error.message });
    const items = (data as IntelRow[]).map(enrich);
    return { phone, found: items.length > 0, items };
  });

  // El Playbook: síntesis IA de argumentos/objeciones/método (la genera
  // scripts/playbook-insights.ts y se guarda en fransua_log).
  app.get("/intel/playbook-insights", async (_req, reply) => {
    if (!brainConfigured()) return reply.status(503).send({ ok: false, error: "brain-not-configured" });
    const sb = getSupabase();
    const { data, error } = await sb
      .from("fransua_log")
      .select("payload,created_at")
      .eq("kind", "playbook_insights")
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    if (error) return reply.status(502).send({ ok: false, error: error.message });
    if (!data) return { found: false };
    return { found: true, storedAt: data.created_at, ...(data.payload as Record<string, unknown>) };
  });

  app.get("/intel/:jid", async (req, reply) => {
    if (!brainConfigured()) return reply.status(503).send({ ok: false, error: "brain-not-configured" });
    const jid = decodeURIComponent((req.params as any).jid);
    const sb = getSupabase();
    const { data, error } = await sb.from("chat_intel").select(COLS).eq("jid", jid).maybeSingle();
    if (error) return reply.status(502).send({ ok: false, error: error.message });
    if (!data) return reply.status(404).send({ ok: false, error: "sin inteligencia para este chat" });
    return enrich(data as IntelRow);
  });
}

function tempRank(t: string | null): number {
  return t === "caliente" ? 3 : t === "templado" ? 2 : t === "frio" ? 1 : 0;
}
