/**
 * ESTADO DE LECTURA REAL DE WHATSAPP (petición del usuario 2026-08-01: "que las
 * notificaciones verdes estén a la par que las del WhatsApp real — si mi
 * compañero lo lee en WhatsApp Web o en el móvil, aquí no debe seguir pendiente").
 *
 * EL PROBLEMA QUE RESUELVE: hasta ahora el contador de no leídos era 100% LOCAL
 * — contaba los mensajes entrantes posteriores a `chats.last_opened_at`, que
 * solo se escribe al abrir el chat en ESTE teléfono flotante. Como Fran lleva
 * años leyendo en WhatsApp de verdad y casi nunca aquí, el badge contaba
 * historial entero: 4.299 "sin leer" con chats de 648. Números inútiles.
 *
 * CÓMO SE ARREGLA: WhatsApp sincroniza su propio `unreadCount` entre todos los
 * dispositivos (es lo que hace que al leer en el móvil se apague el globo en
 * WhatsApp Web). Baileys lo entrega en `chats.update` / `chats.upsert` y en el
 * volcado de historial. Aquí lo convertimos en una MARCA DE AGUA `wa_read_at`:
 * todo mensaje entrante con `ts <= wa_read_at` está leído en el WhatsApp real.
 *
 * Regla final del badge (en routes/chats.ts): un mensaje cuenta como pendiente
 * solo si es posterior a AMBAS marcas — la local y la de WhatsApp. O sea:
 * **leído en cualquiera de los dos sitios = leído**. Es lo que pidió el usuario
 * y lo que espera quien usa las dos pantallas a la vez.
 *
 * ⚠️ ESTO ES SOLO LECTURA Y EN UN SOLO SENTIDO (WhatsApp → aquí). Abrir un chat
 * en el teléfono flotante NO lo marca como leído en WhatsApp: para eso harían
 * falta las funciones de acuse de lectura y de modificación de chats, ambas
 * PROHIBIDAS por `check:nosend` en TODO el servicio (son las que delatarían al
 * sidecar y las que tocan el estado de la cuenta). Si algún día se quiere, es
 * una decisión de producto del usuario, no una ampliación silenciosa.
 */
import { getDb, getMeta, setMeta } from "../db/db";

/** Marca de "ya sembramos el histórico" para que la siembra corra UNA sola vez. */
const SEED_META_KEY = "wa_read_seed_v1";

/**
 * Antigüedad a partir de la cual un chat existente se da por leído en la siembra
 * inicial. Todo lo anterior a esto es historial que Fran YA trabajó en WhatsApp;
 * la última semana se deja intacta para que la resuelva el estado real.
 */
const SEED_CUTOFF_DIAS = 7;

/**
 * Escribe la marca de agua a partir del `unreadCount` que reporta WhatsApp.
 *
 * - `unreadCount === 0` → todo lo que tenemos guardado está leído: la marca sube
 *   al último mensaje del chat.
 * - `unreadCount === N > 0` → deben quedar EXACTAMENTE N entrantes por leer: se
 *   busca el N-ésimo entrante más reciente y la marca se pone justo por debajo.
 *   Así el contador local converge al número que enseña WhatsApp en vez de
 *   inventarse el suyo. Si tenemos menos de N entrantes guardados (WhatsApp
 *   conoce más historial que nosotros), no se toca nada.
 *
 * La marca es MONÓTONA: nunca retrocede. Eso protege de eventos que lleguen
 * desordenados y de un `unreadCount` inflado — un badge ya apagado no puede
 * "resucitar" solo. (Efecto secundario asumido: marcar un chat como no leído a
 * mano en el móvil no se refleja aquí.)
 *
 * Nunca lanza: un fallo aquí no puede tumbar la ingesta.
 */
export function applyWaRead(jid: string, unreadCount: number | null | undefined): boolean {
  if (typeof unreadCount !== "number" || !Number.isFinite(unreadCount) || unreadCount < 0) return false;
  try {
    const db = getDb();
    let marca: number | null = null;

    if (unreadCount === 0) {
      const row = db.prepare("SELECT MAX(ts) AS ts FROM messages WHERE chat_jid = ?").get(jid) as
        | { ts: number | null }
        | undefined;
      marca = row?.ts ?? Math.floor(Date.now() / 1000);
    } else {
      const row = db
        .prepare(
          "SELECT ts FROM messages WHERE chat_jid = ? AND from_me = 0 ORDER BY ts DESC LIMIT 1 OFFSET ?"
        )
        .get(jid, unreadCount - 1) as { ts: number } | undefined;
      // Sin fila = WhatsApp cuenta más mensajes de los que tenemos: no tocar.
      if (!row) return false;
      marca = row.ts - 1;
    }

    const res = db
      .prepare("UPDATE chats SET wa_read_at = ? WHERE jid = ? AND COALESCE(wa_read_at, 0) < ?")
      .run(marca, jid, marca);
    return res.changes > 0;
  } catch (e) {
    console.error("[read-state] no se pudo aplicar el estado de lectura:", (e as Error).message);
    return false;
  }
}

/**
 * SIEMBRA ÚNICA del histórico. Sin esto, el arreglo no se notaría: WhatsApp solo
 * manda `chats.update` de los chats que CAMBIAN, así que los cientos de chats
 * viejos se quedarían con su badge inflado para siempre.
 *
 * Da por leído todo chat cuyo último mensaje tenga más de `SEED_CUTOFF_DIAS`
 * días. Es cierto en la práctica (son conversaciones ya trabajadas en WhatsApp)
 * y deja la última semana sin tocar para que mande el estado real.
 */
export function seedHistoricalRead(): void {
  try {
    if (getMeta(SEED_META_KEY)) return;
    const corte = Math.floor(Date.now() / 1000) - SEED_CUTOFF_DIAS * 86_400;
    const res = getDb()
      .prepare(
        `UPDATE chats SET wa_read_at = last_message_at
          WHERE last_message_at IS NOT NULL
            AND last_message_at < ?
            AND COALESCE(wa_read_at, 0) < last_message_at`
      )
      .run(corte);
    setMeta(SEED_META_KEY, String(Math.floor(Date.now() / 1000)));
    console.log(
      `[read-state] siembra inicial: ${res.changes} chats con más de ${SEED_CUTOFF_DIAS} días ` +
        "dados por leídos (el estado real de WhatsApp manda a partir de ahora)."
    );
  } catch (e) {
    console.error("[read-state] siembra inicial falló:", (e as Error).message);
  }
}
