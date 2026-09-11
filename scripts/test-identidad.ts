/**
 * Pruebas de la capa PURA de identidad (src/wa/identidad.ts): normalización de
 * jids (sufijo de dispositivo, @c.us), LID, grupos e internacionales (E.164).
 *
 * Ejecutar: npx tsx scripts/test-identidad.ts
 */
import { claveTelefono, digitosDeJid, esGrupo, esLid, esPn, jidPnDe, normalizarJid, telefonoEs } from "../src/wa/identidad";

let ok = 0;
let ko = 0;
function eq<T>(nombre: string, real: T, esperado: T): void {
  if (JSON.stringify(real) === JSON.stringify(esperado)) ok++;
  else {
    ko++;
    console.error(`✗ ${nombre}: esperado ${JSON.stringify(esperado)}, real ${JSON.stringify(real)}`);
  }
}

// normalizarJid
eq("quita sufijo de dispositivo", normalizarJid("34611222333:12@s.whatsapp.net"), "34611222333@s.whatsapp.net");
eq("quita agente", normalizarJid("34611222333_1@s.whatsapp.net"), "34611222333@s.whatsapp.net");
eq("@c.us → @s.whatsapp.net", normalizarJid("34611222333@c.us"), "34611222333@s.whatsapp.net");
eq("lid se conserva", normalizarJid("123456789012345@lid"), "123456789012345@lid");
eq("lid con dispositivo", normalizarJid("123456789012345:3@lid"), "123456789012345@lid");
eq("grupo se conserva", normalizarJid("120363012345678901@g.us"), "120363012345678901@g.us");
eq("sin @ no es jid", normalizarJid("34611222333"), "");
eq("null", normalizarJid(null), "");
eq("espacios", normalizarJid(" 34611222333@s.whatsapp.net "), "34611222333@s.whatsapp.net");

// clasificación
eq("esLid", esLid("1@lid"), true);
eq("esPn", esPn("34611222333@s.whatsapp.net"), true);
eq("esPn c.us", esPn("34611222333@c.us"), true);
eq("esGrupo", esGrupo("1@g.us"), true);
eq("esPn no para lid", esPn("1@lid"), false);

// claveTelefono (E.164 sin '+', ES a 9 dígitos)
eq("ES desde jid", claveTelefono("34611222333@s.whatsapp.net"), "611222333");
eq("ES desde senderPn sin servidor", claveTelefono("34611222333"), "611222333");
eq("ES con dispositivo", claveTelefono("34611222333:5@s.whatsapp.net"), "611222333");
eq("ES escrito", claveTelefono("+34 611 222 333"), "611222333");
eq("ES con 00", claveTelefono("0034611222333"), "611222333");
eq("ES 9 dígitos", claveTelefono("611222333"), "611222333");
eq("ES fijo 9xx", claveTelefono("34911222333"), "911222333");
eq("Reino Unido", claveTelefono("447911123456@s.whatsapp.net"), "447911123456");
eq("Argentina", claveTelefono("5491122334455@s.whatsapp.net"), "5491122334455");
eq("EE.UU. 11 dígitos", claveTelefono("+1 415 555 2671"), "14155552671");
eq("lid no tiene teléfono", claveTelefono("123456789012345@lid"), null);
eq("vacío", claveTelefono(""), null);
eq("demasiado corto", claveTelefono("12345"), null);

// telefonoEs
eq("telefonoEs ES", telefonoEs("34611222333@s.whatsapp.net"), "611222333");
eq("telefonoEs extranjero", telefonoEs("447911123456@s.whatsapp.net"), null);

// digitosDeJid / jidPnDe
eq("dígitos del jid", digitosDeJid("34611222333@s.whatsapp.net"), "34611222333");
eq("dígitos de lid", digitosDeJid("1@lid"), null);
eq("jidPnDe desde senderPn", jidPnDe("34611222333@s.whatsapp.net"), "34611222333@s.whatsapp.net");
eq("jidPnDe desde número ES", jidPnDe("611222333"), "34611222333@s.whatsapp.net");
eq("jidPnDe desde +", jidPnDe("+44 7911 123456"), "447911123456@s.whatsapp.net");
eq("jidPnDe desde c.us", jidPnDe("34611222333@c.us"), "34611222333@s.whatsapp.net");
eq("jidPnDe lid → null", jidPnDe("1@lid"), null);

console.log(`identidad: ${ok} OK, ${ko} fallos`);
if (ko) process.exit(1);
