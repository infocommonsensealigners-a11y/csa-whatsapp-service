/**
 * Avisa al dashboard de un mensaje que nos han ESCRITO, para que decida si es
 * una petición de BAJA o la RESPUESTA a una campaña.
 *
 * La decisión se toma en el dashboard a propósito: allí están el almacén de
 * campañas y la lista global de bajas, y así el criterio de "esto suena a no me
 * escribáis" vive en un único sitio (probado en `scripts/test-campanas.ts`) en
 * vez de duplicado a los dos lados.
 *
 * Es best-effort y no bloquea el ingreso de mensajes: si el dashboard no
 * contesta, se pierde ese aviso concreto — el mensaje ya está guardado y Fran lo
 * va a ver igual en el teléfono flotante.
 *
 * ⚠️ Solo se llama con tráfico EN VIVO (`messages.upsert` tipo "notify"). Con el
 * history-sync daríamos de baja a gente por algo que escribió hace meses.
 */

import { config } from "../config";

export async function avisarEntrante(telefono: string, texto: string): Promise<void> {
  const token = process.env.FRANSUA_INTERNAL_TOKEN;
  if (!token) return;
  try {
    const res = await fetch(`${config.dashboardUrl}/api/campanas/worker/baja`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-fransua-token": token },
      body: JSON.stringify({ telefono, texto: texto.slice(0, 1000) }),
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) return;
    const j = (await res.json()) as { accion?: string; campanas?: number };
    if (j.accion === "baja") {
      console.log(`[campanas] BAJA registrada: ${telefono} — no se le vuelve a escribir en ninguna campaña.`);
    } else if (j.accion === "respuesta") {
      console.log(`[campanas] respuesta de ${telefono} anotada en ${j.campanas ?? 0} campaña(s).`);
    }
  } catch {
    /* best-effort */
  }
}
