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

Todos da equipe veem todas as contas. Quem cria um acesso fica **aguardando aprovação** e não vê nada até ser aprovado.
A **primeira pessoa** a criar acesso vira administradora.

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
| `sw.js`, `manifest.webmanifest`, `icons/` | Instalação como app |
