/**
 * CONTEXTO-360 de un lead, pedido al dashboard (que es quien tiene el CRM /
 * facturación / EDICIONES). Server-to-server con token compartido
 * (FRANSUA_INTERNAL_TOKEN, validado en el proxy del dashboard). Cacheado en
 * memoria y DEGRADA a null ante cualquier fallo: si el dashboard no responde,
 * Fransua sigue funcionando (solo pierde este contexto extra).
 */
import { config } from "../config";

const TTL_MS = 3 * 60 * 1000;
const cache = new Map<string, { texto: string | null; at: number }>();

const canon = (s: string | null | undefined): string => String(s ?? "").replace(/\D/g, "").slice(-9);

export async function getLeadContext360(phone: string | null): Promise<string | null> {
  const tel = canon(phone);
  const token = process.env.FRANSUA_INTERNAL_TOKEN;
  if (tel.length < 9 || !token) return null;

  const hit = cache.get(tel);
  if (hit && Date.now() - hit.at < TTL_MS) return hit.texto;

  try {
    const res = await fetch(`${config.dashboardUrl}/api/fransua/lead-context?tel=${tel}`, {
      headers: { "x-fransua-token": token },
      signal: AbortSignal.timeout(4500),
    });
    let texto: string | null = null;
    if (res.ok) {
      const j = (await res.json()) as { found?: boolean; texto?: string };
      if (j?.found && typeof j.texto === "string" && j.texto.trim()) texto = j.texto;
    }
    cache.set(tel, { texto, at: Date.now() });
    return texto;
  } catch {
    cache.set(tel, { texto: null, at: Date.now() });
    return null;
  }
}
