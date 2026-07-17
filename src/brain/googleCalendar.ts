/**
 * Sincronización con Google Calendar (agenda "CSA · Fransua"). Reutiliza la
 * MISMA service-account que el dashboard usa para Sheets (csa-seguimiento),
 * pero con scope de Calendar. Crea un calendario dedicado, lo comparte con la
 * cuenta de CSA y espeja ahí los calendar_events. El iPhone de Fran ve ese
 * calendario al añadir la cuenta de Google.
 *
 * La sincronización es BEST-EFFORT: si Google falla o la Calendar API no está
 * habilitada, la agenda local (Supabase) sigue funcionando igual.
 */
import { google } from "googleapis";
import { readFileSync } from "node:fs";
import path from "node:path";
import { config } from "../config";
import { getMeta, setMeta } from "../db/db";

type Key = { client_email: string; private_key: string; project_id?: string };

function parseKey(raw: string): Key {
  const k = JSON.parse(raw) as Key;
  if (typeof k.private_key === "string") k.private_key = k.private_key.replace(/\\n/g, "\n");
  if (!k.client_email || !k.private_key) throw new Error("La credencial de Google no tiene client_email/private_key.");
  return k;
}

/** Resuelve la credencial igual que el dashboard: B64 → JSON → PATH. */
function loadKey(): Key {
  const b64 = process.env.GOOGLE_SERVICE_ACCOUNT_KEY_B64?.trim();
  if (b64) return parseKey(Buffer.from(b64, "base64").toString("utf-8"));
  const json = process.env.GOOGLE_SERVICE_ACCOUNT_KEY_JSON?.trim();
  if (json) return parseKey(json);
  const p = process.env.GOOGLE_SERVICE_ACCOUNT_KEY_PATH;
  if (!p) throw new Error("Sin credencial de Google: define GOOGLE_SERVICE_ACCOUNT_KEY_PATH (o _B64/_JSON).");
  return parseKey(readFileSync(path.resolve(process.cwd(), p), "utf-8"));
}

export function googleConfigured(): boolean {
  return !!(
    process.env.GOOGLE_SERVICE_ACCOUNT_KEY_PATH ||
    process.env.GOOGLE_SERVICE_ACCOUNT_KEY_B64 ||
    process.env.GOOGLE_SERVICE_ACCOUNT_KEY_JSON
  );
}

const SCOPES = ["https://www.googleapis.com/auth/calendar"];
const CAL_SUMMARY = "CSA · Fransua";
const TZ = "Europe/Madrid";

let cal: ReturnType<typeof google.calendar> | null = null;
function client() {
  if (cal) return cal;
  const key = loadKey();
  const auth = new google.auth.GoogleAuth({
    credentials: { client_email: key.client_email, private_key: key.private_key },
    scopes: SCOPES,
  });
  cal = google.calendar({ version: "v3", auth });
  return cal;
}

export function serviceAccountEmail(): string {
  return loadKey().client_email;
}
export function serviceAccountProject(): string | undefined {
  return loadKey().project_id;
}

/** Devuelve el id del calendario "CSA · Fransua", creándolo la primera vez. */
export async function ensureFransuaCalendar(): Promise<string> {
  const cached = getMeta("fransua_calendar_id");
  if (cached) return cached;
  const c = client();
  const list = await c.calendarList.list({ maxResults: 250 });
  const existing = list.data.items?.find((x) => x.summary === CAL_SUMMARY);
  let id = existing?.id ?? undefined;
  if (!id) {
    const created = await c.calendars.insert({
      requestBody: { summary: CAL_SUMMARY, description: "Agenda de Fransua (CSA): citas, formaciones, llamadas y seguimientos.", timeZone: TZ },
    });
    id = created.data.id ?? undefined;
  }
  if (!id) throw new Error("No se pudo obtener/crear el calendario CSA · Fransua.");
  setMeta("fransua_calendar_id", id);
  return id;
}

/** Comparte el calendario con una cuenta (permiso de edición). Idempotente. */
export async function shareCalendarWith(email: string): Promise<void> {
  const c = client();
  const calendarId = await ensureFransuaCalendar();
  try {
    await c.acl.insert({ calendarId, requestBody: { role: "writer", scope: { type: "user", value: email } } });
  } catch (e: any) {
    // 409/duplicate = ya compartido → ok.
    if (!/already|duplicate|409/i.test(String(e?.message ?? e))) throw e;
  }
}

type EventRow = {
  id?: number;
  titulo: string;
  descripcion?: string | null;
  start_at: string;
  end_at?: string | null;
  all_day?: boolean;
  google_event_id?: string | null;
};

function toGoogleEvent(e: EventRow): any {
  const body: any = { summary: e.titulo, description: e.descripcion ?? undefined };
  if (e.all_day) {
    const d = new Date(e.start_at);
    const day = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
    const next = new Date(d.getTime() + 86400_000);
    const nextDay = `${next.getFullYear()}-${String(next.getMonth() + 1).padStart(2, "0")}-${String(next.getDate()).padStart(2, "0")}`;
    body.start = { date: day };
    body.end = { date: nextDay };
  } else {
    const end = e.end_at ?? new Date(new Date(e.start_at).getTime() + 3600_000).toISOString();
    body.start = { dateTime: new Date(e.start_at).toISOString(), timeZone: TZ };
    body.end = { dateTime: new Date(end).toISOString(), timeZone: TZ };
  }
  return body;
}

/** Crea o actualiza el evento en Google; devuelve el google_event_id. */
export async function pushEvent(e: EventRow): Promise<string> {
  const c = client();
  const calendarId = await ensureFransuaCalendar();
  if (e.google_event_id) {
    const upd = await c.events.update({ calendarId, eventId: e.google_event_id, requestBody: toGoogleEvent(e) });
    return upd.data.id ?? e.google_event_id;
  }
  const created = await c.events.insert({ calendarId, requestBody: toGoogleEvent(e) });
  if (!created.data.id) throw new Error("Google no devolvió id de evento.");
  return created.data.id;
}

export async function deleteGoogleEvent(googleEventId: string): Promise<void> {
  const c = client();
  const calendarId = await ensureFransuaCalendar();
  try {
    await c.events.delete({ calendarId, eventId: googleEventId });
  } catch {
    /* ya borrado / inexistente → ignorar */
  }
}

export const calendarShareEmail = config.calendarShareEmail;
