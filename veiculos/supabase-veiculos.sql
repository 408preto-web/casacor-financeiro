-- =====================================================================
-- Garagem — controle de veículos (abastecimentos, manutenções, documentos)
-- Usa o MESMO projeto do Supabase da CASACOR, com tabelas próprias (vei_…)
-- e equipe própria: quem é da CASACOR não vê os carros, e vice-versa.
-- Cole no Supabase em: SQL Editor → New query → Run. Pode rodar mais de uma vez.
-- Depois de rodar, abra o app e crie o acesso: a PRIMEIRA pessoa vira dona (administra).
-- =====================================================================

-- ---------- Pessoas ----------
create table if not exists public.vei_members (
  user_id    uuid primary key references auth.users (id) on delete cascade,
  email      text        not null default '',
  name       text        not null default '',
  role       text        not null default 'pending' check (role in ('pending', 'driver', 'owner', 'blocked')),
  created_at timestamptz not null default now()
);

create or replace function public.vei_role() returns text
language sql stable security definer set search_path = public as $$
  select role from public.vei_members where user_id = auth.uid()
$$;
create or replace function public.vei_is_member() returns boolean
language sql stable security definer set search_path = public as $$
  select coalesce(public.vei_role() in ('driver', 'owner'), false)
$$;
create or replace function public.vei_is_owner() returns boolean
language sql stable security definer set search_path = public as $$
  select coalesce(public.vei_role() = 'owner', false)
$$;

-- Entrar: a primeira pessoa vira dona; as outras ficam aguardando aprovação
create or replace function public.vei_join(p_name text) returns text
language plpgsql security definer set search_path = public as $$
declare r text;
begin
  if auth.uid() is null then raise exception 'não autenticado'; end if;
  select role into r from public.vei_members where user_id = auth.uid();
  if r is not null then return r; end if;
  r := case when exists (select 1 from public.vei_members where role = 'owner') then 'pending' else 'owner' end;
  insert into public.vei_members (user_id, email, name, role)
  values (auth.uid(), coalesce(auth.jwt() ->> 'email', ''), coalesce(nullif(trim(p_name), ''), 'Sem nome'), r);
  return r;
end;
$$;

create or replace function public.vei_members_guard() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if new.user_id <> old.user_id or new.email <> old.email then raise exception 'não é possível alterar o usuário ou o e-mail'; end if;
  if new.role is distinct from old.role then
    if not public.vei_is_owner() then raise exception 'só quem administra pode mudar a função'; end if;
    if old.role = 'owner' and new.role <> 'owner' and (select count(*) from public.vei_members where role = 'owner') <= 1 then
      raise exception 'é preciso ter pelo menos uma pessoa administradora';
    end if;
  end if;
  return new;
end;
$$;
drop trigger if exists vei_members_guard on public.vei_members;
create trigger vei_members_guard before update on public.vei_members for each row execute function public.vei_members_guard();

alter table public.vei_members enable row level security;
drop policy if exists "vei pessoas: ver" on public.vei_members;
create policy "vei pessoas: ver" on public.vei_members for select using (public.vei_is_member() or user_id = auth.uid());
drop policy if exists "vei pessoas: alterar" on public.vei_members;
create policy "vei pessoas: alterar" on public.vei_members for update using (public.vei_is_owner() or user_id = auth.uid());
drop policy if exists "vei pessoas: remover" on public.vei_members;
create policy "vei pessoas: remover" on public.vei_members for delete using (public.vei_is_owner() and user_id <> auth.uid());

-- ---------- Veículos ----------
create table if not exists public.vei_vehicles (
  id             uuid primary key default gen_random_uuid(),
  created_at     timestamptz not null default now(),
  name           text        not null,                 -- apelido: "Hilux", "Carro da Neuma"
  brand          text        not null default '',
  model          text        not null default '',
  year           text        not null default '',
  plate          text        not null default '',
  color          text        not null default '',
  fuel           text        not null default 'flex',  -- gasolina, etanol, flex, diesel, eletrico, gnv
  tank_l         numeric(6, 1),
  initial_km     int         not null default 0,
  purchase_date  date,
  purchase_price numeric(12, 2),
  renavam        text        not null default '',
  chassis        text        not null default '',
  notes          text        not null default '',
  active         boolean     not null default true
);

-- ---------- Abastecimentos ----------
create table if not exists public.vei_fuel (
  id          uuid primary key default gen_random_uuid(),
  created_at  timestamptz not null default now(),
  created_by  uuid        not null default auth.uid() references auth.users (id),
  vehicle_id  uuid        not null references public.vei_vehicles (id) on delete cascade,
  date        date        not null default current_date,
  odometer    int         not null check (odometer >= 0),
  liters      numeric(8, 3) not null check (liters > 0),
  price_l     numeric(8, 3),
  total       numeric(10, 2) not null check (total >= 0),
  fuel        text        not null default 'gasolina',
  full_tank   boolean     not null default true,
  station     text        not null default '',
  notes       text        not null default '',
  attachments jsonb       not null default '[]'::jsonb
);
create index if not exists vei_fuel_vehicle on public.vei_fuel (vehicle_id, odometer);

-- ---------- Manutenções e outras despesas ----------
create table if not exists public.vei_services (
  id             uuid primary key default gen_random_uuid(),
  created_at     timestamptz not null default now(),
  created_by     uuid        not null default auth.uid() references auth.users (id),
  vehicle_id     uuid        not null references public.vei_vehicles (id) on delete cascade,
  date           date        not null default current_date,
  odometer       int,
  kind           text        not null default 'mecanica',
  description    text        not null default '',
  shop           text        not null default '',
  cost           numeric(12, 2) not null default 0,
  warranty_until date,
  next_km        int,
  next_date      date,
  notes          text        not null default '',
  attachments    jsonb       not null default '[]'::jsonb
);
create index if not exists vei_services_vehicle on public.vei_services (vehicle_id, date);

alter table public.vei_vehicles enable row level security;
alter table public.vei_fuel enable row level security;
alter table public.vei_services enable row level security;

drop policy if exists "vei veículos: ver" on public.vei_vehicles;
create policy "vei veículos: ver" on public.vei_vehicles for select using (public.vei_is_member());
drop policy if exists "vei veículos: administrar" on public.vei_vehicles;
create policy "vei veículos: administrar" on public.vei_vehicles for all using (public.vei_is_owner()) with check (public.vei_is_owner());

drop policy if exists "vei abastecimentos: ver" on public.vei_fuel;
create policy "vei abastecimentos: ver" on public.vei_fuel for select using (public.vei_is_member());
drop policy if exists "vei abastecimentos: lançar" on public.vei_fuel;
create policy "vei abastecimentos: lançar" on public.vei_fuel for insert with check (public.vei_is_member() and created_by = auth.uid());
drop policy if exists "vei abastecimentos: editar" on public.vei_fuel;
create policy "vei abastecimentos: editar" on public.vei_fuel for update
  using (public.vei_is_owner() or (public.vei_is_member() and created_by = auth.uid())) with check (public.vei_is_member());
drop policy if exists "vei abastecimentos: excluir" on public.vei_fuel;
create policy "vei abastecimentos: excluir" on public.vei_fuel for delete using (public.vei_is_owner() or (public.vei_is_member() and created_by = auth.uid()));

drop policy if exists "vei despesas: ver" on public.vei_services;
create policy "vei despesas: ver" on public.vei_services for select using (public.vei_is_member());
drop policy if exists "vei despesas: lançar" on public.vei_services;
create policy "vei despesas: lançar" on public.vei_services for insert with check (public.vei_is_member() and created_by = auth.uid());
drop policy if exists "vei despesas: editar" on public.vei_services;
create policy "vei despesas: editar" on public.vei_services for update
  using (public.vei_is_owner() or (public.vei_is_member() and created_by = auth.uid())) with check (public.vei_is_member());
drop policy if exists "vei despesas: excluir" on public.vei_services;
create policy "vei despesas: excluir" on public.vei_services for delete using (public.vei_is_owner() or (public.vei_is_member() and created_by = auth.uid()));

grant select, insert, update, delete on public.vei_members, public.vei_vehicles, public.vei_fuel, public.vei_services to authenticated;
grant execute on function public.vei_role(), public.vei_is_member(), public.vei_is_owner(), public.vei_join(text) to authenticated;

-- ---------- Documentos e fotos (notas, recibos, laudos) ----------
insert into storage.buckets (id, name, public, file_size_limit)
values ('veiculos', 'veiculos', false, 10485760)
on conflict (id) do nothing;
drop policy if exists "veiculos: ver" on storage.objects;
create policy "veiculos: ver" on storage.objects for select to authenticated using (bucket_id = 'veiculos' and public.vei_is_member());
drop policy if exists "veiculos: enviar" on storage.objects;
create policy "veiculos: enviar" on storage.objects for insert to authenticated with check (bucket_id = 'veiculos' and public.vei_is_member());
drop policy if exists "veiculos: apagar" on storage.objects;
create policy "veiculos: apagar" on storage.objects for delete to authenticated using (bucket_id = 'veiculos' and public.vei_is_member());
