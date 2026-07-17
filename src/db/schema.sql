-- Esquema completo del sidecar WhatsApp (versión 1).
-- Las tablas IA (tags/chat_tags/ai_artifacts/ai_jobs) se crean ya, aunque
-- no se usan hasta Fase 2 — así las migraciones futuras parten de una base única.

CREATE TABLE IF NOT EXISTS chats (
  jid TEXT PRIMARY KEY,                 -- '34611222333@s.whatsapp.net'
  phone TEXT,                           -- '611222333' canónico ES o NULL (internacional)
  display_name TEXT,
  avatar_path TEXT,
  avatar_fetched_at INTEGER,
  last_message_at INTEGER,
  last_message_preview TEXT,
  last_opened_at INTEGER,               -- "no leídos" LOCALES del equipo (no read-receipts WA)
  ignored INTEGER NOT NULL DEFAULT 0,
  backfill_status TEXT,                 -- NULL=pendiente | 'done' | 'exhausted' | 'partial'
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_chats_phone ON chats(phone);
CREATE INDEX IF NOT EXISTS idx_chats_last ON chats(last_message_at DESC);

CREATE TABLE IF NOT EXISTS messages (
  chat_jid TEXT NOT NULL REFERENCES chats(jid),
  id TEXT NOT NULL,                     -- Baileys key.id
  from_me INTEGER NOT NULL,
  ts INTEGER NOT NULL,                  -- epoch seconds
  type TEXT NOT NULL,                   -- 'text'|'image'|'audio'|'video'|'document'|'other'
  text TEXT,
  media_path TEXT,
  media_mime TEXT,
  raw_json TEXT,
  PRIMARY KEY (chat_jid, id)
);
CREATE INDEX IF NOT EXISTS idx_messages_chat_ts ON messages(chat_jid, ts DESC);

CREATE TABLE IF NOT EXISTS lead_directory (
  source_row INTEGER PRIMARY KEY,
  phone TEXT,
  name TEXT,
  estado TEXT,
  synced_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_leaddir_phone ON lead_directory(phone);

CREATE TABLE IF NOT EXISTS chat_lead_links (
  id INTEGER PRIMARY KEY,
  chat_jid TEXT NOT NULL REFERENCES chats(jid),
  source_row INTEGER NOT NULL,
  phone_snapshot TEXT,
  lead_name_snapshot TEXT,
  method TEXT NOT NULL CHECK (method IN ('auto','manual')),
  status TEXT NOT NULL CHECK (status IN ('active','removed')),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE (chat_jid, source_row)
);

CREATE TABLE IF NOT EXISTS tags (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  color TEXT,
  description TEXT,                     -- alimenta el prompt de clasificación
  is_active INTEGER NOT NULL DEFAULT 1,
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS chat_tags (
  id INTEGER PRIMARY KEY,
  chat_jid TEXT NOT NULL REFERENCES chats(jid),
  tag_id INTEGER NOT NULL REFERENCES tags(id),
  source TEXT NOT NULL CHECK (source IN ('ai','human')),
  status TEXT NOT NULL CHECK (status IN ('proposed','approved','rejected')),
  confidence REAL,
  proposed_at INTEGER,
  decided_at INTEGER,
  UNIQUE (chat_jid, tag_id)
);

CREATE TABLE IF NOT EXISTS ai_artifacts (
  id INTEGER PRIMARY KEY,
  chat_jid TEXT REFERENCES chats(jid),  -- NULL para 'style_profile' (global)
  kind TEXT NOT NULL CHECK (kind IN ('abstract','interests','reply_suggestion','style_profile')),
  content TEXT NOT NULL,                -- JSON
  model TEXT NOT NULL,
  input_last_message_id TEXT,
  input_message_count INTEGER,
  generation INTEGER NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_artifacts ON ai_artifacts(chat_jid, kind, generation DESC);

CREATE TABLE IF NOT EXISTS ai_jobs (
  id INTEGER PRIMARY KEY,
  chat_jid TEXT,
  kind TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','running','done','error')),
  priority INTEGER NOT NULL DEFAULT 5,  -- 1 = on-demand (suggest_reply), 5 = bulk
  attempts INTEGER NOT NULL DEFAULT 0,
  last_error TEXT,
  not_before INTEGER,                   -- ventana de calma
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
-- Coalescing: como máximo UN job pending por (chat, kind).
CREATE UNIQUE INDEX IF NOT EXISTS idx_jobs_pending
  ON ai_jobs(chat_jid, kind) WHERE status = 'pending';

CREATE TABLE IF NOT EXISTS meta (
  key TEXT PRIMARY KEY,
  value TEXT
);
