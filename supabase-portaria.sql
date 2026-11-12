-- =====================================================================
-- Casa Cor Ceará — Portaria da obra
-- Cole no Supabase em: SQL Editor → New query → Run. Pode rodar mais de uma vez.
-- Cria a função "Porteiro" (só vê a portaria), ambientes, pessoas e entradas/saídas.
-- =====================================================================

-- Nova função: porteiro
alter table public.members drop constraint if exists members_role_check;
alter table public.members add constraint members_role_check
  check (role in ('pending', 'member', 'payer', 'admin', 'blocked', 'gate'));

-- Quem pode usar a portaria: porteiro + equipe aprovada
create or replace function public.is_gate() returns boolean
language sql stable security definer set search_path = public as $$
  select coalesce(public.my_role() in ('gate', 'member', 'payer', 'admin'), false)
$$;
grant execute on function public.is_gate() to authenticated;

-- ---------- Ambientes ----------
create table if not exists public.gate_envs (
  id         bigint generated always as identity primary key,
  number     text    not null default '',
  name       text    not null,
  architect  text    not null default '',
  active     boolean not null default true,
  created_at timestamptz not null default now()
);
alter table public.gate_envs enable row level security;
drop policy if exists "ambientes: ver" on public.gate_envs;
create policy "ambientes: ver" on public.gate_envs for select using (public.is_gate());
drop policy if exists "ambientes: cadastrar" on public.gate_envs;
create policy "ambientes: cadastrar" on public.gate_envs for all using (public.is_member()) with check (public.is_member());
insert into public.gate_envs (number, name, architect)
select '', 'Áreas comuns / obra geral', 'Casa Cor'
where not exists (select 1 from public.gate_envs);

-- ---------- Pessoas ----------
create table if not exists public.gate_people (
  id           uuid primary key default gen_random_uuid(),
  created_at   timestamptz not null default now(),
  created_by   uuid        default auth.uid() references auth.users (id),
  name         text        not null,
  cpf          text        not null default '',
  company      text        not null default '',
  phone        text        not null default '',
  is_team      boolean     not null default false,   -- equipe Casa Cor (crachá)
  blocked      boolean     not null default false,
  block_reason text        not null default '',
  last_env_id  bigint      references public.gate_envs (id) on delete set null,
  last_service text        not null default ''
);
create unique index if not exists gate_people_cpf on public.gate_people (cpf) where cpf <> '';

-- Porteiro não pode desbloquear nem marcar como equipe (só a equipe aprovada)
create or replace function public.gate_people_guard() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if tg_op = 'UPDATE' and (new.blocked is distinct from old.blocked or new.is_team is distinct from old.is_team) and not public.is_member() then
    raise exception 'só a administração pode bloquear/desbloquear ou marcar como equipe';
  end if;
  if tg_op = 'INSERT' and (new.blocked or new.is_team) and not public.is_member() then
    raise exception 'só a administração pode bloquear ou marcar como equipe';
  end if;
  return new;
end;
$$;
drop trigger if exists gate_people_guard on public.gate_people;
create trigger gate_people_guard before insert or update on public.gate_people
  for each row execute function public.gate_people_guard();

alter table public.gate_people enable row level security;
drop policy if exists "pessoas: ver" on public.gate_people;
create policy "pessoas: ver" on public.gate_people for select using (public.is_gate());
drop policy if exists "pessoas: cadastrar" on public.gate_people;
create policy "pessoas: cadastrar" on public.gate_people for insert with check (public.is_gate());
drop policy if exists "pessoas: alterar" on public.gate_people;
create policy "pessoas: alterar" on public.gate_people for update using (public.is_gate()) with check (public.is_gate());
drop policy if exists "pessoas: excluir" on public.gate_people;
create policy "pessoas: excluir" on public.gate_people for delete using (public.is_admin());

-- ---------- Entradas e saídas ----------
create table if not exists public.gate_entries (
  id         uuid primary key default gen_random_uuid(),
  person_id  uuid        not null references public.gate_people (id) on delete cascade,
  env_id     bigint      references public.gate_envs (id) on delete set null,
  service    text        not null default '',
  entered_at timestamptz not null default now(),
  exited_at  timestamptz,
  created_by uuid        default auth.uid() references auth.users (id),
  exited_by  uuid        references auth.users (id),
  notes      text        not null default ''
);
create index if not exists gate_entries_day on public.gate_entries (entered_at);
create index if not exists gate_entries_open on public.gate_entries (person_id) where exited_at is null;
alter table public.gate_entries enable row level security;
drop policy if exists "entradas: ver" on public.gate_entries;
create policy "entradas: ver" on public.gate_entries for select using (public.is_gate());
drop policy if exists "entradas: registrar" on public.gate_entries;
create policy "entradas: registrar" on public.gate_entries for insert with check (public.is_gate());
drop policy if exists "entradas: saída" on public.gate_entries;
create policy "entradas: saída" on public.gate_entries for update using (public.is_gate()) with check (public.is_gate());
drop policy if exists "entradas: excluir" on public.gate_entries;
create policy "entradas: excluir" on public.gate_entries for delete using (public.is_admin());

grant select, insert, update, delete on public.gate_envs, public.gate_people, public.gate_entries to authenticated;

-- ---------- Convites (link pelo WhatsApp: a pessoa entra já com a função certa, sem esperar aprovação) ----------
create table if not exists public.invites (
  token      uuid        primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  name       text        not null,
  role       text        not null check (role in ('member', 'payer', 'gate')),
  created_by uuid        default auth.uid(),
  used_by    uuid,
  used_at    timestamptz,
  expires_at timestamptz not null default now() + interval '7 days'
);
alter table public.invites enable row level security;
drop policy if exists "convites: administração" on public.invites;
create policy "convites: administração" on public.invites for all using (public.is_admin()) with check (public.is_admin());
grant select, insert, delete on public.invites to authenticated;

create or replace function public.accept_invite(p_token uuid, p_name text) returns text
language plpgsql security definer set search_path = public as $$
declare
  inv public.invites;
  r text;
begin
  if auth.uid() is null then
    raise exception 'não autenticado';
  end if;
  select role into r from public.members where user_id = auth.uid();
  if r in ('member', 'payer', 'admin', 'gate') then
    return r; -- já tem acesso: o convite fica livre
  end if;
  select * into inv from public.invites
   where token = p_token and used_at is null and expires_at > now() for update;
  if not found then
    raise exception 'Este convite já foi usado ou venceu. Peça um novo para a administração.';
  end if;
  delete from public.members where user_id = auth.uid(); -- pedido pendente (ou recusado) é substituído pelo convite
  insert into public.members (user_id, email, name, role)
  values (auth.uid(), coalesce(auth.jwt() ->> 'email', ''), coalesce(nullif(trim(p_name), ''), inv.name), inv.role);
  update public.invites set used_by = auth.uid(), used_at = now() where token = inv.token;
  return inv.role;
end;
$$;
grant execute on function public.accept_invite(uuid, text) to authenticated;
