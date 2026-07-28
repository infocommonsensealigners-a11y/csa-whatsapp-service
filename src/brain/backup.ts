/**
 * BACKUP AUTOMÁTICO de `wa.sqlite3` a Supabase Storage (auditoría 2026-07-28,
 * eje 0.8 — destino elegido por el usuario).
 *
 * Es el dato con MÁS riesgo de todo el proyecto: 60k+ mensajes de WhatsApp,
 * media y los enlaces chat↔lead viven SOLO en el volumen de Railway, sin
 * ninguna copia (el único respaldo era ejecutar `scripts/migrate-to-prod.ts` a
 * mano). Si ese volumen se pierde, no hay forma de recuperarlo.
 *
 * Cómo:
 *  - `db.backup()` de better-sqlite3 → copia CONSISTENTE aunque haya escrituras
 *    en curso (no vale copiar el fichero a pelo: el WAL dejaría un snapshot roto).
 *  - gzip antes de subir (un SQLite de ~17 MB baja mucho; ahorra transferencia
 *    y espacio en el bucket).
 *  - Una vez al día (marca en la tabla `meta`), retención 14 días.
 *  - GATED por SUPABASE_*, nunca lanza: un backup fallido jamás debe tumbar el
 *    sidecar (Fransua/chats/agenda siguen funcionando).
 */
import { readFileSync, unlinkSync, existsSync, readdirSync, statSync } from "node:fs";
import { gzipSync } from "node:zlib";
import path from "node:path";
import { config } from "../config";
import { getDb, getMeta, setMeta } from "../db/db";
import { getSupabase, brainConfigured } from "./supabase";

const BUCKET = "csa-backups";
const PREFIX = "sidecar";
const META_KEY = "backup_last_day";
const DIAS_RETENCION = 14;
const INTERVAL_MS = 6 * 60 * 60_000; // cada 6 h; el guard diario decide si toca

function today(): string {
  return new Date().toISOString().slice(0, 10);
}

async function ensureBucket(): Promise<boolean> {
  const sb = getSupabase();
  try {
    const { data } = await sb.storage.getBucket(BUCKET);
    if (data) return true;
  } catch {
    /* intenta crearlo */
  }
  const { error } = await sb.storage.createBucket(BUCKET, { public: false });
  if (error && !/already exists/i.test(error.message)) {
    console.warn("[backup-sidecar] no se pudo crear el bucket:", error.message);
    return false;
  }
  return true;
}

async function pruneOld(): Promise<void> {
  try {
    const sb = getSupabase();
    const { data, error } = await sb.storage.from(BUCKET).list(PREFIX, { limit: 1000 });
    if (error || !data) return;
    const cutoff = new Date(Date.now() - DIAS_RETENCION * 86_400_000).toISOString().slice(0, 10);
    const viejos = data.filter((f) => f.name < cutoff).map((f) => `${PREFIX}/${f.name}`);
    if (viejos.length) await sb.storage.from(BUCKET).remove(viejos);
  } catch {
    /* la retención no es crítica */
  }
}

export interface SidecarBackupResult {
  ok: boolean;
  skipped?: "disabled" | "already-today";
  bytes?: number;
  bytesRaw?: number;
  path?: string;
  /** Resultado del backup del EMPAREJAMIENTO (ver backupAuth). */
  auth?: { ok: boolean; files?: number; bytes?: number; error?: string };
  error?: string;
}

/**
 * Backup del EMPAREJAMIENTO de Baileys (`/data/auth`) — decisión del usuario
 * 28-07-2026 ("sí, respáldalo también").
 *
 * POR QUÉ: Baileys es la ÚNICA vía por la que entran los mensajes (Coexistence
 * está por integrar). Si el volumen se pierde y esta carpeta no está respaldada,
 * WhatsApp queda desconectado hasta que alguien **escanee un QR con el móvil de
 * Fran** — recuperable, pero requiere su presencia física. Con el backup, la
 * recuperación es automática.
 *
 * ⚠️ SON CREDENCIALES de acceso a la cuenta de WhatsApp. Van al MISMO bucket
 * privado que el resto (solo alcanzable con la secret key de Supabase, nunca
 * público). Se guardan como un único JSON con todos los ficheros de la carpeta,
 * comprimido. Riesgo asumido a cambio de disponibilidad — el usuario lo decidió
 * conociendo el trade-off.
 */
async function backupAuth(day: string): Promise<NonNullable<SidecarBackupResult["auth"]>> {
  try {
    const dir = config.authDir;
    if (!existsSync(dir)) return { ok: false, error: "no existe /data/auth" };
    const bundle: Record<string, string> = {};
    let files = 0;
    for (const name of readdirSync(dir)) {
      const p = path.join(dir, name);
      try {
        if (!statSync(p).isFile()) continue;
        bundle[name] = readFileSync(p, "utf-8");
        files++;
      } catch {
        /* un fichero ilegible no invalida el resto del emparejamiento */
      }
    }
    if (files === 0) return { ok: false, error: "carpeta auth vacía (¿sin emparejar?)" };
    const gz = gzipSync(JSON.stringify({ at: new Date().toISOString(), files, bundle }));
    const { error } = await getSupabase().storage.from(BUCKET).upload(`${PREFIX}/${day}-auth.json.gz`, gz, {
      contentType: "application/gzip",
      upsert: true,
    });
    if (error) return { ok: false, error: error.message };
    return { ok: true, files, bytes: gz.length };
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  }
}

/** Ejecuta el backup del SQLite. `force` ignora la marca diaria. Nunca lanza. */
export async function runSidecarBackup(force = false): Promise<SidecarBackupResult> {
  if (!brainConfigured()) return { ok: false, skipped: "disabled" };
  const day = today();
  if (!force && getMeta(META_KEY) === day) return { ok: true, skipped: "already-today" };

  const tmp = path.join(path.dirname(config.dbPath), `wa-backup-${Date.now()}.sqlite3`);
  try {
    if (!(await ensureBucket())) return { ok: false, error: "bucket no disponible" };

    // Copia consistente (incluye el WAL aplicado) — API oficial de better-sqlite3.
    await getDb().backup(tmp);
    const raw = readFileSync(tmp);
    const gz = gzipSync(raw);

    const objPath = `${PREFIX}/${day}-wa.sqlite3.gz`;
    const { error } = await getSupabase().storage.from(BUCKET).upload(objPath, gz, {
      contentType: "application/gzip",
      upsert: true,
    });
    if (error) throw new Error(error.message);

    // Emparejamiento de Baileys (para no tener que re-escanear el QR).
    const auth = await backupAuth(day);
    if (!auth.ok) console.warn("[backup-sidecar] auth NO respaldada:", auth.error);

    setMeta(META_KEY, day);
    void pruneOld();
    console.log(
      `[backup-sidecar] OK ${objPath} — ${(gz.length / 1048576).toFixed(1)} MB (de ${(raw.length / 1048576).toFixed(1)} MB)` +
        (auth.ok ? ` · auth: ${auth.files} ficheros` : " · auth: NO")
    );
    return { ok: true, bytes: gz.length, bytesRaw: raw.length, path: objPath, auth };
  } catch (e) {
    const error = (e as Error).message;
    console.warn("[backup-sidecar] falló:", error);
    return { ok: false, error };
  } finally {
    try {
      if (existsSync(tmp)) unlinkSync(tmp);
    } catch {
      /* el temporal se limpiará en el próximo arranque del contenedor */
    }
  }
}

/** Arranca el backup periódico. No-op silencioso si Supabase no está configurado. */
export function startBackupScheduler(): void {
  if (!brainConfigured()) {
    console.log("[backup-sidecar] SUPABASE_* no configurado → backup automático desactivado.");
    return;
  }
  // Primera pasada con retraso: no competir con el arranque (ingesta/Baileys).
  setTimeout(() => {
    void runSidecarBackup().catch((e) => console.error("[backup-sidecar] primera pasada:", (e as Error).message));
  }, 60_000);
  setInterval(() => {
    void runSidecarBackup().catch((e) => console.error("[backup-sidecar] tick:", (e as Error).message));
  }, INTERVAL_MS);
  console.log(`[backup-sidecar] backup diario de wa.sqlite3 activo (revisión cada ${INTERVAL_MS / 3_600_000} h).`);
}
