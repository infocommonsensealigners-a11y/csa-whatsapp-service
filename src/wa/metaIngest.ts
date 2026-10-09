/**
 * RED DE SEGURIDAD: los mensajes que entrega el webhook de Meta (coexistence).
 *
 * Decisión del usuario (09-10-2026): Baileys sigue siendo el teléfono (envía sin
 * la ventana de 24 h, grupos, etiquetas…), y Meta es la red de seguridad. Lo
 * pidió después de ver que desde el 05-10 Baileys no descifraba NINGÚN mensaje
 * entrante (CIPHERTEXT) y se perdieron ~900.
 *
 * Meta entrega TODOS los mensajes del número (entrantes y lo que Fran manda
 * desde su app), con reintentos durante días. El mismo mensaje puede llegar
 * también por Baileys, así que la regla es UNA FILA POR MENSAJE:
 *
 *  - El id interno de un `wamid.…` ES el id del mensaje en Baileys
 *    (`idInternoDeWamid`). Se busca por id en CUALQUIER chat.
 *  - ¿Ya estaba descifrado? No se toca.
 *  - ¿Estaba como «esperando el mensaje…» (CIPHERTEXT)? Se rellena en su sitio.
 *  - ¿No estaba? Se guarda en el chat del teléfono, marcado `origen: "meta"`;
 *    si después llega por Baileys, Baileys lo ENRIQUECE (su raw_json permite
 *    descargar la foto o el audio) en vez de duplicarlo (ver ingestCore).
 *  - Si Baileys lo tenía en un chat `@lid` sin teléfono, Meta dice de quién es:
 *    se aprende el mapeo y los dos chats se funden.
 */
import { getDb } from "../db/db";
import { aprenderMapeo, canonicoDe } from "./canonico";
import { esLid, jidPnDe, telefonoEs } from "./identidad";
import { previewDe } from "./preview";

export interface MensajeMeta {
  /** `wamid.…` tal cual lo da Meta (o ya el id interno). */
  wamid: string;
  /** Teléfono del cliente (wa_id): solo dígitos, con prefijo de país. */
  telefono: string;
  fromMe: boolean;
  /** Segundos epoch. */
  ts: number;
  tipo: string;
  texto: string | null;
  /** Nombre de perfil que trae Meta (`contacts[].profile.name`). */
  nombre?: string | null;
}

export interface ResultadoMeta {
  nuevos: number;
  rellenados: number;
  yaEstaban: number;
  descartados: number;
  /** Chats tocados (para avisar a la interfaz). */
  jids: string[];
}

/**
 * `wamid.HBgL…` → id del mensaje en el protocolo (el que ve Baileys). Copia de
 * `dashboard/lib/whatsappCloud/plantillas.ts`: el wamid es base64 de un
 * protobuf que lleva el teléfono y, al final, el id en hexadecimal.
 */
export function idInternoDeWamid(wamid: string): string {
  const original = String(wamid ?? "");
  let b64 = original.replace(/^wamid\./, "").replace(/-/g, "+").replace(/_/g, "/").replace(/=+$/, "");
  if (!b64 || /[^A-Za-z0-9+/]/.test(b64) || b64.length % 4 === 1) return original;
  b64 += "=".repeat((4 - (b64.length % 4)) % 4);
  let binario: string;
  try {
    binario = Buffer.from(b64, "base64").toString("latin1");
  } catch {
    return original;
  }
  const rachas = binario.match(/[0-9A-F]{16,}/g);
  return rachas?.length ? rachas[rachas.length - 1] : original;
}

const TIPOS = new Set(["text", "image", "audio", "video", "document", "other"]);

export function ingestarDesdeMeta(lista: MensajeMeta[], now = Math.floor(Date.now() / 1000)): ResultadoMeta {
  const db = getDb();
  const out: ResultadoMeta = { nuevos: 0, rellenados: 0, yaEstaban: 0, descartados: 0, jids: [] };
  const jids = new Set<string>();

  const porId = db.prepare(`SELECT chat_jid AS jid, stub FROM messages WHERE id = ? LIMIT 1`);
  const rellenar = db.prepare(
    `UPDATE messages SET type = @type, text = @text, stub = NULL
      WHERE id = @id AND stub = 'CIPHERTEXT'`
  );
  const previewSiEsElUltimo = db.prepare(
    `UPDATE chats SET last_message_preview = @preview, updated_at = @now
      WHERE jid = @jid AND COALESCE(last_message_at, 0) <= @ts`
  );
  const ensureChat = db.prepare(
    `INSERT INTO chats(jid, phone, display_name, created_at, updated_at)
     VALUES (@jid, @phone, @display_name, @now, @now)
     ON CONFLICT(jid) DO UPDATE SET
       display_name = COALESCE(NULLIF(chats.display_name, ''), NULLIF(excluded.display_name, '')),
       phone = COALESCE(NULLIF(chats.phone, ''), excluded.phone),
       updated_at = excluded.updated_at`
  );
  const insertar = db.prepare(
    `INSERT INTO messages(chat_jid, id, from_me, ts, type, text, media_path, media_mime, raw_json, participant, status, stub)
     VALUES (@chat_jid, @id, @from_me, @ts, @type, @text, NULL, NULL, @raw_json, NULL, NULL, NULL)
     ON CONFLICT(chat_jid, id) DO NOTHING`
  );
  const bump = db.prepare(
    `UPDATE chats SET
       last_message_preview = CASE WHEN @ts >= COALESCE(last_message_at, 0) THEN @preview ELSE last_message_preview END,
       last_message_at = MAX(COALESCE(last_message_at, 0), @ts),
       deleted_at = NULL,
       updated_at = @now
     WHERE jid = @jid`
  );

  for (const m of lista) {
    const id = idInternoDeWamid(String(m.wamid ?? "").trim());
    const pn = jidPnDe(m.telefono);
    if (!id || !pn) {
      out.descartados++;
      continue;
    }
    const tipo = TIPOS.has(m.tipo) ? m.tipo : "other";
    const texto = m.texto && m.texto.trim() ? m.texto : null;
    const ts = Number.isFinite(m.ts) && m.ts > 0 ? Math.floor(m.ts) : now;

    const antes = porId.get(id) as { jid: string; stub: string | null } | undefined;
    if (antes) {
      // Baileys lo guardó en un @lid sin teléfono: Meta dice de quién es → se funden.
      if (esLid(antes.jid) && canonicoDe(antes.jid) === antes.jid) {
        try {
          aprenderMapeo(antes.jid, pn, "meta");
        } catch {
          /* el mapeo es accesorio: el mensaje se rellena igual */
        }
      }
      const jid = canonicoDe(antes.jid) || antes.jid;
      if (antes.stub === "CIPHERTEXT" && (texto || tipo !== "other")) {
        if (rellenar.run({ id, type: tipo, text: texto }).changes > 0) {
          previewSiEsElUltimo.run({ jid, ts, preview: previewDe(tipo, texto), now });
          out.rellenados++;
          jids.add(jid);
          continue;
        }
      }
      out.yaEstaban++;
      continue;
    }

    const jid = canonicoDe(pn) || pn;
    const tx = db.transaction(() => {
      ensureChat.run({ jid, phone: telefonoEs(jid), display_name: !m.fromMe && m.nombre ? m.nombre : "", now });
      const r = insertar.run({
        chat_jid: jid, id, from_me: m.fromMe ? 1 : 0, ts, type: tipo, text: texto,
        raw_json: JSON.stringify({ origen: "meta", wamid: m.wamid }),
      });
      if (r.changes > 0) bump.run({ jid, ts, preview: previewDe(tipo, texto), now });
      return r.changes > 0;
    });
    if (tx()) {
      out.nuevos++;
      jids.add(jid);
    } else out.yaEstaban++;
  }
  out.jids = [...jids];
  return out;
}

/** ¿Esta fila la guardó la red de seguridad de Meta (sin el mensaje de Baileys)? */
export function esFilaDeMeta(rawJson: string | null | undefined): boolean {
  return typeof rawJson === "string" && rawJson.startsWith('{"origen":"meta"');
}
