/**
 * AUDITORÍA DE ACCIONES (idea 4). Cada acción que Fransua ejecuta CON la
 * aprobación de Fran (agendar, cambiar estado, nota…) deja un rastro en
 * `fransua_log` kind='action_audit' — quién, qué, sobre quién, cuándo, con qué
 * resultado. Reutiliza la tabla existente (el comentario del esquema ya preveía
 * kind='action'); NO requiere migración. Fire-and-forget: si el log falla, la
 * acción NO se rompe (solo se pierde el rastro, se avisa por consola).
 *
 * El "actor" es la persona real (email de sesión reenviado como x-csa-user por
 * el dashboard) — con fallback a "Fran" si no llega.
 */
import { getSupabase } from "./supabase";

export interface ActionAuditEntry {
  actor: string;
  action_type: string; // "agendar" | "cambiar_estado" | "nota" | ...
  params?: Record<string, unknown>;
  result?: string; // "ok" | "dry-run" | "error: ..."
  sourceRow?: number | null;
  jid?: string | null;
  phone?: string | null;
  name?: string | null;
}

export async function logActionAudit(entry: ActionAuditEntry): Promise<void> {
  try {
    const sb = getSupabase();
    await sb.from("fransua_log").insert({
      kind: "action_audit",
      source_row: entry.sourceRow ?? null,
      payload: { at: new Date().toISOString(), ...entry },
    });
  } catch (e) {
    console.warn("[audit] no se pudo registrar la acción:", (e as Error)?.message ?? e);
  }
}
