/**
 * INSERT TOLERANTE a que la columna `phone` exista o no todavía.
 *
 * Contexto (auditoría 2026-07-28, eje 0.6): las tablas del cerebro
 * (`reminders`, `calendar_events`, `conversation_memory`, `fransua_log`)
 * vinculaban al lead solo por `source_row`, que es POSICIONAL y se corrompe al
 * mover filas del Sheet. La migración `supabase/003_phone_identity.sql` añade
 * la columna `phone` (identidad estable), pero el DDL lo ejecuta una persona en
 * el SQL Editor de Supabase — no el código.
 *
 * Para que el despliegue NO dependa de ese orden (y sobre todo para que un
 * sidecar nuevo contra una BD sin migrar no deje de crear recordatorios), cada
 * insert intenta incluir `phone` y, si Postgres responde que la columna no
 * existe, REINTENTA sin ella y lo recuerda para no volver a intentarlo.
 * En cuanto alguien ejecute el SQL, basta un reinicio (o el flag se resetea
 * solo al arrancar) para que empiece a guardarse.
 */
import type { SupabaseClient } from "@supabase/supabase-js";

/** Tablas donde ya sabemos que `phone` NO existe → no reintentarlo en cada insert. */
const sinPhone = new Set<string>();

/** ¿El error dice que la columna no existe? (PostgREST PGRST204 / Postgres 42703) */
function esColumnaInexistente(err: { code?: string; message?: string } | null): boolean {
  if (!err) return false;
  if (err.code === "PGRST204" || err.code === "42703") return true;
  return /column .*phone.* does not exist|could not find the 'phone' column/i.test(err.message ?? "");
}

function avisarUnaVez(table: string): void {
  sinPhone.add(table);
  console.warn(
    `[phone-column] '${table}' aún no tiene la columna phone — ejecuta ` +
      "whatsapp-service/supabase/003_phone_identity.sql en Supabase. Guardando sin identidad de momento."
  );
}

/**
 * Inserta `row` en `table` añadiendo `phone` si se conoce. Devuelve el error de
 * Supabase (o null si fue bien) para que el llamante decida qué hacer — igual
 * que un `.insert()` normal.
 */
export async function insertConPhone(
  sb: SupabaseClient,
  table: string,
  row: Record<string, unknown>,
  phone: string | null | undefined
): Promise<{ error: { message: string } | null }> {
  const tel = (phone ?? "").trim();
  const conPhone = !!tel && !sinPhone.has(table);

  const { error } = await sb.from(table).insert(conPhone ? { ...row, phone: tel } : row);
  if (!error || !conPhone || !esColumnaInexistente(error)) return { error };

  // La columna aún no existe: recuérdalo y reintenta sin ella (nunca se pierde
  // el dato principal por no poder guardar la identidad).
  avisarUnaVez(table);
  return await sb.from(table).insert(row);
}

/**
 * Igual que `insertConPhone` pero devolviendo la fila creada
 * (`.select(cols).single()`), que es lo que necesita la agenda para espejar el
 * evento a Google Calendar.
 */
export async function insertConPhoneSelect<T = Record<string, unknown>>(
  sb: SupabaseClient,
  table: string,
  row: Record<string, unknown>,
  phone: string | null | undefined,
  cols: string
): Promise<{ data: T | null; error: { message: string } | null }> {
  type R = { data: T | null; error: { message: string; code?: string } | null };
  const tel = (phone ?? "").trim();
  const conPhone = !!tel && !sinPhone.has(table);

  const first = (await sb.from(table).insert(conPhone ? { ...row, phone: tel } : row).select(cols).single()) as unknown as R;
  if (!first.error || !conPhone || !esColumnaInexistente(first.error)) return first;

  avisarUnaVez(table);
  return (await sb.from(table).insert(row).select(cols).single()) as unknown as R;
}
