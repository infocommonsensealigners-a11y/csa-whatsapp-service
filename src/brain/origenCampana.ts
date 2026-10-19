/**
 * ORIGEN DEL CRM → CAMPAÑA DE META — material para el chat de Fransua (19-10-2026).
 *
 * Mismo patrón que `objeciones.ts`: el dato vive en el dashboard (el funnel de
 * Marketing, que cruza Meta Ads con el CRM) y el sidecar lo pide con el token
 * interno. Aquí no se calcula nada: se sirve lo que ya enseña la ventana de
 * «Inversión en publicidad», para que Fransua diga lo mismo que ve Fran.
 */

import { config } from "../config";

const TTL_MS = 10 * 60_000;
const cache = new Map<string, { at: number; r: OrigenCampanaRespuesta }>();

export interface OrigenCampanaRespuesta {
  ok: boolean;
  error?: string;
  origen?: string;
  canal?: string;
  periodo?: { etiqueta?: string; desde?: string; hasta?: string };
  campanas?: Record<string, unknown>[];
  mapa?: Record<string, unknown>[];
  texto?: string;
}

/** `periodo`: 30d, 90d, mes, mesant, anio, 2025, 2024; con `mes` se puede pasar `m` = YYYY-MM. */
export async function getOrigenCampana(origen: string, periodo = "30d", m?: string): Promise<OrigenCampanaRespuesta | null> {
  const token = process.env.FRANSUA_INTERNAL_TOKEN;
  if (!token) return null;
  const key = origen.trim().toLowerCase() + "|" + periodo + "|" + (m || "");
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < TTL_MS) return hit.r;
  try {
    const qs = new URLSearchParams({ origen, p: periodo });
    if (m) qs.set("m", m);
    const url = `${config.dashboardUrl}/api/fransua/origen-campana?${qs.toString()}`;
    const res = await fetch(url, {
      headers: { "x-fransua-token": token },
      // El funnel va cacheado en el dashboard; en frío (varias llamadas a Meta) puede tardar.
      signal: AbortSignal.timeout(25_000),
    });
    const j = (await res.json()) as OrigenCampanaRespuesta;
    if (!j || typeof j.ok !== "boolean") return null;
    if (j.ok) cache.set(key, { at: Date.now(), r: j });
    return j;
  } catch {
    return null;
  }
}
