/**
 * ETIQUETAS DE WHATSAPP BUSINESS — lectura del catálogo y escritura BIDIRECCIONAL
 * (petición del usuario 2026-07-30: "lo que ponga aquí sale en WhatsApp, lo que
 * ponga en WhatsApp sale aquí").
 *
 * Es el ÚNICO fichero autorizado a ETIQUETAR chats en WhatsApp, igual que
 * `send.ts` es el único autorizado a publicar texto. El guardián
 * `npm run check:nosend` permite los tokens de etiquetado SOLO aquí: cualquier
 * otro fichero de src/ que los nombre (incluido TODO src/ai/ y src/brain/, o
 * sea Fransua) rompe la verificación.
 *
 * ⚠️ Se usan las funciones ESTRECHAS de Baileys (`addChatLabel` /
 * `removeChatLabel`): solo etiquetan. La función ancha de modificar chats (la
 * que además marca como leído, archiva o silencia) sigue prohibida en TODO el
 * servicio, sin excepción — ni siquiera aquí. Etiquetar no envía nada ni toca
 * los acuses de lectura, así que no cambia el riesgo de la cuenta.
 *
 * SENTIDO WHATSAPP → AQUÍ: lo cubre la ingesta (`labels.edit` y
 * `labels.association` en ingest.ts), que además emite `chat.updated` para que
 * la interfaz se entere al instante.
 *
 * SENTIDO AQUÍ → WHATSAPP: `setChatLabel()`. Escribe primero en WhatsApp (si
 * falla, NO se toca la copia local: nunca se miente al usuario) y solo entonces
 * refleja el cambio en SQLite y avisa a la interfaz. El eco de WhatsApp llegará
 * después por `labels.association` y es idempotente (INSERT OR IGNORE / DELETE).
 */
import { getDb } from "../db/db";
import { emitSse } from "../http/sse";
import { isStorableChatJid } from "./jidPhone";
import { getActiveSocket } from "./socket";

export interface WaLabelRow {
  id: string;
  name: string;
  color: number;
}

export type LabelResult =
  | { ok: true; jid: string; labelId: string; on: boolean; labels: WaLabelRow[] }
  | { ok: false; error: string; code: "offline" | "invalid" | "unknown-label" | "fail" };

/** Catálogo de etiquetas conocidas (las no borradas), en orden alfabético. */
export function listLabelCatalog(): WaLabelRow[] {
  try {
    return getDb()
      .prepare("SELECT id, COALESCE(name,'') AS name, color FROM wa_labels WHERE deleted = 0 ORDER BY name COLLATE NOCASE")
      .all() as WaLabelRow[];
  } catch {
    return [];
  }
}

/** Etiquetas puestas a UN chat. */
export function labelsOfChat(jid: string): WaLabelRow[] {
  try {
    return getDb()
      .prepare(
        `SELECT l.id AS id, COALESCE(l.name,'') AS name, l.color AS color
           FROM wa_chat_labels cl JOIN wa_labels l ON l.id = cl.label_id
          WHERE cl.chat_jid = ? AND l.deleted = 0
          ORDER BY l.name COLLATE NOCASE`
      )
      .all(jid) as WaLabelRow[];
  } catch {
    return [];
  }
}

/**
 * Vuelve a pedirle a WhatsApp el estado de la app para RELLENAR el catálogo.
 * Necesario porque `labels.edit` solo llega durante la sincronización: si una
 * etiqueta se creó en el móvil después del último emparejamiento, aquí no
 * existe. Es una operación de LECTURA (Baileys hace lo mismo al conectar); se
 * dispara a mano desde el menú de etiquetas, no en bucle.
 *
 * EFECTO SECUNDARIO ÚTIL: esa misma sincronización arrastra los cambios de
 * estado de los chats, así que también refresca los NO LEÍDOS reales (ver
 * src/wa/readState.ts). Por eso el botón del menú se llama "Sincronizar con el
 * móvil" y no solo "traer etiquetas": es la salida manual si algún globo verde
 * se quedara desfasado.
 */
export async function resyncLabels(): Promise<{ ok: boolean; error?: string; labels: number }> {
  const sock = getActiveSocket();
  if (!sock) return { ok: false, error: "WhatsApp no está conectado ahora mismo.", labels: listLabelCatalog().length };
  try {
    // "regular" es la colección donde viajan las etiquetas y sus asociaciones.
    await sock.resyncAppState(["regular", "regular_high", "regular_low"], false);
  } catch (e) {
    const msg = String((e as Error)?.message ?? e).slice(0, 160);
    console.error("[labels] resync falló:", msg);
    return { ok: false, error: msg, labels: listLabelCatalog().length };
  }
  emitSse({ type: "labels.updated" });
  return { ok: true, labels: listLabelCatalog().length };
}

function ensureAuditTable(): void {
  getDb().exec(
    `CREATE TABLE IF NOT EXISTS wa_label_audit (
       id INTEGER PRIMARY KEY,
       chat_jid TEXT NOT NULL,
       label_id TEXT NOT NULL,
       accion TEXT NOT NULL,
       actor TEXT,
       created_at INTEGER NOT NULL
     )`
  );
}

/**
 * Pone (on=true) o quita (on=false) una etiqueta a un chat, EN WHATSAPP y aquí.
 * Idempotente: volver a poner lo que ya está no falla ni duplica.
 */
export async function setChatLabel(
  jid: string,
  labelId: string,
  on: boolean,
  actor: string | null
): Promise<LabelResult> {
  const id = String(labelId ?? "").trim();
  if (!id) return { ok: false, error: "Falta la etiqueta.", code: "invalid" };
  if (!isStorableChatJid(jid)) {
    return { ok: false, error: "Destino no válido (solo chats 1-a-1).", code: "invalid" };
  }
  const db = getDb();
  const label = db.prepare("SELECT id, COALESCE(name,'') AS name, color, deleted FROM wa_labels WHERE id = ?").get(id) as
    | (WaLabelRow & { deleted: number })
    | undefined;
  if (!label || label.deleted) {
    return { ok: false, error: "Esa etiqueta no existe en tu WhatsApp.", code: "unknown-label" };
  }
  const chat = db.prepare("SELECT jid FROM chats WHERE jid = ?").get(jid) as { jid: string } | undefined;
  if (!chat) return { ok: false, error: "Ese chat no está en el historial.", code: "invalid" };

  const sock = getActiveSocket();
  if (!sock) {
    return { ok: false, error: "WhatsApp no está conectado ahora mismo.", code: "offline" };
  }

  // 1) WhatsApp PRIMERO: si esto falla, la copia local se queda como estaba y
  //    el usuario ve el error — jamás una etiqueta "puesta" que allí no está.
  try {
    if (on) await sock.addChatLabel(jid, id);
    else await sock.removeChatLabel(jid, id);
  } catch (e) {
    const msg = String((e as Error)?.message ?? e).slice(0, 160);
    console.error(`[labels] no se pudo ${on ? "poner" : "quitar"} ${id} en ${jid}:`, msg);
    return { ok: false, error: `WhatsApp rechazó el cambio: ${msg}`, code: "fail" };
  }

  // 2) Espejo local + auditoría. El eco de WhatsApp llegará luego y es inocuo.
  try {
    if (on) {
      db.prepare("INSERT OR IGNORE INTO wa_chat_labels(chat_jid, label_id) VALUES (?, ?)").run(jid, id);
    } else {
      db.prepare("DELETE FROM wa_chat_labels WHERE chat_jid = ? AND label_id = ?").run(jid, id);
    }
    ensureAuditTable();
    db.prepare(
      "INSERT INTO wa_label_audit(chat_jid, label_id, accion, actor, created_at) VALUES (?, ?, ?, ?, ?)"
    ).run(jid, id, on ? "add" : "remove", actor ?? null, Math.floor(Date.now() / 1000));
  } catch (e) {
    console.error("[labels] espejo local falló:", (e as Error).message);
  }

  emitSse({ type: "chat.updated", jid });
  return { ok: true, jid, labelId: id, on, labels: labelsOfChat(jid) };
}
