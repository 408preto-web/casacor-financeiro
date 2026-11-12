# Casa Cor Ceará — Controle de Pagamentos

Sistema web (instalável no celular/iPad/computador) para a equipe lançar as contas a pagar da Casa Cor Ceará
e o financeiro ver o que vence e marcar como pago.

## Como funciona

- **Quem compra lança a conta:** fornecedor, o que foi comprado, área, valor, data da compra, **data para pagar**,
  forma de pagamento (Pix com chave, boleto com código, cartão da empresa, transferência, dinheiro), parcelas e
  **anexos** (foto/PDF da nota fiscal e do boleto). “Quem comprou” é registrado automaticamente.
- **Quem paga** (pagador/administrador) vê no **Painel**: atrasadas, vencem hoje, próximos 7 dias, depois —
  copia a chave Pix/código do boleto, paga e marca como pago com **comprovante**.
- **Cartão da empresa:** as compras entram na fatura certa (pelo dia de fechamento); paga-se a fatura inteira.
- **Relatórios:** total pago e a pagar por **área (setor)**, **quem comprou**, mês, forma de pagamento e maiores
  fornecedores, filtrando por **edição** do evento e período. Exporta planilha (CSV).

## Funções (permissões garantidas pelo banco de dados)

| Função | Lança contas | Marca como pago | Aprova pessoas / configura |
|---|---|---|---|
| **Comprador** | ✅ | — | — |
| **Pagador** | ✅ | ✅ | — |
| **Administrador** | ✅ | ✅ | ✅ |
| **Porteiro** | — | — | — (vê só a Portaria da obra) |

Todos da equipe veem todas as contas. Quem cria um acesso fica **aguardando aprovação** e não vê nada até ser aprovado.
A **primeira pessoa** a criar acesso vira administradora.

## 🧑‍💼 RH — Pessoal (só para quem tem acesso ao RH)

Ative rodando [`supabase-rh.sql`](supabase-rh.sql) no SQL Editor (depois do `supabase.sql`). O administrador libera o
**Acesso ao RH** para outras pessoas em **Equipe**. Quem não tem acesso não vê funcionários, ocorrências, documentos
nem as contas de salário (área **Pessoal**) — inclusive nas listas e relatórios.

- **Funcionários:** dados, cargo, área, admissão, experiência (45/90 dias), **mensalista** (pago nos dias **15 e 30**, com
  o % do dia 15 configurável) ou **semanalista** (valor semanal, dia da semana do pagamento), Pix/dados bancários e documentos.
- **Ocorrências:** faltas, horas extras, férias, atestados, adiantamentos/vales, descontos e bônus (com valor sugerido:
  falta = salário ÷ 30 ou ÷ 6 dias; hora extra = valor da hora + 50%).
- **Folha:** gera as contas a pagar do dia 15, do dia 30 (restante + ajustes do mês) ou da semana, com conferência antes
  e sem permitir gerar o mesmo pagamento duas vezes.
- **Avisos:** fim da experiência, férias com prazo-limite (e vencidas) e aniversários.

## 🚧 Portaria da obra

Ative rodando [`supabase-portaria.sql`](supabase-portaria.sql) no SQL Editor (depois dos anteriores).
O porteiro cria o acesso no celular/tablet e o administrador o aprova como **Porteiro**: ele vê **só** a portaria
(nada de contas, RH ou equipe).

- **Entrada:** busca por nome ou CPF → (pessoa nova: nome, CPF validado, empresa) → toca no **ambiente** → toca no
  **trabalho** → **Confirmar**. Quem já veio antes entra com um toque (repete o último ambiente e trabalho).
- **Saída:** lista de quem está na obra, com **SAIU** por pessoa e **Fim do dia: saída de todos**.
- **Bloqueio:** a equipe pode bloquear uma pessoa (com motivo); o porteiro vê **NÃO PERMITIR A ENTRADA**.
- **Equipe (abas):** relatório por dia (por ambiente e por empresa, exporta CSV), cadastro dos **ambientes**
  (número, nome, arquiteto) e das **pessoas** (importar a equipe do RH, marcar crachá, bloquear).

## Configuração (uma vez)

1. **Supabase:** crie um projeto novo (supabase.com → New project, região São Paulo).
2. **SQL Editor → New query:** cole o conteúdo de [`supabase.sql`](supabase.sql) (abra pelo endereço
   `raw.githubusercontent.com/408preto-web/casacor-financeiro/HEAD/supabase.sql`) e execute (**Run**).
3. **Authentication → Sign In / Providers → Email:** desligue **Confirm email**.
   **Authentication → URL Configuration → Site URL:** `https://408preto-web.github.io/casacor-financeiro/`.
4. **Project Settings → API Keys:** copie o **Project URL** e a chave **publishable** (ou *anon public*) para
   [`config.js`](config.js). (Nunca use a chave *secret*/*service_role*.)
5. **GitHub → Settings → Pages → Source: GitHub Actions.** O site é publicado a cada alteração na branch `main`.
6. O administrador abre o site e toca em **Criar acesso** primeiro. Depois envia o endereço para a equipe e
   aprova cada pessoa em **Equipe**.

## Arquivos

| Arquivo | Função |
|---|---|
| `index.html`, `styles.css` | Estrutura e visual |
| `app.js` | Telas e regras do app |
| `api.js` | Comunicação com o Supabase (login, dados, anexos) |
| `config.js` | Endereço e chave pública do Supabase |
| `supabase.sql` | Tabelas, permissões (RLS) e armazenamento de anexos |
| `rh.js`, `supabase-rh.sql` | Módulo de RH (funcionários, ocorrências, folha, avisos) |
| `sw.js`, `manifest.webmanifest`, `icons/` | Instalação como app |
| `portaria.js`, `supabase-portaria.sql` | Portaria da obra (entradas, saídas, ambientes, relatório) |
