/**
 * Test de la decisión de reconexión (src/wa/reconexion.ts). Sin red ni socket.
 *   npx tsx scripts/test-reconexion.ts
 */
import { DisconnectReason } from "baileys";
import {
  COD_LOGGED_OUT,
  COD_RESTART_REQUIRED,
  COD_TIMED_OUT,
  PAUSA_QR_MS,
  TOPE_BACKOFF_MS,
  decidirCierre,
} from "../src/wa/reconexion";

let ok = 0;
let fallos = 0;
function igual(nombre: string, real: unknown, esperado: unknown): void {
  const a = JSON.stringify(real);
  const b = JSON.stringify(esperado);
  if (a === b) {
    ok++;
    console.log(`OK   ${nombre}`);
  } else {
    fallos++;
    console.log(`FALLO ${nombre}\n     real:     ${a}\n     esperado: ${b}`);
  }
}

const AHORA = 1_789_131_754_437;

// Los códigos que usamos coinciden con los de la versión instalada de Baileys.
igual("401 = DisconnectReason.loggedOut", COD_LOGGED_OUT, DisconnectReason.loggedOut);
igual("408 = DisconnectReason.timedOut", COD_TIMED_OUT, DisconnectReason.timedOut);
igual("515 = DisconnectReason.restartRequired", COD_RESTART_REQUIRED, DisconnectReason.restartRequired);

// Desvinculado: limpiar y QR nuevo, esté como esté.
igual(
  "401 → reset",
  decidirCierre({ statusCode: 401, estadoPrevio: "open", retrasoMs: 8_000, ahoraMs: AHORA, ultimoReinicioYaMs: 0 }),
  { accion: "reset" }
);

// El caso del incidente: backoff ya en 60 s y llega el 515 tras escanear.
igual(
  "515 tras escanear con backoff en 60 s → reconectar YA",
  decidirCierre({ statusCode: 515, estadoPrevio: "needs_qr", retrasoMs: 60_000, ahoraMs: AHORA, ultimoReinicioYaMs: 0 }),
  { accion: "ya" }
);
igual(
  "515 con la sesión abierta → también YA",
  decidirCierre({ statusCode: 515, estadoPrevio: "open", retrasoMs: 1_000, ahoraMs: AHORA, ultimoReinicioYaMs: AHORA - 3_600_000 }),
  { accion: "ya" }
);

// Sin bucles: un segundo 515 dentro de 30 s vuelve al backoff.
igual(
  "515 repetido a los 5 s → backoff normal",
  decidirCierre({ statusCode: 515, estadoPrevio: "connecting", retrasoMs: 1_000, ahoraMs: AHORA, ultimoReinicioYaMs: AHORA - 5_000 }),
  { accion: "esperar", ms: 1_000, siguienteMs: 2_000 }
);
igual(
  "515 pasados 30 s → otra vez YA",
  decidirCierre({ statusCode: 515, estadoPrevio: "connecting", retrasoMs: 1_000, ahoraMs: AHORA, ultimoReinicioYaMs: AHORA - 30_000 }),
  { accion: "ya" }
);

// QR caducado: pausa corta y el backoff NO crece.
igual(
  "408 con QR en pantalla → pausa corta sin inflar",
  decidirCierre({ statusCode: 408, estadoPrevio: "needs_qr", retrasoMs: 16_000, ahoraMs: AHORA, ultimoReinicioYaMs: 0 }),
  { accion: "esperar", ms: PAUSA_QR_MS, siguienteMs: 16_000 }
);

// 408 con la sesión abierta o conectando = red: backoff normal.
igual(
  "408 con sesión abierta → backoff",
  decidirCierre({ statusCode: 408, estadoPrevio: "open", retrasoMs: 4_000, ahoraMs: AHORA, ultimoReinicioYaMs: 0 }),
  { accion: "esperar", ms: 4_000, siguienteMs: 8_000 }
);
igual(
  "408 mientras conecta → backoff",
  decidirCierre({ statusCode: 408, estadoPrevio: "connecting", retrasoMs: 2_000, ahoraMs: AHORA, ultimoReinicioYaMs: 0 }),
  { accion: "esperar", ms: 2_000, siguienteMs: 4_000 }
);

// Otros cierres (428, 500, sin código) y tope de 60 s.
igual(
  "428 → backoff",
  decidirCierre({ statusCode: 428, estadoPrevio: "open", retrasoMs: 1_000, ahoraMs: AHORA, ultimoReinicioYaMs: 0 }),
  { accion: "esperar", ms: 1_000, siguienteMs: 2_000 }
);
igual(
  "sin código → backoff",
  decidirCierre({ statusCode: undefined, estadoPrevio: "connecting", retrasoMs: 32_000, ahoraMs: AHORA, ultimoReinicioYaMs: 0 }),
  { accion: "esperar", ms: 32_000, siguienteMs: TOPE_BACKOFF_MS }
);
igual(
  "tope de 60 s",
  decidirCierre({ statusCode: 500, estadoPrevio: "open", retrasoMs: 60_000, ahoraMs: AHORA, ultimoReinicioYaMs: 0 }),
  { accion: "esperar", ms: 60_000, siguienteMs: 60_000 }
);

console.log(`\n${ok} OK, ${fallos} fallos`);
if (fallos > 0) process.exit(1);
