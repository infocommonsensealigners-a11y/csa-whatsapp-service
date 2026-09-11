/**
 * HISTORIAL QUE MANDA EL MÓVIL (al emparejar y a demanda): capa propia, con
 * visibilidad y respaldo, encima de Baileys.
 *
 * Por qué (11-09-2026, 16:31): tras volver a vincular, el móvil mandó sus
 * mensajes de protocolo en el primer minuto (ocho, desde nuestro propio `@lid`)
 * y Baileys no emitió ni un `messaging-history.set`, sin registrar error alguno.
 * El dashboard se quedó en el 09-09 y nadie podía saber por qué: Baileys cuenta
 * lo que hace con el historial a nivel `info`, y aquí solo se enseñaba `warn+`.
 *
 * Qué hace este módulo:
 *  1. VE cada aviso de historial que pasa por `messages.upsert` y lo deja
 *     escrito en el log y en `meta` (tipo, trozo, progreso, tamaño, remitente).
 *  2. Si Baileys no entrega el volcado en `ESPERA_BAILEYS_MS`, lo DESCARGA y
 *     procesa este módulo (con tiempo límite y reintentos) por el mismo camino
 *     (`procesarVolcado`) que usa el evento de Baileys. Es idempotente: si los
 *     dos lo procesan, la segunda pasada no inserta nada.
 *  3. Solo acepta un aviso que venga de NUESTRA cuenta (fromMe, o el remitente es
 *     nuestro teléfono o nuestro `@lid`): la misma protección que aplica Baileys
 *     contra avisos falsos de terceros, que aquí se comprueba aparte.
 *  4. Lee el payload EN LÍNEA (`initialHistBootstrapInlinePayload`), que la
 *     versión instalada de Baileys ignora.
 *  5. RELLENA HUECOS: si al conectar la base tiene un silencio largo (más de
 *     `SILENCIO_HUECO_S`), pide al móvil los últimos mensajes de los chats que
 *     estaban activos antes del hueco. Empieza por UN chat; si el móvil no
 *     atiende, se para. Ritmo lento, tope de chats, una vez por conexión.
 *  6. Expone el estado para `/status`.
 *
 * Nada de aquí escribe hacia ningún contacto: son peticiones a nuestro propio
 * móvil (las mismas que hace WhatsApp Web al abrir un chat) y lecturas.
 */
import { promisify } from "node:util";
import { inflate } from "node:zlib";
import {
  downloadContentFromMessage,
  getHistoryMsg,
  processHistoryMessage,
  proto,
  type Chat,
  type Contact,
  type WAMessage,
} from "baileys";
import { getDb, setMeta } from "../db/db";
import { emitSse } from "../http/sse";
import { normalizarJid } from "./identidad";
import { applyContactNames, ingestChatShells, ingestMessages } from "./ingestCore";
import { getMe, getWaState, lookupLids, onStateChange, requestOlderHistory } from "./socket";

const inflateAsync = promisify(inflate);

/* ------------------------------- parámetros ------------------------------- */

/** Cuánto se le deja a Baileys para entregar el volcado antes de bajarlo aquí. */
export const ESPERA_BAILEYS_MS = 60_000;
/** Tiempo límite de una descarga propia. */
export const TIEMPO_DESCARGA_MS = 180_000;
/** Esperas antes de cada reintento de descarga propia. */
export const REINTENTOS_MS = [30_000, 90_000, 240_000];
/** Un silencio mayor que esto en la base al conectar se toma por hueco. */
export const SILENCIO_HUECO_S = 20 * 3600;
/** Cuánto atrás se busca ese silencio. */
export const VENTANA_SILENCIO_S = 7 * 86_400;
/** Relleno de huecos: espera tras abrir, chats como mucho, pausa entre chats y espera a la respuesta. */
export const HUECO_TRAS_ABRIR_MS = 3 * 60_000;
export const HUECO_MAX_CHATS = 40;
export const HUECO_PAUSA_MS = 4_000;
export const HUECO_ESPERA_RESPUESTA_MS = 25_000;
export const HUECO_MENSAJES_POR_CHAT = 50;

const TIPO = proto.Message.HistorySyncNotification.HistorySyncType;
/** Los mismos tipos que Baileys procesa (Defaults.PROCESSABLE_HISTORY_TYPES). */
const PROCESABLES = new Set<number>([TIPO.INITIAL_BOOTSTRAP, TIPO.PUSH_NAME, TIPO.RECENT, TIPO.FULL, TIPO.ON_DEMAND]);

export function nombreTipo(t: number | null | undefined): string {
  return typeof t === "number" ? (TIPO[t] ?? String(t)) : "?";
}

/* ----------------------------- funciones puras ----------------------------- */

/** ¿`remitente` es la misma cuenta que `yo` (por teléfono o por @lid)? Sin sufijo de dispositivo. */
export function esMismaCuenta(remitente: string | null | undefined, yo: { jid?: string | null; lid?: string | null }): boolean {
  const r = normalizarJid(remitente);
  if (!r) return false;
  const usuario = (j: string | null | undefined) => {
    const n = normalizarJid(j);
    return n ? n.slice(0, n.indexOf("@")) : "";
  };
  const u = usuario(r);
  return !!u && (u === usuario(yo.jid) || u === usuario(yo.lid));
}

/**
 * Mayor silencio entre mensajes consecutivos dentro de la ventana. Devuelve el
 * tramo [desde, hasta] (segundos) o null si no supera `minimoS`.
 */
export function mayorSilencio(tsOrdenados: number[], minimoS: number): { desde: number; hasta: number } | null {
  let mejor: { desde: number; hasta: number } | null = null;
  for (let i = 1; i < tsOrdenados.length; i++) {
    const a = tsOrdenados[i - 1];
    const b = tsOrdenados[i];
    if (b - a >= minimoS && (!mejor || b - a > mejor.hasta - mejor.desde)) mejor = { desde: a, hasta: b };
  }
  return mejor;
}

export interface Volcado {
  chats: Chat[];
  contacts: Contact[];
  messages: WAMessage[];
  syncType?: number | null;
  progress?: number | null;
  isLatest?: boolean;
}

/** Bytes de un volcado (comprimido con zlib o en claro) → chats, contactos y mensajes. */
export async function decodificarVolcado(bytes: Uint8Array): Promise<Volcado> {
  let buf = Buffer.from(bytes);
  try {
    buf = await inflateAsync(buf);
  } catch {
    // no venía comprimido: se decodifica tal cual
  }
  const sync = proto.HistorySync.decode(buf);
  const r = processHistoryMessage(sync);
  return { chats: r.chats as Chat[], contacts: r.contacts as Contact[], messages: r.messages as WAMessage[], syncType: r.syncType, progress: r.progress };
}

/* ------------------------------ estado interno ------------------------------ */

type EstadoAviso = "esperando" | "descargando" | "hecho" | "rechazado" | "agotado";
interface Aviso {
  id: string;
  hist: proto.Message.IHistorySyncNotification;
  vistoMs: number;
  intentos: number;
  estado: EstadoAviso;
  timer?: NodeJS.Timeout;
}

const avisos = new Map<string, Aviso>();
/** Volcados que Baileys entregó sin que su aviso estuviera aún registrado (llegan antes en el mismo flush). */
const volcadosSinAviso: Array<{ tipo: number | null | undefined; ms: number }> = [];
let volcados = 0;
let volcadosPropios = 0;
let ultimoVolcadoMs: number | null = null;
let ultimoAvisoMs: number | null = null;
let lidPropio: string | null = null;

export function estadoHistorial(): { lastAt: number | null; notifiedAt: number | null; pending: number; processedHere: number; total: number } {
  let pending = 0;
  for (const a of avisos.values()) if (a.estado === "esperando" || a.estado === "descargando") pending++;
  return {
    lastAt: ultimoVolcadoMs ? Math.floor(ultimoVolcadoMs / 1000) : null,
    notifiedAt: ultimoAvisoMs ? Math.floor(ultimoAvisoMs / 1000) : null,
    pending,
    processedHere: volcadosPropios,
    total: volcados,
  };
}

function yo(): { jid?: string | null; lid?: string | null } {
  const me = getMe();
  return { jid: me?.jid ?? null, lid: me?.lid ?? lidPropio };
}

/** Si Baileys no nos dio nuestro @lid al emparejar, se le pregunta a WhatsApp (consulta de solo lectura). */
async function aprenderLidPropio(): Promise<void> {
  const me = getMe();
  if (!me?.jid || me.lid || lidPropio) return;
  try {
    const r = await lookupLids([normalizarJid(me.jid)]);
    const lid = r[0]?.lid ? normalizarJid(r[0].lid) : "";
    if (lid) {
      lidPropio = lid;
      console.log(`[historial] nuestro @lid aprendido por onWhatsApp: ${lid}`);
    }
  } catch {
    // sin conexión o sin respuesta: se vuelve a intentar en la siguiente apertura
  }
}

/* --------------------------- procesar un volcado --------------------------- */

/**
 * ÚNICO camino por el que un volcado entra en la base, venga del evento de
 * Baileys o de nuestra descarga. Contactos y chats primero (identidad
 * teléfono↔LID), luego los mensajes en modo `history` (sin media, sin campañas).
 */
export function procesarVolcado(v: Volcado, origen: "baileys" | "propio"): { chats: number; conMensajes: number } {
  applyContactNames(v.contacts ?? [], false);
  const shells = ingestChatShells(v.chats ?? []);
  const r = ingestMessages(v.messages ?? [], { modo: "history" });
  const ahora = Date.now();
  volcados++;
  if (origen === "propio") volcadosPropios++;
  ultimoVolcadoMs = ahora;
  setMeta("last_history_sync", String(Math.floor(ahora / 1000)));
  console.log(
    `[historial] volcado (${origen}) tipo=${nombreTipo(v.syncType)} progreso=${v.progress ?? "-"} ` +
      `chats=${(v.chats ?? []).length} contactos=${(v.contacts ?? []).length} mensajes=${(v.messages ?? []).length} ` +
      `→ chatsGuardados=${shells} chatsConMensajesNuevos=${r.touched.size}`
  );
  emitSse({ type: "chats.synced" });
  if (origen === "baileys") cerrarAvisoPendiente(v.syncType);
  return { chats: shells, conMensajes: r.touched.size };
}

/** Un volcado de Baileys da por hecho el aviso pendiente más antiguo de su tipo (Baileys no dice cuál era). */
function cerrarAvisoPendiente(tipo: number | null | undefined): void {
  let candidato: Aviso | null = null;
  for (const a of avisos.values()) {
    if (a.estado !== "esperando") continue;
    if (typeof tipo === "number" && a.hist.syncType !== tipo) continue;
    if (!candidato || a.vistoMs < candidato.vistoMs) candidato = a;
  }
  if (!candidato) {
    // Baileys entrega el volcado ANTES de que veamos su aviso (mismo flush): se anota para casarlo después.
    volcadosSinAviso.push({ tipo, ms: Date.now() });
    return;
  }
  if (candidato.timer) clearTimeout(candidato.timer);
  candidato.estado = "hecho";
}

/* ----------------------------- ver los avisos ----------------------------- */

/**
 * Se llama con CADA mensaje que pasa por `messages.upsert`. Devuelve true si
 * era un mensaje de protocolo de nuestra cuenta (aviso de historial u otro),
 * para que la ingesta no lo cuente como «mensaje sin guardar».
 */
export function verMensajeDeProtocolo(msg: WAMessage): boolean {
  if (!msg.message) return false;
  const proto_ = msg.message.protocolMessage ?? msg.message.ephemeralMessage?.message?.protocolMessage ?? null;
  const hist = getHistoryMsg(msg.message);
  if (!hist && !proto_) return false;

  const remitente = normalizarJid(msg.key?.participant ?? msg.key?.remoteJid);
  const propio = !!msg.key?.fromMe || esMismaCuenta(remitente, yo());

  if (!hist) {
    if (propio) {
      const t = proto_?.type;
      const nombre = typeof t === "number" ? (proto.Message.ProtocolMessage.Type[t] ?? String(t)) : "?";
      console.log(`[historial] protocolo del móvil: ${nombre}`);
    }
    return propio;
  }

  const id = msg.key?.id ?? `sin-id-${Date.now()}`;
  const bytes = Number(hist.fileLength ?? 0) || 0;
  const enLinea = !!hist.initialHistBootstrapInlinePayload?.length;
  ultimoAvisoMs = Date.now();
  setMeta("history_notified_at", String(Math.floor(ultimoAvisoMs / 1000)));
  console.log(
    `[historial] aviso del móvil: tipo=${nombreTipo(hist.syncType)} trozo=${hist.chunkOrder ?? "-"} ` +
      `progreso=${hist.progress ?? "-"} bytes=${bytes} enLinea=${enLinea} fromMe=${!!msg.key?.fromMe} propio=${propio} id=${id}`
  );
  if (avisos.has(id)) return true;

  if (!propio) {
    console.warn(`[historial] aviso IGNORADO: no viene de nuestra cuenta (${remitente || "?"})`);
    avisos.set(id, { id, hist, vistoMs: Date.now(), intentos: 0, estado: "rechazado" });
    return true;
  }
  if (!PROCESABLES.has(hist.syncType ?? -1)) {
    console.log(`[historial] aviso de tipo ${nombreTipo(hist.syncType)}: no lleva chats ni mensajes, se deja pasar`);
    avisos.set(id, { id, hist, vistoMs: Date.now(), intentos: 0, estado: "hecho" });
    return true;
  }

  const aviso: Aviso = { id, hist, vistoMs: Date.now(), intentos: 0, estado: "esperando" };
  avisos.set(id, aviso);

  // ¿Baileys ya entregó este volcado hace un momento? Entonces no hay nada que descargar.
  const i = volcadosSinAviso.findIndex((v) => Date.now() - v.ms < 120_000 && (v.tipo == null || v.tipo === hist.syncType));
  if (i >= 0) {
    volcadosSinAviso.splice(i, 1);
    aviso.estado = "hecho";
    return true;
  }
  aviso.timer = setTimeout(() => void descargarPorNuestraCuenta(aviso), ESPERA_BAILEYS_MS);
  return true;
}

async function descargarPorNuestraCuenta(aviso: Aviso): Promise<void> {
  if (aviso.estado !== "esperando") return;
  aviso.estado = "descargando";
  aviso.intentos++;
  console.log(
    `[historial] Baileys no ha entregado el volcado del aviso ${aviso.id} (${nombreTipo(aviso.hist.syncType)}) ` +
      `en ${Math.round(ESPERA_BAILEYS_MS / 1000)} s: lo descargo aquí (intento ${aviso.intentos})`
  );
  try {
    const bytes = await bajarBytes(aviso.hist);
    const v = await decodificarVolcado(bytes);
    procesarVolcado(v, "propio");
    aviso.estado = "hecho";
  } catch (e) {
    console.error(`[historial] descarga propia falló (${aviso.id}, intento ${aviso.intentos}): ${(e as Error).message}`);
    const espera = REINTENTOS_MS[aviso.intentos - 1];
    if (espera === undefined) {
      aviso.estado = "agotado";
      return;
    }
    aviso.estado = "esperando";
    aviso.timer = setTimeout(() => void descargarPorNuestraCuenta(aviso), espera);
  }
}

/** Payload en línea si lo hay; si no, descarga del CDN de WhatsApp con tiempo límite. */
async function bajarBytes(hist: proto.Message.IHistorySyncNotification): Promise<Uint8Array> {
  if (hist.initialHistBootstrapInlinePayload?.length) return hist.initialHistBootstrapInlinePayload;
  const tope = new Promise<never>((_, rej) => setTimeout(() => rej(new Error(`descarga sin terminar en ${TIEMPO_DESCARGA_MS / 1000} s`)), TIEMPO_DESCARGA_MS));
  const descarga = (async () => {
    const stream = await downloadContentFromMessage(
      { mediaKey: hist.mediaKey ?? undefined, directPath: hist.directPath ?? undefined },
      "md-msg-hist",
      { options: { timeout: TIEMPO_DESCARGA_MS } }
    );
    const trozos: Buffer[] = [];
    for await (const chunk of stream) trozos.push(chunk as Buffer);
    return Buffer.concat(trozos);
  })();
  return Promise.race([descarga, tope]);
}

/* ------------------------------ relleno de huecos ------------------------------ */

let huecoEnCurso = false;
let huecoHecho = false;

/**
 * Silencio largo en la base (los días que estuvimos desvinculados). Se busca
 * entre los mensajes de la última semana, sin contar los de grupos.
 */
export function detectarHueco(): { desde: number; hasta: number } | null {
  const ahora = Math.floor(Date.now() / 1000);
  const filas = getDb()
    .prepare(`SELECT DISTINCT ts FROM messages WHERE ts >= ? AND chat_jid NOT LIKE '%@g.us' ORDER BY ts ASC`)
    .all(ahora - VENTANA_SILENCIO_S) as Array<{ ts: number }>;
  return mayorSilencio(filas.map((f) => f.ts), SILENCIO_HUECO_S);
}

function mensajesEnTramo(jid: string, desde: number, hasta: number): number {
  return (getDb().prepare(`SELECT COUNT(*) AS n FROM messages WHERE chat_jid = ? AND ts > ? AND ts < ?`).get(jid, desde, hasta) as { n: number }).n;
}

const dormir = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** Pide al móvil los últimos N mensajes del chat con el ancla dada y espera a ver si entra algo en el hueco. */
async function pedirYEsperar(jid: string, ancla: { id: string; fromMe: boolean }, hueco: { desde: number; hasta: number }): Promise<boolean> {
  const antes = mensajesEnTramo(jid, hueco.desde, hueco.hasta);
  const ok = await requestOlderHistory({ remoteJid: jid, id: ancla.id, fromMe: ancla.fromMe }, Math.floor(Date.now() / 1000), HUECO_MENSAJES_POR_CHAT);
  if (!ok) return false;
  const limite = Date.now() + HUECO_ESPERA_RESPUESTA_MS;
  while (Date.now() < limite) {
    await dormir(1_000);
    if (mensajesEnTramo(jid, hueco.desde, hueco.hasta) > antes) return true;
  }
  return false;
}

/**
 * Relleno de huecos, una vez por conexión. Empieza por un solo chat: prueba el
 * ancla real (nuestro último mensaje del chat, con la hora de ahora) y, si el
 * móvil no responde, un ancla sintética. Si tampoco, se para y lo deja escrito.
 */
export async function rellenarHueco(motivo: string): Promise<void> {
  if (huecoEnCurso || huecoHecho) return;
  if (getWaState() !== "open") return;
  const hueco = detectarHueco();
  if (!hueco) {
    console.log(`[historial] sin hueco que rellenar (${motivo}): ningún silencio de más de ${SILENCIO_HUECO_S / 3600} h en la última semana`);
    huecoHecho = true;
    return;
  }
  huecoEnCurso = true;
  const f = (s: number) => new Date(s * 1000).toISOString().slice(0, 16).replace("T", " ");
  console.log(`[historial] hueco detectado (${motivo}): ${f(hueco.desde)} → ${f(hueco.hasta)} UTC. Pido al móvil los chats activos antes del hueco.`);
  try {
    const db = getDb();
    const candidatos = db
      .prepare(
        `SELECT c.jid, m.id AS ultimo_id, m.from_me AS ultimo_from_me
           FROM chats c
           JOIN messages m ON m.chat_jid = c.jid
          WHERE c.ignored = 0 AND c.alias_of IS NULL AND c.deleted_at IS NULL
            AND c.jid NOT LIKE '%@g.us'
            AND m.ts = (SELECT MAX(ts) FROM messages WHERE chat_jid = c.jid AND ts <= ?)
            AND m.ts >= ?
            AND NOT EXISTS (SELECT 1 FROM messages x WHERE x.chat_jid = c.jid AND x.ts > ? AND x.ts < ?)
          ORDER BY m.ts DESC
          LIMIT ?`
      )
      .all(hueco.desde, hueco.desde - 14 * 86_400, hueco.desde, hueco.hasta, HUECO_MAX_CHATS) as Array<{ jid: string; ultimo_id: string; ultimo_from_me: number }>;
    if (!candidatos.length) {
      console.log("[historial] hueco: ningún chat activo antes del hueco sin mensajes dentro de él; nada que pedir");
      huecoHecho = true;
      return;
    }
    // Sonda: un solo chat, dos anclas.
    const sonda = candidatos[0];
    let modo: "real" | "sintetica" | null = null;
    if (await pedirYEsperar(sonda.jid, { id: sonda.ultimo_id, fromMe: sonda.ultimo_from_me === 1 }, hueco)) modo = "real";
    else if (await pedirYEsperar(sonda.jid, { id: `DASHBOARD${Date.now().toString(16).toUpperCase()}`, fromMe: false }, hueco)) modo = "sintetica";
    if (!modo) {
      console.log(`[historial] hueco: el móvil no devolvió nada para ${sonda.jid} con ninguna ancla. No se insiste; el volcado del emparejamiento es el camino.`);
      huecoHecho = true;
      return;
    }
    console.log(`[historial] hueco: el móvil atiende con ancla ${modo}. Sigo con ${candidatos.length - 1} chats más, uno cada ${HUECO_PAUSA_MS / 1000} s.`);
    let rellenados = 1;
    for (const c of candidatos.slice(1)) {
      if (getWaState() !== "open") break;
      await dormir(HUECO_PAUSA_MS);
      const ancla = modo === "real" ? { id: c.ultimo_id, fromMe: c.ultimo_from_me === 1 } : { id: `DASHBOARD${Date.now().toString(16).toUpperCase()}`, fromMe: false };
      if (await pedirYEsperar(c.jid, ancla, hueco)) rellenados++;
    }
    console.log(`[historial] hueco: ${rellenados}/${candidatos.length} chats con mensajes nuevos dentro del hueco`);
    huecoHecho = true;
  } catch (e) {
    console.error("[historial] relleno de huecos falló:", (e as Error).message);
  } finally {
    huecoEnCurso = false;
  }
}

/* --------------------------------- arranque --------------------------------- */

let vigiladoTimer: NodeJS.Timeout | null = null;
let huecoTimer: NodeJS.Timeout | null = null;
let huboQr = false;

/** Engancha la vigilancia al ciclo de conexión. Se llama una vez desde registerIngest. */
export function vigilarHistorial(): void {
  onStateChange((s) => {
    if (s === "needs_qr") huboQr = true;
    if (s !== "open") return;
    void aprenderLidPropio();
    const fila = getDb().prepare(`SELECT MAX(ts) AS t FROM messages`).get() as { t: number | null };
    const ultimo = fila.t ? new Date(fila.t * 1000).toISOString().slice(0, 16).replace("T", " ") : "—";
    if (huboQr) {
      huboQr = false;
      console.log(`[historial] emparejado de nuevo: la base llega hasta ${ultimo} UTC. El móvil debe mandar ahora su volcado; conviene dejar WhatsApp abierto en el móvil unos minutos.`);
      if (vigiladoTimer) clearTimeout(vigiladoTimer);
      vigiladoTimer = setTimeout(() => {
        if (!ultimoAvisoMs || Date.now() - ultimoAvisoMs > HUECO_TRAS_ABRIR_MS) {
          console.warn("[historial] ⚠️ 3 min tras emparejar sin ningún aviso de historial del móvil. Abre WhatsApp en el móvil y déjalo en primer plano.");
        }
      }, HUECO_TRAS_ABRIR_MS);
    } else {
      console.log(`[historial] conectado: la base llega hasta ${ultimo} UTC`);
    }
    if (huecoTimer) clearTimeout(huecoTimer);
    huecoTimer = setTimeout(() => void rellenarHueco(huboQr ? "tras emparejar" : "al conectar"), HUECO_TRAS_ABRIR_MS);
  });
}
