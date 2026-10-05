-- ============================================================================
-- 004 — REAPUNTAR lo guardado por NÚMERO DE FILA cuando se borran filas de CSA
--
-- ⚠️ PROPUESTA: NO se ha ejecutado. Ejecutar en: Supabase → SQL Editor → pegar y Run.
--
-- POR QUÉ (05-10-2026). La fusión de duplicados borró 212 filas de la hoja CSA y
-- todo lo que había por debajo cambió de número. El dashboard reapuntó lo suyo
-- (responsividad manual, chats desvinculados), pero estas tablas guardan
-- `source_row` y no las tocó nadie: 3.220 registros quedaron señalando la fila
-- de otra persona (medido con dashboard/scripts/repara-filas-tras-fusion.ts).
--
-- La identidad estable es el TELÉFONO (003_phone_identity.sql) y las lecturas
-- ya van por él; `source_row` queda como pista. Esto la mantiene al día: una
-- función que el dashboard llama UNA vez justo después de borrar filas, y que
-- mueve todas las tablas en una sola transacción (o entra todo o no entra nada).
--
-- ADITIVO Y SEGURO de ejecutar: crea dos funciones y rellena una columna vacía.
-- No borra nada. El código funciona igual antes y después: si la función no
-- existe, el dashboard lo dice en el aviso de la fusión y no la llama
-- (lib/fransua/reapuntarTablas.ts).
-- ============================================================================

-- 1) La fila nueva de una fila vieja. CALCO de `crearRemapeo`
--    (dashboard/lib/domain/fusionPlan.ts): si la fila es una de las borradas y
--    tiene principal, la de su principal; y a eso se le restan las filas
--    borradas que quedan por encima. Si cambia una, cambia la otra.
create or replace function public.csa_fila_nueva(p_fila integer, p_borradas integer[], p_principal jsonb)
returns integer
language sql
immutable
as $$
  select x.f - (select count(*)::integer from unnest(p_borradas) as b where b < x.f)
    from (select coalesce((p_principal ->> p_fila::text)::integer, p_fila) as f) as x
$$;

-- 2) Mueve todo lo que apunta a una fila de CSA.
--    p_borradas  : las filas que se han borrado (números de ANTES de borrar).
--    p_principal : { "<fila borrada>": <su fila principal> } — vacío para huecos en blanco.
--    p_antes     : solo se mueve lo creado ANTES de este instante (lo que nace
--                  después del borrado ya lleva la fila nueva).
create or replace function public.csa_reapuntar_filas(
  p_borradas  integer[],
  p_principal jsonb default '{}'::jsonb,
  p_antes     timestamptz default now()
)
returns jsonb
language plpgsql
set search_path = public
as $$
declare
  v_min     integer;
  n_rem     integer := 0;
  n_cal     integer := 0;
  n_mem     integer := 0;
  n_log     integer := 0;
  n_intel   integer := 0;
  n_hitos   integer := 0;
  h         record;
  v_nueva   text;
begin
  if p_borradas is null or cardinality(p_borradas) = 0 then
    return jsonb_build_object('ok', true, 'filas', 0);
  end if;
  select min(b) into v_min from unnest(p_borradas) as b;

  update reminders
     set source_row = csa_fila_nueva(source_row, p_borradas, p_principal)
   where source_row >= v_min and created_at < p_antes
     and source_row <> csa_fila_nueva(source_row, p_borradas, p_principal);
  get diagnostics n_rem = row_count;

  update calendar_events
     set source_row = csa_fila_nueva(source_row, p_borradas, p_principal)
   where source_row >= v_min and created_at < p_antes
     and source_row <> csa_fila_nueva(source_row, p_borradas, p_principal);
  get diagnostics n_cal = row_count;

  update conversation_memory
     set source_row = csa_fila_nueva(source_row, p_borradas, p_principal)
   where source_row >= v_min and created_at < p_antes
     and source_row <> csa_fila_nueva(source_row, p_borradas, p_principal);
  get diagnostics n_mem = row_count;

  -- fransua_log: SOLO lo que habla de una fila de CSA.
  --  · Fuera `responsividad_manual` y `wa_unlink`: son append-only y el dashboard
  --    los reapunta por su cuenta ANTES de borrar (añadiendo marcas, no moviéndolas).
  --  · Del rastro (`action_audit`), fuera las acciones de Alumnos: su fila es de
  --    la pestaña EDICIONES. Los apuntes nuevos lo dicen en payload.hoja; los
  --    antiguos, por la etiqueta.
  update fransua_log
     set source_row = csa_fila_nueva(source_row, p_borradas, p_principal)
   where source_row >= v_min and created_at < p_antes
     and source_row <> csa_fila_nueva(source_row, p_borradas, p_principal)
     and (
       kind in ('human_note', 'event', 'leccion')
       or (kind = 'action_audit' and (
            payload ->> 'hoja' = 'CSA'
            or (payload ->> 'hoja' is null
                and payload ->> 'action_type' ~* '^(crm[ -]|mark-call|unmark-call|whatsapp-log|fransua-lead-create|lead_fusionado|agendar|cambiar_estado|estado|nota|crear_evento|crear_recordatorio|crear_aviso)')
          ))
     );
  get diagnostics n_log = row_count;

  -- chat_intel no tiene created_at: se usa updated_at. (El sidecar la repasa
  -- después contra sus vínculos, que es quien manda; esto solo evita que entre
  -- tanto señale a otra persona.)
  update chat_intel
     set source_row = csa_fila_nueva(source_row, p_borradas, p_principal)
   where source_row >= v_min and updated_at < p_antes
     and source_row <> csa_fila_nueva(source_row, p_borradas, p_principal);
  get diagnostics n_intel = row_count;

  -- seguimiento_hitos: la clave es un número de fila solo cuando el lead no tenía
  -- teléfono ni nombre. De arriba abajo (la fila nueva siempre es menor, así que
  -- su hueco ya está libre) y sin pisar una marca que ya exista en el destino.
  if to_regclass('public.seguimiento_hitos') is not null then
    for h in
      select lead_key, hito_id from seguimiento_hitos
       where lead_key ~ '^[0-9]{1,5}$' and lead_key::integer >= v_min and hecho_at < p_antes
       order by lead_key::integer asc
    loop
      v_nueva := csa_fila_nueva(h.lead_key::integer, p_borradas, p_principal)::text;
      if v_nueva <> h.lead_key
         and not exists (select 1 from seguimiento_hitos x where x.lead_key = v_nueva and x.hito_id = h.hito_id) then
        update seguimiento_hitos set lead_key = v_nueva where lead_key = h.lead_key and hito_id = h.hito_id;
        n_hitos := n_hitos + 1;
      end if;
    end loop;
  end if;

  return jsonb_build_object(
    'ok', true,
    'filas', cardinality(p_borradas),
    'reminders', n_rem,
    'calendar_events', n_cal,
    'conversation_memory', n_mem,
    'fransua_log', n_log,
    'chat_intel', n_intel,
    'seguimiento_hitos', n_hitos
  );
end;
$$;

-- Solo el backend (secret key = service_role) puede llamarlas.
revoke all on function public.csa_reapuntar_filas(integer[], jsonb, timestamptz) from public;
revoke all on function public.csa_fila_nueva(integer, integer[], jsonb) from public;
grant execute on function public.csa_reapuntar_filas(integer[], jsonb, timestamptz) to service_role;
grant execute on function public.csa_fila_nueva(integer, integer[], jsonb) to service_role;

-- 3) RETRO-RELLENO de la columna `phone` de fransua_log con el teléfono que ya
--    estaba dentro del payload (notas, eventos y rastro lo guardaban ahí pero no
--    en la columna). Así «todo lo de este teléfono» se puede buscar con índice.
--    No usa `source_row` para nada.
update fransua_log
   set phone = payload ->> 'phone'
 where phone is null
   and coalesce(payload ->> 'phone', '') <> ''
   and kind in ('human_note', 'event', 'action_audit', 'responsividad_manual', 'wa_unlink');

-- 4) Buscar el rastro «de esta persona» sin recorrer la tabla.
create index if not exists idx_fransua_log_kind_row on fransua_log(kind, source_row) where source_row is not null;
