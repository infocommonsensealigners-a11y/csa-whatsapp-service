/**
 * Rutas de AGENDA (calendar_events en Supabase). CRUD para la app de agenda del
 * dashboard. La sincronización con Google Calendar (google_event_id) se añadirá
 * encima; de momento el origen de verdad es Supabase.
 *
 *  - GET    /calendar/events?from=ISO&to=ISO   → eventos en rango
 *  - GET    /calendar/agenda                   → resumen para el widget (hoy + próximos)
 *  - POST   /calendar/events                   → crear
 *  - PATCH  /calendar/events/:id               → editar / mover / cambiar estado
 *  - DELETE /calendar/events/:id               → cancelar (status) o borrar (?hard=1)
 */
import type { FastifyInstance } from "fastify";
import { brainConfigured, getSupabase } from "../../brain/supabase";
import { getMeta } from "../../db/db";
import {
  googleConfigured,
  ensureFransuaCalendar,
  shareCalendarWith,
  pushEvent,
  deleteGoogleEvent,
  serviceAccountEmail,
  serviceAccountProject,
  calendarShareEmail,
} from "../../brain/googleCalendar";

/** Espeja un evento a Google (best-effort) y devuelve el google_event_id nuevo, o null. */
async function syncToGoogle(event: any): Promise<string | null> {
  if (!googleConfigured()) return null;
  try {
    const gid = await pushEvent(event);
    return gid ?? null;
  } catch (e) {
    console.warn("[gcal] no se pudo sincronizar el evento:", String((e as Error)?.message ?? e).slice(0, 120));
    return null;
  }
}

const COLS =
  "id,source_row,jid,titulo,descripcion,start_at,end_at,all_day,tipo,origen,color,google_event_id,status,created_at,updated_at";

/** Tipo de evento: string libre (la key del catálogo DINÁMICO del dashboard).
 *  Ya no hay lista cerrada — el usuario crea sus propios tipos. Se sanea a un
 *  string corto; si viene vacío, cae a "cita". */
function normTipo(v: unknown, fallback = "cita"): string {
  const s = typeof v === "string" ? v.trim().slice(0, 60) : "";
  return s || fallback;
}

function down(reply: any) {
  return reply.status(503).send({ ok: false, error: "brain-not-configured" });
}

export function registerCalendarRoutes(app: FastifyInstance): void {
  app.get("/calendar/events", async (req, reply) => {
    if (!brainConfigured()) return down(reply);
    const q = req.query as any;
    const sb = getSupabase();
    let query = sb.from("calendar_events").select(COLS).neq("status", "cancelled").order("start_at", { ascending: true });
    if (q?.from) query = query.gte("start_at", String(q.from));
    if (q?.to) query = query.lte("start_at", String(q.to));
    const { data, error } = await query.limit(1000);
    if (error) return reply.status(502).send({ ok: false, error: error.message });
    return { items: data ?? [] };
  });

  app.get("/calendar/agenda", async (_req, reply) => {
    if (!brainConfigured()) return down(reply);
    const sb = getSupabase();
    const now = new Date();
    const startToday = new Date(now.getFullYear(), now.getMonth(), now.getDate()).toISOString();
    const in7 = new Date(now.getTime() + 7 * 86400_000).toISOString();
    const endToday = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1).toISOString();

    const { data, error } = await sb
      .from("calendar_events")
      .select(COLS)
      .neq("status", "cancelled")
      .gte("start_at", startToday)
      .lte("start_at", in7)
      .order("start_at", { ascending: true })
      .limit(50);
    if (error) return reply.status(502).send({ ok: false, error: error.message });

    const all = data ?? [];
    const today = all.filter((e: any) => e.start_at < endToday);
    const upcoming = all.filter((e: any) => e.start_at >= endToday);
    return { generatedAt: now.toISOString(), today, upcoming, counts: { today: today.length, week: all.length } };
  });

  app.post("/calendar/events", async (req, reply) => {
    if (!brainConfigured()) return down(reply);
    const b = (req.body ?? {}) as any;
    if (!b.titulo || !b.start_at) {
      return reply.status(400).send({ ok: false, error: "titulo y start_at son obligatorios" });
    }
    const record = {
      titulo: String(b.titulo).slice(0, 300),
      descripcion: b.descripcion ? String(b.descripcion) : null,
      start_at: new Date(b.start_at).toISOString(),
      end_at: b.end_at ? new Date(b.end_at).toISOString() : null,
      all_day: !!b.all_day,
      tipo: normTipo(b.tipo),
      origen: b.origen === "fransua" ? "fransua" : "humano",
      source_row: Number.isFinite(Number(b.source_row)) ? Number(b.source_row) : null,
      jid: b.jid ? String(b.jid) : null,
      color: b.color ? String(b.color) : null,
      status: "active",
    };
    const sb = getSupabase();
    const { data, error } = await sb.from("calendar_events").insert(record).select(COLS).single();
    if (error) return reply.status(502).send({ ok: false, error: error.message });

    const gid = await syncToGoogle(data);
    if (gid && data) {
      await sb.from("calendar_events").update({ google_event_id: gid }).eq("id", data.id);
      (data as any).google_event_id = gid;
    }
    return { ok: true, event: data };
  });

  app.patch("/calendar/events/:id", async (req, reply) => {
    if (!brainConfigured()) return down(reply);
    const id = Number((req.params as any).id);
    if (!Number.isFinite(id)) return reply.status(400).send({ ok: false, error: "id inválido" });
    const b = (req.body ?? {}) as any;
    const patch: Record<string, unknown> = { updated_at: new Date().toISOString() };
    if (b.titulo != null) patch.titulo = String(b.titulo).slice(0, 300);
    if (b.descripcion !== undefined) patch.descripcion = b.descripcion ? String(b.descripcion) : null;
    if (b.start_at != null) patch.start_at = new Date(b.start_at).toISOString();
    if (b.end_at !== undefined) patch.end_at = b.end_at ? new Date(b.end_at).toISOString() : null;
    if (b.all_day != null) patch.all_day = !!b.all_day;
    if (b.tipo != null && String(b.tipo).trim()) patch.tipo = normTipo(b.tipo);
    if (b.source_row !== undefined) patch.source_row = Number.isFinite(Number(b.source_row)) ? Number(b.source_row) : null;
    if (b.jid !== undefined) patch.jid = b.jid ? String(b.jid) : null;
    if (b.color !== undefined) patch.color = b.color ? String(b.color) : null;
    if (b.status != null) patch.status = String(b.status);

    const sb = getSupabase();
    const { data, error } = await sb.from("calendar_events").update(patch).eq("id", id).select(COLS).single();
    if (error) return reply.status(502).send({ ok: false, error: error.message });

    const gid = await syncToGoogle(data);
    if (gid && data && gid !== (data as any).google_event_id) {
      await sb.from("calendar_events").update({ google_event_id: gid }).eq("id", id);
      (data as any).google_event_id = gid;
    }
    return { ok: true, event: data };
  });

  app.delete("/calendar/events/:id", async (req, reply) => {
    if (!brainConfigured()) return down(reply);
    const id = Number((req.params as any).id);
    if (!Number.isFinite(id)) return reply.status(400).send({ ok: false, error: "id inválido" });
    const hard = (req.query as any)?.hard === "1";
    const sb = getSupabase();
    const { data: row } = await sb.from("calendar_events").select("google_event_id").eq("id", id).maybeSingle();

    if (hard) {
      const { error } = await sb.from("calendar_events").delete().eq("id", id);
      if (error) return reply.status(502).send({ ok: false, error: error.message });
    } else {
      const { error } = await sb
        .from("calendar_events")
        .update({ status: "cancelled", updated_at: new Date().toISOString() })
        .eq("id", id);
      if (error) return reply.status(502).send({ ok: false, error: error.message });
    }

    if (googleConfigured() && (row as any)?.google_event_id) {
      try {
        await deleteGoogleEvent((row as any).google_event_id);
      } catch {
        /* best-effort */
      }
    }
    return { ok: true };
  });

  // ── Sincronización con Google Calendar ────────────────────────────────────
  app.get("/calendar/google/status", async () => {
    if (!googleConfigured()) return { configured: false };
    let serviceAccount: string | null = null;
    let project: string | null = null;
    try {
      serviceAccount = serviceAccountEmail();
      project = serviceAccountProject() ?? null;
    } catch {
      /* credencial ilegible */
    }
    return {
      configured: true,
      serviceAccount,
      project,
      shareEmail: calendarShareEmail,
      calendarId: getMeta("fransua_calendar_id"),
    };
  });

  app.post("/calendar/google/setup", async (_req, reply) => {
    if (!googleConfigured()) {
      return reply.status(400).send({ ok: false, error: "Google no configurado: falta la service-account en .env del sidecar." });
    }
    try {
      const calendarId = await ensureFransuaCalendar();
      await shareCalendarWith(calendarShareEmail);
      return { ok: true, calendarId, sharedWith: calendarShareEmail, serviceAccount: serviceAccountEmail() };
    } catch (e: any) {
      return reply.status(502).send({ ok: false, error: String(e?.message ?? e) });
    }
  });
}
