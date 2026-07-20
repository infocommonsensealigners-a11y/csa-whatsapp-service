/**
 * Secretos de configuración de Fransua guardados en Supabase (tabla existente
 * `fransua_log`, kind='config', payload={key,value}). RLS activo → solo la
 * secret key del backend accede. Se usa para el token de suscripción de Claude
 * (`CLAUDE_CODE_OAUTH_TOKEN`) de modo que el sidecar de Railway pueda usar la
 * SUSCRIPCIÓN (gratis) sin tener que tocar las variables de Railway a mano.
 *
 * NOTA: no requiere migración de esquema (reutiliza fransua_log). El token vive
 * protegido por RLS igual que cualquier otro dato del cerebro.
 */
import { brainConfigured, getSupabase } from "./supabase";

/** Devuelve el valor más reciente de un secreto de config, o null. */
export async function loadSecret(key: string): Promise<string | null> {
  if (!brainConfigured()) return null;
  try {
    const sb = getSupabase();
    const { data, error } = await sb
      .from("fransua_log")
      .select("payload")
      .eq("kind", "config")
      .order("created_at", { ascending: false })
      .limit(30);
    if (error || !data) return null;
    for (const row of data as Array<{ payload: any }>) {
      const p = row.payload;
      if (p && p.key === key && typeof p.value === "string" && p.value) return p.value;
    }
    return null;
  } catch {
    return null;
  }
}

/** Guarda (append) un secreto de config. El más reciente gana en loadSecret. */
export async function storeSecret(key: string, value: string): Promise<void> {
  const sb = getSupabase();
  const { error } = await sb.from("fransua_log").insert({
    kind: "config",
    payload: { key, value, at: new Date().toISOString() },
  });
  if (error) throw new Error(error.message);
}

/** Borra todos los secretos de una clave (para rotar/invalidar). */
export async function deleteSecret(key: string): Promise<number> {
  const sb = getSupabase();
  const { data, error } = await sb
    .from("fransua_log")
    .select("id,payload")
    .eq("kind", "config")
    .limit(200);
  if (error || !data) return 0;
  const ids = (data as Array<{ id: number; payload: any }>).filter((r) => r.payload?.key === key).map((r) => r.id);
  if (!ids.length) return 0;
  await sb.from("fransua_log").delete().in("id", ids);
  return ids.length;
}

/**
 * Asegura que el token de suscripción de Claude esté en el entorno para que el
 * Agent SDK lo use (sin ANTHROPIC_API_KEY = sin coste de API). Perezoso e
 * idempotente. Si ya hay una API key, NO hace nada (la API key tiene prioridad).
 */
let ensurePromise: Promise<boolean> | null = null;
export function ensureClaudeAuth(): Promise<boolean> {
  // Credencial ya en el entorno → listo (la API key, si existe, tiene prioridad).
  if (process.env.CLAUDE_CODE_OAUTH_TOKEN || process.env.ANTHROPIC_API_KEY) return Promise.resolve(true);
  if (!ensurePromise) {
    ensurePromise = (async () => {
      const tok = await loadSecret("CLAUDE_CODE_OAUTH_TOKEN");
      if (tok) {
        process.env.CLAUDE_CODE_OAUTH_TOKEN = tok;
        return true;
      }
      // NO cachear el fallo: si el token se guarda más tarde en Supabase, la
      // próxima nota debe reintentar y encontrarlo (sin reiniciar el sidecar).
      ensurePromise = null;
      return false;
    })();
  }
  return ensurePromise;
}
