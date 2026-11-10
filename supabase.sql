-- =====================================================================
-- Casa Cor Ceará — Controle de Pagamentos
-- Cole este script no Supabase em: SQL Editor → New query → Run.
-- Pode ser executado mais de uma vez sem perder dados.
-- =====================================================================

-- ---------- Equipe ----------
create table if not exists public.members (
  user_id    uuid primary key references auth.users (id) on delete cascade,
  email      text        not null default '',
  name       text        not null default '',
  role       text        not null default 'pending'
             check (role in ('pending', 'member', 'payer', 'admin', 'blocked')),
  area       text        not null default '',
  created_at timestamptz not null default now()
);

-- Funções de permissão (usadas pelas regras de acesso abaixo)
create or replace function public.my_role() returns text
language sql stable security definer set search_path = public as $$
  select role from public.members where user_id = auth.uid()
$$;
create or replace function public.is_member() returns boolean
language sql stable security definer set search_path = public as $$
  select coalesce(public.my_role() in ('member', 'payer', 'admin'), false)
$$;
create or replace function public.is_payer() returns boolean
language sql stable security definer set search_path = public as $$
  select coalesce(public.my_role() in ('payer', 'admin'), false)
$$;
create or replace function public.is_admin() returns boolean
language sql stable security definer set search_path = public as $$
  select coalesce(public.my_role() = 'admin', false)
$$;

-- Entrar na equipe depois de criar a conta.
-- A primeira pessoa vira administradora; as demais aguardam aprovação.
create or replace function public.join_team(p_name text) returns text
language plpgsql security definer set search_path = public as $$
declare
  r text;
begin
  if auth.uid() is null then
    raise exception 'não autenticado';
  end if;
  select role into r from public.members where user_id = auth.uid();
  if r is not null then
    return r;
  end if;
  if exists (select 1 from public.members where role = 'admin') then
    r := 'pending';
  else
    r := 'admin';
  end if;
  insert into public.members (user_id, email, name, role)
  values (auth.uid(), coalesce(auth.jwt() ->> 'email', ''), coalesce(nullif(trim(p_name), ''), 'Sem nome'), r);
  return r;
end;
$$;

-- Só a administração muda funções; nunca fica sem administrador.
create or replace function public.members_guard() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if new.user_id <> old.user_id or new.email <> old.email then
    raise exception 'não é possível alterar o usuário ou o e-mail';
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
drop trigger if exists members_guard on public.members;
create trigger members_guard before update on public.members
  for each row execute function public.members_guard();

alter table public.members enable row level security;
drop policy if exists "membros: ver" on public.members;
create policy "membros: ver" on public.members
  for select using (public.is_member() or user_id = auth.uid());
drop policy if exists "membros: alterar" on public.members;
create policy "membros: alterar" on public.members
  for update using (public.is_admin() or user_id = auth.uid());
drop policy if exists "membros: remover" on public.members;
create policy "membros: remover" on public.members
  for delete using (public.is_admin() and user_id <> auth.uid());

-- ---------- Áreas ----------
create table if not exists public.areas (
  id     bigint generated always as identity primary key,
  name   text    not null,
  color  text    not null default '#64748b',
  sort   int     not null default 0,
  active boolean not null default true
);
alter table public.areas enable row level security;
drop policy if exists "áreas: ver" on public.areas;
create policy "áreas: ver" on public.areas for select using (public.is_member());
drop policy if exists "áreas: administrar" on public.areas;
create policy "áreas: administrar" on public.areas for all using (public.is_admin()) with check (public.is_admin());

insert into public.areas (name, color, sort)
select v.name, v.color, v.sort
from (values ('Obra', '#ea580c', 1), ('Comercial', '#2563eb', 2), ('Eventos', '#db2777', 3),
             ('Marketing', '#7c3aed', 4), ('Administrativo', '#0f766e', 5)) as v(name, color, sort)
where not exists (select 1 from public.areas);

-- ---------- Cartões da empresa ----------
create table if not exists public.cards (
  id          uuid primary key default gen_random_uuid(),
  name        text    not null,
  final       text    not null default '',
  closing_day int     not null default 1 check (closing_day between 1 and 31),
  due_day     int     not null default 10 check (due_day between 1 and 31),
  color       text    not null default '#475569',
  active      boolean not null default true
);
alter table public.cards enable row level security;
drop policy if exists "cartões: ver" on public.cards;
create policy "cartões: ver" on public.cards for select using (public.is_member());
drop policy if exists "cartões: administrar" on public.cards;
create policy "cartões: administrar" on public.cards for all using (public.is_payer()) with check (public.is_payer());

-- ---------- Configurações gerais (edição atual do evento) ----------
create table if not exists public.settings (
  id      int  primary key default 1 check (id = 1),
  edition text not null default ''
);
insert into public.settings (id, edition)
values (1, to_char(now(), 'YYYY'))
on conflict (id) do nothing;
alter table public.settings enable row level security;
drop policy if exists "config: ver" on public.settings;
create policy "config: ver" on public.settings for select using (public.is_member());
drop policy if exists "config: alterar" on public.settings;
create policy "config: alterar" on public.settings for update using (public.is_admin()) with check (public.is_admin());

-- ---------- Contas a pagar ----------
create table if not exists public.bills (
  id             uuid primary key default gen_random_uuid(),
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),
  created_by     uuid        not null default auth.uid() references auth.users (id),
  purchase_date  date        not null default current_date,
  supplier       text        not null,
  description    text        not null default '',
  area_id        bigint      references public.areas (id),
  edition        text        not null default '',
  amount         numeric(12, 2) not null check (amount > 0),
  due_date       date        not null,
  method         text        not null check (method in ('pix', 'boleto', 'cartao', 'transferencia', 'dinheiro')),
  pix_key        text        not null default '',
  boleto_code    text        not null default '',
  bank_info      text        not null default '',
  card_id        uuid        references public.cards (id),
  installment    text        not null default '',
  group_id       uuid,
  notes          text        not null default '',
  status         text        not null default 'pending' check (status in ('pending', 'paid', 'cancelled')),
  paid_at        date,
  paid_by        uuid        references auth.users (id),
  paid_amount    numeric(12, 2),
  payment_notes  text        not null default '',
  attachments    jsonb       not null default '[]'::jsonb
);
create index if not exists bills_due on public.bills (status, due_date);
create index if not exists bills_group on public.bills (group_id);

-- Regras: qualquer pessoa da equipe lança e edita contas em aberto;
-- só quem paga (você e sua mãe) marca como paga ou altera contas já pagas.
create or replace function public.bills_guard() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if tg_op = 'INSERT' then
    new.created_by := coalesce(auth.uid(), new.created_by);
    if new.status <> 'pending' and not public.is_payer() then
      raise exception 'só quem paga pode lançar contas já pagas';
    end if;
    new.updated_at := now();
    return new;
  end if;
  if new.created_by is distinct from old.created_by then
    raise exception 'não é possível alterar quem lançou a conta';
  end if;
  if (new.status is distinct from old.status
      or new.paid_at is distinct from old.paid_at
      or new.paid_by is distinct from old.paid_by
      or new.paid_amount is distinct from old.paid_amount)
     and not public.is_payer() then
    raise exception 'só quem paga pode marcar ou desmarcar pagamentos';
  end if;
  if old.status = 'paid' and not public.is_payer() then
    raise exception 'esta conta já foi paga: só quem paga pode alterá-la';
  end if;
  new.updated_at := now();
  return new;
end;
$$;
drop trigger if exists bills_guard on public.bills;
create trigger bills_guard before insert or update on public.bills
  for each row execute function public.bills_guard();

alter table public.bills enable row level security;
drop policy if exists "contas: ver" on public.bills;
create policy "contas: ver" on public.bills for select using (public.is_member());
drop policy if exists "contas: lançar" on public.bills;
create policy "contas: lançar" on public.bills for insert with check (public.is_member());
drop policy if exists "contas: editar" on public.bills;
create policy "contas: editar" on public.bills for update using (public.is_member()) with check (public.is_member());
drop policy if exists "contas: excluir" on public.bills;
create policy "contas: excluir" on public.bills for delete
  using (public.is_admin() or (created_by = auth.uid() and status = 'pending'));

-- ---------- Permissões para usuários logados ----------
grant select, insert, update, delete on public.members, public.areas, public.cards, public.settings, public.bills to authenticated;
grant execute on function public.my_role(), public.is_member(), public.is_payer(), public.is_admin(), public.join_team(text) to authenticated;

-- ---------- Anexos (notas fiscais, boletos, comprovantes) ----------
insert into storage.buckets (id, name, public, file_size_limit)
values ('anexos', 'anexos', false, 10485760)
on conflict (id) do nothing;

drop policy if exists "anexos: ver" on storage.objects;
create policy "anexos: ver" on storage.objects for select to authenticated
  using (bucket_id = 'anexos' and public.is_member());
drop policy if exists "anexos: enviar" on storage.objects;
create policy "anexos: enviar" on storage.objects for insert to authenticated
  with check (bucket_id = 'anexos' and public.is_member());
drop policy if exists "anexos: apagar" on storage.objects;
create policy "anexos: apagar" on storage.objects for delete to authenticated
  using (bucket_id = 'anexos' and public.is_member());
