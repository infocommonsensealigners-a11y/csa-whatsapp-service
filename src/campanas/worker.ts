/**
 * WORKER de campañas comerciales.
 *
 * Reparto de papeles: el CEREBRO está en el dashboard (allí viven el almacén de
 * campañas y el dataset del Sheet con el que se resuelve la audiencia); el BRAZO
 * es este servicio, que es quien tiene el socket de WhatsApp. El worker pregunta
 * "¿qué envío?", envía, y contesta "esto pasó". Ningún servicio necesita el
 * volumen del otro.
 *
 * ⚠️ Por qué existe: el usuario pidió (2026-09-07) envío AUTOMÁTICO por Baileys,
 * avisado del riesgo de cierre de cuenta. Vive aquí y no en el navegador para que
 * una campaña avance aunque nadie tenga el dashboard abierto.
 *
 * NO habla con Baileys: llama a `sendText()` de `../wa/send`, el ÚNICO módulo con
 * permiso de publicación según `check:nosend`. Así se heredan solas sus
 * salvaguardas — solo chats 1-a-1, verificación del número antes de estrenar uno
 * en frío, tope de ritmo y auditoría en `wa_send_audit` — y el guardián no se
 * amplía ni un milímetro.
 *
 * Apagado por defecto: hace falta `CAMPANAS_WORKER=on`. Desplegar esto NO empieza
 * a enviar nada.
 */

import { config } from "../config";
import { sendText } from "../wa/send";
import { registrarAutomatico, registrarNota } from "./marcas";

const POLL_MIN_MS = 5_000;
const POLL_MAX_MS = 15 * 60_000;
/** Espera cuando WhatsApp está caído: no es culpa de ningún destinatario. */
const ESPERA_OFFLINE_MS = 60_000;

interface EnvioPendiente {
  campanaId: string;
  campanaNombre: string;
  telefono: string;
  jid: string;
  texto: string;
  /** ⚠️ Permite estrenar conversación en frío (lo decide la campaña). */
  permitirChatNuevo?: boolean;
  /** Nota interna a dejar tras enviar (no se envía al lead). */
  notaInterna?: string | null;
}

interface RespuestaSiguiente {
  success: boolean;
  nada?: boolean;
  motivo?: string;
  reintentarEnSec?: number;
  envio?: EnvioPendiente;
}

let corriendo = false;
let paradoPor: string | null = null;

function habilitado(): boolean {
  return String(process.env.CAMPANAS_WORKER ?? "").toLowerCase() === "on";
}

function token(): string | null {
  return process.env.FRANSUA_INTERNAL_TOKEN ?? null;
}

async function pedirSiguiente(): Promise<RespuestaSiguiente | null> {
  const t = token();
  if (!t) return null;
  try {
    const res = await fetch(`${config.dashboardUrl}/api/campanas/worker/siguiente`, {
      headers: { "x-fransua-token": t },
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) return null;
    return (await res.json()) as RespuestaSiguiente;
  } catch {
    return null;
  }
}

async function contarResultado(e: EnvioPendiente, ok: boolean, error?: string, codigo?: string): Promise<void> {
  const t = token();
  if (!t) return;
  try {
    await fetch(`${config.dashboardUrl}/api/campanas/worker/resultado`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-fransua-token": t },
      /**
       * `codigo` viaja para que el dashboard pueda decidir QUE cuenta para la
       * autopausa. "unknown-chat" (ese numero no esta en WhatsApp) es un
       * problema del dato de ese lead, no una senal de que la cuenta este en
       * apuros: tres numeros malos seguidos no deben parar la campana.
       */
      body: JSON.stringify({ campanaId: e.campanaId, telefono: e.telefono, ok, error, codigo }),
      signal: AbortSignal.timeout(10_000),
    });
  } catch {
    // Si no se puede contar, el destinatario sigue "pendiente" en el dashboard y
    // se reintentará. Peor sería marcarlo enviado sin estarlo.
  }
}

const dormir = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** Un ciclo: pregunta, envía si toca, cuenta. Devuelve cuánto esperar. */
async function ciclo(): Promise<number> {
  const r = await pedirSiguiente();
  if (!r || !r.success) return 60_000; // dashboard caído o token mal: se reintenta suave

  if (r.nada || !r.envio) {
    const sec = Math.max(5, Math.min(900, r.reintentarEnSec ?? 120));
    return sec * 1000;
  }

  const e = r.envio;
  const actor = `campaña:${e.campanaNombre}`.slice(0, 120);
  const res = await sendText(e.jid, e.texto, actor, {
    permitirChatNuevo: e.permitirChatNuevo === true,
  });

  if (res.ok) {
    // Marca de agua: distingue este mensaje de uno escrito por Fran a mano.
    registrarAutomatico(e.jid, res.message.id, e.campanaNombre, e.campanaId);
    if (e.notaInterna) registrarNota(e.jid, e.notaInterna, e.campanaId);
    await contarResultado(e, true);
    console.log(`[campanas] enviado a ${e.telefono} · ${e.campanaNombre}`);
    // El hueco entre mensajes lo decide el dashboard (`decidirEnvio`); aquí basta
    // con volver a preguntar enseguida y que él diga "espera".
    return POLL_MIN_MS;
  }

  // DISTINGUIR el fallo global del fallo de este destinatario. Si WhatsApp está
  // caído o el ritmo de send.ts frena, NO es culpa de esta persona: contarlo como
  // fallo la quemaría y, con tres seguidos, pausaría la campaña sin motivo real.
  if (res.code === "offline" || res.code === "rate") {
    console.log(`[campanas] en espera (${res.code}): ${res.error}`);
    return ESPERA_OFFLINE_MS;
  }

  await contarResultado(e, false, res.error, res.code);
  console.warn(`[campanas] FALLÓ a ${e.telefono} (${res.code}): ${res.error}`);
  return POLL_MIN_MS;
}

/** Arranca el bucle. Idempotente: llamarlo dos veces no crea dos workers. */
export function arrancarWorkerCampanas(): void {
  if (corriendo) return;
  if (!habilitado()) {
    console.log("[campanas] worker APAGADO (CAMPANAS_WORKER != on).");
    return;
  }
  if (!token()) {
    console.warn("[campanas] worker no arranca: falta FRANSUA_INTERNAL_TOKEN.");
    return;
  }
  corriendo = true;
  console.log("[campanas] worker en marcha.");

  void (async () => {
    while (corriendo) {
      let espera = 60_000;
      try {
        espera = await ciclo();
      } catch (err) {
        // Un fallo inesperado NO debe matar el bucle ni el servicio.
        paradoPor = (err as Error).message;
        console.error("[campanas] error en el ciclo:", paradoPor);
        espera = 60_000;
      }
      await dormir(Math.max(POLL_MIN_MS, Math.min(POLL_MAX_MS, espera)));
    }
  })();
}

export function pararWorkerCampanas(): void {
  corriendo = false;
}

export function estadoWorkerCampanas(): { habilitado: boolean; corriendo: boolean; ultimoError: string | null } {
  return { habilitado: habilitado(), corriendo, ultimoError: paradoPor };
}
