/**
 * DIRECCIONES POSTALES recogidas en un periodo — material para Fransua.
 *
 * El dato vive en el dashboard (las campañas de WhatsApp apuntan ahí la
 * dirección que da el doctor, y ahí está también la que se escribe a mano en la
 * ficha), así que el sidecar lo pide con el token interno. Mismo patrón que
 * `objeciones.ts`. Sin caché: «desde ayer» tiene que incluir la que entró hace
 * un minuto.
 */

import { config } from "../config";

export async function getDireccionesRecogidas(
  desde: Date,
  hasta: Date,
): Promise<{ texto: string; n: number; telefonos: string[] } | null> {
  const token = process.env.FRANSUA_INTERNAL_TOKEN;
  if (!token) return null;
  try {
    const url =
      `${config.dashboardUrl}/api/fransua/direcciones` +
      `?desde=${encodeURIComponent(desde.toISOString())}&hasta=${encodeURIComponent(hasta.toISOString())}`;
    const res = await fetch(url, { headers: { "x-fransua-token": token }, signal: AbortSignal.timeout(10_000) });
    if (!res.ok) return null;
    const j = (await res.json()) as { ok?: boolean; texto?: string; items?: { telefono?: unknown }[] };
    if (!j?.ok || typeof j.texto !== "string") return null;
    const items = Array.isArray(j.items) ? j.items : [];
    // Los teléfonos registrados, para no repetirlos en lo que se encuentra en los chats.
    const telefonos = items.map((i) => String(i?.telefono ?? "")).filter(Boolean);
    return { texto: j.texto, n: items.length, telefonos };
  } catch {
    return null;
  }
}
