/**
 * RESCATE DEL TELÉFONO DE LOS CHATS `@lid`.
 *
 * WhatsApp direcciona muchas conversaciones 1-a-1 con un JID `@lid` que NO lleva
 * el número, así que `jidToPhone()` (que solo mira el texto del JID) los deja con
 * `phone = NULL` y quedan fuera de todo emparejamiento por teléfono: ni el
 * auto-linker del CRM ni la ficha del lead pueden encontrarlos.
 *
 * Pero el número SÍ nos llega: Baileys pone el teléfono real en `key.senderPn`
 * de cada mensaje entrante, y la ingesta ya guardaba el mensaje entero en
 * `messages.raw_json`. Es decir, el dato lleva tiempo en disco sin usarse.
 *
 * Este módulo:
 *   · `recordLidFromKey`  — captura el mapeo EN VIVO al ingerir.
 *   · `backfillLidPhones` — lo recupera HACIA ATRÁS leyendo raw_json.
 *
 * Regla de oro: solo RELLENA `chats.phone` cuando está vacío; nunca sobrescribe
 * un teléfono existente ni borra nada (los datos se suman).
 */
import { getDb } from "../db/db";
import { SPANISH_MOBILE_PATTERN } from "./jidPhone";
import { lookupLids } from "./socket";

/** '34600111222@s.whatsapp.net' | '34600111222' → '600111222' si es móvil ES; si no, null. */
export function pnToSpanishPhone(pn: string | null | undefined): string | null {
  if (!pn) return null;
  const digits = String(pn).split("@")[0].split(":")[0].replace(/\D/g, "");
  if (digits.startsWith("34")) {
    const rest = digits.slice(2);
    if (SPANISH_MOBILE_PATTERN.test(rest)) return rest;
  }
  if (SPANISH_MOBILE_PATTERN.test(digits)) return digits;
  return null;
}

const isLid = (jid: string | null | undefined) => !!jid && jid.endsWith("@lid");

/**
 * Guarda el mapeo lid→teléfono de un mensaje y, si el teléfono es un móvil ES
 * canónico, lo rellena en el chat (solo si estaba vacío). Silencioso y
 * tolerante: nunca debe romper la ingesta.
 */
export function recordLidFromKey(
  jid: string | null | undefined,
  senderPn: string | null | undefined,
  source = "senderPn"
): void {
  if (!isLid(jid) || !senderPn) return;
  try {
    const db = getDb();
    const phone = pnToSpanishPhone(senderPn);
    db.prepare(
      `INSERT INTO wa_lid_map(lid, pn, phone, source, created_at)
       VALUES (@lid, @pn, @phone, @source, @now)
       ON CONFLICT(lid) DO UPDATE SET
         pn = excluded.pn,
         phone = COALESCE(excluded.phone, wa_lid_map.phone)`
    ).run({ lid: jid, pn: String(senderPn), phone, source, now: Math.floor(Date.now() / 1000) });
    if (phone) {
      // Solo rellenar: si ya tenía teléfono, se respeta.
      db.prepare("UPDATE chats SET phone = @phone WHERE jid = @jid AND (phone IS NULL OR phone = '')").run({
        phone,
        jid,
      });
    }
  } catch {
    /* nunca romper la ingesta por el mapeo */
  }
}

export interface LidBackfillResult {
  lidChats: number;
  conMapeo: number;
  telefonoEsCanonico: number;
  chatsRellenados: number;
  sinSenderPn: number;
  /** Pares "misma persona, dos conversaciones": el @lid y su gemelo <phone>@s.whatsapp.net. */
  duplicados: Array<{ lid: string; pn: string; phone: string; lidName: string | null; pnName: string | null }>;
}

/**
 * Recorre los mensajes ya guardados de los chats `@lid`, extrae `key.senderPn`
 * de `raw_json` y materializa el mapa + rellena `chats.phone`. Idempotente:
 * re-ejecutarlo no duplica ni sobrescribe nada.
 */
export function backfillLidPhones(): LidBackfillResult {
  const db = getDb();
  const lidChats = db.prepare("SELECT jid, phone, display_name FROM chats WHERE jid LIKE '%@lid'").all() as Array<{
    jid: string;
    phone: string | null;
    display_name: string | null;
  }>;

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
  let chatsRellenados = 0;
  const phoneByLid = new Map<string, string>();

  const tx = db.transaction(() => {
    for (const r of found) {
      const phone = pnToSpanishPhone(r.pn);
      if (phone) {
        telefonoEsCanonico++;
        phoneByLid.set(r.jid, phone);
      }
      db.prepare(
        `INSERT INTO wa_lid_map(lid, pn, phone, source, created_at)
         VALUES (@lid, @pn, @phone, 'backfill:senderPn', @now)
         ON CONFLICT(lid) DO UPDATE SET
           pn = excluded.pn,
           phone = COALESCE(excluded.phone, wa_lid_map.phone)`
      ).run({ lid: r.jid, pn: String(r.pn), phone, now: Math.floor(Date.now() / 1000) });
      if (phone) {
        const res = db
          .prepare("UPDATE chats SET phone = @phone WHERE jid = @jid AND (phone IS NULL OR phone = '')")
          .run({ phone, jid: r.jid });
        chatsRellenados += res.changes;
      }
    }
  });
  tx();

  // Gemelos: la misma persona con dos filas (el @lid de Baileys y el
  // <phone>@s.whatsapp.net que crea el webhook de Coexistence). NO se fusionan
  // aquí (fusionar historial es destructivo): se REPORTAN para decidir.
  const duplicados: LidBackfillResult["duplicados"] = [];
  for (const [lid, phone] of phoneByLid) {
    const twin = db
      .prepare("SELECT jid, display_name FROM chats WHERE phone = ? AND jid <> ? AND jid NOT LIKE '%@lid'")
      .get(phone, lid) as { jid: string; display_name: string | null } | undefined;
    if (twin) {
      duplicados.push({
        lid,
        pn: twin.jid,
        phone,
        lidName: lidChats.find((c) => c.jid === lid)?.display_name ?? null,
        pnName: twin.display_name ?? null,
      });
    }
  }

  return {
    lidChats: lidChats.length,
    conMapeo: found.length,
    telefonoEsCanonico,
    chatsRellenados,
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
  /** true si se acaba de rellenar el teléfono de ese chat. */
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
        // Se guarda el mapeo aunque todavía no exista el chat: si esa persona
        // escribe mañana, su conversación ya nace identificada.
        db.prepare(
          `INSERT INTO wa_lid_map(lid, pn, phone, source, created_at)
           VALUES (@lid, @pn, @phone, 'onWhatsApp', @now)
           ON CONFLICT(lid) DO UPDATE SET
             pn = excluded.pn,
             phone = COALESCE(excluded.phone, wa_lid_map.phone)`
        ).run({ lid, pn: `34${phone}@s.whatsapp.net`, phone, now: Math.floor(Date.now() / 1000) });
        const chat = db.prepare("SELECT jid, display_name, phone FROM chats WHERE jid = ?").get(lid) as
          | { jid: string; display_name: string | null; phone: string | null }
          | undefined;
        if (chat) {
          chatLocalizado = true;
          chatNombre = chat.display_name ?? null;
          const upd = db
            .prepare("UPDATE chats SET phone = @phone WHERE jid = @jid AND (phone IS NULL OR phone = '')")
            .run({ phone, jid: lid });
          rellenado = upd.changes > 0;
        }
      }
      out.push({
        phone,
        enWhatsapp: Boolean(r?.exists),
        lid,
        chatLocalizado,
        chatNombre,
        rellenado,
      });
    }
    if (i + 20 < limpios.length) await new Promise((r) => setTimeout(r, 1500));
  }
  return out;
}
