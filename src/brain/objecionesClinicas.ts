/**
 * OBJECIONES CLÍNICAS DE LOS DOCTORES — material para el chat de Fransua.
 *
 * Hermano de `objeciones.ts` (las comerciales), mismo patrón calcado: el dato
 * vive en el dashboard (que tiene el dataset destilado del histórico) y el
 * sidecar lo pide con el token interno. Aquí no se analiza nada.
 *
 * Van en un fichero y una tool APARTE de las comerciales a propósito: son dos
 * conversaciones distintas (precio/tiempo vs. técnica/indicación/capacidad
 * propia), y Fransua tiene que poder ofrecer la que toca sin mezclarlas.
 */

import { config } from "../config";

const TTL_MS = 10 * 60_000;
const cache = new Map<string, { at: number; texto: string | null }>();

export interface ObjecionesClinicasRespuesta {
  texto: string;
  informeUrl: string;
  generadoEl: string;
}

export async function getObjecionesClinicas(consulta: string): Promise<ObjecionesClinicasRespuesta | null> {
  const token = process.env.FRANSUA_INTERNAL_TOKEN;
  if (!token) return null;
  const key = consulta.trim().toLowerCase();
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < TTL_MS && hit.texto) {
    return { texto: hit.texto, informeUrl: "/api/informes/objeciones-clinicas", generadoEl: "" };
  }
  try {
    const url = `${config.dashboardUrl}/api/fransua/objeciones-clinicas?q=${encodeURIComponent(consulta)}`;
    const res = await fetch(url, {
      headers: { "x-fransua-token": token },
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) return null;
    const j = (await res.json()) as { ok?: boolean; texto?: string; informeUrl?: string; generadoEl?: string };
    if (!j?.ok || typeof j.texto !== "string" || !j.texto.trim()) return null;
    cache.set(key, { at: Date.now(), texto: j.texto });
    return {
      texto: j.texto,
      informeUrl: j.informeUrl ?? "/api/informes/objeciones-clinicas",
      generadoEl: j.generadoEl ?? "",
    };
  } catch {
    return null;
  }
}
