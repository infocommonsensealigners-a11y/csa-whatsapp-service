/**
 * Avatares bajo demanda: GET /avatars/:jid sirve la foto de perfil desde disco;
 * si falta o está caducada (7 días) y hay sesión abierta, la descarga primero.
 * Anti-flood: dedup de peticiones en vuelo + caché negativa 6 h (contactos sin
 * foto o con foto restringida) — así la UI puede pedir avatares alegremente.
 */
import type { FastifyInstance } from "fastify";
import fs from "node:fs";
import path from "node:path";
import { config } from "../../config";
import { getDb } from "../../db/db";
import { fetchProfilePicture, getWaState } from "../../wa/socket";

const FRESH_S = 7 * 24 * 3600;
const NEGATIVE_TTL_MS = 6 * 3600 * 1000;

const inflight = new Map<string, Promise<string | null>>();
const negativeCache = new Map<string, number>();

function avatarFile(jid: string): string {
  return path.join(config.avatarsDir, `${jid.replace(/[^a-zA-Z0-9]/g, "_")}.jpg`);
}

async function ensureAvatar(jid: string): Promise<string | null> {
  // Foto ya presente en el volumen (migrada/subida): sírvela directamente por su
  // nombre determinista, sin depender del avatar_path de la BD (que tras una
  // migración puede apuntar a rutas locales antiguas). Esto hace que los avatares
  // subidos al volumen /data/avatars se vean aunque Baileys esté apagado.
  const localFile = avatarFile(jid);
  if (fs.existsSync(localFile)) return localFile;

  const db = getDb();
  const row = db
    .prepare("SELECT avatar_path, avatar_fetched_at FROM chats WHERE jid = ?")
    .get(jid) as { avatar_path: string | null; avatar_fetched_at: number | null } | undefined;
  const nowS = Math.floor(Date.now() / 1000);

  if (
    row?.avatar_path &&
    fs.existsSync(row.avatar_path) &&
    row.avatar_fetched_at &&
    nowS - row.avatar_fetched_at < FRESH_S
  ) {
    return row.avatar_path;
  }

  const negativeAt = negativeCache.get(jid);
  if (negativeAt && Date.now() - negativeAt < NEGATIVE_TTL_MS) {
    // Sin foto hace poco: sirve la caducada si existe, antes que re-pedir.
    return row?.avatar_path && fs.existsSync(row.avatar_path) ? row.avatar_path : null;
  }
  if (getWaState() !== "open") {
    return row?.avatar_path && fs.existsSync(row.avatar_path) ? row.avatar_path : null;
  }

  const existing = inflight.get(jid);
  if (existing) return existing;

  const task = (async (): Promise<string | null> => {
    try {
      const url = await fetchProfilePicture(jid);
      if (!url) {
        negativeCache.set(jid, Date.now());
        return row?.avatar_path && fs.existsSync(row.avatar_path) ? row.avatar_path : null;
      }
      const res = await fetch(url);
      if (!res.ok) {
        // Fallo puntual DESCARGANDO la imagen (no "sin foto"): nunca debe
        // devolver null si ya había una foto buena cacheada — se sirve esa
        // (regla: la foto solo se suma/actualiza, nunca desaparece).
        negativeCache.set(jid, Date.now());
        return row?.avatar_path && fs.existsSync(row.avatar_path) ? row.avatar_path : null;
      }
      const buf = Buffer.from(await res.arrayBuffer());
      const file = avatarFile(jid);
      fs.writeFileSync(file, buf);
      db.prepare(
        "UPDATE chats SET avatar_path = ?, avatar_fetched_at = ?, updated_at = ? WHERE jid = ?"
      ).run(file, nowS, nowS, jid);
      return file;
    } catch {
      negativeCache.set(jid, Date.now());
      return null;
    } finally {
      inflight.delete(jid);
    }
  })();
  inflight.set(jid, task);
  return task;
}

export function registerAvatarRoutes(app: FastifyInstance): void {
  app.get("/avatars/:jid", async (request, reply) => {
    const { jid } = request.params as { jid: string };
    const file = await ensureAvatar(jid);
    if (!file) return reply.status(404).send();
    reply.header("cache-control", "private, max-age=3600");
    return reply.type("image/jpeg").send(fs.createReadStream(file));
  });
}
