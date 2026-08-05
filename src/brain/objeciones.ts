/**
 * OBJECIONES DE LOS DOCTORES — material para el chat de Fransua.
 *
 * Calco del patrón de `businessSnapshot.ts`: el dato vive en el dashboard (que
 * es quien tiene el dataset destilado del histórico) y el sidecar lo pide con el
 * token interno. Aquí no se analiza nada: el análisis del histórico completo se
 * hizo fuera (no cabe en el turno de un chat) y esto solo lo sirve.
 */

import { config } from "../config";

const TTL_MS = 10 * 60_000;
const cache = new Map<string, { at: number; texto: string | null }>();

export interface ObjecionesRespuesta {
  texto: string;
  informeUrl: string;
  generadoEl: string;
}

export async function getObjeciones(consulta: string): Promise<ObjecionesRespuesta | null> {
  const token = process.env.FRANSUA_INTERNAL_TOKEN;
  if (!token) return null;
  const key = consulta.trim().toLowerCase();
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < TTL_MS && hit.texto) {
    return { texto: hit.texto, informeUrl: "/api/informes/objeciones", generadoEl: "" };
  }
  try {
    const url = `${config.dashboardUrl}/api/fransua/objeciones?q=${encodeURIComponent(consulta)}`;
    const res = await fetch(url, {
      headers: { "x-fransua-token": token },
      // Más holgado que el snapshot (6s): son 14 fichas de texto, no un cálculo.
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) return null;
    const j = (await res.json()) as { ok?: boolean; texto?: string; informeUrl?: string; generadoEl?: string };
    if (!j?.ok || typeof j.texto !== "string" || !j.texto.trim()) return null;
    cache.set(key, { at: Date.now(), texto: j.texto });
    return {
      texto: j.texto,
      informeUrl: j.informeUrl ?? "/api/informes/objeciones",
      generadoEl: j.generadoEl ?? "",
    };
  } catch {
    return null;
  }
}
