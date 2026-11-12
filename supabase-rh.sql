-- =====================================================================
-- Casa Cor Ceará — Módulo de RH (funcionários, ocorrências e folha)
-- Rode DEPOIS do supabase.sql: SQL Editor → New query → Run.
-- Pode ser executado mais de uma vez sem perder dados.
-- Só quem tem "Acesso ao RH" (e a administração) vê funcionários e salários.
-- =====================================================================

-- ---------- Permissão de RH ----------
alter table public.members add column if not exists can_hr boolean not null default false;

create or replace function public.is_hr() returns boolean
language sql stable security definer set search_path = public as $$
  select coalesce((
    select role = 'admin' or (can_hr and role in ('member', 'payer'))
    from public.members where user_id = auth.uid()
  ), false)
$$;
grant execute on function public.is_hr() to authenticated;

-- Só a administração liga/desliga o acesso ao RH (ninguém se dá acesso sozinho).
create or replace function public.members_guard() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if new.user_id <> old.user_id or new.email <> old.email then
    raise exception 'não é possível alterar o usuário ou o e-mail';
  end if;
  if new.can_hr is distinct from old.can_hr and not public.is_admin() then
    raise exception 'só a administração pode liberar o acesso ao RH';
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

-- ---------- Funcionários ----------
create table if not exists public.employees (
  id                uuid primary key default gen_random_uuid(),
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),
  name              text        not null,
  cpf               text        not null default '',
  job_title         text        not null default '',
  area_id           bigint      references public.areas (id),
  phone             text        not null default '',
  birth_date        date,
  admission_date    date        not null,
  experience_days   int         not null default 90 check (experience_days between 0 and 90),
  status            text        not null default 'active' check (status in ('active', 'terminated')),
  termination_date  date,
  pay_type          text        not null default 'monthly' check (pay_type in ('monthly', 'weekly')),
  salary            numeric(12, 2) not null default 0 check (salary >= 0),   -- mensal (mensalista) ou semanal (semanalista)
  first_pay_percent numeric(5, 2)  not null default 50 check (first_pay_percent between 0 and 100), -- % paga no dia 15
  pay_weekday       int         not null default 5 check (pay_weekday between 0 and 6),          -- 5 = sexta
  pix_key           text        not null default '',
  bank_info         text        not null default '',
  notes             text        not null default '',
  attachments       jsonb       not null default '[]'::jsonb
);
alter table public.employees enable row level security;
drop policy if exists "funcionários: RH" on public.employees;
create policy "funcionários: RH" on public.employees for all using (public.is_hr()) with check (public.is_hr());

-- ---------- Ocorrências (faltas, horas extras, férias, atestados, adiantamentos…) ----------
create table if not exists public.hr_events (
  id          uuid primary key default gen_random_uuid(),
  created_at  timestamptz not null default now(),
  created_by  uuid        not null default auth.uid() references auth.users (id),
  employee_id uuid        not null references public.employees (id) on delete cascade,
  kind        text        not null check (kind in ('falta', 'hora_extra', 'ferias', 'atestado', 'adiantamento', 'desconto', 'bonus', 'outro')),
  date        date        not null,
  end_date    date,
  quantity    numeric(8, 2) not null default 0,   -- dias (falta, férias, atestado) ou horas (hora extra)
  amount      numeric(12, 2) not null default 0,  -- R$ somado (+) ou descontado (−) na folha
  notes       text        not null default '',
  attachments jsonb       not null default '[]'::jsonb
);
create index if not exists hr_events_emp on public.hr_events (employee_id, date);
alter table public.hr_events enable row level security;
drop policy if exists "ocorrências: RH" on public.hr_events;
create policy "ocorrências: RH" on public.hr_events for all using (public.is_hr()) with check (public.is_hr());

grant select, insert, update, delete on public.employees, public.hr_events to authenticated;

-- ---------- Pagamentos de salário dentro das contas a pagar ----------
alter table public.bills add column if not exists employee_id uuid references public.employees (id) on delete set null;
alter table public.bills add column if not exists payroll_ref text not null default '';
create unique index if not exists bills_payroll_ref on public.bills (payroll_ref) where payroll_ref <> '';

-- Contas de salário só aparecem para quem tem acesso ao RH.
drop policy if exists "contas: ver" on public.bills;
create policy "contas: ver" on public.bills for select
  using (public.is_member() and (employee_id is null or public.is_hr()));
drop policy if exists "contas: lançar" on public.bills;
create policy "contas: lançar" on public.bills for insert
  with check (public.is_member() and (employee_id is null or public.is_hr()));
drop policy if exists "contas: editar" on public.bills;
create policy "contas: editar" on public.bills for update
  using (public.is_member() and (employee_id is null or public.is_hr()))
  with check (public.is_member() and (employee_id is null or public.is_hr()));
drop policy if exists "contas: excluir" on public.bills;
create policy "contas: excluir" on public.bills for delete
  using ((public.is_admin() or (created_by = auth.uid() and status = 'pending')) and (employee_id is null or public.is_hr()));

-- Área "Pessoal" para os pagamentos da folha
insert into public.areas (name, color, sort)
select 'Pessoal', '#0891b2', 6
where not exists (select 1 from public.areas where lower(name) = 'pessoal');

-- ---------- Documentos do RH (bucket privado separado) ----------
insert into storage.buckets (id, name, public, file_size_limit)
values ('rh', 'rh', false, 10485760)
on conflict (id) do nothing;
drop policy if exists "rh: ver" on storage.objects;
create policy "rh: ver" on storage.objects for select to authenticated using (bucket_id = 'rh' and public.is_hr());
drop policy if exists "rh: enviar" on storage.objects;
create policy "rh: enviar" on storage.objects for insert to authenticated with check (bucket_id = 'rh' and public.is_hr());
drop policy if exists "rh: apagar" on storage.objects;
create policy "rh: apagar" on storage.objects for delete to authenticated using (bucket_id = 'rh' and public.is_hr());

-- Obs.: a administração já tem acesso ao RH automaticamente (pela função is_hr).

-- Férias já quitadas até (quantidade de períodos aquisitivos já tirados antes de usar o sistema)
alter table public.employees add column if not exists vacation_periods_settled int not null default 0;

-- Vale-alimentação e vale-transporte (valores por dia) e dias trabalhados por semana (semanalistas)
alter table public.employees add column if not exists va_daily numeric(10, 2) not null default 0;
alter table public.employees add column if not exists vt_daily numeric(10, 2) not null default 0;
alter table public.employees add column if not exists work_days_week int not null default 6;
