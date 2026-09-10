/**
 * La FILA del Sheet de un evento no puede nacer de un nulo (10-09-2026).
 *
 *   npx tsx scripts/test-fila-identidad.ts
 *
 * `Number(null)` es 0: con la conversión vieja, los eventos creados SIN lead se
 * guardaban con «fila 0» (35 de los 49 eventos futuros en producción).
 */
import { filaDe } from "../src/brain/identidadLead";

let fallos = 0;
const ok = (cond: boolean, msg: string) => {
  if (!cond) {
    fallos++;
    console.error("  ✗ " + msg);
  }
};

ok(filaDe(null) === null, "null → sin fila (antes daba 0)");
ok(filaDe(undefined) === null, "undefined → sin fila");
ok(filaDe("") === null, "cadena vacía → sin fila (Number('') también es 0)");
ok(filaDe(0) === null, "0 → sin fila");
ok(filaDe(-3) === null, "negativa → sin fila");
ok(filaDe(12.5) === null, "decimal → sin fila");
ok(filaDe("abc") === null, "texto → sin fila");
ok(filaDe(1858) === 1858, "fila real");
ok(filaDe("1566") === 1566, "fila real en texto");

console.log(fallos ? `\n  ${fallos} fallos\n` : "\n  test-fila-identidad: 9/9\n");
process.exit(fallos ? 1 : 0);
