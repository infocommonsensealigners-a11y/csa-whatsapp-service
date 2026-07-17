-- ============================================================================
-- Fransua — agenda v1. Enriquece calendar_events para la app de agenda del
-- dashboard. Aplicar en: Supabase → SQL Editor → New query → pegar → Run.
-- ============================================================================

alter table calendar_events add column if not exists tipo    text    default 'cita';    -- cita | formacion | llamada | seguimiento | otro
alter table calendar_events add column if not exists all_day boolean default false;
alter table calendar_events add column if not exists origen  text    default 'humano';  -- humano | fransua
alter table calendar_events add column if not exists color   text;                      -- override opcional

create index if not exists idx_calendar_events_start on calendar_events(start_at);
create index if not exists idx_calendar_events_source_row on calendar_events(source_row);
