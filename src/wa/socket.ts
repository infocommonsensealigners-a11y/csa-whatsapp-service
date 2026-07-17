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
 * Ciclo de vida de la conexión:
 *  - QR nuevo → estado "needs_qr" + dataURL disponible para la UI.
 *  - Cierre recuperable (timeout, restartRequired tras escanear, red) →
 *    reconexión con backoff exponencial 1 s → 60 s.
 *  - loggedOut (desvinculado desde el móvil) → se limpia data/auth y se
 *    arranca de cero, lo que produce un QR fresco.
 */
import makeWASocket, {
  DisconnectReason,
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
import type { WaConnectionState } from "../../../shared/whatsapp-contracts";

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
      // Solo ignoramos GRUPOS y NEWSLETTERS a nivel de socket. NO ignoramos
      // "todo lo que no sea @s.whatsapp.net": eso tiraba el push del history-sync
      // (que puede enrutarse por el propio JID/broadcast) y los mensajes 1-a-1
      // con direccionamiento nuevo @lid. El filtrado fino (qué se GUARDA) vive en
      // ingest.ts (isStorableChatJid), no aquí.
      shouldIgnoreJid: (jid: string) => isGroupJid(jid) || isNewsletterJid(jid),
      browser: Browsers.windows("Dashboard CSA"),
      generateHighQualityLinkPreview: false,
    });
    sock = s;

    s.ev.on("creds.update", saveCreds);
    s.ev.on("connection.update", (update) => {
      void handleConnectionUpdate(update);
    });
    for (const { event, handler } of registrations) {
      s.ev.on(event, handler as never);
    }
  } finally {
    starting = false;
  }
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

    if (statusCode === DisconnectReason.loggedOut) {
      // Desvinculado desde el móvil: las credenciales ya no valen.
      log.warn("wa: sesión desvinculada remotamente — limpiando auth y pidiendo QR nuevo");
      await resetSession();
      return;
    }

    setState("close");
    log.warn({ statusCode, retryInMs: reconnectDelayMs }, "wa: conexión cerrada, reintentando");
    teardownSocket();
    if (reconnectTimer) clearTimeout(reconnectTimer);
    reconnectTimer = setTimeout(() => {
      void startWhatsapp();
    }, reconnectDelayMs);
    reconnectDelayMs = Math.min(reconnectDelayMs * 2, 60_000);
  }
}
