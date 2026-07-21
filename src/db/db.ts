/**
 * Capa SQLite del sidecar (better-sqlite3, WAL). Única dueña de la BD:
 * el dashboard NUNCA abre este fichero; consume la API HTTP.
 *
 * Migraciones: el esquema completo v1 vive en schema.sql (idempotente vía
 * IF NOT EXISTS); migraciones futuras se encadenan por `meta.schema_version`.
 */
import Database from "better-sqlite3";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { config } from "../config";

const SCHEMA_VERSION = 1;

let db: Database.Database | null = null;

export function openDb(): Database.Database {
  if (db) return db;
  db = new Database(config.dbPath);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  migrate(db);
  return db;
}

export function getDb(): Database.Database {
  if (!db) throw new Error("BD no inicializada: llama a openDb() en el bootstrap.");
  return db;
}

function migrate(d: Database.Database): void {
  d.exec("CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT)");
  const row = d.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get() as
    | { value: string }
    | undefined;
  const current = row ? Number(row.value) : 0;

  if (current < 1) {
    const schemaPath = path.join(path.dirname(fileURLToPath(import.meta.url)), "schema.sql");
    d.exec(fs.readFileSync(schemaPath, "utf-8"));
  }

  // Columnas añadidas después de v1: idempotente (guardado por table_info), así
  // sirve tanto para BDs nuevas (ya vienen en schema.sql) como existentes.
  ensureColumn(d, "chats", "backfill_status", "TEXT");

  // Tablas añadidas post-v1 (etiquetas de WhatsApp): crear SIEMPRE, idempotente.
  // El schema.sql solo se aplica a BDs nuevas (current < 1); las existentes
  // necesitan esto para no quedarse sin las tablas nuevas.
  d.exec(`
    CREATE TABLE IF NOT EXISTS wa_labels (
      id TEXT PRIMARY KEY,
      name TEXT,
      color INTEGER NOT NULL DEFAULT 0,
      deleted INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS wa_chat_labels (
      chat_jid TEXT NOT NULL,
      label_id TEXT NOT NULL,
      PRIMARY KEY (chat_jid, label_id)
    );
    CREATE INDEX IF NOT EXISTS idx_wa_chat_labels_jid ON wa_chat_labels(chat_jid);
  `);

  d.prepare(
    "INSERT INTO meta(key, value) VALUES('schema_version', ?) " +
      "ON CONFLICT(key) DO UPDATE SET value = excluded.value"
  ).run(String(SCHEMA_VERSION));
}

function ensureColumn(d: Database.Database, table: string, column: string, decl: string): void {
  const cols = d.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
  if (!cols.some((c) => c.name === column)) {
    d.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${decl}`);
  }
}

/* ------------------------------- meta ------------------------------------ */

export function getMeta(key: string): string | null {
  const row = getDb().prepare("SELECT value FROM meta WHERE key = ?").get(key) as
    | { value: string }
    | undefined;
  return row?.value ?? null;
}

export function setMeta(key: string, value: string): void {
  getDb()
    .prepare(
      "INSERT INTO meta(key, value) VALUES(?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value"
    )
    .run(key, value);
}

/* ----------------------------- agregados ---------------------------------- */

function countOne(sql: string): number {
  const row = getDb().prepare(sql).get() as { n: number };
  return row.n;
}

/** Contadores para WaStatus.counts. */
export function statusCounts(): { chats: number; messages: number; linked: number; unknown: number } {
  return {
    chats: countOne("SELECT COUNT(*) AS n FROM chats"),
    messages: countOne("SELECT COUNT(*) AS n FROM messages"),
    linked: countOne(
      "SELECT COUNT(DISTINCT chat_jid) AS n FROM chat_lead_links WHERE status = 'active'"
    ),
    unknown: countOne(
      "SELECT COUNT(*) AS n FROM chats c WHERE c.ignored = 0 AND NOT EXISTS (" +
        "SELECT 1 FROM chat_lead_links l WHERE l.chat_jid = c.jid AND l.status = 'active')"
    ),
  };
}

/** Jobs IA pendientes (Fase 2; en Fase 0-1 siempre 0). */
export function aiQueuePending(): number {
  return countOne("SELECT COUNT(*) AS n FROM ai_jobs WHERE status = 'pending'");
}
