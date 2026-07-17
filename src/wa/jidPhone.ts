/**
 * Mapeo JID de WhatsApp ↔ teléfono canónico del CRM + clasificación de JIDs.
 *
 * El formato canónico replica `normalizarTelefono` del dashboard
 * (dashboard/lib/parsers/normalizers/phone.ts): un móvil español son
 * 9 dígitos SIN prefijo (`/^[6789]\d{8}$/`). Un JID individual clásico es
 * `34XXXXXXXXX@s.whatsapp.net`; los internacionales devuelven null (se
 * ingieren igualmente, pero solo se vinculan a mano).
 *
 * OJO: WhatsApp moderno también direcciona 1-a-1 con JIDs `@lid` (LID, ocultos
 * por privacidad) que NO llevan el número. Los tratamos como chat individual
 * (se muestran) con teléfono null hasta poder mapearlos.
 */

export const SPANISH_MOBILE_PATTERN = /^[6789]\d{8}$/;

const INDIVIDUAL_SUFFIX = "@s.whatsapp.net";

// OJO: Baileys a veces invoca estos con jid undefined (p.ej. handleReceipt con
// remoteJid ausente). Todos deben tolerar null/undefined sin lanzar.
export function isGroupJid(jid: string | null | undefined): boolean {
  return !!jid && jid.endsWith("@g.us");
}

export function isBroadcastJid(jid: string | null | undefined): boolean {
  // incluye status@broadcast y las listas de difusión
  return !!jid && jid.endsWith("@broadcast");
}

export function isNewsletterJid(jid: string | null | undefined): boolean {
  return !!jid && jid.endsWith("@newsletter");
}

/** JID individual clásico con número (permite mapear a teléfono). */
export function isIndividualJid(jid: string | null | undefined): boolean {
  return !!jid && jid.endsWith(INDIVIDUAL_SUFFIX);
}

/**
 * Un chat que SÍ guardamos y mostramos: conversación 1-a-1 (número o LID),
 * nunca grupo, difusión/estado ni newsletter.
 */
export function isStorableChatJid(jid: string): boolean {
  return !!jid && !isGroupJid(jid) && !isBroadcastJid(jid) && !isNewsletterJid(jid);
}

/** '34611222333@s.whatsapp.net' → '611222333'; no-ES / LID / no individual → null. */
export function jidToPhone(jid: string): string | null {
  if (!isIndividualJid(jid)) return null;
  // La parte de usuario puede llevar sufijo de dispositivo ('34611222333:12').
  const user = jid.slice(0, jid.indexOf("@")).split(":")[0];
  if (user.startsWith("34")) {
    const rest = user.slice(2);
    if (SPANISH_MOBILE_PATTERN.test(rest)) return rest;
  }
  return null;
}

/** '611222333' → '34611222333@s.whatsapp.net'; teléfono no canónico → null. */
export function phoneToJid(phone: string): string | null {
  if (!SPANISH_MOBILE_PATTERN.test(phone)) return null;
  return `34${phone}${INDIVIDUAL_SUFFIX}`;
}
