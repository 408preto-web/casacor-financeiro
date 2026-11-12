-- =====================================================================
-- Casa Cor Ceará — RH: vale-alimentação e vale-transporte
-- Cole no Supabase em: SQL Editor → New query → Run. Pode rodar mais de uma vez.
-- Valores por dia; pagos junto com o salário (15 dias em cada quinzena, ou os dias da semana).
-- =====================================================================
alter table public.employees add column if not exists va_daily numeric(10, 2) not null default 0 check (va_daily >= 0);
alter table public.employees add column if not exists vt_daily numeric(10, 2) not null default 0 check (vt_daily >= 0);
alter table public.employees add column if not exists work_days_week int not null default 6 check (work_days_week between 1 and 7);
