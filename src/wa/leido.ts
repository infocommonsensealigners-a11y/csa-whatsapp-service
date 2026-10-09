/**
 * MARCAR LEÍDO EN WHATSAPP — permitido SOLO en este fichero (decisión del
 * usuario, 09-10-2026: «haz todo lo que queda… los 5 puntos», tras proponerle
 * acabar con la BANDEJA DOBLE).
 *
 * Por qué: leer un chat en el teléfono flotante no lo marcaba como leído en el
 * WhatsApp de Fran. El móvil seguía con sus globos, había que «limpiarlos» allí
 * y el doctor no veía el doble check azul. Era la razón nº 2 de la auditoría
 * por la que Fran vuelve al móvil.
 *
 * Cómo está acotado (mismo patrón que `send.ts` y `labels.ts`):
 *  - `check:nosend` prohíbe el token de leído en todo `src/` salvo AQUÍ.
 *    Fransua (`src/ai`, `src/brain`) no puede nombrarlo.
 *  - Solo lo llama la ruta `POST /chats/:jid/leido`, que llama el teléfono
 *    flotante cuando una PERSONA tiene ese chat abierto y delante.
 *  - Solo marca mensajes ENTRANTES ya guardados y más nuevos que la marca de
 *    leído que ya teníamos. No envía ningún mensaje, no toca la presencia.
 *  - Es exactamente lo que hace WhatsApp Web al abrir un chat.
 */
import { getDb } from "../db/db";
import { getActiveSocket } from "./socket";

/** Mensajes como mucho por llamada (los más nuevos sin leer). */
const MAX_POR_VEZ = 100;
/** No se repite para el mismo chat en este rato (el flotante puede pedirlo seguido). */
const ESPERA_MS = 3_000;
const ultimo = new Map<string, number>();

type Clave = { remoteJid: string; id: string; fromMe: false; participant?: string };

export type ResultadoLeido =
  | { ok: true; marcados: number }
  | { ok: false; error: string; code: "offline" | "fail" };

export async function marcarLeidoEnWhatsapp(jid: string): Promise<ResultadoLeido> {
  const ahora = Date.now();
  const antes = ultimo.get(jid);
  if (antes !== undefined && ahora - antes < ESPERA_MS) return { ok: true, marcados: 0 };
  ultimo.set(jid, ahora);
  if (ultimo.size > 2000) for (const [k, t] of ultimo) if (ahora - t > ESPERA_MS) ultimo.delete(k);

  const db = getDb();
  const filas = db
    .prepare(
      `SELECT m.id, m.ts, m.participant,
              json_extract(m.raw_json, '$.key.remoteJid') AS remoto,
              json_extract(m.raw_json, '$.key.participant') AS participanteCrudo
         FROM messages m JOIN chats c ON c.jid = m.chat_jid
        WHERE m.chat_jid = ? AND m.from_me = 0 AND m.stub IS NULL
          AND m.ts > COALESCE(c.wa_read_at, 0)
        ORDER BY m.ts DESC LIMIT ?`
    )
    .all(jid, MAX_POR_VEZ) as Array<{ id: string; ts: number; participant: string | null; remoto: string | null; participanteCrudo: string | null }>;
  if (filas.length === 0) return { ok: true, marcados: 0 };

  const sock = getActiveSocket();
  if (!sock) return { ok: false, error: "WhatsApp no está conectado.", code: "offline" };

  // La clave tal como la vio WhatsApp (puede ser el @lid de la persona, aunque
  // aquí el chat esté guardado bajo su teléfono).
  const claves: Clave[] = filas.map((f) => {
    const c: Clave = { remoteJid: f.remoto || jid, id: f.id, fromMe: false };
    const p = f.participanteCrudo || f.participant;
    if (p) c.participant = p;
    return c;
  });
  try {
    await sock.readMessages(claves);
  } catch (e) {
    return { ok: false, error: (e as Error).message, code: "fail" };
  }
  const tope = Math.max(...filas.map((f) => f.ts));
  db.prepare(`UPDATE chats SET wa_read_at = ? WHERE jid = ? AND COALESCE(wa_read_at, 0) < ?`).run(tope, jid, tope);
  return { ok: true, marcados: claves.length };
}
