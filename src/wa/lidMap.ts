/**
 * RESCATE DEL TELÉFONO DE LOS CHATS `@lid` — vías RETROACTIVAS y bajo demanda.
 *
 * La regla de identidad vive en `canonico.ts` (`aprenderMapeo`): guarda el par
 * lid→teléfono en `wa_lid_map` y, si el `@lid` tenía chat propio, lo funde en el
 * chat del teléfono. Este módulo solo aporta las dos vías que no pasan por la
 * ingesta en vivo:
 *   · `backfillLidPhones`     — relee `key.senderPn` de `messages.raw_json`.
 *   · `resolvePhonesToLids`   — pregunta a WhatsApp el LID de teléfonos del CRM
 *                               (`onWhatsApp`, solo lectura).
 */
import { getDb } from "../db/db";
import { planFusion } from "../db/fusion";
import { SPANISH_MOBILE_PATTERN } from "./jidPhone";
import { aprenderMapeo } from "./canonico";
import { claveTelefono, telefonoEs } from "./identidad";
import { lookupLids } from "./socket";

/** '34600111222@s.whatsapp.net' | '34600111222' → '600111222' si es móvil ES; si no, null. */
export function pnToSpanishPhone(pn: string | null | undefined): string | null {
  return telefonoEs(pn);
}

/**
 * Clave de teléfono para CRUZAR con el CRM: móvil español → 9 dígitos;
 * extranjero → todos sus dígitos con prefijo de país. Mismo formato que
 * `phoneKey` de `linkLeads.ts`, para que las claves casen.
 */
export function pnToPhoneKey(pn: string | null | undefined): string | null {
  return claveTelefono(pn);
}

/** Mapeo en vivo desde la clave de un mensaje (delegado en la capa de identidad). */
export function recordLidFromKey(
  jid: string | null | undefined,
  senderPn: string | null | undefined,
  source = "senderPn"
): void {
  aprenderMapeo(jid, senderPn, source);
}

export interface LidBackfillResult {
  lidChats: number;
  conMapeo: number;
  telefonoEsCanonico: number;
  /** Chats @lid que se han fundido en su chat del teléfono en esta pasada. */
  chatsFundidos: number;
  sinSenderPn: number;
  /** Pares que siguen pendientes de fundir (debería ser 0 tras la pasada). */
  duplicados: Array<{ lid: string; pn: string; phone: string | null; lidName: string | null; pnName: string | null }>;
}

/**
 * Recorre los mensajes ya guardados de los chats `@lid`, extrae `key.senderPn`
 * de `raw_json` y aprende el mapeo (lo que funde el chat en el del teléfono).
 * Idempotente: re-ejecutarlo no duplica ni sobrescribe nada.
 */
export function backfillLidPhones(): LidBackfillResult {
  const db = getDb();
  const lidChats = db.prepare("SELECT jid FROM chats WHERE jid LIKE '%@lid' AND alias_of IS NULL").all() as Array<{ jid: string }>;

  // Un solo barrido por SQL: primer senderPn no nulo de cada chat @lid.
  const found = db
    .prepare(
      `SELECT chat_jid AS jid, json_extract(raw_json, '$.key.senderPn') AS pn
         FROM messages
        WHERE chat_jid LIKE '%@lid'
          AND json_extract(raw_json, '$.key.senderPn') IS NOT NULL
        GROUP BY chat_jid`
    )
    .all() as Array<{ jid: string; pn: string }>;

  let telefonoEsCanonico = 0;
  let chatsFundidos = 0;
  for (const r of found) {
    if (telefonoEs(r.pn)) telefonoEsCanonico++;
    const res = aprenderMapeo(r.jid, r.pn, "backfill:senderPn");
    if (res.fusionado) chatsFundidos++;
  }

  const duplicados = planFusion(db).map((p) => ({
    lid: p.lid,
    pn: p.pn,
    phone: p.phone,
    lidName: p.nombreLid,
    pnName: p.nombrePn,
  }));

  return {
    lidChats: lidChats.length,
    conMapeo: found.length,
    telefonoEsCanonico,
    chatsFundidos,
    sinSenderPn: lidChats.length - found.length,
    duplicados,
  };
}

export interface ResolveByPhoneRow {
  phone: string;
  /** ¿Ese número tiene cuenta de WhatsApp? */
  enWhatsapp: boolean;
  lid: string | null;
  /** true si TENEMOS una conversación con ese LID (¡su chat oculto localizado!). */
  chatLocalizado: boolean;
  chatNombre: string | null;
  /** true si ese chat oculto se ha fundido ahora en el chat del teléfono. */
  rellenado: boolean;
}

/**
 * ÚLTIMA VÍA para los chats `@lid` cuyo teléfono no venía en `senderPn` (chats
 * donde solo escribimos nosotros, o anteriores a ese campo): se le pregunta a
 * WhatsApp el LID de cada teléfono del CRM y se cruza con nuestras
 * conversaciones. Consulta de solo lectura (ver socket.lookupLids).
 *
 * Se procesa en tandas de 20 con una pausa breve: son pocas consultas y del
 * mismo tipo que hace la app al abrir un contacto, pero no conviene ráfagas.
 */
export async function resolvePhonesToLids(phones: string[]): Promise<ResolveByPhoneRow[]> {
  const db = getDb();
  const limpios = Array.from(
    new Set(
      phones
        .map((p) => String(p ?? "").replace(/\D/g, "").slice(-9))
        .filter((p) => SPANISH_MOBILE_PATTERN.test(p))
    )
  );
  const out: ResolveByPhoneRow[] = [];

  for (let i = 0; i < limpios.length; i += 20) {
    const tanda = limpios.slice(i, i + 20);
    const res = await lookupLids(tanda.map((p) => `34${p}@s.whatsapp.net`));
    const porTelefono = new Map<string, { exists: boolean; lid: string | null }>();
    for (const r of res) {
      const key = r.jid.split("@")[0].replace(/\D/g, "").slice(-9);
      porTelefono.set(key, { exists: r.exists, lid: r.lid });
    }
    for (const phone of tanda) {
      const r = porTelefono.get(phone);
      const lid = r?.lid ?? null;
      let chatNombre: string | null = null;
      let chatLocalizado = false;
      let rellenado = false;
      if (lid) {
        const chat = db.prepare("SELECT display_name FROM chats WHERE jid = ?").get(lid) as { display_name: string | null } | undefined;
        chatLocalizado = !!chat;
        chatNombre = chat?.display_name ?? null;
        // Se guarda el mapeo aunque todavía no exista el chat: si esa persona
        // escribe mañana, su conversación ya nace identificada. Si existía, se
        // funde ahora en la del teléfono.
        rellenado = aprenderMapeo(lid, `34${phone}@s.whatsapp.net`, "onWhatsApp").fusionado;
      }
      out.push({ phone, enWhatsapp: Boolean(r?.exists), lid, chatLocalizado, chatNombre, rellenado });
    }
    if (i + 20 < limpios.length) await new Promise((r) => setTimeout(r, 1500));
  }
  return out;
}
