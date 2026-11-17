-- =====================================================================
-- CASACOR — Categorias dentro de cada área (para o relatório por área)
-- Cole no Supabase em: SQL Editor → New query → Run. Pode rodar mais de uma vez.
-- Ex.: Obra → Mão de obra, Material de construção, Frete…  Marketing → Mídia, Gráfica…
-- As listas podem ser mudadas depois em Ajustes → Áreas.
-- =====================================================================

alter table public.areas add column if not exists categories text[] not null default '{}';
alter table public.bills add column if not exists category text not null default '';
create index if not exists bills_area_category on public.bills (area_id, category);

-- Listas iniciais (só onde ainda está vazio)
update public.areas set categories = array['Mão de obra (terceirizada)', 'Material de construção', 'Elétrica e hidráulica',
  'Acabamentos (piso, revestimento, tinta)', 'Gesso e forro', 'Marcenaria e serralheria', 'Locação de equipamentos',
  'Frete e transporte', 'Ferramentas e EPI', 'Caçamba, descarte e limpeza', 'Projetos e serviços técnicos', 'Alimentação da equipe', 'Outros']
where categories = '{}' and lower(name) like 'obra%';

update public.areas set categories = array['Mídia paga (anúncios e redes)', 'Agência e criação', 'Gráfica e impressos', 'Fotografia e vídeo',
  'Assessoria de imprensa', 'Influenciadores', 'Sinalização e comunicação visual', 'Brindes', 'Site e tecnologia', 'Outros']
where categories = '{}' and lower(name) like 'marketing%';

update public.areas set categories = array['Comissões', 'Viagens e visitas', 'Material de vendas', 'Brindes e presentes a clientes', 'Eventos de relacionamento', 'Outros']
where categories = '{}' and lower(name) like 'comercial%';

update public.areas set categories = array['Buffet e bebidas', 'Som, luz e palco', 'Decoração e flores', 'Atrações e artistas', 'Recepção e staff',
  'Locação de estrutura e mobiliário', 'Segurança', 'Limpeza', 'Outros']
where categories = '{}' and lower(name) like 'evento%';

update public.areas set categories = array['Aluguel e condomínio', 'Luz, água e internet', 'Contabilidade e jurídico', 'Impostos e taxas',
  'Material de escritório', 'Sistemas e assinaturas', 'Transporte e combustível', 'Outros']
where categories = '{}' and lower(name) like 'administr%';

update public.areas set categories = array['Salários', 'Vale-alimentação e vale-transporte', 'Encargos (INSS, FGTS)', 'Férias e 13º', 'Rescisões', 'Outros']
where categories = '{}' and lower(name) like 'pessoal%';

-- ---------- Criar categoria na hora de lançar a conta (qualquer pessoa da equipe) ----------
create or replace function public.add_area_category(p_area bigint, p_name text) returns text[]
language plpgsql security definer set search_path = public as $$
declare
  a public.areas;
  n text := regexp_replace(trim(coalesce(p_name, '')), '\s+', ' ', 'g');
begin
  select * into a from public.areas where id = p_area;
  if not found or not public.is_member() or not public.has_unit(a.unit) then
    raise exception 'Você não tem permissão para isso.';
  end if;
  if n = '' or length(n) > 60 then raise exception 'Escreva o nome da categoria (até 60 letras).'; end if;
  if not exists (select 1 from unnest(a.categories) c where lower(c) = lower(n)) then
    -- entra antes de "Outros", que fica sempre por último
    update public.areas
       set categories = array_remove(categories, 'Outros') || n
                        || case when 'Outros' = any(categories) then array['Outros'] else '{}'::text[] end
     where id = p_area returning * into a;
  end if;
  return a.categories;
end;
$$;
grant execute on function public.add_area_category(bigint, text) to authenticated;
