/**
 * Configuración tipada del sidecar, leída de env (cargada por
 * `tsx --env-file=.env`). Todas las rutas de datos cuelgan de `dataDir`
 * (gitignored: contiene sesión Baileys, SQLite y media).
 */
import path from "node:path";
import fs from "node:fs";

function intEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  const n = raw ? Number.parseInt(raw, 10) : NaN;
  return Number.isFinite(n) ? n : fallback;
}

const rootDir = process.cwd();
// En Railway se apunta al volumen con WA_DATA_DIR; en local cuelga de ./data.
const dataDir = process.env.WA_DATA_DIR ? path.resolve(process.env.WA_DATA_DIR) : path.join(rootDir, "data");

export const config = {
  /** Loopback en local; en Railway WA_HOST=0.0.0.0 (red interna privada). */
  host: process.env.WA_HOST ?? "127.0.0.1",
  /** Railway inyecta PORT; en local cae a WA_PORT (3211). */
  port: intEnv("PORT", intEnv("WA_PORT", 3211)),
  dashboardUrl: process.env.DASHBOARD_URL ?? "http://127.0.0.1:3210",

  dataDir,
  authDir: path.join(dataDir, "auth"),
  dbPath: path.join(dataDir, "wa.sqlite3"),
  mediaDir: path.join(dataDir, "media"),
  avatarsDir: path.join(dataDir, "avatars"),

  aiModelBulk: process.env.WA_AI_MODEL_BULK ?? "haiku",
  aiModelSuggest: process.env.WA_AI_MODEL_SUGGEST ?? "sonnet",
  calmMinutes: intEnv("WA_CALM_MINUTES", 10),

  /** Fecha (YYYY-MM-DD) hasta la que el backfill intenta retroceder. */
  backfillSince: process.env.WA_BACKFILL_SINCE ?? "2025-01-01",

  /** Cerebro de Fransua (Supabase). Vacío ⇒ la capa IA no persiste en la nube. */
  supabaseUrl: process.env.SUPABASE_URL ?? "",
  supabaseSecretKey: process.env.SUPABASE_SECRET_KEY ?? "",

  /** Ventana de APRENDIZAJE: se asimilan chats con actividad desde esta fecha. */
  learnSince: process.env.WA_LEARN_SINCE ?? "2024-01-01",

  /** Cuenta de Google con la que se comparte el calendario "CSA · Fransua". */
  calendarShareEmail: process.env.WA_GCAL_SHARE ?? "infocommonsensealigners@gmail.com",
} as const;

/** Crea las carpetas de runtime si faltan (idempotente, se llama en el boot). */
export function ensureDataDirs(): void {
  for (const dir of [config.dataDir, config.authDir, config.mediaDir, config.avatarsDir]) {
    fs.mkdirSync(dir, { recursive: true });
  }
}
