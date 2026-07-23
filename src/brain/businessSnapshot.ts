/**
 * RETRATO DEL NEGOCIO (idea 3): foto compacta de todo el estado comercial que el
 * dashboard arma (/api/fransua/business-snapshot) y Fransua inyecta en /intel/ask
 * para razonar el briefing con la película completa. Server-to-server con token
 * compartido; cache 2 min; DEGRADA a null si el dashboard no responde.
 */
import { config } from "../config";

const TTL_MS = 2 * 60 * 1000;
let cache: { texto: string | null; at: number } | null = null;

export async function getBusinessSnapshot(): Promise<string | null> {
  const token = process.env.FRANSUA_INTERNAL_TOKEN;
  if (!token) return null;
  if (cache && Date.now() - cache.at < TTL_MS) return cache.texto;
  try {
    const res = await fetch(`${config.dashboardUrl}/api/fransua/business-snapshot`, {
      headers: { "x-fransua-token": token },
      signal: AbortSignal.timeout(6000),
    });
    let texto: string | null = null;
    if (res.ok) {
      const j = (await res.json()) as { ok?: boolean; texto?: string };
      if (j?.ok && typeof j.texto === "string" && j.texto.trim()) texto = j.texto;
    }
    cache = { texto, at: Date.now() };
    return texto;
  } catch {
    cache = { texto: null, at: Date.now() };
    return null;
  }
}
