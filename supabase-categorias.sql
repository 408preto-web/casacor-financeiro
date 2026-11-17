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
