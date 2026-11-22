-- =====================================================================
-- CASACOR — Administrador POR FRANQUIA
-- Cole no Supabase em: SQL Editor → New query → Run. Pode rodar mais de uma vez.
-- Rode DEPOIS do supabase-franquias.sql.
--
-- Antes: todo administrador via todas as franquias.
-- Agora: cada pessoa (inclusive administradores) só vê e mexe nas franquias marcadas
-- para ela em Equipe. Ex.: Fred e Cristina = administradores só do Piauí.
-- • Quem administra TODAS as franquias (administração geral) continua vendo tudo, inclusive
--   a equipe inteira.
-- • Um administrador só muda pessoas, convites, áreas e configurações das próprias franquias,
--   e não consegue se dar acesso a outra franquia.
-- • Os administradores atuais passam a ter TODAS as franquias marcadas (nada muda para eles).
-- =====================================================================

create or replace function public.my_units() returns text[]
language sql stable security definer set search_path = public as $$
  select coalesce((select units from public.members where user_id = auth.uid()), '{}')
$$;

-- Administração geral: administrador com todas as franquias marcadas
create or replace function public.is_super() returns boolean
language sql stable security definer set search_path = public as $$
  select coalesce((select m.role = 'admin' and m.units @> (select coalesce(array_agg(code), '{}') from public.units)
                     from public.members m where m.user_id = auth.uid()), false)
$$;

-- Franquia liberada para a pessoa (sem exceção para administradores)
create or replace function public.has_unit(u text) returns boolean
language sql stable security definer set search_path = public as $$
  select coalesce((select u = any(m.units) from public.members m where m.user_id = auth.uid()), false)
$$;
grant execute on function public.my_units(), public.is_super(), public.has_unit(text) to authenticated;

-- Administradores atuais: todas as franquias (a trava abaixo é desligada só para este ajuste)
alter table public.members disable trigger members_guard;
update public.members set units = (select array_agg(code order by sort) from public.units)
 where role = 'admin' and not units @> (select array_agg(code) from public.units);
alter table public.members enable trigger members_guard;

-- Mudar função, RH ou franquias de alguém: só administração, e só dentro das próprias franquias
create or replace function public.members_guard() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if new.user_id <> old.user_id or new.email <> old.email then
    raise exception 'não é possível alterar o usuário ou o e-mail';
  end if;
  if new.role is distinct from old.role or new.units is distinct from old.units or new.can_hr is distinct from old.can_hr then
    if not public.is_admin() then
      raise exception 'só a administração pode mudar função, acesso ao RH ou franquias';
    end if;
    if not public.is_super() then
      if not (new.units <@ public.my_units()) then
        raise exception 'você só pode dar acesso às suas franquias';
      end if;
      if old.role <> 'pending' and not (old.units <@ public.my_units()) then
        raise exception 'esta pessoa também é de outra franquia: fale com a administração geral';
      end if;
    end if;
    if old.role = 'admin' and new.role <> 'admin'
       and (select count(*) from public.members where role = 'admin') <= 1 then
      raise exception 'é preciso ter pelo menos uma pessoa administradora';
    end if;
  end if;
  return new;
end;
$$;

-- Equipe: cada um vê quem divide alguma franquia com ele (a administração geral vê todos;
-- administradores veem também quem está aguardando aprovação)
drop policy if exists "membros: ver" on public.members;
create policy "membros: ver" on public.members for select using (
  user_id = auth.uid() or public.is_super()
  or (public.is_member() and units && public.my_units())
  or (public.is_admin() and role = 'pending'));
drop policy if exists "membros: remover" on public.members;
create policy "membros: remover" on public.members for delete using (
  public.is_admin() and user_id <> auth.uid() and (public.is_super() or units <@ public.my_units()));

-- Convites: só para as próprias franquias
drop policy if exists "convites: administração" on public.invites;
create policy "convites: administração" on public.invites for all
  using (public.is_admin() and (public.is_super() or units <@ public.my_units()))
  with check (public.is_admin() and (public.is_super() or units <@ public.my_units()));

-- Áreas, edição, portaria: administração só da própria franquia
drop policy if exists "áreas: administrar" on public.areas;
create policy "áreas: administrar" on public.areas for all
  using (public.is_admin() and public.has_unit(unit)) with check (public.is_admin() and public.has_unit(unit));
drop policy if exists "config: alterar" on public.settings;
create policy "config: alterar" on public.settings for update
  using (public.is_admin() and public.has_unit(unit)) with check (public.is_admin() and public.has_unit(unit));
drop policy if exists "pessoas: excluir" on public.gate_people;
create policy "pessoas: excluir" on public.gate_people for delete using (public.is_admin() and public.has_unit(unit));
drop policy if exists "entradas: excluir" on public.gate_entries;
create policy "entradas: excluir" on public.gate_entries for delete using (public.is_admin() and public.has_unit(unit));

-- Criar ou renomear franquias: só a administração geral
drop policy if exists "franquias: administrar" on public.units;
create policy "franquias: administrar" on public.units for all using (public.is_super()) with check (public.is_super());

-- Primeira pessoa (instalação nova) vira administração geral, com todas as franquias
create or replace function public.join_team(p_name text) returns text
language plpgsql security definer set search_path = public as $$
declare r text;
begin
  if auth.uid() is null then raise exception 'não autenticado'; end if;
  select role into r from public.members where user_id = auth.uid();
  if r is not null then return r; end if;
  r := case when exists (select 1 from public.members where role = 'admin') then 'pending' else 'admin' end;
  insert into public.members (user_id, email, name, role, units)
  values (auth.uid(), coalesce(auth.jwt() ->> 'email', ''), coalesce(nullif(trim(p_name), ''), 'Sem nome'), r,
          case when r = 'admin' then (select coalesce(array_agg(code order by sort), '{ce}') from public.units) else '{ce}' end);
  return r;
end;
$$;
