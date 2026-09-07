/**
 * Avisa al dashboard de un mensaje que nos han ESCRITO y, si toca, manda la
 * respuesta del guion.
 *
 * El dashboard decide (allí están el almacén de campañas, la lista global de
 * bajas y el criterio de clasificación, probado en `scripts/test-conversacion.ts`);
 * aquí solo se ejecuta. Ningún texto se compone en este fichero.
 *
 * ⚠️ Solo se llama con tráfico EN VIVO (`messages.upsert` tipo "notify"). Con el
 * history-sync daríamos de baja a gente —y le contestaríamos— por algo que
 * escribió hace meses.
 */

import { config } from "../config";
import { sendText } from "../wa/send";
import { registrarAutomatico, registrarNota } from "./marcas";

interface EnvioConversacional {
  campanaId: string;
  campanaNombre: string;
  telefono: string;
  jid: string;
  texto: string;
  permitirChatNuevo?: boolean;
}

interface Respuesta {
  success?: boolean;
  accion?: string;
  campanas?: number;
  campanaId?: string;
  envio?: EnvioConversacional | null;
  notaInterna?: string | null;
}

function token(): string | null {
  return process.env.FRANSUA_INTERNAL_TOKEN ?? null;
}

export async function avisarEntrante(telefono: string, texto: string, jid: string): Promise<void> {
  const t = token();
  if (!t) return;
  let j: Respuesta | null = null;
  try {
    const res = await fetch(`${config.dashboardUrl}/api/campanas/worker/baja`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-fransua-token": t },
      body: JSON.stringify({ telefono, texto: texto.slice(0, 1000) }),
      signal: AbortSignal.timeout(12_000),
    });
    if (!res.ok) return;
    j = (await res.json()) as Respuesta;
  } catch {
    return; // best-effort: el mensaje ya está guardado y Fran lo verá igual
  }
  if (!j?.success) return;

  if (j.accion === "baja") {
    console.log(`[campanas] BAJA registrada: ${telefono} — no se le vuelve a escribir en ninguna campaña.`);
    return;
  }

  if (j.accion === "conversacion") {
    // La nota interna se deja SIEMPRE, incluso si no hay nada que mandar
    // (cierre a revisión o baja). No se envía al lead: es para Fran.
    if (j.notaInterna) registrarNota(jid, j.notaInterna, j.campanaId ?? null);

    if (j.envio?.texto) {
      const r = await sendText(j.envio.jid, j.envio.texto, `campaña:${j.envio.campanaNombre}`.slice(0, 120), {
        permitirChatNuevo: j.envio.permitirChatNuevo === true,
      });
      if (r.ok) {
        // Marca de agua: este mensaje lo escribió la automatización, no Fran.
        registrarAutomatico(j.envio.jid, r.message.id, j.envio.campanaNombre, j.envio.campanaId);
        console.log(`[campanas] guion avanzado con ${telefono} · ${j.envio.campanaNombre}`);
        await contarResultado(j.envio.campanaId, telefono, true);
      } else {
        console.warn(`[campanas] no se pudo responder a ${telefono} (${r.code}): ${r.error}`);
        // offline/rate NO se cuentan como fallo del destinatario.
        if (r.code !== "offline" && r.code !== "rate") {
          await contarResultado(j.envio.campanaId, telefono, false, r.error);
        }
      }
    }
    return;
  }

  if (j.accion === "respuesta") {
    console.log(`[campanas] respuesta de ${telefono} anotada en ${j.campanas ?? 0} campaña(s).`);
  }
}

async function contarResultado(campanaId: string, telefono: string, ok: boolean, error?: string): Promise<void> {
  const t = token();
  if (!t) return;
  try {
    await fetch(`${config.dashboardUrl}/api/campanas/worker/resultado`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-fransua-token": t },
      body: JSON.stringify({ campanaId, telefono, ok, error }),
      signal: AbortSignal.timeout(10_000),
    });
  } catch {
    /* best-effort */
  }
}
