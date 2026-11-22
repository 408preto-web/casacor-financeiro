-- =====================================================================
-- CASACOR — Comprador restrito: lança compras e vê SÓ o que ele mesmo lançou
-- Cole no Supabase em: SQL Editor → New query → Run. Pode rodar mais de uma vez.
-- Rode DEPOIS do supabase-franquias.sql e do supabase-admin-franquia.sql.
--
-- • Em Equipe, marque "Vê só o que lança" num Comprador (ou convide como
--   "Comprador — vê só o que ele lança").
-- • Ele não vê as contas dos outros, nem a portaria e a obra (o banco bloqueia).
-- =====================================================================

alter table public.members add column if not exists only_own boolean not null default false;
alter table public.invites add column if not exists only_own boolean not null default false;

-- Comprador restrito (só vale para a função Comprador)
create or replace function public.only_own() returns boolean
language sql stable security definer set search_path = public as $$
  select coalesce((select m.only_own and m.role = 'member' from public.members m where m.user_id = auth.uid()), false)
$$;
grant execute on function public.only_own() to authenticated;

-- Portaria e obra: não para o comprador restrito (o porteiro continua igual)
create or replace function public.is_gate() returns boolean
language sql stable security definer set search_path = public as $$
  select coalesce(public.my_role() = 'gate' or (public.my_role() in ('member', 'payer', 'admin') and not public.only_own()), false)
$$;

-- Contas: o restrito só vê e altera as que ele lançou
drop policy if exists "contas: ver" on public.bills;
create policy "contas: ver" on public.bills for select
  using (public.is_member() and public.has_unit(unit) and (employee_id is null or public.is_hr())
         and (not public.only_own() or created_by = auth.uid()));
drop policy if exists "contas: lançar" on public.bills;
create policy "contas: lançar" on public.bills for insert
  with check (public.is_member() and public.has_unit(unit) and (employee_id is null or public.is_hr()));
drop policy if exists "contas: editar" on public.bills;
create policy "contas: editar" on public.bills for update
  using (public.is_member() and public.has_unit(unit) and (employee_id is null or public.is_hr())
         and (not public.only_own() or created_by = auth.uid()))
  with check (public.is_member() and public.has_unit(unit) and (employee_id is null or public.is_hr()));

drop policy if exists "obra etapas: ver" on public.obra_stages;
create policy "obra etapas: ver" on public.obra_stages for select using (public.is_member() and not public.only_own() and public.has_unit(unit));
drop policy if exists "obra etapas: editar" on public.obra_stages;
create policy "obra etapas: editar" on public.obra_stages for all
  using (public.is_member() and not public.only_own() and public.has_unit(unit)) with check (public.is_member() and not public.only_own() and public.has_unit(unit));
drop policy if exists "obra atualizações: ver" on public.obra_updates;
create policy "obra atualizações: ver" on public.obra_updates for select using (public.is_member() and not public.only_own() and public.has_unit(unit));
drop policy if exists "obra atualizações: registrar" on public.obra_updates;
create policy "obra atualizações: registrar" on public.obra_updates for insert with check (public.is_member() and not public.only_own() and public.has_unit(unit));

-- Só a administração muda isso (junto com função, RH e franquias)
create or replace function public.members_guard() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if new.user_id <> old.user_id or new.email <> old.email then
    raise exception 'não é possível alterar o usuário ou o e-mail';
  end if;
  if new.role is distinct from old.role or new.units is distinct from old.units or new.can_hr is distinct from old.can_hr
     or new.only_own is distinct from old.only_own then
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

-- Convite já pode vir como comprador restrito
create or replace function public.accept_invite(p_token uuid, p_name text) returns text
language plpgsql security definer set search_path = public as $$
declare
  inv public.invites;
  r text;
begin
  if auth.uid() is null then raise exception 'não autenticado'; end if;
  select role into r from public.members where user_id = auth.uid();
  if r in ('member', 'payer', 'admin', 'gate') then return r; end if;
  select * into inv from public.invites where token = p_token and used_at is null and expires_at > now() for update;
  if not found then raise exception 'Este convite já foi usado ou venceu. Peça um novo para a administração.'; end if;
  delete from public.members where user_id = auth.uid();
  insert into public.members (user_id, email, name, role, units, only_own)
  values (auth.uid(), coalesce(auth.jwt() ->> 'email', ''), coalesce(nullif(trim(p_name), ''), inv.name), inv.role,
          coalesce(nullif(inv.units, '{}'), '{ce}'), inv.only_own and inv.role = 'member');
  update public.invites set used_by = auth.uid(), used_at = now() where token = inv.token;
  return inv.role;
end;
$$;
grant execute on function public.accept_invite(uuid, text) to authenticated;

-- Ambientes da portaria/obra: cadastrar também não é para o comprador restrito
drop policy if exists "ambientes: cadastrar" on public.gate_envs;
create policy "ambientes: cadastrar" on public.gate_envs for all
  using (public.is_member() and not public.only_own() and public.has_unit(unit))
  with check (public.is_member() and not public.only_own() and public.has_unit(unit));
