/**
 * Qué hacer cuando Baileys cierra la conexión. Función PURA (sin socket ni
 * red) para poder probarla sin tocar WhatsApp: scripts/test-reconexion.ts.
 *
 * Por qué existe (incidente 11-09-2026, 15:02 Madrid): al escanear el QR,
 * WhatsApp corta con 515 «restartRequired» y espera que el cliente abra un
 * socket nuevo AL MOMENTO con las credenciales recién emparejadas. El sidecar
 * lo trataba como un corte cualquiera, con el backoff exponencial que, tras
 * varios QR caducados sin escanear, ya estaba en 60 s. El móvil dio la
 * vinculación por fallida y, cuando por fin reconectamos, WhatsApp abrió la
 * sesión y la retiró un segundo después (401 device_removed).
 *
 * Reglas:
 *  - 401 loggedOut  → las credenciales ya no valen: limpiar y pedir QR nuevo.
 *  - 515 restartRequired → reconectar YA. Una sola vez por ventana de 30 s:
 *    si WhatsApp lo repitiera en bucle, se vuelve al backoff normal (nada de
 *    reconexiones agresivas).
 *  - 408 con un QR en pantalla → el QR caducó sin que nadie lo escanease: pausa
 *    corta y QR nuevo, sin inflar el backoff. Antes pasaba hasta 1 min sin QR
 *    (y el dashboard seguía enseñando el caducado).
 *  - Cualquier otro cierre → backoff exponencial 1 s → 60 s, como siempre.
 */
import type { WaConnectionState } from "../shared/whatsapp-contracts";

export const COD_LOGGED_OUT = 401;
export const COD_TIMED_OUT = 408;
export const COD_RESTART_REQUIRED = 515;

export const PAUSA_QR_MS = 3_000;
export const TOPE_BACKOFF_MS = 60_000;
export const VENTANA_REINICIO_MS = 30_000;

export type DecisionCierre =
  | { accion: "reset" }
  | { accion: "ya" }
  | { accion: "esperar"; ms: number; siguienteMs: number };

export function decidirCierre(p: {
  statusCode: number | undefined;
  /** Estado en el que estaba la conexión justo ANTES de cerrarse. */
  estadoPrevio: WaConnectionState;
  /** Retraso de backoff vigente. */
  retrasoMs: number;
  ahoraMs: number;
  /** Cuándo se hizo la última reconexión inmediata (0 si nunca). */
  ultimoReinicioYaMs: number;
}): DecisionCierre {
  const { statusCode, estadoPrevio, retrasoMs, ahoraMs, ultimoReinicioYaMs } = p;

  if (statusCode === COD_LOGGED_OUT) return { accion: "reset" };

  if (statusCode === COD_RESTART_REQUIRED && ahoraMs - ultimoReinicioYaMs >= VENTANA_REINICIO_MS) {
    return { accion: "ya" };
  }

  if (statusCode === COD_TIMED_OUT && estadoPrevio === "needs_qr") {
    return { accion: "esperar", ms: PAUSA_QR_MS, siguienteMs: retrasoMs };
  }

  return {
    accion: "esperar",
    ms: retrasoMs,
    siguienteMs: Math.min(retrasoMs * 2, TOPE_BACKOFF_MS),
  };
}
