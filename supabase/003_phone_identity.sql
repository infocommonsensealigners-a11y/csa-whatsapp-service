-- ============================================================================
-- 003 — IDENTIDAD POR TELÉFONO en las tablas del cerebro
--
-- POR QUÉ (auditoría 2026-07-28, eje 0.6): `reminders`, `calendar_events`,
-- `conversation_memory` y `fransua_log` vinculan al lead SOLO por `source_row`,
-- que es la POSICIÓN de la fila en el Google Sheet. Si se mueven o borran filas
-- (pasa: ya provocó el bug grave de "Análisis de llamadas" el 27-07), un
-- recordatorio creado hoy pasa a apuntar a OTRO lead mañana, en silencio.
--
-- La identidad estable del proyecto es el TELÉFONO canónico
-- (dashboard/lib/domain/leadIdentity.ts, calco del Apps Script).
--
-- Esta migración es ADITIVA y SEGURA: solo añade una columna nullable + índice.
-- No borra ni transforma nada, y el código del sidecar funciona igual antes y
-- después de ejecutarla (ver src/brain/phoneColumn.ts: intenta escribir `phone`
-- y, si la columna aún no existe, reintenta sin ella).
--
-- Ejecutar en: Supabase → SQL Editor → pegar y Run.
-- ============================================================================

alter table reminders           add column if not exists phone text;
alter table calendar_events     add column if not exists phone text;
alter table conversation_memory add column if not exists phone text;
alter table fransua_log         add column if not exists phone text;

-- Búsquedas "todo lo de este lead" por identidad estable.
create index if not exists idx_reminders_phone           on reminders(phone)           where phone is not null;
create index if not exists idx_calendar_events_phone     on calendar_events(phone)     where phone is not null;
create index if not exists idx_conversation_memory_phone on conversation_memory(phone) where phone is not null;
create index if not exists idx_fransua_log_phone         on fransua_log(phone)         where phone is not null;

-- RETRO-RELLENO de lo ya existente: `chat_intel` sí guarda el teléfono, así que
-- para las filas que tengan jid se puede recuperar. `source_row` NO se usa para
-- esto a propósito (es justo el dato del que no nos fiamos).
update reminders r
   set phone = ci.phone
  from chat_intel ci
 where r.phone is null and r.jid is not null and ci.jid = r.jid and ci.phone is not null;

update calendar_events e
   set phone = ci.phone
  from chat_intel ci
 where e.phone is null and e.jid is not null and ci.jid = e.jid and ci.phone is not null;

update conversation_memory m
   set phone = ci.phone
  from chat_intel ci
 where m.phone is null and m.jid is not null and ci.jid = m.jid and ci.phone is not null;
