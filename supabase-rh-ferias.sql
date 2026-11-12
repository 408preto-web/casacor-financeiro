-- =====================================================================
-- Casa Cor Ceará — RH: "Férias já quitadas até"
-- Cole no Supabase em: SQL Editor → New query → Run. Pode rodar mais de uma vez.
-- Cria o campo e, para os funcionários já cadastrados, considera quitados os
-- períodos de férias cujo prazo para tirar já passou (deixa em aberto só o que
-- ainda está no prazo). Depois é possível ajustar no cadastro de cada um.
-- =====================================================================
do $$
begin
  if not exists (select 1 from information_schema.columns
                 where table_schema = 'public' and table_name = 'employees' and column_name = 'vacation_periods_settled') then
    alter table public.employees add column vacation_periods_settled int not null default 0
      check (vacation_periods_settled >= 0);
    update public.employees
       set vacation_periods_settled = greatest(0, extract(year from age(current_date, admission_date))::int - 1);
  end if;
end;
$$;
