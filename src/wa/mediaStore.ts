/**
 * Almacén de MEDIA en el volumen (`config.mediaDir`), con cuota.
 *
 * ⚠️ POR QUÉ HAY CUOTA (auditoría 2026-08-06): el volumen son 500 MB y ya carga
 * `wa.sqlite3` (~17 MB), su WAL, `avatars/` (~21 MB) y `auth/` (el emparejamiento
 * de Baileys — si se llena el volumen, SQLite deja de poder escribir y también
 * se cae la ingesta de mensajes, no solo la media). Sin tope, los documentos
 * (2.115 en el histórico) por sí solos podrían superar los 500 MB.
 *
 * Política: tope por fichero (`MEDIA_MAX_BYTES`) y cuota total del directorio
 * (`MEDIA_QUOTA_BYTES`, purga LRU por fecha de modificación antes de escribir
 * uno nuevo). Ambos ajustables por env sin tocar código.
 */
import fs from "node:fs";
import path from "node:path";
import { config } from "../config";

export const MEDIA_MAX_BYTES = Number(process.env.WA_MEDIA_MAX_BYTES) || 10 * 1024 * 1024; // 10 MB/fichero
export const MEDIA_QUOTA_BYTES = Number(process.env.WA_MEDIA_QUOTA_BYTES) || 300 * 1024 * 1024; // 300 MB (60% del volumen)

/** Extensión de archivo a partir del mimetype (para que el navegador/OS lo reconozca al descargar). */
const EXT_BY_MIME: Record<string, string> = {
  "image/jpeg": "jpg", "image/png": "png", "image/webp": "webp", "image/gif": "gif",
  "audio/ogg": "ogg", "audio/mpeg": "mp3", "audio/mp4": "m4a", "audio/webm": "webm", "audio/aac": "aac",
  "video/mp4": "mp4", "video/3gpp": "3gp",
  "application/pdf": "pdf",
};

export function extFromMime(mime: string | null | undefined, fallbackName?: string | null): string {
  if (mime && EXT_BY_MIME[mime]) return EXT_BY_MIME[mime];
  const fromName = fallbackName?.match(/\.([a-z0-9]{1,6})$/i)?.[1];
  if (fromName) return fromName.toLowerCase();
  return "bin";
}

function safeChatDir(jid: string): string {
  const dir = path.join(config.mediaDir, jid.replace(/[^a-zA-Z0-9]/g, "_"));
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

export function mediaFilePath(jid: string, id: string, ext: string): string {
  return path.join(safeChatDir(jid), `${id.replace(/[^a-zA-Z0-9_-]/g, "_")}.${ext}`);
}

/** Suma el tamaño de todo `mediaDir`, recursivo. Coste O(n_ficheros); se llama
 *  solo al guardar media nueva (poco frecuente comparado con leer mensajes). */
function dirSizeBytes(dir: string): number {
  let total = 0;
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return 0;
  }
  for (const e of entries) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) total += dirSizeBytes(full);
    else {
      try {
        total += fs.statSync(full).size;
      } catch {
        /* fichero borrado entre el readdir y el stat: ignora */
      }
    }
  }
  return total;
}

/** Todos los ficheros de `mediaDir` con su mtime, para poder purgar los más viejos. */
function listAllFiles(dir: string): Array<{ file: string; mtime: number; size: number }> {
  const out: Array<{ file: string; mtime: number; size: number }> = [];
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...listAllFiles(full));
    else {
      try {
        const st = fs.statSync(full);
        out.push({ file: full, mtime: st.mtimeMs, size: st.size });
      } catch {
        /* ignora */
      }
    }
  }
  return out;
}

/** Si al añadir `incomingBytes` se superaría la cuota, borra ficheros LRU (los
 *  de `media_path` en BD quedan huérfanos: el mensaje vuelve a mostrarse como
 *  etiqueta sin adjunto, degradación aceptada — nunca se borra un mensaje). */
function ensureQuota(incomingBytes: number): void {
  const current = dirSizeBytes(config.mediaDir);
  if (current + incomingBytes <= MEDIA_QUOTA_BYTES) return;
  const files = listAllFiles(config.mediaDir).sort((a, b) => a.mtime - b.mtime);
  let freed = 0;
  const need = current + incomingBytes - MEDIA_QUOTA_BYTES;
  for (const f of files) {
    if (freed >= need) break;
    try {
      fs.unlinkSync(f.file);
      freed += f.size;
    } catch {
      /* ya no estaba: sigue */
    }
  }
  if (freed > 0) console.log(`[media] cuota: purgados ${(freed / 1024 / 1024).toFixed(1)} MB (LRU) para hacer sitio`);
}

/**
 * Guarda un buffer de media respetando el tope por fichero y la cuota total.
 * Devuelve la ruta absoluta si se guardó, o null si se descartó (demasiado
 * grande) — nunca lanza: un fallo de media no debe tumbar la ingesta.
 */
export function saveMediaBuffer(jid: string, id: string, mime: string | null, buf: Buffer, fallbackName?: string | null): string | null {
  if (buf.byteLength > MEDIA_MAX_BYTES) {
    console.log(`[media] descartado (${(buf.byteLength / 1024 / 1024).toFixed(1)} MB > tope ${(MEDIA_MAX_BYTES / 1024 / 1024).toFixed(0)} MB): ${jid}/${id}`);
    return null;
  }
  try {
    ensureQuota(buf.byteLength);
    const file = mediaFilePath(jid, id, extFromMime(mime, fallbackName));
    fs.writeFileSync(file, buf);
    return file;
  } catch (e) {
    console.error("[media] fallo al guardar:", (e as Error).message);
    return null;
  }
}
