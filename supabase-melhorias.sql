-- =====================================================================
-- CASACOR — Melhorias: aprovação de compras, orçamento por área, fluxo de caixa
-- Cole no Supabase em: SQL Editor → New query → Run. Pode rodar mais de uma vez.
-- Rode DEPOIS dos outros scripts (franquias, admin-franquia, comprador-restrito, estoque).
-- =====================================================================

-- ---------- 1. Aprovação de compras ----------
-- Conta lançada por Comprador vira SOLICITAÇÃO; Pagador/Administrador aprova (vira "a pagar") ou recusa.
alter table public.bills add column if not exists approval text not null default 'approved';
do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'bills_approval_check') then
    alter table public.bills add constraint bills_approval_check check (approval in ('requested', 'approved', 'rejected'));
  end if;
end $$;
alter table public.bills add column if not exists approval_by uuid;
alter table public.bills add column if not exists approval_at timestamptz;
alter table public.bills add column if not exists approval_note text not null default '';

create or replace function public.bills_approval_guard() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if tg_op = 'INSERT' then
    if public.my_role() = 'member' then            -- comprador: sempre solicitação
      new.approval := 'requested'; new.status := 'pending';
    elsif new.approval = 'requested' and public.is_payer() then
      new.approval := 'approved';
    end if;
    return new;
  end if;
  if new.approval is distinct from old.approval then
    if not public.is_payer() then raise exception 'só quem paga pode aprovar ou recusar compras'; end if;
    new.approval_by := auth.uid(); new.approval_at := now();
  end if;
  if new.status = 'paid' and new.approval <> 'approved' then   -- pagou = aprovou
    new.approval := 'approved'; new.approval_by := auth.uid(); new.approval_at := now();
  end if;
  return new;
end;
$$;
drop trigger if exists bills_approval_guard on public.bills;
create trigger bills_approval_guard before insert or update on public.bills
  for each row execute function public.bills_approval_guard();

-- ---------- 2. Orçamento por área (por edição) ----------
create table if not exists public.area_budgets (
  id      uuid primary key default gen_random_uuid(),
  unit    text   not null default 'ce' references public.units (code),
  area_id bigint not null references public.areas (id) on delete cascade,
  edition text   not null default '',
  amount  numeric(14, 2) not null check (amount >= 0),
  unique (area_id, edition)
);
alter table public.area_budgets enable row level security;
drop policy if exists "orçamento: ver" on public.area_budgets;
create policy "orçamento: ver" on public.area_budgets for select using (public.is_payer() and public.has_unit(unit));
drop policy if exists "orçamento: definir" on public.area_budgets;
create policy "orçamento: definir" on public.area_budgets for all
  using (public.is_admin() and public.has_unit(unit)) with check (public.is_admin() and public.has_unit(unit));
grant select, insert, update, delete on public.area_budgets to authenticated;

-- ---------- 3. Fluxo de caixa: saldo em conta informado ----------
alter table public.settings add column if not exists cash_balance numeric(14, 2);
alter table public.settings add column if not exists cash_at date;
drop policy if exists "config: saldo" on public.settings;
create policy "config: saldo" on public.settings for update
  using (public.is_payer() and public.has_unit(unit)) with check (public.is_payer() and public.has_unit(unit));
