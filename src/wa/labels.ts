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

const COLECCIONES = ["regular", "regular_high", "regular_low"] as const;

/**
 * RECONSTRUIR EL ESPEJO DE ETIQUETAS DESDE CERO (12-11-2026).
 *
 * Por qué: al recrear las listas en el móvil (05-11), WhatsApp reutilizó los
 * ids de etiquetas borradas («19» era «Seguimiento Estancias» y pasó a ser
 * «WEBINAR GESTIÓN CLÍNICA JAVI»). El espejo conservaba las asociaciones viejas
 * de esos ids y contaba 213 chats donde el móvil de Fran tiene 174. Un resync
 * normal solo trae CAMBIOS: no puede saber qué filas sobran.
 *
 * Cómo: copia de seguridad de `wa_chat_labels` en una tabla con fecha, se vacía,
 * se marcan las etiquetas como borradas (las vivas vuelven por `labels.edit`) y
 * se olvida la versión del estado de la app de las colecciones de etiquetas.
 * Así WhatsApp devuelve la FOTO COMPLETA y la ingesta de siempre
 * (`labels.edit` / `labels.association`) rellena el espejo con la verdad.
 * Solo LEE de WhatsApp: no etiqueta, no envía, no marca nada en el móvil.
 * Si la petición falla, se restaura la copia tal cual.
 */
export async function rebuildLabels(): Promise<{
  ok: boolean;
  error?: string;
  copia?: string;
  antes?: number;
  despues?: number;
  porEtiqueta?: Array<{ id: string; name: string; chats: number }>;
}> {
  const sock = getActiveSocket();
  if (!sock) return { ok: false, error: "WhatsApp no está conectado ahora mismo." };
  const db = getDb();
  const sello = new Date().toISOString().replace(/\D/g, "").slice(0, 12);
  const copia = `wa_chat_labels_copia_${sello}`;
  const copiaCat = `wa_labels_copia_${sello}`;
  const antes = (db.prepare("SELECT COUNT(*) AS n FROM wa_chat_labels").get() as { n: number }).n;
  db.exec(`CREATE TABLE ${copia} AS SELECT * FROM wa_chat_labels; CREATE TABLE ${copiaCat} AS SELECT * FROM wa_labels;`);
  db.transaction(() => {
    db.prepare("DELETE FROM wa_chat_labels").run();
    // Las pseudo-listas del sistema (U+200E delante) no viajan en la foto: se respetan.
    db.prepare("UPDATE wa_labels SET deleted = 1 WHERE name NOT LIKE '‎%'").run();
  })();
  try {
    const vacio = Object.fromEntries(COLECCIONES.map((c) => [c, null]));
    await sock.authState.keys.set({ "app-state-sync-version": vacio } as never);
    await sock.resyncAppState([...COLECCIONES], true);
    // La ingesta procesa los eventos del búfer de Baileys justo después: margen corto.
    await new Promise((r) => setTimeout(r, 3000));
  } catch (e) {
    const msg = String((e as Error)?.message ?? e).slice(0, 200);
    console.error("[labels] rebuild falló, restaurando copia:", msg);
    db.transaction(() => {
      db.prepare("DELETE FROM wa_chat_labels").run();
      db.exec(`INSERT OR IGNORE INTO wa_chat_labels SELECT * FROM ${copia}`);
      db.exec(`DELETE FROM wa_labels; INSERT INTO wa_labels SELECT * FROM ${copiaCat}`);
    })();
    emitSse({ type: "labels.updated" });
    return { ok: false, error: msg, copia };
  }
  const despues = (db.prepare("SELECT COUNT(*) AS n FROM wa_chat_labels").get() as { n: number }).n;
  const porEtiqueta = db
    .prepare(
      `SELECT l.id AS id, COALESCE(l.name,'') AS name, COUNT(cl.chat_jid) AS chats
         FROM wa_labels l LEFT JOIN wa_chat_labels cl ON cl.label_id = l.id
        WHERE l.deleted = 0 GROUP BY l.id ORDER BY l.name COLLATE NOCASE`
    )
    .all() as Array<{ id: string; name: string; chats: number }>;
  emitSse({ type: "labels.updated" });
  console.log(`[labels] espejo reconstruido: ${antes} → ${despues} asociaciones (copia en ${copia})`);
  return { ok: true, copia, antes, despues, porEtiqueta };
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
