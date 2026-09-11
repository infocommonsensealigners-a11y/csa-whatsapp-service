/**
 * IDENTIDAD DE UN CHAT — funciones PURAS (sin BD, sin Baileys) para normalizar
 * jids y sacar la clave de teléfono con la que se cruza todo.
 *
 * Por qué existe (auditoría 2026-09-11): WhatsApp direcciona a la MISMA persona
 * unas veces por su número (`34611222333@s.whatsapp.net`) y otras por un
 * identificador oculto (`123456789012345@lid`), y a veces con sufijo de
 * dispositivo (`34611222333:12@s.whatsapp.net`) o con el servidor antiguo
 * (`@c.us`). Guardar el jid tal cual llega producía una fila de chat por cada
 * forma: 93 personas con dos conversaciones vivas en producción.
 *
 * Reglas:
 *  - `normalizarJid` quita el sufijo de dispositivo y el agente, y pasa
 *    `@c.us` a `@s.whatsapp.net`. Es lo mismo que hace Baileys
 *    (`jidNormalizedUser`), copiado aquí para poder probarlo sin arrancar nada.
 *  - `claveTelefono` es la clave de CRUCE: móvil español → 9 dígitos (la
 *    identidad del proyecto, ver `jidPhone.ts`); cualquier otro país → todos sus
 *    dígitos con prefijo (E.164 sin el «+»). Un `@lid` no tiene clave: su
 *    teléfono se aprende aparte (ver `canonico.ts`).
 */
import { SPANISH_MOBILE_PATTERN } from "./jidPhone";

export const SUFIJO_PN = "@s.whatsapp.net";
export const SUFIJO_LID = "@lid";
export const SUFIJO_GRUPO = "@g.us";

/** `user:device@server` → `user@server`; `@c.us` → `@s.whatsapp.net`. Devuelve "" si no es un jid. */
export function normalizarJid(jid: string | null | undefined): string {
  if (!jid || typeof jid !== "string") return "";
  const sep = jid.indexOf("@");
  if (sep <= 0) return "";
  const server = jid.slice(sep + 1).trim();
  const userCombinado = jid.slice(0, sep);
  // Sufijo de dispositivo (`:12`) y agente (`_1`): identifican un aparato, no una persona.
  const user = userCombinado.split(":")[0].split("_")[0].trim();
  if (!user || !server) return "";
  return `${user}@${server === "c.us" ? "s.whatsapp.net" : server}`;
}

export function esLid(jid: string | null | undefined): boolean {
  return !!jid && jid.endsWith(SUFIJO_LID);
}
export function esPn(jid: string | null | undefined): boolean {
  return !!jid && (jid.endsWith(SUFIJO_PN) || jid.endsWith("@c.us"));
}
export function esGrupo(jid: string | null | undefined): boolean {
  return !!jid && jid.endsWith(SUFIJO_GRUPO);
}

/** Dígitos del número de un jid con teléfono (`34611222333@s.whatsapp.net` → `34611222333`). */
export function digitosDeJid(jid: string | null | undefined): string | null {
  const n = normalizarJid(jid);
  if (!esPn(n)) return null;
  const d = n.slice(0, n.indexOf("@")).replace(/\D/g, "");
  return d.length >= 7 && d.length <= 15 ? d : null;
}

/**
 * Clave de teléfono para cruzar: móvil ES → 9 dígitos; otro país → E.164 sin «+».
 * Acepta un jid, un `senderPn` (`34600111222@s.whatsapp.net` o `34600111222`) o
 * un número escrito (`+34 600 111 222`, `0034600111222`).
 */
export function claveTelefono(valor: string | null | undefined): string | null {
  if (!valor) return null;
  const s = String(valor);
  // Un jid que no sea de teléfono (@lid, @g.us, @broadcast…) no tiene clave:
  // sus dígitos son un identificador, no un número.
  if (s.includes("@") && !esPn(normalizarJid(s))) return null;
  const sinServidor = s.split("@")[0].split(":")[0];
  let d = sinServidor.replace(/\D/g, "");
  if (!d) return null;
  if (d.startsWith("00")) d = d.slice(2);
  if (d.startsWith("34") && SPANISH_MOBILE_PATTERN.test(d.slice(2))) return d.slice(2);
  if (SPANISH_MOBILE_PATTERN.test(d)) return d;
  return d.length >= 10 && d.length <= 15 ? d : null;
}

/** Móvil español canónico (9 dígitos) o null: lo que promete `chats.phone`. */
export function telefonoEs(valor: string | null | undefined): string | null {
  const k = claveTelefono(valor);
  return k && SPANISH_MOBILE_PATTERN.test(k) ? k : null;
}

/** Jid con teléfono a partir de un `senderPn`/número: siempre `<dígitos>@s.whatsapp.net`. */
export function jidPnDe(valor: string | null | undefined): string | null {
  if (!valor) return null;
  const s = String(valor);
  if (s.includes("@")) {
    const n = normalizarJid(s);
    return esPn(n) ? n : null;
  }
  let d = s.replace(/\D/g, "");
  if (!d) return null;
  if (d.startsWith("00")) d = d.slice(2);
  if (SPANISH_MOBILE_PATTERN.test(d)) d = `34${d}`;
  return d.length >= 7 && d.length <= 15 ? `${d}${SUFIJO_PN}` : null;
}
