/**
 * GET /media/:jid/:id — sirve el binario de un mensaje multimedia ya descargado
 * (`messages.media_path`). Mismo patrón que `avatars.ts` pero con RANGE: sin él
 * el `<audio>`/`<video>` del navegador no puede hacer seek ni reproducir bien.
 *
 * Solo lectura: no descarga nada aquí (eso lo hace `ingest.ts` al llegar el
 * mensaje). Si `media_path` es NULL —no descargado, purgado por cuota, o
 * histórico sin claves— responde 404 y la UI se queda con la etiqueta.
 */
import type { FastifyInstance } from "fastify";
import fs from "node:fs";
import { getDb } from "../../db/db";

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
}
