-- =====================================================================
-- CASACOR — Obra: cronograma por ambiente + atualização pelo QR Code
-- Cole no Supabase em: SQL Editor → New query → Run. Pode rodar mais de uma vez.
-- Rode DEPOIS do supabase-portaria.sql e do supabase-franquias.sql.
--
-- • Cada ambiente (cadastrado na Portaria) ganha um QR Code próprio.
-- • Quem escaneia o QR (sem precisar de login) informa o andamento das etapas
--   daquele ambiente — só daquele —, com nome, observação e foto.
-- • A equipe (login) monta o cronograma e acompanha tudo, por franquia.
-- =====================================================================

-- QR de cada ambiente: um código secreto (não dá para adivinhar)
alter table public.gate_envs add column if not exists qr_token uuid not null default gen_random_uuid();
create unique index if not exists gate_envs_qr_token on public.gate_envs (qr_token);

-- ---------- Etapas do cronograma ----------
create table if not exists public.obra_stages (
  id         uuid primary key default gen_random_uuid(),
  unit       text        not null default 'ce' references public.units (code),
  env_id     bigint      references public.gate_envs (id) on delete cascade,  -- vazio = marco geral da obra
  name       text        not null,
  sort       int         not null default 0,
  start_date date,
  end_date   date,
  status     text        not null default 'todo' check (status in ('todo', 'doing', 'done', 'blocked')),
  progress   int         not null default 0 check (progress between 0 and 100),
  updated_at timestamptz not null default now(),
  updated_by text        not null default ''
);
create index if not exists obra_stages_env on public.obra_stages (unit, env_id, sort);

-- ---------- Atualizações (histórico, com fotos) ----------
create table if not exists public.obra_updates (
  id         uuid primary key default gen_random_uuid(),
  unit       text        not null default 'ce' references public.units (code),
  env_id     bigint      references public.gate_envs (id) on delete cascade,
  stage_id   uuid        references public.obra_stages (id) on delete cascade,
  created_at timestamptz not null default now(),
  author     text        not null default '',
  created_by uuid        default auth.uid(),
  status     text        not null default '',
  progress   int,
  note       text        not null default '',
  photos     jsonb       not null default '[]'::jsonb,
  via        text        not null default 'app'
);
create index if not exists obra_updates_unit on public.obra_updates (unit, created_at desc);

alter table public.obra_stages enable row level security;
alter table public.obra_updates enable row level security;
drop policy if exists "obra etapas: ver" on public.obra_stages;
create policy "obra etapas: ver" on public.obra_stages for select using (public.is_member() and public.has_unit(unit));
drop policy if exists "obra etapas: editar" on public.obra_stages;
create policy "obra etapas: editar" on public.obra_stages for all
  using (public.is_member() and public.has_unit(unit)) with check (public.is_member() and public.has_unit(unit));
drop policy if exists "obra atualizações: ver" on public.obra_updates;
create policy "obra atualizações: ver" on public.obra_updates for select using (public.is_member() and public.has_unit(unit));
drop policy if exists "obra atualizações: registrar" on public.obra_updates;
create policy "obra atualizações: registrar" on public.obra_updates for insert with check (public.is_member() and public.has_unit(unit));
drop policy if exists "obra atualizações: apagar" on public.obra_updates;
create policy "obra atualizações: apagar" on public.obra_updates for delete using (public.is_admin() and public.has_unit(unit));
grant select, insert, update, delete on public.obra_stages, public.obra_updates to authenticated;

-- ---------- Pelo QR Code (sem login): só lê e atualiza o ambiente daquele QR ----------
create or replace function public.obra_info(p_token uuid) returns json
language plpgsql stable security definer set search_path = public as $$
declare
  e public.gate_envs;
begin
  select * into e from public.gate_envs where qr_token = p_token and active;
  if not found then
    raise exception 'QR Code inválido ou ambiente desativado.';
  end if;
  return json_build_object(
    'unit', (select name from public.units where code = e.unit),
    'env', json_build_object('id', e.id, 'number', e.number, 'name', e.name, 'architect', e.architect),
    'stages', coalesce((select json_agg(s order by s.sort, s.start_date nulls last, s.name)
                          from (select id, name, sort, start_date, end_date, status, progress, updated_at, updated_by
                                  from public.obra_stages where env_id = e.id) s), '[]'::json),
    'recent', coalesce((select json_agg(u order by u.created_at desc)
                          from (select u.created_at, u.author, u.status, u.progress, u.note, st.name as stage
                                  from public.obra_updates u left join public.obra_stages st on st.id = u.stage_id
                                 where u.env_id = e.id order by u.created_at desc limit 6) u), '[]'::json));
end;
$$;

create or replace function public.obra_post(p_token uuid, p_stage uuid, p_status text, p_progress int,
                                            p_note text, p_author text, p_photos jsonb default '[]'::jsonb) returns json
language plpgsql security definer set search_path = public as $$
declare
  e public.gate_envs;
  s public.obra_stages;
  ph jsonb := coalesce(p_photos, '[]'::jsonb);
begin
  select * into e from public.gate_envs where qr_token = p_token and active;
  if not found then raise exception 'QR Code inválido ou ambiente desativado.'; end if;
  select * into s from public.obra_stages where id = p_stage and env_id = e.id for update;
  if not found then raise exception 'Etapa não encontrada neste ambiente.'; end if;
  if p_status not in ('todo', 'doing', 'done', 'blocked') then raise exception 'Situação inválida.'; end if;
  if length(trim(coalesce(p_author, ''))) < 2 or length(p_author) > 60 then raise exception 'Escreva seu nome.'; end if;
  if length(coalesce(p_note, '')) > 600 then raise exception 'Observação muito longa.'; end if;
  if jsonb_typeof(ph) <> 'array' or jsonb_array_length(ph) > 3
     or exists (select 1 from jsonb_array_elements_text(ph) x where x not like p_token::text || '/%') then
    raise exception 'Fotos inválidas.';
  end if;
  update public.obra_stages
     set status = p_status,
         progress = case when p_status = 'done' then 100 when p_status = 'todo' then 0
                         when p_progress is null then progress else greatest(0, least(100, p_progress)) end,
         updated_at = now(), updated_by = trim(p_author)
   where id = s.id returning * into s;
  insert into public.obra_updates (unit, env_id, stage_id, author, created_by, status, progress, note, photos, via)
  values (e.unit, e.id, s.id, trim(p_author), auth.uid(), p_status, s.progress, trim(coalesce(p_note, '')),
          (select coalesce(jsonb_agg(jsonb_build_object('path', x, 'bucket', 'obra')), '[]'::jsonb) from jsonb_array_elements_text(ph) x),
          case when auth.uid() is null then 'qr' else 'qr-login' end);
  return json_build_object('id', s.id, 'status', s.status, 'progress', s.progress);
end;
$$;
grant execute on function public.obra_info(uuid), public.obra_post(uuid, uuid, text, int, text, text, jsonb) to anon, authenticated;

-- ---------- Fotos da obra ----------
create or replace function public.obra_token_ok(t text) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.gate_envs where qr_token::text = t and active)
$$;
grant execute on function public.obra_token_ok(text) to anon, authenticated;

insert into storage.buckets (id, name, public, file_size_limit)
values ('obra', 'obra', false, 8388608)
on conflict (id) do nothing;
do $$ begin
  if exists (select 1 from information_schema.columns where table_schema = 'storage' and table_name = 'buckets' and column_name = 'allowed_mime_types') then
    update storage.buckets set allowed_mime_types = array['image/jpeg', 'image/png', 'image/webp', 'image/heic'] where id = 'obra';
  end if;
end $$;
drop policy if exists "obra: ver fotos" on storage.objects;
create policy "obra: ver fotos" on storage.objects for select to authenticated using (bucket_id = 'obra' and public.is_member());
drop policy if exists "obra: enviar foto pelo QR" on storage.objects;
create policy "obra: enviar foto pelo QR" on storage.objects for insert to anon, authenticated
  with check (bucket_id = 'obra' and public.obra_token_ok(split_part(name, '/', 1)));
drop policy if exists "obra: apagar fotos" on storage.objects;
create policy "obra: apagar fotos" on storage.objects for delete to authenticated using (bucket_id = 'obra' and public.is_admin());
