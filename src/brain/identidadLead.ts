/**
 * IDENTIDAD DEL LEAD en el sidecar — piezas pequeñas y compartidas.
 *
 * REGLA (usuario, 27-07-2026 y otra vez el 10-09-2026): un lead se identifica
 * por su TELÉFONO, nunca por su fila del Sheet. Las filas se borran y todo lo de
 * debajo sube: el 10-09 un evento con Marta Cuadra enseñaba a Nerea Lobe porque
 * solo guardaba la fila 1858. La fila es, como mucho, una pista.
 */
import { getDb } from "../db/db";

/**
 * FILA DEL SHEET de un registro: null si no viene o no es una fila real.
 *
 * ⚠️ Antes se hacía `Number.isFinite(Number(v)) ? Number(v) : null`, y
 * `Number(null)` es 0: todo evento creado SIN lead se guardaba con «fila 0»
 * (35 de los 49 eventos futuros, medido el 10-09-2026).
 */
export function filaDe(v: unknown): number | null {
  if (v == null || v === "") return null;
  const n = Number(v);
  return Number.isInteger(n) && n > 0 ? n : null;
}

/** 9 dígitos si es un móvil/fijo español con prefijo; si no, los dígitos tal cual. */
function digitos(v: unknown): string | null {
  const d = String(v ?? "").replace(/\D/g, "");
  if (d.length < 8) return null;
  return d.length === 11 && d.startsWith("34") ? d.slice(2) : d;
}

/**
 * Teléfono de un CHAT: el guardado en `chats` (incluye los `@lid` a los que se
 * les rescató el número por `senderPn`) o, si no, el del propio jid
 * `34612345678@s.whatsapp.net`. Es la identidad del propio chat: no depende de
 * ninguna fila del Sheet, así que no se desplaza.
 */
export function telefonoDeChat(jid: string | null | undefined): string | null {
  const j = String(jid ?? "").trim();
  if (!j) return null;
  try {
    const r = getDb().prepare("SELECT phone FROM chats WHERE jid = ?").get(j) as { phone: string | null } | undefined;
    const t = digitos(r?.phone);
    if (t) return t;
  } catch {
    /* sin BD local: se cae al número del jid */
  }
  const m = j.match(/^(\d{8,15})@s\.whatsapp\.net$/);
  return m ? digitos(m[1]) : null;
}
