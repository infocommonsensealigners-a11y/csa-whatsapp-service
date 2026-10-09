/**
 * MORDAZA para los volcados de `libsignal` (la librería de cifrado de Baileys).
 *
 * ⚠️ Visto en producción el 09-10-2026: `session_record.js` hace
 * `console.info("Closing session:", session)` con el objeto ENTERO, y ese objeto
 * lleva las CLAVES PRIVADAS de la sesión (`ephemeralKeyPair.privKey`, `rootKey`…).
 * Iban a los logs de Railway. Además, cuando el descifrado falla en bucle, las
 * trazas de `Bad MAC` saturaban el límite de 500 líneas/s y Railway tiraba logs
 * de verdad.
 *
 * Se intercepta la consola ANTES de cargar nada más (es el primer import de
 * `index.ts`): los mensajes de libsignal se reducen a un contador y una línea
 * resumen por minuto, sin objetos. El resto de la consola no se toca.
 */

const PATRONES: Array<[RegExp, string]> = [
  [/^Closing session/, "sesion_cerrada"],
  [/^Opening session/, "sesion_abierta"],
  [/^Removing old closed session/, "sesion_retirada"],
  [/^Session already (open|closed)/, "sesion_ya"],
  [/^Closing open session in favor/, "sesion_sustituida"],
  [/^Migrating session/, "sesion_migrada"],
  [/^Decrypted message with closed session/, "descifrado_sesion_cerrada"],
  [/^Failed to decrypt message with any known session/, "descifrado_fallido"],
  [/^Session error/, "error_sesion"],
  [/^V1 session storage migration error/, "error_migracion"],
];

const contadores: Record<string, number> = {};
const totales: Record<string, number> = {};
let resumenProgramado: NodeJS.Timeout | null = null;

function clave(args: unknown[]): string | null {
  const primero = args[0];
  if (typeof primero !== "string") return null;
  for (const [re, k] of PATRONES) if (re.test(primero)) return k;
  return null;
}

function apuntar(k: string): void {
  contadores[k] = (contadores[k] ?? 0) + 1;
  totales[k] = (totales[k] ?? 0) + 1;
  if (resumenProgramado) return;
  resumenProgramado = setTimeout(() => {
    resumenProgramado = null;
    const partes = Object.entries(contadores).map(([n, v]) => `${n}=${v}`);
    for (const n of Object.keys(contadores)) delete contadores[n];
    if (partes.length) original.warn(`[signal] último minuto: ${partes.join(" · ")}`);
  }, 60_000);
  resumenProgramado.unref?.();
}

const original = {
  log: console.log.bind(console),
  info: console.info.bind(console),
  warn: console.warn.bind(console),
  error: console.error.bind(console),
};

for (const nivel of ["log", "info", "warn", "error"] as const) {
  console[nivel] = (...args: unknown[]) => {
    const k = clave(args);
    if (k) {
      apuntar(k);
      return;
    }
    original[nivel](...args);
  };
}

/** Totales desde el arranque (para /status). */
export function contadoresSignal(): Record<string, number> {
  return { ...totales };
}
