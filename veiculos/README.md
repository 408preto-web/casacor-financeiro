# Garagem — controle de veículos

App separado (mesmo Supabase da CASACOR, tabelas `vei_…`, equipe própria).
Endereço: `https://408preto-web.github.io/casacor-financeiro/veiculos/`

- **Abastecimentos:** km do painel, litros, preço/total (um calcula o outro), tanque cheio ou parcial, posto, foto do
  cupom. **Consumo (km/l)** pelo método tanque cheio → tanque cheio; média, último consumo e R$/km.
- **Manutenção e despesas:** tipo (revisão, óleo, pneus, freios…; IPVA, seguro, multa…), descrição, oficina, valor,
  km, garantia, **lembrete da próxima** (por km ou data) e **notas/recibos/fotos** anexados.
- **Painel:** km atual, média de consumo, gasto do mês e lembretes de cada veículo.
- **Relatórios:** gastos por tipo e por mês, km rodados, custo por km; **Histórico do veículo (PDF)** com os dados do
  carro, as manutenções em ordem e os documentos anexados (para a venda); planilha Excel.
- **Pessoas:** a primeira pessoa administra; as outras pedem acesso e são aprovadas ("Lança" ou "Administra").

## Configuração
1. Supabase → SQL Editor → rode [`supabase-veiculos.sql`](supabase-veiculos.sql).
2. Abra o endereço e crie o acesso (ou entre com o login da CASACOR) — a primeira pessoa vira administradora.
