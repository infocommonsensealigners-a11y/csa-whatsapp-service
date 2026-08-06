/**
 * EL CEREBRO DE FRANSUA — índice de informes ya producidos, para el prompt.
 *
 * Calco de `lecciones.ts`: memoria persistente que se PRE-INYECTA en cada turno
 * del chat agéntico. Sin esto, Fransua solo se enteraba de que tiene un análisis
 * si la pregunta usaba las palabras que disparan su herramienta; con el índice
 * delante sabe qué producciones existen, qué contestan y qué NO cubren, así que
 * puede ofrecerlas él.
 *
 * Es solo el ÍNDICE (títulos, alcance, titulares, límites): son unas pocas
 * líneas. El detalle sigue viniendo de la herramienta, que se llama solo cuando
 * hace falta.
 */

import { config } from "../config";

const TTL_MS = 10 * 60_000;
let cache: { texto: string; at: number } | null = null;

export async function getInformesTexto(): Promise<string> {
  const token = process.env.FRANSUA_INTERNAL_TOKEN;
  if (!token) return "";
  if (cache && Date.now() - cache.at < TTL_MS) return cache.texto;
  try {
    const res = await fetch(`${config.dashboardUrl}/api/fransua/objeciones?catalogo=1`, {
      headers: { "x-fransua-token": token },
      signal: AbortSignal.timeout(6000),
    });
    let texto = "";
    if (res.ok) {
      const j = (await res.json()) as { ok?: boolean; texto?: string };
      if (j?.ok && typeof j.texto === "string") texto = j.texto;
    }
    cache = { texto, at: Date.now() };
    return texto;
  } catch {
    // Sin catálogo el prompt sigue funcionando: la herramienta continúa ahí.
    cache = { texto: "", at: Date.now() };
    return "";
  }
}
