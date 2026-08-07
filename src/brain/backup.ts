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
  skipped?: "disabled" | "already-today" | "peor-que-el-existente";
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

/** Marca que acompaña a cada backup: hasta dónde llegan sus datos. */
interface MarcaBackup {
  /** Epoch (s) del mensaje más nuevo que contiene esa copia. 0 si está vacía. */
  ultimoMensajeTs: number;
  subidoEn: string;
  bytes: number;
}

/** Mensaje más nuevo de NUESTRA base: la vara de medir cómo de buena es la copia. */
function ultimoMensajeTs(): number {
  try {
    const r = getDb().prepare("SELECT MAX(ts) AS t FROM messages").get() as { t: number | null };
    return r?.t ?? 0;
  } catch {
    return 0; // sin tabla o base recién creada: la copia más pobre posible
  }
}

/** Lee la marca del backup ya subido hoy. `null` si no hay o no se puede leer. */
async function leerMarca(objPath: string): Promise<MarcaBackup | null> {
  try {
    const { data, error } = await getSupabase().storage.from(BUCKET).download(objPath);
    if (error || !data) return null;
    const j = JSON.parse(await data.text()) as MarcaBackup;
    return typeof j?.ultimoMensajeTs === "number" ? j : null;
  } catch {
    // Sin marca no se bloquea el backup: es preferible subir a no tener nada.
    return null;
  }
}

async function escribirMarca(objPath: string, marca: MarcaBackup): Promise<void> {
  try {
    await getSupabase().storage.from(BUCKET).upload(objPath, Buffer.from(JSON.stringify(marca)), {
      contentType: "application/json",
      upsert: true,
    });
  } catch {
    /* la marca es una ayuda, no una condición: si falla, el backup ya está subido */
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

    /**
     * ⚠️ NO PISAR UN BACKUP MEJOR CON UNO PEOR (detectado 2026-08-07).
     *
     * El backup del día se subía con `upsert: true`, así que el ÚLTIMO
     * contenedor que corriera se quedaba con el objeto. Y aquí no corre un solo
     * contenedor: el repo despliega en dos proyectos de Railway, y basta con que
     * uno tenga un volumen viejo o Baileys sin emparejar para que suba su copia
     * anémica encima de la buena. Resultado real: los backups del 28-07 al 07-08
     * eran todos la MISMA base congelada el 28-07 a las 07:19 — diez días de
     * respaldo inservible sin que nadie se enterara, porque el fichero existía y
     * pesaba lo normal.
     *
     * El árbitro es el MENSAJE MÁS NUEVO de la base: un backup solo sustituye al
     * del día si trae datos más recientes. Es el criterio correcto porque mide lo
     * que de verdad importa (cuánta conversación conserva), no el tamaño ni la
     * hora de subida. Se sube aparte una marca `.meta.json` legible con ese dato.
     */
    const nuestroUltimoTs = ultimoMensajeTs();
    const objPath = `${PREFIX}/${day}-wa.sqlite3.gz`;
    const metaPath = `${PREFIX}/${day}-wa.meta.json`;
    const previo = await leerMarca(metaPath);
    if (previo && previo.ultimoMensajeTs > nuestroUltimoTs) {
      const dias = Math.round((previo.ultimoMensajeTs - nuestroUltimoTs) / 86400);
      console.warn(
        `[backup-sidecar] NO se sube: el backup de hoy ya tiene datos más nuevos ` +
          `(${new Date(previo.ultimoMensajeTs * 1000).toISOString()} vs los nuestros ` +
          `${new Date(nuestroUltimoTs * 1000).toISOString()}, ${dias} días). ` +
          `Este contenedor tiene una copia PEOR de la base — probablemente es el ` +
          `proyecto duplicado o un volumen sin emparejar.`
      );
      setMeta(META_KEY, day); // no reintentar en bucle el resto del día
      return { ok: true, skipped: "peor-que-el-existente" };
    }

    const { error } = await getSupabase().storage.from(BUCKET).upload(objPath, gz, {
      contentType: "application/gzip",
      upsert: true,
    });
    if (error) throw new Error(error.message);
    await escribirMarca(metaPath, { ultimoMensajeTs: nuestroUltimoTs, subidoEn: new Date().toISOString(), bytes: gz.length });

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
