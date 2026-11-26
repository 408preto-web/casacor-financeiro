-- =====================================================================
-- CASACOR — Contato do arquiteto em cada ambiente (telefone e e-mail)
-- Cole no Supabase em: SQL Editor → New query → Run. Pode rodar mais de uma vez.
-- =====================================================================
alter table public.gate_envs add column if not exists phone text not null default '';
alter table public.gate_envs add column if not exists email text not null default '';
