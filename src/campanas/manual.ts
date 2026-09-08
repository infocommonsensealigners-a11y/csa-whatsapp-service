/**
 * TOMA MANUAL — «si mi compañero lo toma en manual se para el automático».
 *
 * Petición del usuario (2026-09-08) después de ver la conversación de Julio, y
 * era un agujero de verdad: la automatización no tenía NINGUNA forma de saber
 * que un humano se había metido en el chat. Fran le contestó a mano a las 15:13
 * («no, para los asistentes estamos enviando a casa el libro… ¿lo quieres?»),
 * Julio le contestó a ÉL, y el guion —que seguía esperando la confirmación de su
 * primer mensaje— le mandó una reconducción sobre si se había apuntado al taller
 * y luego el paso 2 repitiendo lo que Fran ya le había dicho dos veces.
 *
 * ⚠️ ESTO SOLO PUEDE VIVIR AQUÍ. El dashboard no ve lo que sale de la cuenta de
 * WhatsApp; el socket está en este servicio. Y la señal no es el texto ni la
 * hora: es que un mensaje SALIENTE no lleve marca de automático.
 *
 * DOS CAMINOS, porque hay dos formas de escribir a mano y ninguna de las dos
 * puede fallar:
 *
 *  1. Desde el TELÉFONO FLOTANTE del dashboard → pasa por `sendText`/`sendMedia`
 *     con un actor humano. Se avisa AL MOMENTO (`avisarSalienteManual`).
 *
 *  2. Desde el WHATSAPP DE FRAN (su móvil, WhatsApp Web…) → el mensaje llega
 *     como eco en `messages.upsert` con `fromMe`. Ahí no hay actor, así que se
 *     mira si el id del mensaje tiene marca de automático… pero NO se puede
 *     mirar en ese instante: el eco puede adelantar al `registrarAutomatico`
 *     que va justo detrás del envío, y entonces confundiríamos un mensaje del
 *     guion con uno de Fran y pararíamos la campaña sola. Por eso se ENCOLA y se
 *     comprueba 25 segundos después, cuando la marca ya está escrita
 *     (`encolarSalientePorSiEsManual`).
 *
 * En caso de duda el sesgo es PARAR: un falso positivo deja la conversación en
 * manos de Fran (que es donde acabaría de todos modos), y un falso negativo es
 * la automatización hablándole encima a un doctor.
 */

import { config } from "../config";
import { getDb } from "../db/db";
import { jidToPhone } from "../wa/jidPhone";
import { registrarNota } from "./marcas";

/** Prefijo del actor con el que envía la automatización (ver worker.ts). */
const ACTOR_AUTOMATICO = "campaña:";

/**
 * Espera antes de juzgar un eco saliente. Tiene que ser mayor que el hueco
 * entre `sendText` y `registrarAutomatico` —que son milisegundos— con margen de
 * sobra para un volumen ocupado.
 */
const RETARDO_MS = 25_000;

/** Solo se juzgan ecos RECIENTES: un `append` viejo no es una toma manual. */
const FRESCURA_MAX_S = 10 * 60;

/** No se avisa dos veces del mismo chat en este rato (Fran escribe seguido). */
const AVISO_TTL_MS = 15 * 60_000;

/**
 * Margen para dar por "el mismo envío" un saliente y un mensaje de la
 * automatización en el mismo chat cuando los ids no casan. Ver la tercera
 * comprobación de `esDeLaAutomatizacion`.
 */
const MARGEN_MISMO_ENVIO_S = 90;

interface Saliente {
  jid: string;
  waMsgId: string;
}

/** Lo que devuelve `/api/campanas/worker/manual`. */
interface RespuestaManual {
  success?: boolean;
  /** Conversaciones que se han parado por esta toma manual. */
  paradas?: number;
  tomas?: Array<{
    campanaId: string;
    campanaNombre: string;
    jid: string;
    notaInterna: string;
    efecto: string;
  }>;
}

const cola = new Map<string, Saliente & { ts: number }>();
let temporizador: NodeJS.Timeout | null = null;
const avisados = new Map<string, number>();

function token(): string | null {
  return process.env.FRANSUA_INTERNAL_TOKEN ?? null;
}

/**
 * ¿Este mensaje lo mandó la automatización? Se pregunta a las DOS tablas:
 *
 *  - `campana_marcas` es la marca de agua que pone el worker al enviar.
 *  - `wa_send_audit` es la auditoría de todo lo que sale por este servicio, y
 *    ahí el actor dice quién fue.
 *
 * Las dos porque cada una cubre el fallo de la otra: si una marca no se llegó a
 * escribir (ya pasó una vez, con el `ON CONFLICT` del índice parcial), la
 * auditoría sigue teniendo la fila con el actor `campaña:…`.
 */
function esDeLaAutomatizacion(waMsgId: string, jid: string, ts: number): boolean {
  const db = getDb();
  try {
    const marca = db.prepare(`SELECT 1 AS x FROM campana_marcas WHERE wa_msg_id = ? LIMIT 1`).get(waMsgId);
    if (marca) return true;
  } catch {
    // La tabla puede no existir todavía (nunca se envió una campaña).
  }
  try {
    const audit = db
      .prepare(`SELECT actor FROM wa_send_audit WHERE wa_msg_id = ? ORDER BY id DESC LIMIT 1`)
      .get(waMsgId) as { actor: string | null } | undefined;
    if (audit && (audit.actor ?? "").startsWith(ACTOR_AUTOMATICO)) return true;
  } catch {
    /* idem */
  }
  /**
   * TERCERA comprobación, y es una red de seguridad contra el falso positivo
   * más caro: que la automatización se pare sola.
   *
   * Las dos de arriba buscan por ID de mensaje, y ese id puede NO coincidir. Si
   * Baileys no devolviera `key.id` al enviar, `sendText` guarda un id
   * sintético (`sent-…`) y la marca de agua se escribe con ÉSE, mientras el eco
   * llega con el id real. Los dos primeros filtros no casarían y daríamos por
   * escrito a mano un mensaje del guion: cerraríamos la conversación de un
   * doctor con una nota que además dice algo falso.
   *
   * Así que si en este mismo chat salió un mensaje de la automatización
   * pegado en el tiempo a éste, se considera el mismo. El precio es acotado y
   * conocido: si un compañero escribe a mano en el mismo minuto que sale un
   * mensaje automático, esa toma no se detecta ahora — la cazan el siguiente
   * mensaje que escriba o el repaso del próximo arranque.
   */
  try {
    const cerca = db
      .prepare(
        `SELECT 1 AS x FROM wa_send_audit
          WHERE chat_jid = ? AND actor LIKE ? AND ABS(created_at - ?) <= ?
          LIMIT 1`
      )
      .get(jid, `${ACTOR_AUTOMATICO}%`, ts, MARGEN_MISMO_ENVIO_S);
    if (cerca) return true;
  } catch {
    /* idem */
  }
  return false;
}

/** Teléfono del chat. En los `@lid` el jid no lo lleva: se saca de `chats`. */
function telefonoDeChat(jid: string): string | null {
  const directo = jidToPhone(jid);
  if (directo) return directo;
  try {
    const row = getDb().prepare(`SELECT phone FROM chats WHERE jid = ?`).get(jid) as
      | { phone: string | null }
      | undefined;
    return row?.phone ? String(row.phone) : null;
  } catch {
    return null;
  }
}

/**
 * Avisa al dashboard de que este chat lo lleva un humano, y deja en el chat las
 * notas que devuelva para que se vean en el teléfono flotante.
 */
async function avisarDashboard(jid: string, actor: string | null): Promise<boolean> {
  const t = token();
  if (!t) return false;
  const telefono = telefonoDeChat(jid);
  if (!telefono) return false;

  const ahora = Date.now();
  const visto = avisados.get(telefono);
  if (visto !== undefined && ahora - visto < AVISO_TTL_MS) return true;
  avisados.set(telefono, ahora);
  if (avisados.size > 3000) {
    for (const [k, v] of avisados) if (ahora - v > AVISO_TTL_MS) avisados.delete(k);
  }

  let j: RespuestaManual | null = null;
  try {
    const res = await fetch(`${config.dashboardUrl}/api/campanas/worker/manual`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-fransua-token": t },
      body: JSON.stringify({ telefono, actor }),
      signal: AbortSignal.timeout(12_000),
    });
    /**
     * ⚠️ UN 404 O UN 502 NO ES UN "NO HAY NADA QUE PARAR": es que el dashboard
     * está desplegando. Hay que OLVIDAR el teléfono para volver a intentarlo,
     * igual que con un fallo de red. Darlo por avisado dejaría la
     * automatización suelta 15 minutos justo en un chat que lleva una persona —
     * y el repaso del arranque, que corre una sola vez, se perdería entero si
     * cae mientras el dashboard reinicia.
     */
    if (!res.ok) {
      avisados.delete(telefono);
      return false;
    }
    j = (await res.json()) as RespuestaManual;
  } catch {
    /**
     * ⚠️ Si el aviso no llega, se OLVIDA el teléfono para que el siguiente
     * mensaje manual vuelva a intentarlo. Guardarlo como avisado sin haberlo
     * conseguido dejaría la automatización suelta 15 minutos justo en el chat en
     * el que un humano está escribiendo.
     */
    avisados.delete(telefono);
    return false;
  }
  if (!j?.success) {
    avisados.delete(telefono);
    return false;
  }
  if (!j.tomas?.length) return true;

  for (const toma of j.tomas) {
    /**
     * La nota se deja en el chat donde ESCRIBIÓ el humano y, si es otro, también
     * en el que tiene la campaña: la misma persona puede tener dos chats (uno
     * `@lid` y otro por teléfono) y la nota tiene que verse donde se está
     * mirando.
     */
    registrarNota(jid, toma.notaInterna, toma.campanaId);
    if (toma.jid && toma.jid !== jid) registrarNota(toma.jid, toma.notaInterna, toma.campanaId);
  }
  console.log(
    `[campanas] TOMA MANUAL en ${telefono}: parada${(j.paradas ?? 0) === 1 ? "" : "s"} ${j.paradas ?? 0} conversación(es)` +
      (actor ? ` · a mano por ${actor}` : " · escrito desde el WhatsApp de Fran"),
  );
  return true;
}

/* -------------------------------------------------------------------------- */
/* Camino 1: envío manual por este servicio (teléfono flotante)               */
/* -------------------------------------------------------------------------- */

/**
 * Un mensaje ha salido por `sendText`/`sendMedia` con un actor que NO es la
 * automatización: lo ha escrito una persona. Se avisa al momento, sin esperas:
 * aquí no hay ninguna duda de quién lo mandó.
 */
export function avisarSalienteManual(jid: string, actor: string | null): void {
  if ((actor ?? "").startsWith(ACTOR_AUTOMATICO)) return;
  void avisarDashboard(jid, actor).catch(() => {
    /* best-effort: el mensaje ya salió, esto solo frena la automatización */
  });
}

/* -------------------------------------------------------------------------- */
/* Camino 2: eco de un mensaje escrito desde el WhatsApp de Fran              */
/* -------------------------------------------------------------------------- */

/**
 * Encola un mensaje SALIENTE que ha llegado por el socket para juzgarlo dentro
 * de `RETARDO_MS`. Ver el comentario de cabecera: no se puede juzgar ya porque
 * el eco puede adelantar a la marca de agua del propio envío automático.
 */
export function encolarSalientePorSiEsManual(s: Saliente & { ts: number }): void {
  if (!token()) return;
  const edad = Math.floor(Date.now() / 1000) - s.ts;
  // Un mensaje viejo (reentrega, `append` de sincronización) no es una toma.
  if (edad > FRESCURA_MAX_S) return;
  cola.set(`${s.jid}|${s.waMsgId}`, { jid: s.jid, waMsgId: s.waMsgId, ts: s.ts });
  if (temporizador) return;
  temporizador = setTimeout(() => {
    temporizador = null;
    const lote = [...cola.values()];
    cola.clear();
    for (const s2 of lote) {
      if (esDeLaAutomatizacion(s2.waMsgId, s2.jid, s2.ts)) continue;
      void avisarDashboard(s2.jid, null).catch(() => {});
    }
  }, RETARDO_MS);
  // No debe mantener el proceso vivo si no hay nada más que hacer.
  temporizador.unref?.();
}

/* -------------------------------------------------------------------------- */
/* Repaso RETROACTIVO al arrancar                                             */
/* -------------------------------------------------------------------------- */

/** Espera antes del repaso: que el dashboard esté en pie y la base abierta. */
const REPASO_MS = 45_000;

/**
 * TOMAS MANUALES QUE YA HABÍAN PASADO. Se repasa una vez al arrancar.
 *
 * ⚠️ Sin esto el arreglo solo valdría de aquí en adelante, y la campaña del
 * taller está EN MARCHA con conversaciones que Fran ya ha cogido a mano —la de
 * Julio es una de ellas—. El tope de 3 mensajes cubre a quien ya iba pasado de
 * cuenta, pero no a quien solo había recibido la apertura: ahí la
 * automatización tendría todavía dos mensajes de margen para escribir encima de
 * un compañero.
 *
 * La señal, con lo que ya hay en la base y sin preguntar nada a WhatsApp: en un
 * chat que ha tocado la automatización, si el ÚLTIMO mensaje que salió no lleva
 * marca de automático, lo escribió una persona y la conversación es suya.
 *
 * Es el último mensaje y no "algún mensaje" a propósito: un chat en el que Fran
 * escribió hace meses y que la automatización estrenó después no es una toma
 * manual, y darlo por tal cerraría conversaciones vivas sin motivo.
 */
export function repasarTomasManuales(): void {
  if (!token()) return;
  const t = setTimeout(() => {
    let candidatos: { jid: string }[] = [];
    try {
      candidatos = getDb()
        .prepare(`SELECT DISTINCT chat_jid AS jid FROM campana_marcas WHERE wa_msg_id IS NOT NULL`)
        .all() as { jid: string }[];
    } catch {
      return; // nunca ha enviado una campaña: no hay nada que repasar
    }
    const tomados: string[] = [];
    for (const { jid } of candidatos) {
      let ultimo: { id: string; ts: number } | undefined;
      try {
        ultimo = getDb()
          .prepare(`SELECT id, ts FROM messages WHERE chat_jid = ? AND from_me = 1 ORDER BY ts DESC, rowid DESC LIMIT 1`)
          .get(jid) as { id: string; ts: number } | undefined;
      } catch {
        continue;
      }
      if (!ultimo || esDeLaAutomatizacion(ultimo.id, jid, ultimo.ts)) continue;
      tomados.push(jid);
    }
    if (tomados.length === 0) {
      console.log("[campanas] repaso de tomas manuales: ninguna conversación la lleva un humano.");
      return;
    }
    console.log(`[campanas] repaso de tomas manuales: ${tomados.length} chat(s) los lleva un humano. Parando la automatización ahí.`);
    void avisarPorLotes(tomados, 1);
  }, REPASO_MS);
  t.unref?.();
}

/** Reintentos del repaso, en minutos. Ver `avisarPorLotes`. */
const REINTENTOS_MIN = [2, 6, 15];

/**
 * Avisa de una lista de chats, de uno en uno, y REINTENTA los que fallen.
 *
 * ⚠️ El reintento no es celo: el repaso corre UNA vez al arrancar, y el arranque
 * del sidecar coincide casi siempre con un despliegue del dashboard —los dos
 * repos se despliegan juntos—. Sin reintento, un 404 de treinta segundos se
 * llevaba por delante toda la protección retroactiva hasta el siguiente
 * reinicio, que puede ser dentro de días.
 */
async function avisarPorLotes(jids: string[], vuelta: number): Promise<void> {
  const fallidos: string[] = [];
  for (const jid of jids) {
    const ok = await avisarDashboard(jid, null).catch(() => false);
    if (!ok) fallidos.push(jid);
    // De uno en uno y con calma: son avisos, no hay ninguna prisa.
    await new Promise((r) => setTimeout(r, 500));
  }
  if (fallidos.length === 0) {
    console.log(`[campanas] repaso de tomas manuales: avisados todos (vuelta ${vuelta}).`);
    return;
  }
  const espera = REINTENTOS_MIN[vuelta - 1];
  if (espera === undefined) {
    console.warn(
      `[campanas] repaso de tomas manuales: ${fallidos.length} chat(s) sin avisar tras ${vuelta} vueltas. ` +
        "El tope de mensajes sigue protegiendo; se reintentará al próximo arranque.",
    );
    return;
  }
  console.warn(
    `[campanas] repaso de tomas manuales: ${fallidos.length} sin avisar (¿dashboard desplegando?). Reintento en ${espera} min.`,
  );
  const t = setTimeout(() => void avisarPorLotes(fallidos, vuelta + 1), espera * 60_000);
  t.unref?.();
}
