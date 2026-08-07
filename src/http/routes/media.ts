/**
 * GET  /media/:jid/:id       — sirve el binario ya descargado (`messages.media_path`).
 * POST /media/:jid/:id/fetch — DESCARGA BAJO DEMANDA: recupera el binario de un
 *                              mensaje que nunca se bajó, si aún tiene claves.
 *
 * El GET mantiene RANGE: sin él el `<audio>`/`<video>` del navegador no puede
 * hacer seek. Si `media_path` es NULL —no descargado, purgado por cuota, o
 * histórico sin claves— responde 404 y la UI se queda con la etiqueta.
 *
 * POR QUÉ EXISTE EL /fetch (auditoría 2026-08-07): la descarga automática solo
 * corre para el tráfico EN VIVO (`ingest.ts`), así que 3.522 mensajes de media
 * del histórico nacieron sin binario. Bajarlos todos de golpe es imposible
 * (~5,4 GB contra una cuota de 300 MB en un volumen de 500 MB compartido con
 * wa.sqlite3), pero UNO cuando el usuario lo pide sí cabe. Requisito: tener
 * `raw_json`, que es donde viven mediaKey/directPath — solo se guarda desde el
 * 17-07-2026, así que para lo anterior la respuesta honesta es "sin-claves".
 */
import type { FastifyInstance } from "fastify";
import type { WAMessage } from "baileys";
import fs from "node:fs";
import { getDb } from "../../db/db";
import { downloadMedia, getWaState } from "../../wa/socket";
import { saveMediaBuffer, MEDIA_MAX_BYTES } from "../../wa/mediaStore";

interface MediaRow {
  media_path: string | null;
  media_mime: string | null;
  type: string;
  text: string | null;
}

/** Nombre de descarga: usa el de WhatsApp si se capturó (documentos), si no un genérico por tipo. */
function fileNameFor(row: MediaRow, id: string): string {
  const fromText = row.type === "document" ? row.text?.match(/^[^\n]{1,100}\.[a-z0-9]{2,5}$/i)?.[0] : null;
  if (fromText) return fromText;
  const ext = row.media_path?.match(/\.([a-z0-9]+)$/i)?.[1] ?? "bin";
  return `${row.type}-${id.slice(0, 12)}.${ext}`;
}

export function registerMediaRoutes(app: FastifyInstance): void {
  app.get("/media/:jid/:id", async (request, reply) => {
    const { jid, id } = request.params as { jid: string; id: string };
    const row = getDb()
      .prepare(`SELECT media_path, media_mime, type, text FROM messages WHERE chat_jid = ? AND id = ?`)
      .get(jid, id) as MediaRow | undefined;
    if (!row?.media_path || !fs.existsSync(row.media_path)) return reply.status(404).send();

    const stat = fs.statSync(row.media_path);
    const mime = row.media_mime ?? "application/octet-stream";
    // Documentos siempre a descargar; imagen/audio/vídeo inline (se ven/oyen en
    // la propia burbuja); el nombre de fichero viaja siempre, por si el usuario
    // decide "Guardar como" también en una foto.
    const disposition = row.type === "document" ? "attachment" : "inline";
    reply.header("content-disposition", `${disposition}; filename="${fileNameFor(row, id).replace(/"/g, "")}"`);
    reply.header("cache-control", "private, max-age=31536000, immutable"); // el binario de un mensaje no cambia nunca
    reply.header("accept-ranges", "bytes");

    const range = request.headers.range;
    if (range) {
      const m = /^bytes=(\d*)-(\d*)$/.exec(range);
      if (m) {
        const start = m[1] ? Number.parseInt(m[1], 10) : 0;
        const end = m[2] ? Number.parseInt(m[2], 10) : stat.size - 1;
        if (Number.isFinite(start) && Number.isFinite(end) && start <= end && end < stat.size) {
          reply
            .status(206)
            .header("content-range", `bytes ${start}-${end}/${stat.size}`)
            .header("content-length", String(end - start + 1))
            .type(mime);
          return reply.send(fs.createReadStream(row.media_path, { start, end }));
        }
      }
      // Range mal formado o fuera de rango: cae al 200 completo de abajo.
    }
    reply.header("content-length", String(stat.size)).type(mime);
    return reply.send(fs.createReadStream(row.media_path));
  });

  /* ------------------ POST /media/:jid/:id/fetch (bajo demanda) ------------------ */

  app.post("/media/:jid/:id/fetch", async (request, reply) => {
    const { jid, id } = request.params as { jid: string; id: string };
    const db = getDb();
    const row = db
      .prepare(`SELECT media_path, media_mime, type, text, raw_json FROM messages WHERE chat_jid = ? AND id = ?`)
      .get(jid, id) as (MediaRow & { raw_json: string | null }) | undefined;

    if (!row) return reply.status(404).send({ ok: false, error: "no-existe" });
    // Idempotente: si el fichero sigue ahí no se toca la red ni la cuota. Se
    // comprueba en disco además de en BD porque la purga LRU borra ficheros sin
    // limpiar `media_path` (mediaStore.ts): la fila puede mentir.
    if (row.media_path && fs.existsSync(row.media_path)) return { ok: true, ya: true };
    if (row.type === "text" || row.type === "other") {
      return reply.status(409).send({ ok: false, error: "sin-media" });
    }
    // Caso MAYORITARIO (98,6% del histórico): sin `raw_json` no hay mediaKey ni
    // directPath, y sin eso el binario es matemáticamente irrecuperable. Se
    // corta aquí, antes de mirar la conexión, para que la UI pueda decirlo sin
    // hacer esperar a nadie.
    if (!row.raw_json) return reply.status(409).send({ ok: false, error: "sin-claves" });
    if (getWaState() !== "open") return reply.status(503).send({ ok: false, error: "sin-conexion" });

    let msg: WAMessage;
    try {
      msg = JSON.parse(row.raw_json) as WAMessage;
    } catch {
      return reply.status(409).send({ ok: false, error: "sin-claves" }); // raw_json corrupto: mismo final práctico
    }
    const meta = metaDeMedia(msg);
    if (!meta) return reply.status(409).send({ ok: false, error: "sin-claves" });
    rellenaUrlAusente(msg);
    // El cupo se consume AQUÍ, no antes: los descartes de arriba no tocan la red,
    // y quemar turno con ellos haría que una lista con muchos mensajes viejos
    // dejase sin cupo a las descargas que sí iban a salir.
    if (!tomarTurnoDeRitmo()) return reply.status(429).send({ ok: false, error: "demasiadas-peticiones" });

    try {
      // Serializado: una descarga a la vez en todo el proceso (misma decisión
      // que `downloadAndAttachMedia` en ingest.ts). Abrir N descargas contra el
      // socket de Baileys en paralelo es la forma rápida de que WhatsApp corte
      // la sesión, y encima cada una puede pesar hasta MEDIA_MAX_BYTES.
      // Deduplicado por mensaje ADEMÁS de la cola: el usuario pulsa dos veces, o
      // dos pestañas piden la misma foto. Sin esto se bajaría el mismo binario
      // dos veces (cupo y ancho de banda tirados) y se escribiría el fichero
      // encima de sí mismo mientras la otra copia lo estaba leyendo.
      const buf = await unaVezPorMensaje(`${jid}|${id}`, () => enCola(() => downloadMedia(msg)));
      // Un binario vacío se guardaría igual y la comprobación de idempotencia lo
      // daría por bueno PARA SIEMPRE: la burbuja quedaría con una foto rota y sin
      // forma de reintentar. Mejor fallar y dejar que se vuelva a pulsar.
      if (!buf || buf.byteLength === 0) return reply.status(502).send({ ok: false, error: "fallo-descarga" });
      // Se mira el tope ANTES de guardar para no confundir dos cosas distintas:
      // saveMediaBuffer devuelve null tanto si el fichero es enorme como si el
      // volumen está lleno o el disco falla, y decirle al usuario "demasiado
      // grande" cuando lo que pasa es que no queda sitio le manda a buscar donde
      // no es.
      if (buf.byteLength > MEDIA_MAX_BYTES) {
        return reply.status(413).send({ ok: false, error: "demasiado-grande" });
      }
      const file = saveMediaBuffer(jid, id, meta.mimetype, buf, meta.fileName);
      if (!file) return reply.status(507).send({ ok: false, error: "fallo-guardado" });
      db.prepare(`UPDATE messages SET media_path = ?, media_mime = ? WHERE chat_jid = ? AND id = ?`).run(
        file,
        meta.mimetype,
        jid,
        id
      );
      return { ok: true };
    } catch (e) {
      // Ojo: aquí puede llegar cualquier cosa (Boom, AxiosError, y en un mal día
      // un `null`), así que nada de `(e as Error).message` a pelo — reventaría
      // dentro del propio catch y Fastify devolvería un 500 sin explicación.
      const msgErr = String((e as Error | null)?.message ?? e ?? "");
      // WhatsApp borra el binario de sus CDN a las pocas semanas. Cuando ya no
      // está, Baileys pide un reenvío al móvil de Fran y, si tampoco lo tiene,
      // el fallo vuelve como 404/410/itemNotFound. NO es "sin-claves": las
      // claves estaban bien, lo que falta es el fichero al otro lado.
      // El guion importa: Baileys lanza literalmente "Media re-upload failed by
      // device" (messages-send.js), así que un `/reupload/` a secas NO casaba y
      // el caso más típico —móvil de Fran sin el fichero— caía al 502 genérico.
      const caducado =
        /\b(404|410)\b|not[- ]?found|itemNotFound|no longer|expired|re-?upload|invalid media status/i.test(msgErr);
      if (caducado) return reply.status(410).send({ ok: false, error: "caducado" });
      // Baileys usa estos dos textos cuando el nodo de media no le sirve: no es
      // un fallo de red, es que las claves no valen. Mismo final que sin-claves,
      // y así la UI no invita a reintentar algo que nunca va a salir.
      if (/is not a media message|No message present|empty media key/i.test(msgErr)) {
        return reply.status(409).send({ ok: false, error: "sin-claves" });
      }
      console.error(`[media] /fetch falló ${jid}/${id}:`, msgErr);
      return reply.status(502).send({ ok: false, error: "fallo-descarga" });
    }
  });
}

/* ------------------------------- protecciones ------------------------------- */

/**
 * Límite de ritmo global muy simple (ventana deslizante en memoria). Esta ruta
 * es la única del sidecar que provoca tráfico saliente hacia el CDN de WhatsApp
 * a petición del navegador: un bucle de clics —o una lista que se re-renderice
 * mal— podría lanzar cientos de descargas y llenar el volumen o quemar la
 * sesión. No hace falta nada fino: el uso legítimo es "un humano pulsa un
 * botón", y 30 descargas por minuto sobran de largo.
 */
const RITMO_MAX = Number(process.env.WA_MEDIA_FETCH_POR_MINUTO) || 30;
const marcasDeTiempo: number[] = [];

function tomarTurnoDeRitmo(): boolean {
  const ahora = Date.now();
  while (marcasDeTiempo.length > 0 && ahora - marcasDeTiempo[0] > 60_000) marcasDeTiempo.shift();
  if (marcasDeTiempo.length >= RITMO_MAX) return false;
  marcasDeTiempo.push(ahora);
  return true;
}

/** Cola de UN hueco: las peticiones simultáneas se encadenan en vez de solaparse. */
let cola: Promise<unknown> = Promise.resolve();

function enCola<T>(tarea: () => Promise<T>): Promise<T> {
  // El `catch` del eslabón anterior es imprescindible: sin él, una descarga
  // fallida dejaría la cadena rechazada y envenenaría todas las siguientes.
  const siguiente = cola.then(tarea, tarea);
  cola = siguiente.catch(() => undefined);
  return siguiente;
}

/**
 * Devuelve el nodo de media de dentro del mensaje, desenvolviendo los mismos
 * wrappers que `ingest.ts` (efímero, ver-una-vez, documento con pie de foto).
 */
function nodoDeMedia(msg: WAMessage): Record<string, unknown> | null {
  const m = msg.message;
  if (!m) return null;
  const inner =
    m.ephemeralMessage?.message ??
    m.viewOnceMessage?.message ??
    m.viewOnceMessageV2?.message ??
    m.documentWithCaptionMessage?.message ??
    m;
  const nodo =
    inner.imageMessage ?? inner.videoMessage ?? inner.audioMessage ?? inner.documentMessage ?? inner.stickerMessage;
  return (nodo as Record<string, unknown> | null | undefined) ?? null;
}

/**
 * TRAMPA del viaje por JSON: protobuf omite los campos vacíos al serializar, así
 * que un mensaje cuyo `url` venía en blanco (pasa con parte del history-sync)
 * pierde la CLAVE entera en `raw_json`. Y Baileys comprueba `'url' in media`
 * antes de nada: sin esa clave lanza «is not a media message» aunque el
 * `directPath` —que es lo que de verdad usa para construir la URL— esté
 * perfecto. Reponer la clave vacía basta para que caiga al camino del
 * directPath. No se toca si ya viene con url.
 */
function rellenaUrlAusente(msg: WAMessage): void {
  const nodo = nodoDeMedia(msg);
  if (nodo && !("url" in nodo) && typeof nodo.directPath === "string") nodo.url = "";
}

/**
 * Una sola descarga en vuelo por mensaje: las peticiones repetidas del MISMO
 * `jid|id` comparten la promesa en vez de encolar copias. El mapa se limpia
 * siempre (finally), también si falló, para que un reintento posterior no se
 * quede pegado a un fallo antiguo.
 */
const enVuelo = new Map<string, Promise<Buffer>>();

function unaVezPorMensaje(clave: string, tarea: () => Promise<Buffer>): Promise<Buffer> {
  const yaVa = enVuelo.get(clave);
  if (yaVa) return yaVa;
  const p = tarea().finally(() => enVuelo.delete(clave));
  enVuelo.set(clave, p);
  return p;
}

/** Mimetype y nombre del adjunto dentro del WAMessage, desenvolviendo los mismos
 *  wrappers que `ingest.ts` (efímero, ver-una-vez, documento con pie de foto). */
function metaDeMedia(msg: WAMessage): { mimetype: string | null; fileName: string | null } | null {
  const m = msg.message;
  if (!m) return null;
  const inner =
    m.ephemeralMessage?.message ??
    m.viewOnceMessage?.message ??
    m.viewOnceMessageV2?.message ??
    m.documentWithCaptionMessage?.message ??
    m;
  if (inner.imageMessage) return { mimetype: inner.imageMessage.mimetype ?? null, fileName: null };
  if (inner.videoMessage) return { mimetype: inner.videoMessage.mimetype ?? null, fileName: null };
  if (inner.audioMessage) return { mimetype: inner.audioMessage.mimetype ?? null, fileName: null };
  if (inner.documentMessage) {
    return {
      mimetype: inner.documentMessage.mimetype ?? null,
      fileName: inner.documentMessage.fileName ?? null,
    };
  }
  if (inner.stickerMessage) return { mimetype: inner.stickerMessage.mimetype ?? null, fileName: null };
  return null;
}
