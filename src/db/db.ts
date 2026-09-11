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
  return openDbAt(config.dbPath);
}

/**
 * Abre (o sustituye) la BD en una ruta concreta. Sirve para las PRUEBAS, que
 * trabajan sobre `":memory:"` con el esquema real y las mismas migraciones que
 * producción, sin tocar `config.dbPath`. En producción solo se llama desde
 * `openDb()`.
 */
export function openDbAt(ruta: string): Database.Database {
  if (db) {
    try {
      db.close();
    } catch {
      /* ya cerrada */
    }
  }
  db = new Database(ruta);
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
  // Marca de agua del estado de lectura REAL de WhatsApp (ver src/wa/readState.ts):
  // todo entrante con ts <= wa_read_at ya está leído en el móvil/WhatsApp Web.
  ensureColumn(d, "chats", "wa_read_at", "INTEGER");
  /**
   * IDENTIDAD (2026-09-11, ver src/wa/canonico.ts): una fila de chat por
   * PERSONA. Cuando un chat `@lid` resulta ser la misma persona que un chat con
   * teléfono, su historial se funde en el canónico y la fila del `@lid` queda
   * como ALIAS (`alias_of` = jid canónico, `ignored = 1`, sin `last_message_at`).
   * Se conserva la fila para que cualquier referencia antigua (enlaces, eventos
   * de WhatsApp que sigan llegando con ese jid) se pueda redirigir.
   */
  ensureColumn(d, "chats", "alias_of", "TEXT");
  /** Remitente dentro de un GRUPO (jid del participante). NULL en chats 1-a-1. */
  ensureColumn(d, "messages", "participant", "TEXT");

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
    -- Mapa LID -> teléfono real. WhatsApp direcciona muchos chats 1-a-1 con un
    -- JID '@lid' que NO lleva el número, pero Baileys SÍ nos da el teléfono en
    -- key.senderPn de cada mensaje entrante (y ya quedaba guardado en
    -- messages.raw_json). Aquí se materializa esa correspondencia para poder
    -- casar esos chats con el CRM por teléfono.
    --   pn    = JID completo con número ('34600111222@s.whatsapp.net')
    --   phone = clave de cruce: móvil ES de 9 dígitos, o E.164 sin '+' si es de fuera
    CREATE TABLE IF NOT EXISTS wa_lid_map (
      lid TEXT PRIMARY KEY,
      pn TEXT NOT NULL,
      phone TEXT,
      source TEXT NOT NULL DEFAULT 'senderPn',
      created_at INTEGER
    );
    CREATE INDEX IF NOT EXISTS idx_wa_lid_map_phone ON wa_lid_map(phone);
    CREATE INDEX IF NOT EXISTS idx_wa_lid_map_pn ON wa_lid_map(pn);
    CREATE INDEX IF NOT EXISTS idx_chats_alias ON chats(alias_of);
    -- Agenda de WhatsApp tal como la sincroniza el móvil (contacts.upsert /
    -- contacts.update / history sync). 'name' = nombre guardado en la agenda,
    -- 'notify' = nombre que la persona se puso (pushName), 'verified_name' = el
    -- de negocio verificado. Sirve para el nombre mostrado (agenda > negocio >
    -- pushName > número, como WhatsApp Web) y para nombrar a quien habla en un
    -- grupo. Se guarda por jid tal cual llega (pn o lid).
    CREATE TABLE IF NOT EXISTS wa_contacts (
      jid TEXT PRIMARY KEY,
      name TEXT,
      notify TEXT,
      verified_name TEXT,
      lid TEXT,
      updated_at INTEGER NOT NULL
    );
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

/** Contadores para WaStatus.counts. Las filas ALIAS (fundidas) no cuentan como chat. */
export function statusCounts(): { chats: number; messages: number; linked: number; unknown: number } {
  return {
    chats: countOne("SELECT COUNT(*) AS n FROM chats WHERE alias_of IS NULL"),
    messages: countOne("SELECT COUNT(*) AS n FROM messages"),
    linked: countOne(
      "SELECT COUNT(DISTINCT chat_jid) AS n FROM chat_lead_links WHERE status = 'active'"
    ),
    unknown: countOne(
      "SELECT COUNT(*) AS n FROM chats c WHERE c.ignored = 0 AND c.alias_of IS NULL AND NOT EXISTS (" +
        "SELECT 1 FROM chat_lead_links l WHERE l.chat_jid = c.jid AND l.status = 'active')"
    ),
  };
}

/** Jobs IA pendientes (Fase 2; en Fase 0-1 siempre 0). */
export function aiQueuePending(): number {
  return countOne("SELECT COUNT(*) AS n FROM ai_jobs WHERE status = 'pending'");
}
