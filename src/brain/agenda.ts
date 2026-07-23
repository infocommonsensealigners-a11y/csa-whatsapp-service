/**
 * Alta de eventos de agenda (calendar_events) desde el CEREBRO — reutilizable por
 * las herramientas del agente (Fransua ejecutor). Hace lo mismo que el CRUD
 * `POST /calendar/events` (routes/calendar.ts): inserta en Supabase (origen de
 * verdad) y ESPEJA a Google Calendar (calendario "CSA · Fransua" compartido con
 * Fran → le llega la notificación al iPhone). Best-effort con Google: si falla,
 * el evento queda igualmente en la agenda del dashboard.
 *
 * Se factoriza aquí (en vez de exportar desde routes/calendar.ts) para no tocar
 * un fichero compartido por otras sesiones y mantener esta capacidad autónoma.
 */
import { getSupabase } from "./supabase";
import { googleConfigured, pushEvent } from "./googleCalendar";

const COLS =
  "id,source_row,jid,titulo,descripcion,start_at,end_at,all_day,tipo,origen,color,google_event_id,status,created_at,updated_at";
const TIPOS = new Set(["cita", "formacion", "llamada", "seguimiento", "otro"]);

export interface AgendaInput {
  titulo: string;
  start_at: string; // ISO 8601
  end_at?: string | null;
  all_day?: boolean;
  tipo?: string;
  descripcion?: string | null;
  source_row?: number | null;
  jid?: string | null;
  /** 'fransua' por defecto (lo crea el cerebro). */
  origen?: "fransua" | "humano";
}

export type AgendaResult =
  | { ok: true; event: any; syncedToGoogle: boolean }
  | { ok: false; error: string };

/** Crea un evento en la agenda y lo espeja a Google. Valida título y fecha. */
export async function createAgendaEvent(input: AgendaInput): Promise<AgendaResult> {
  const titulo = String(input.titulo ?? "").trim();
  if (!titulo) return { ok: false, error: "falta el título del evento" };

  const start = new Date(input.start_at);
  if (Number.isNaN(start.getTime())) return { ok: false, error: "fecha/hora de inicio inválida" };

  const record = {
    titulo: titulo.slice(0, 300),
    descripcion: input.descripcion ? String(input.descripcion) : null,
    start_at: start.toISOString(),
    end_at: input.end_at ? new Date(input.end_at).toISOString() : null,
    all_day: !!input.all_day,
    tipo: TIPOS.has(String(input.tipo)) ? String(input.tipo) : "cita",
    origen: input.origen === "humano" ? "humano" : "fransua",
    source_row: Number.isFinite(Number(input.source_row)) ? Number(input.source_row) : null,
    jid: input.jid ? String(input.jid) : null,
    status: "active",
  };

  const sb = getSupabase();
  const { data, error } = await sb.from("calendar_events").insert(record).select(COLS).single();
  if (error) return { ok: false, error: error.message };

  // Espejo a Google (best-effort) — no bloquea si falla.
  let syncedToGoogle = false;
  if (googleConfigured() && data) {
    try {
      const gid = await pushEvent(data);
      if (gid) {
        await sb.from("calendar_events").update({ google_event_id: gid }).eq("id", (data as any).id);
        (data as any).google_event_id = gid;
        syncedToGoogle = true;
      }
    } catch (e) {
      console.warn("[agenda] no se pudo espejar a Google:", String((e as Error)?.message ?? e).slice(0, 120));
    }
  }

  return { ok: true, event: data, syncedToGoogle };
}
