/**
 * Fachada READ-ONLY sobre Baileys. Este módulo es el ÚNICO que toca el
 * WASocket, y lo mantiene privado: hacia fuera solo expone lectura
 * (estado, QR, registro de listeners, foto de perfil, descarga de media).
 *
 * GARANTÍA DE PRODUCTO: este servicio jamás publica nada hacia WhatsApp.
 * No existe ninguna superficie para hacerlo — y `scripts/check-nosend.ts`
 * verifica que los tokens de la API de publicación de Baileys no aparezcan
 * en ningún fichero de `src/`.
 *
 * Ciclo de vida de la conexión (la decisión vive en ./reconexion.ts):
 *  - QR nuevo → estado "needs_qr" + dataURL disponible para la UI.
 *  - restartRequired (515, justo después de escanear) → socket nuevo AL
 *    MOMENTO, tras terminar de guardar las credenciales. Con espera, el móvil
 *    da la vinculación por fallida (incidente 11-09-2026).
 *  - QR caducado sin escanear (408 en "needs_qr") → QR nuevo a los 3 s.
 *  - Otro cierre recuperable (red, 428, 500…) → backoff exponencial 1 s → 60 s.
 *  - loggedOut (desvinculado desde el móvil) → se limpia data/auth y se
 *    arranca de cero, lo que produce un QR fresco.
 *  - Al cerrarse, el QR se retira: la UI nunca enseña uno caducado.
 */
import makeWASocket, {
  fetchLatestBaileysVersion,
  makeCacheableSignalKeyStore,
  useMultiFileAuthState,
  Browsers,
  downloadMediaMessage,
  type BaileysEventMap,
  type WAMessage,
  type WASocket,
} from "baileys";
import pino from "pino";
import QRCode from "qrcode";
import fs from "node:fs";
import { config } from "../config";
import { isGroupJid, isNewsletterJid } from "./jidPhone";
import type { WaConnectionState } from "../shared/whatsapp-contracts";
import type { GroupMetadata } from "baileys";
import { TOPE_BACKOFF_MS, decidirCierre } from "./reconexion";

const log = pino({ level: "info", base: undefined });
// Baileys es muy verboso; solo nos interesan sus warnings/errores.
const baileysLog = pino({ level: "warn", base: undefined });

/* ----------------------- estado privado del módulo ----------------------- */

let sock: WASocket | null = null;
let state: WaConnectionState = "connecting";
let qrDataUrl: string | null = null;
let me: { jid: string; name: string } | null = null;

let reconnectDelayMs = 1_000;
let reconnectTimer: NodeJS.Timeout | null = null;
let starting = false;
let shuttingDown = false;
/** Cola de guardados de credenciales (ver creds.update en startWhatsapp). */
let guardadoCreds: Promise<void> = Promise.resolve();
/** Última reconexión inmediata por 515 (ver ./reconexion.ts). */
let ultimoReinicioYaMs = 0;

type EventRegistration = {
  event: keyof BaileysEventMap;
  handler: (payload: never) => void;
};
/** Listeners externos (ingesta, avatares…), re-adjuntados en cada socket nuevo. */
const registrations: EventRegistration[] = [];

type StateListener = (s: WaConnectionState) => void;
const stateListeners: StateListener[] = [];

function setState(next: WaConnectionState): void {
  if (state === next) return;
  state = next;
  log.info({ state: next }, "wa: cambio de estado");
  for (const fn of stateListeners) fn(next);
}

/* ------------------------------ API pública ------------------------------ */

export function getWaState(): WaConnectionState {
  return state;
}

export function getQrDataUrl(): string | null {
  return qrDataUrl;
}

export function getMe(): { jid: string; name: string } | null {
  return me;
}

/** Suscripción a cambios de estado (banner de conexión, SSE en Fase 1). */
export function onStateChange(fn: StateListener): void {
  stateListeners.push(fn);
}

/**
 * Registra un listener de eventos Baileys. Sobrevive a reconexiones:
 * la fachada lo re-adjunta a cada socket nuevo.
 */
export function onWaEvent<K extends keyof BaileysEventMap>(
  event: K,
  handler: (payload: BaileysEventMap[K]) => void
): void {
  registrations.push({ event, handler: handler as (payload: never) => void });
  if (sock) sock.ev.on(event, handler);
}

/**
 * Socket activo, SOLO para el módulo de envío manual (src/wa/send.ts — el único
 * fichero donde el guardián check:nosend permite la API de publicación).
 * Devuelve null si no hay conexión abierta.
 */
export function getActiveSocket(): WASocket | null {
  return state === "open" ? sock : null;
}

/** URL de la foto de perfil de un JID, o null (sin foto / oculta / sin conexión). */
export async function fetchProfilePicture(jid: string): Promise<string | null> {
  if (!sock || state !== "open") return null;
  try {
    return (await sock.profilePictureUrl(jid, "image")) ?? null;
  } catch {
    return null; // 404 típico: el contacto no tiene foto o la restringe.
  }
}

/**
 * Pregunta a WhatsApp el LID (identificador oculto) de unos teléfonos.
 *
 * Es una consulta USync de SOLO LECTURA — la misma que hace la app al abrir un
 * contacto para saber si está en WhatsApp: NO escribe, NO notifica al contacto y
 * no aparece en su móvil. Sirve para cerrar el círculo de los chats `@lid` cuyo
 * número no pudimos rescatar de `senderPn` (ver wa/lidMap.ts): sabiendo el LID
 * de un teléfono del CRM, se identifica su conversación oculta.
 *
 * Devuelve [] si no hay conexión. Nunca lanza.
 */
export async function lookupLids(
  jids: string[]
): Promise<Array<{ jid: string; exists: boolean; lid: string | null }>> {
  if (!sock || state !== "open" || jids.length === 0) return [];
  try {
    const res = await sock.onWhatsApp(...jids);
    return (res ?? []).map((r) => ({
      jid: String((r as { jid?: unknown }).jid ?? ""),
      exists: Boolean((r as { exists?: unknown }).exists),
      lid: (r as { lid?: unknown }).lid ? String((r as { lid?: unknown }).lid) : null,
    }));
  } catch {
    return [];
  }
}

/**
 * Pide a WhatsApp un tramo de historial ANTERIOR a un mensaje dado (on-demand).
 * NO envía nada a ningún contacto: es una petición de datos al servidor de
 * WhatsApp; la respuesta llega de forma asíncrona como `messaging-history.set`
 * (syncType ON_DEMAND) y la ingiere el handler normal. Devuelve false si no hay
 * conexión o la petición falla.
 */
export async function requestOlderHistory(
  key: { remoteJid: string; id: string; fromMe: boolean },
  oldestTsSeconds: number,
  count = 50
): Promise<boolean> {
  if (!sock || state !== "open") return false;
  try {
    // El proto espera milisegundos (oldestMsgTimestampMs).
    await sock.fetchMessageHistory(count, key, oldestTsSeconds * 1000);
    return true;
  } catch (err) {
    log.warn({ err: (err as Error).message }, "wa: fetchMessageHistory falló");
    return false;
  }
}

/**
 * Pide a WhatsApp que nos avise de la PRESENCIA de un contacto («en línea»,
 * «escribiendo…», «grabando audio…»). Es lo que hace WhatsApp Web al abrir un
 * chat: una suscripción de lectura, no publica nada nuestro (nuestra propia
 * presencia sigue sin enviarse nunca, ver markOnlineOnConnect). Nunca lanza.
 */
export async function suscribirPresencia(jid: string): Promise<boolean> {
  if (!sock || state !== "open" || !jid || isGroupJid(jid)) return false;
  try {
    await sock.presenceSubscribe(jid);
    return true;
  } catch {
    return false;
  }
}

/** Metadatos de un grupo (asunto, participantes). Solo lectura; null sin conexión o si falla. */
export async function metadatosDeGrupo(jid: string): Promise<GroupMetadata | null> {
  if (!sock || state !== "open" || !isGroupJid(jid)) return null;
  try {
    return await sock.groupMetadata(jid);
  } catch {
    return null;
  }
}

/** Descarga el contenido multimedia de un mensaje (imágenes en Fase 1). */
export async function downloadMedia(msg: WAMessage): Promise<Buffer> {
  const result = await downloadMediaMessage(
    msg,
    "buffer",
    {},
    { logger: baileysLog, reuploadRequest: requireSock().updateMediaMessage }
  );
  return result as Buffer;
}

/** Arranca (o re-arranca) la conexión. Idempotente frente a llamadas solapadas. */
export async function startWhatsapp(): Promise<void> {
  if (starting || shuttingDown) return;
  starting = true;
  try {
    setState("connecting");
    const { state: authState, saveCreds } = await useMultiFileAuthState(config.authDir);

    let version: [number, number, number] | undefined;
    try {
      version = (await fetchLatestBaileysVersion()).version;
    } catch {
      version = undefined; // sin red: Baileys usa su versión embebida
    }

    const s = makeWASocket({
      version,
      auth: {
        creds: authState.creds,
        keys: makeCacheableSignalKeyStore(authState.keys, baileysLog),
      },
      logger: baileysLog,
      // Nunca aparecemos "en línea": el móvil sigue recibiendo notificaciones
      // y no delatamos presencia del sidecar.
      markOnlineOnConnect: false,
      // OJO: NO activar syncFullHistory — con Baileys 6.7.x los servidores de
      // WhatsApp cortan el registro con 428 "Precondition Required" (verificado
      // 2026-07-16 con scripts/debug-wa.ts). Sin él, el emparejamiento entrega
      // igualmente el volcado de historial reciente; si algún día hace falta
      // más profundidad, existe fetchMessageHistory bajo demanda.
      //
      // Solo ignoramos NEWSLETTERS a nivel de socket. Los GRUPOS entran desde el
      // 2026-09-11 (decisión del usuario: que se parezca a WhatsApp Web). NO
      // ignoramos "todo lo que no sea @s.whatsapp.net": eso tiraba el push del
      // history-sync (que puede enrutarse por el propio JID/broadcast) y los
      // mensajes 1-a-1 con direccionamiento nuevo @lid. El filtrado fino (qué se
      // GUARDA) vive en ingestCore.ts (isStorableChatJid), no aquí.
      shouldIgnoreJid: (jid: string) => isNewsletterJid(jid),
      browser: Browsers.windows("Dashboard CSA"),
      generateHighQualityLinkPreview: false,
    });
    sock = s;

    // Guardados en fila: el reinicio del 515 espera a que el último termine,
    // para abrir el socket nuevo con las credenciales recién emparejadas.
    s.ev.on("creds.update", () => {
      guardadoCreds = guardadoCreds
        .then(() => saveCreds())
        .catch((err) => log.error({ err: (err as Error).message }, "wa: no se pudieron guardar las credenciales"));
    });
    s.ev.on("connection.update", (update) => {
      void handleConnectionUpdate(update);
    });
    for (const { event, handler } of registrations) {
      s.ev.on(event, handler as never);
    }
  } catch (err) {
    // Fallo al iniciar (red caída, auth corrupta, versión…): NO propagamos —
    // dejamos el estado en "close" y reintentamos solos con backoff. Así el
    // sidecar nunca se queda sin Baileys por un tropiezo de arranque.
    log.error({ err: (err as Error).message }, "wa: fallo al iniciar; reintento con backoff");
    setState("close");
    scheduleReconnect();
  } finally {
    starting = false;
  }
}

/**
 * Programa una reconexión. Por defecto, backoff exponencial (1 s → 60 s);
 * handleConnectionUpdate pasa lo que decida ./reconexion.ts.
 */
function scheduleReconnect(
  ms: number = reconnectDelayMs,
  siguienteMs: number = Math.min(reconnectDelayMs * 2, TOPE_BACKOFF_MS)
): void {
  if (shuttingDown) return;
  if (reconnectTimer) clearTimeout(reconnectTimer);
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    void startWhatsapp();
  }, ms);
  reconnectDelayMs = siguienteMs;
}

/**
 * Borra la sesión (data/auth) y re-arranca para forzar un QR nuevo.
 * Usado por POST /session/reset y automáticamente tras un loggedOut.
 */
export async function resetSession(): Promise<void> {
  teardownSocket();
  fs.rmSync(config.authDir, { recursive: true, force: true });
  fs.mkdirSync(config.authDir, { recursive: true });
  me = null;
  qrDataUrl = null;
  reconnectDelayMs = 1_000;
  await startWhatsapp();
}

/** Cierre ordenado del proceso (Ctrl+C / shutdown del .bat). */
export function stopWhatsapp(): void {
  shuttingDown = true;
  if (reconnectTimer) clearTimeout(reconnectTimer);
  teardownSocket();
  setState("close");
}

/* ------------------------------ internos --------------------------------- */

function requireSock(): WASocket {
  if (!sock) throw new Error("Socket WhatsApp no iniciado.");
  return sock;
}

function teardownSocket(): void {
  if (!sock) return;
  try {
    sock.ev.removeAllListeners("connection.update");
    sock.end(undefined);
  } catch {
    // el socket puede estar ya cerrado; irrelevante
  }
  sock = null;
}

async function handleConnectionUpdate(
  update: Partial<BaileysEventMap["connection.update"]>
): Promise<void> {
  const { connection, lastDisconnect, qr } = update;

  if (qr) {
    try {
      qrDataUrl = await QRCode.toDataURL(qr, { margin: 1, width: 320 });
    } catch (err) {
      log.error({ err }, "wa: error generando dataURL del QR");
      qrDataUrl = null;
    }
    setState("needs_qr");
  }

  if (connection === "open") {
    qrDataUrl = null;
    reconnectDelayMs = 1_000;
    const user = sock?.user;
    me = user ? { jid: user.id, name: user.name ?? "" } : null;
    setState("open");
    log.info({ me }, "wa: sesión abierta");
  }

  if (connection === "close") {
    const statusCode = (
      lastDisconnect?.error as { output?: { statusCode?: number } } | undefined
    )?.output?.statusCode;

    if (shuttingDown) return;

    const estadoPrevio = state;
    // Un QR de un socket cerrado ya no sirve: que la UI no lo enseñe.
    qrDataUrl = null;

    const decision = decidirCierre({
      statusCode,
      estadoPrevio,
      retrasoMs: reconnectDelayMs,
      ahoraMs: Date.now(),
      ultimoReinicioYaMs,
    });

    if (decision.accion === "reset") {
      // Desvinculado desde el móvil: las credenciales ya no valen.
      log.warn("wa: sesión desvinculada remotamente — limpiando auth y pidiendo QR nuevo");
      await resetSession();
      return;
    }

    if (decision.accion === "ya") {
      log.info({ statusCode, estadoPrevio }, "wa: WhatsApp pide reiniciar la conexión — reconecto al momento");
      if (reconnectTimer) clearTimeout(reconnectTimer);
      reconnectTimer = null;
      teardownSocket();
      ultimoReinicioYaMs = Date.now();
      await guardadoCreds;
      void startWhatsapp();
      return;
    }

    setState("close");
    log.warn({ statusCode, estadoPrevio, retryInMs: decision.ms }, "wa: conexión cerrada, reintentando");
    teardownSocket();
    scheduleReconnect(decision.ms, decision.siguienteMs);
  }
}
