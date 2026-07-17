-- ============================================================================
-- Fransua — cerebro (Supabase / Postgres). Esquema v1.
-- Aplicar en: Supabase → SQL Editor → New query → pegar todo → Run.
-- Guarda solo INTELIGENCIA derivada (resúmenes, temperatura, intervalos,
-- recordatorios, eventos), NO las conversaciones crudas (esas viven en local).
-- Todas las tablas con RLS activado y SIN políticas: solo la secret key
-- (backend) accede; la publishable key no ve nada.
-- ============================================================================

create extension if not exists vector;  -- para memoria semántica (fase posterior)

-- Espejo mínimo de leads del CRM (para unir por fila/teléfono) --------------
create table if not exists lead_mirror (
  source_row integer primary key,
  phone      text,
  name       text,
  producto   text,
  estado     text,
  synced_at  timestamptz not null default now()
);
create index if not exists idx_lead_mirror_phone on lead_mirror(phone);
alter table lead_mirror enable row level security;

-- Inteligencia por chat/lead (salida del worker de asimilación) --------------
create table if not exists chat_intel (
  jid              text primary key,
  phone            text,
  display_name     text,
  source_row       integer,          -- lead enlazado del CRM (si se conoce)
  producto         text,
  first_ts         bigint,           -- epoch s del primer mensaje
  last_ts          bigint,           -- epoch s del último mensaje
  msg_count        integer default 0,
  from_me_count    integer default 0,
  temperatura      text,             -- 'caliente' | 'templado' | 'frio'
  temperatura_motivo text,
  resumen          text,             -- abstract de la conversación
  intereses        jsonb,            -- [{label, evidence}]
  intervalos       jsonb,            -- cadencia / tiempos de respuesta
  etiquetas        jsonb,            -- etiquetas propuestas/aprobadas
  model            text,
  generation       integer default 1,
  updated_at       timestamptz not null default now()
);
create index if not exists idx_chat_intel_phone on chat_intel(phone);
create index if not exists idx_chat_intel_source_row on chat_intel(source_row);
create index if not exists idx_chat_intel_temp on chat_intel(temperatura);
alter table chat_intel enable row level security;

-- Memoria semántica (embeddings) — se rellena en fase posterior -------------
create table if not exists conversation_memory (
  id         bigserial primary key,
  jid        text,
  source_row integer,
  ts_start   bigint,
  ts_end     bigint,
  content    text not null,
  embedding  vector(384),            -- gte-small (Supabase) = 384 dims
  model      text,
  created_at timestamptz not null default now()
);
alter table conversation_memory enable row level security;

-- Recordatorios (notificaciones / agenda) -----------------------------------
create table if not exists reminders (
  id         bigserial primary key,
  source_row integer,
  jid        text,
  titulo     text not null,
  detalle    text,
  due_at     timestamptz not null,
  status     text not null default 'pending',  -- pending | done | dismissed
  origen     text default 'fransua',           -- fransua | humano
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists idx_reminders_due on reminders(due_at) where status = 'pending';
alter table reminders enable row level security;

-- Eventos de calendario (sync con Google Calendar) --------------------------
create table if not exists calendar_events (
  id              bigserial primary key,
  source_row      integer,
  jid             text,
  titulo          text not null,
  descripcion     text,
  start_at        timestamptz not null,
  end_at          timestamptz,
  google_event_id text,
  status          text not null default 'active',
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);
alter table calendar_events enable row level security;

-- Parte diario / decisiones de Fransua --------------------------------------
create table if not exists fransua_log (
  id         bigserial primary key,
  fecha      date not null default current_date,
  kind       text not null,          -- 'digest' | 'recommendation' | 'action' | ...
  source_row integer,
  payload    jsonb not null,
  created_at timestamptz not null default now()
);
create index if not exists idx_fransua_log_fecha on fransua_log(fecha);
alter table fransua_log enable row level security;
