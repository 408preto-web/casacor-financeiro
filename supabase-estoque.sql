-- =====================================================================
-- CASACOR — Estoque (cabos, cimento, areia…) por franquia
-- Cole no Supabase em: SQL Editor → New query → Run. Pode rodar mais de uma vez.
-- Rode DEPOIS do supabase-franquias.sql.
--
-- • Itens com saldo: levantamento (contagem), entradas e saídas.
-- • A compra lançada com itens entra no estoque SOZINHA quando a conta é marcada como paga
--   (e sai de novo se o pagamento for desfeito).
-- • A equipe toda (inclusive compradores) vê e movimenta o estoque — só quantidades, sem valores.
-- =====================================================================

create table if not exists public.stock_items (
  id         uuid primary key default gen_random_uuid(),
  unit       text        not null default 'ce' references public.units (code),
  name       text        not null,
  measure    text        not null default 'unidade',   -- m, unidade, saco, m³, kg, litro, rolo…
  grp        text        not null default 'Outros',    -- Elétrica, Construção, Hidráulica…
  min_qty    numeric(14, 3),                            -- avisa quando o saldo ficar abaixo
  notes      text        not null default '',
  active     boolean     not null default true,
  created_by uuid        default auth.uid(),
  created_at timestamptz not null default now()
);
create unique index if not exists stock_items_unit_name on public.stock_items (unit, lower(name));

create table if not exists public.stock_moves (
  id         uuid primary key default gen_random_uuid(),
  unit       text        not null default 'ce' references public.units (code),
  item_id    uuid        not null references public.stock_items (id) on delete cascade,
  kind       text        not null check (kind in ('in', 'out', 'count')),  -- entrada, saída, contagem
  qty        numeric(14, 3) not null check (qty >= 0),
  date       date        not null default current_date,
  bill_id    uuid        references public.bills (id) on delete cascade,
  dest       text        not null default '',          -- para onde foi (ambiente, obra, evento)
  note       text        not null default '',
  created_by uuid        default auth.uid(),
  created_at timestamptz not null default now()
);
create index if not exists stock_moves_item on public.stock_moves (item_id, date, created_at);

-- Itens da compra na própria conta: [{item_id, name, qty, measure}]
alter table public.bills add column if not exists items jsonb not null default '[]'::jsonb;

alter table public.stock_items enable row level security;
alter table public.stock_moves enable row level security;
drop policy if exists "estoque itens: ver" on public.stock_items;
create policy "estoque itens: ver" on public.stock_items for select using (public.is_member() and public.has_unit(unit));
drop policy if exists "estoque itens: cadastrar" on public.stock_items;
create policy "estoque itens: cadastrar" on public.stock_items for insert with check (public.is_member() and public.has_unit(unit));
drop policy if exists "estoque itens: alterar" on public.stock_items;
create policy "estoque itens: alterar" on public.stock_items for update
  using (public.is_member() and public.has_unit(unit)) with check (public.is_member() and public.has_unit(unit));
drop policy if exists "estoque itens: excluir" on public.stock_items;
create policy "estoque itens: excluir" on public.stock_items for delete using (public.has_unit(unit) and (public.is_admin() or created_by = auth.uid()));

drop policy if exists "estoque movimentos: ver" on public.stock_moves;
create policy "estoque movimentos: ver" on public.stock_moves for select using (public.is_member() and public.has_unit(unit));
drop policy if exists "estoque movimentos: lançar" on public.stock_moves;
create policy "estoque movimentos: lançar" on public.stock_moves for insert
  with check (public.is_member() and public.has_unit(unit) and bill_id is null
              and exists (select 1 from public.stock_items i where i.id = item_id and i.unit = stock_moves.unit));
drop policy if exists "estoque movimentos: corrigir" on public.stock_moves;
create policy "estoque movimentos: corrigir" on public.stock_moves for update
  using (public.has_unit(unit) and bill_id is null and (public.is_admin() or created_by = auth.uid()))
  with check (public.has_unit(unit) and bill_id is null);
drop policy if exists "estoque movimentos: apagar" on public.stock_moves;
create policy "estoque movimentos: apagar" on public.stock_moves for delete
  using (public.has_unit(unit) and bill_id is null and (public.is_admin() or created_by = auth.uid()));
grant select, insert, update, delete on public.stock_items, public.stock_moves to authenticated;

-- Conta paga → itens entram no estoque; pagamento desfeito / conta cancelada → saem
create or replace function public.stock_from_bill() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if new.status = 'paid' and (tg_op = 'INSERT' or old.status is distinct from 'paid') then
    if not exists (select 1 from public.stock_moves where bill_id = new.id) then
      insert into public.stock_moves (unit, item_id, kind, qty, date, bill_id, note, created_by)
      select new.unit, i.id, 'in', (x ->> 'qty')::numeric, coalesce(new.paid_at, current_date), new.id,
             'Compra: ' || new.supplier, new.created_by
        from jsonb_array_elements(coalesce(new.items, '[]'::jsonb)) x
        join public.stock_items i on i.id::text = x ->> 'item_id' and i.unit = new.unit
       where coalesce((x ->> 'qty')::numeric, 0) > 0;
    end if;
  elsif tg_op = 'UPDATE' and old.status = 'paid' and new.status <> 'paid' then
    delete from public.stock_moves where bill_id = new.id and kind = 'in';
  end if;
  return new;
end;
$$;
drop trigger if exists stock_from_bill on public.bills;
create trigger stock_from_bill after insert or update of status on public.bills
  for each row execute function public.stock_from_bill();
