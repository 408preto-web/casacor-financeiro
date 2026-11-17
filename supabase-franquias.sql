-- =====================================================================
-- CASACOR — Franquias (Ceará, Piauí…) no mesmo sistema
-- Cole no Supabase em: SQL Editor → New query → Run. Pode rodar mais de uma vez.
-- Rode DEPOIS dos outros scripts (supabase.sql, supabase-rh.sql, supabase-portaria.sql).
--
-- • Tudo o que já existe passa a ser da franquia Ceará ('ce').
-- • Cada conta, cartão, área, funcionário, ocorrência e registro da portaria
--   pertence a uma franquia. O banco só mostra as franquias liberadas para a pessoa.
-- • Administradores veem todas. Os outros veem as marcadas em Equipe.
-- =====================================================================

-- ---------- Franquias ----------
create table if not exists public.units (
  code text primary key,
  name text not null,
  sort int  not null default 0
);
insert into public.units (code, name, sort) values ('ce', 'Ceará', 1), ('pi', 'Piauí', 2)
on conflict (code) do nothing;
alter table public.units enable row level security;
drop policy if exists "franquias: ver" on public.units;
create policy "franquias: ver" on public.units for select using (auth.uid() is not null);
drop policy if exists "franquias: administrar" on public.units;
create policy "franquias: administrar" on public.units for all using (public.is_admin()) with check (public.is_admin());
grant select, insert, update, delete on public.units to authenticated;

-- Quais franquias cada pessoa acessa (administrador: todas)
alter table public.members add column if not exists units text[] not null default '{ce}';

create or replace function public.has_unit(u text) returns boolean
language sql stable security definer set search_path = public as $$
  select coalesce((select m.role = 'admin' or u = any(m.units) from public.members m where m.user_id = auth.uid()), false)
$$;
grant execute on function public.has_unit(text) to authenticated;

-- Só a administração muda função, RH e franquias de alguém
create or replace function public.members_guard() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if new.user_id <> old.user_id or new.email <> old.email then
    raise exception 'não é possível alterar o usuário ou o e-mail';
  end if;
  if new.can_hr is distinct from old.can_hr and not public.is_admin() then
    raise exception 'só a administração pode liberar o acesso ao RH';
  end if;
  if new.units is distinct from old.units and not public.is_admin() then
    raise exception 'só a administração pode mudar as franquias de alguém';
  end if;
  if new.role is distinct from old.role then
    if not public.is_admin() then
      raise exception 'só a administração pode mudar a função';
    end if;
    if old.role = 'admin' and new.role <> 'admin'
       and (select count(*) from public.members where role = 'admin') <= 1 then
      raise exception 'é preciso ter pelo menos uma pessoa administradora';
    end if;
  end if;
  return new;
end;
$$;

-- ---------- Coluna "unit" em tudo o que é separado por franquia ----------
alter table public.areas        add column if not exists unit text not null default 'ce' references public.units (code);
alter table public.cards        add column if not exists unit text not null default 'ce' references public.units (code);
alter table public.settings     add column if not exists unit text not null default 'ce' references public.units (code);
alter table public.bills        add column if not exists unit text not null default 'ce' references public.units (code);
alter table public.employees    add column if not exists unit text not null default 'ce' references public.units (code);
alter table public.hr_events    add column if not exists unit text not null default 'ce' references public.units (code);
alter table public.gate_envs    add column if not exists unit text not null default 'ce' references public.units (code);
alter table public.gate_people  add column if not exists unit text not null default 'ce' references public.units (code);
alter table public.gate_entries add column if not exists unit text not null default 'ce' references public.units (code);
alter table public.invites      add column if not exists units text[] not null default '{ce}';

create index if not exists bills_unit on public.bills (unit, due_date);
create index if not exists gate_entries_unit on public.gate_entries (unit, entered_at);

-- Configurações: uma linha por franquia (antes era uma só, id = 1)
alter table public.settings drop constraint if exists settings_id_check;
alter table public.settings drop constraint if exists settings_pkey;
alter table public.settings alter column id drop default;
alter table public.settings alter column id drop not null;
do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'settings_unit_key') then
    alter table public.settings add constraint settings_unit_key unique (unit);
  end if;
end $$;

-- O mesmo CPF pode trabalhar nas duas obras
drop index if exists public.gate_people_cpf;
create unique index if not exists gate_people_unit_cpf on public.gate_people (unit, cpf) where cpf <> '';

-- ---------- Piauí começa com o mesmo jeito do Ceará ----------
insert into public.settings (unit, edition)
select u.code, to_char(now(), 'YYYY') from public.units u
where not exists (select 1 from public.settings s where s.unit = u.code);

insert into public.areas (name, color, sort, unit)
select a.name, a.color, a.sort, u.code
from public.units u
cross join (select distinct on (name) name, color, sort from public.areas where unit = 'ce' and active order by name, sort) a
where u.code <> 'ce' and not exists (select 1 from public.areas x where x.unit = u.code);

insert into public.gate_envs (name, architect, unit)
select 'Áreas comuns / obra geral', 'CASACOR', u.code from public.units u
where u.code <> 'ce' and not exists (select 1 from public.gate_envs x where x.unit = u.code);

-- ---------- Regras de acesso: + franquia ----------
drop policy if exists "áreas: ver" on public.areas;
create policy "áreas: ver" on public.areas for select using (public.is_member() and public.has_unit(unit));
drop policy if exists "áreas: administrar" on public.areas;
create policy "áreas: administrar" on public.areas for all using (public.is_admin()) with check (public.is_admin());

drop policy if exists "cartões: ver" on public.cards;
create policy "cartões: ver" on public.cards for select using (public.is_member() and public.has_unit(unit));
drop policy if exists "cartões: administrar" on public.cards;
create policy "cartões: administrar" on public.cards for all
  using (public.is_payer() and public.has_unit(unit)) with check (public.is_payer() and public.has_unit(unit));

drop policy if exists "config: ver" on public.settings;
create policy "config: ver" on public.settings for select using (public.is_member() and public.has_unit(unit));
drop policy if exists "config: alterar" on public.settings;
create policy "config: alterar" on public.settings for update using (public.is_admin()) with check (public.is_admin());

drop policy if exists "contas: ver" on public.bills;
create policy "contas: ver" on public.bills for select
  using (public.is_member() and public.has_unit(unit) and (employee_id is null or public.is_hr()));
drop policy if exists "contas: lançar" on public.bills;
create policy "contas: lançar" on public.bills for insert
  with check (public.is_member() and public.has_unit(unit) and (employee_id is null or public.is_hr()));
drop policy if exists "contas: editar" on public.bills;
create policy "contas: editar" on public.bills for update
  using (public.is_member() and public.has_unit(unit) and (employee_id is null or public.is_hr()))
  with check (public.is_member() and public.has_unit(unit) and (employee_id is null or public.is_hr()));
drop policy if exists "contas: excluir" on public.bills;
create policy "contas: excluir" on public.bills for delete
  using ((public.is_admin() or (created_by = auth.uid() and status = 'pending')) and public.has_unit(unit) and (employee_id is null or public.is_hr()));

drop policy if exists "funcionários: RH" on public.employees;
create policy "funcionários: RH" on public.employees for all
  using (public.is_hr() and public.has_unit(unit)) with check (public.is_hr() and public.has_unit(unit));
drop policy if exists "ocorrências: RH" on public.hr_events;
create policy "ocorrências: RH" on public.hr_events for all
  using (public.is_hr() and public.has_unit(unit)) with check (public.is_hr() and public.has_unit(unit));

drop policy if exists "ambientes: ver" on public.gate_envs;
create policy "ambientes: ver" on public.gate_envs for select using (public.is_gate() and public.has_unit(unit));
drop policy if exists "ambientes: cadastrar" on public.gate_envs;
create policy "ambientes: cadastrar" on public.gate_envs for all
  using (public.is_member() and public.has_unit(unit)) with check (public.is_member() and public.has_unit(unit));

drop policy if exists "pessoas: ver" on public.gate_people;
create policy "pessoas: ver" on public.gate_people for select using (public.is_gate() and public.has_unit(unit));
drop policy if exists "pessoas: cadastrar" on public.gate_people;
create policy "pessoas: cadastrar" on public.gate_people for insert with check (public.is_gate() and public.has_unit(unit));
drop policy if exists "pessoas: alterar" on public.gate_people;
create policy "pessoas: alterar" on public.gate_people for update
  using (public.is_gate() and public.has_unit(unit)) with check (public.is_gate() and public.has_unit(unit));
drop policy if exists "pessoas: excluir" on public.gate_people;
create policy "pessoas: excluir" on public.gate_people for delete using (public.is_admin());

drop policy if exists "entradas: ver" on public.gate_entries;
create policy "entradas: ver" on public.gate_entries for select using (public.is_gate() and public.has_unit(unit));
drop policy if exists "entradas: registrar" on public.gate_entries;
create policy "entradas: registrar" on public.gate_entries for insert with check (public.is_gate() and public.has_unit(unit));
drop policy if exists "entradas: saída" on public.gate_entries;
create policy "entradas: saída" on public.gate_entries for update
  using (public.is_gate() and public.has_unit(unit)) with check (public.is_gate() and public.has_unit(unit));
drop policy if exists "entradas: excluir" on public.gate_entries;
create policy "entradas: excluir" on public.gate_entries for delete using (public.is_admin());

-- ---------- Convite já leva as franquias da pessoa ----------
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
  delete from public.members where user_id = auth.uid();
  insert into public.members (user_id, email, name, role, units)
  values (auth.uid(), coalesce(auth.jwt() ->> 'email', ''), coalesce(nullif(trim(p_name), ''), inv.name), inv.role,
          coalesce(nullif(inv.units, '{}'), '{ce}'));
  update public.invites set used_by = auth.uid(), used_at = now() where token = inv.token;
  return inv.role;
end;
$$;
grant execute on function public.accept_invite(uuid, text) to authenticated;
