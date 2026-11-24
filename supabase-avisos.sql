-- =====================================================================
-- CASACOR — Avisos no celular (notificações), todo dia às 8h (horário de Fortaleza)
-- Cole no Supabase em: SQL Editor → New query → Run. Pode rodar mais de uma vez.
-- Depois, crie a função "avisos" em Edge Functions (arquivo supabase/functions/avisos/index.ts).
--
-- • Cada pessoa ativa os avisos no próprio aparelho (Ajustes → Avisos no celular).
-- • Quem paga: contas atrasadas, que vencem hoje e amanhã, e solicitações para aprovar.
-- • Quem tem RH: lembrete da folha do dia 15 / dia 30 ainda não gerada.
-- =====================================================================

create extension if not exists pg_cron;
create extension if not exists pg_net;

-- Aparelhos que aceitaram receber avisos
create table if not exists public.push_subs (
  id         uuid primary key default gen_random_uuid(),
  user_id    uuid not null default auth.uid() references auth.users (id) on delete cascade,
  endpoint   text not null unique,
  p256dh     text not null,
  auth       text not null,
  device     text not null default '',
  created_at timestamptz not null default now()
);
alter table public.push_subs enable row level security;
drop policy if exists "avisos: meus aparelhos" on public.push_subs;
create policy "avisos: meus aparelhos" on public.push_subs for all using (user_id = auth.uid()) with check (user_id = auth.uid());
grant select, insert, update, delete on public.push_subs to authenticated;

-- Chaves do envio (geradas pela própria função na primeira vez) e senha do agendamento.
-- Ninguém do app lê esta tabela; só a função (com a chave de serviço) e o agendamento.
create table if not exists public.push_config (
  id          int primary key default 1 check (id = 1),
  public_key  text,
  private_key text,
  cron_secret text not null default replace(gen_random_uuid()::text, '-', '') || replace(gen_random_uuid()::text, '-', '')
);
insert into public.push_config (id) values (1) on conflict (id) do nothing;
alter table public.push_config enable row level security;
revoke all on public.push_config from anon, authenticated;

create or replace function public.push_public_key() returns text
language sql stable security definer set search_path = public as $$ select public_key from public.push_config where id = 1 $$;
grant execute on function public.push_public_key() to authenticated;

-- Agendamento: todo dia às 11:00 UTC = 8:00 em Fortaleza
do $$ begin
  if exists (select 1 from cron.job where jobname = 'casacor-avisos') then perform cron.unschedule('casacor-avisos'); end if;
end $$;
select cron.schedule('casacor-avisos', '0 11 * * *', $cron$
  select net.http_post(
    url := 'https://zydbeisnpfivlvkckonj.supabase.co/functions/v1/avisos',
    headers := jsonb_build_object('Content-Type', 'application/json', 'x-cron-secret', (select cron_secret from public.push_config where id = 1)),
    body := '{"run":"daily"}'::jsonb)
$cron$);
