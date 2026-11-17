'use strict';

/* =========================================================
   Cópia de segurança: baixa TUDO (todas as franquias liberadas) numa
   planilha Excel, uma aba por assunto. Só administradores.
   Os arquivos (notas, comprovantes, fotos) continuam guardados no Supabase;
   a planilha lista o nome de cada anexo.
   Usa as funções e o estado globais de app.js.
   ========================================================= */

const XLSX_LIB = 'https://cdnjs.cloudflare.com/ajax/libs/xlsx/0.18.5/xlsx.full.min.js';
const BACKUP_KEY = 'casacor:backup:last';
const lastBackup = () => { try { return localStorage.getItem(BACKUP_KEY) || ''; } catch { return ''; } };
const backupDays = () => (lastBackup() ? dateDiffDays(lastBackup().slice(0, 10), todayISO()) : null);

function backupBanner() {
  if (!isAdmin()) return '';
  const d = backupDays();
  if (d !== null && d < 30) return '';
  return `<div class="alerts"><div class="alert info"><span class="alert-icon">💾</span>
    <div class="alert-text"><b>${d === null ? 'Faça a primeira cópia de segurança' : `Última cópia de segurança há ${d} dias`}</b> <span class="muted">— uma planilha com todos os dados, para guardar.</span></div>
    <button class="btn small primary" id="bkNow">Fazer agora</button></div></div>`;
}

function backupCard() {
  if (!isAdmin()) return '';
  const lb = lastBackup();
  return `<div class="card mt"><h2>💾 Cópia de segurança</h2>
    <p class="muted">Baixa uma planilha Excel com <b>todos os dados</b>${unitsOn() && myUnits().length > 1 ? ' das franquias ' + esc(myUnits().map((u) => u.name).join(' e ')) : ''}: contas, cartões, áreas, equipe, RH, portaria e obra — uma aba para cada.
    Guarde no Google Drive, iCloud ou e-mail. Recomendado: uma vez por mês.</p>
    <p class="small">${lb ? `Última cópia neste aparelho: <b>${new Date(lb).toLocaleString('pt-BR', { dateStyle: 'short', timeStyle: 'short' })}</b>` : '<span class="muted">Nenhuma cópia feita neste aparelho ainda.</span>'}</p>
    <button class="btn primary" id="bkBtn">💾 Baixar cópia de segurança</button></div>`;
}

/* Lê uma tabela em todas as franquias (sem o filtro da franquia atual). */
async function fetchAll(table, order, perUnit = true) {
  const units = unitsOn() ? myUnits().map((u) => u.code) : [];
  const q = `select=*${order ? '&order=' + order : ''}${perUnit && units.length ? `&unit=in.(${units.join(',')})` : ''}`;
  try { return await api.select(table, q); } catch (e) { if (/não foi configurado|permissão/.test(e.message)) return []; throw e; }
}

async function makeBackup() {
  const btns = $$('#bkBtn, #bkNow'); btns.forEach((b) => { b.disabled = true; b.dataset.l = b.textContent; b.textContent = 'Preparando…'; });
  try {
    await loadScriptOnce(XLSX_LIB);
    const [areas, cards, bills, emps, evs, envs, people, entries, stages, updates, settings] = await Promise.all([
      fetchAll('areas', 'sort'), fetchAll('cards', 'name'), fetchAll('bills', 'due_date'),
      fetchAll('employees', 'name'), fetchAll('hr_events', 'date'), fetchAll('gate_envs', 'number'),
      fetchAll('gate_people', 'name'), fetchAll('gate_entries', 'entered_at'), fetchAll('obra_stages', 'sort'),
      fetchAll('obra_updates', 'created_at'), fetchAll('settings'),
    ]);
    const un = (c) => (unitsOn() ? unitName(c) : '');
    const aName = (id) => areas.find((a) => String(a.id) === String(id))?.name || '';
    const cName = (id) => { const c = cards.find((x) => x.id === id); return c ? cardLabel(c) : ''; };
    const eName = (id) => emps.find((x) => x.id === id)?.name || '';
    const envName = (id) => { const e = envs.find((x) => String(x.id) === String(id)); return e ? `${e.number ? e.number + ' · ' : ''}${e.name}` : ''; };
    const pName = (id) => people.find((x) => x.id === id)?.name || '';
    const sName = (id) => stages.find((x) => x.id === id)?.name || '';
    const files = (a) => (Array.isArray(a) ? a.map((x) => x.name || x.path).join(' | ') : '');
    const num = (v) => (v == null || v === '' ? '' : Number(v));
    const d = (v) => (v ? fmtDate(String(v).slice(0, 10)) : '');
    const dt = (v) => (v ? new Date(v).toLocaleString('pt-BR') : '');
    const st = { pending: 'A pagar', paid: 'Pago', cancelled: 'Cancelado' };
    const sheets = [
      ['Contas', bills.map((b) => ({ Franquia: un(b.unit), Fornecedor: b.supplier, Descrição: b.description, Área: aName(b.area_id), Categoria: b.category || '', Edição: b.edition,
        'Valor (R$)': num(b.amount), 'Data da compra': d(b.purchase_date), Vencimento: d(b.due_date), Forma: METHODS[b.method]?.label || b.method, Cartão: cName(b.card_id),
        Parcela: b.installment, Situação: st[b.status] || b.status, 'Pago em': d(b.paid_at), 'Valor pago (R$)': num(b.paid_amount), 'Pago por': b.paid_by ? memberName(b.paid_by) : '',
        'Lançado por': memberName(b.created_by), Funcionário: eName(b.employee_id), 'Chave Pix': b.pix_key, Boleto: b.boleto_code, 'Dados bancários': b.bank_info,
        Observações: b.notes, 'Obs. do pagamento': b.payment_notes, Anexos: files(b.attachments), 'Lançada em': dt(b.created_at) }))],
      ['Cartões', cards.map((c) => ({ Franquia: un(c.unit), Cartão: c.name, Final: c.final, 'Dia de fechamento': c.closing_day, 'Dia de vencimento': c.due_day, Ativo: c.active ? 'sim' : 'não' }))],
      ['Áreas', areas.map((a) => ({ Franquia: un(a.unit), Área: a.name, Categorias: (a.categories || []).join(' | '), Ativa: a.active ? 'sim' : 'não' }))],
      ['Equipe', state.members.map((m) => ({ Nome: m.name, 'E-mail': m.email, Função: ROLES[m.role]?.label || m.role, 'Acesso ao RH': m.role === 'admin' || m.can_hr ? 'sim' : 'não', Franquias: m.role === 'admin' ? 'todas' : unitNames(m.units), 'Desde': d(m.created_at) }))],
      ['Funcionários', emps.map((e) => ({ Franquia: un(e.unit), Nome: e.name, CPF: e.cpf, Cargo: e.job_title, Área: aName(e.area_id), Telefone: e.phone, Nascimento: d(e.birth_date),
        Admissão: d(e.admission_date), Situação: e.status === 'active' ? 'Ativo' : 'Desligado', Desligamento: d(e.termination_date), Tipo: e.pay_type === 'weekly' ? 'Semanal' : 'Mensal',
        'Salário (R$)': num(e.salary), '% dia 15': e.pay_type === 'weekly' ? '' : num(e.first_pay_percent), 'VA por dia': num(e.va_daily), 'VT por dia': num(e.vt_daily),
        'Chave Pix': e.pix_key, 'Dados bancários': e.bank_info, Observações: e.notes, Documentos: files(e.attachments) }))],
      ['Ocorrências RH', evs.map((x) => ({ Franquia: un(x.unit), Funcionário: eName(x.employee_id), Tipo: HR_KINDS[x.kind]?.label || x.kind, Data: d(x.date), Até: d(x.end_date),
        Quantidade: num(x.quantity), 'Valor (R$)': num(x.amount), Observação: x.notes }))],
      ['Ambientes', envs.map((e) => ({ Franquia: un(e.unit), Número: e.number, Ambiente: e.name, Arquiteto: e.architect, Ativo: e.active ? 'sim' : 'não', 'Link do QR': e.qr_token ? `${location.origin}${location.pathname}#obra=${e.qr_token}` : '' }))],
      ['Portaria - pessoas', people.map((p) => ({ Franquia: un(p.unit), Nome: p.name, CPF: p.cpf, Empresa: p.company, Telefone: p.phone, 'Equipe CASACOR': p.is_team ? 'sim' : '',
        Bloqueado: p.blocked ? 'SIM' : '', Motivo: p.block_reason }))],
      ['Portaria - entradas', entries.map((x) => ({ Franquia: un(x.unit), Pessoa: pName(x.person_id), Ambiente: envName(x.env_id), Trabalho: x.service, Entrada: dt(x.entered_at), Saída: dt(x.exited_at), Observação: x.notes }))],
      ['Obra - etapas', stages.map((s) => ({ Franquia: un(s.unit), Ambiente: s.env_id ? envName(s.env_id) : '🚩 Marco da obra', Etapa: s.name, Início: d(s.start_date), Fim: d(s.end_date),
        Situação: STAGE_STATUS?.[s.status]?.label || s.status, '%': num(s.progress), 'Atualizado por': s.updated_by, 'Atualizado em': dt(s.updated_at) }))],
      ['Obra - atualizações', updates.map((u) => ({ Franquia: un(u.unit), Ambiente: envName(u.env_id), Etapa: sName(u.stage_id), Quando: dt(u.created_at), Quem: u.author,
        Situação: STAGE_STATUS?.[u.status]?.label || u.status, '%': num(u.progress), Observação: u.note, Fotos: (u.photos || []).length || '', Via: u.via === 'app' ? 'sistema' : 'QR Code' }))],
      ['Configurações', settings.map((s) => ({ Franquia: un(s.unit), 'Edição atual': s.edition }))],
    ];
    const wb = XLSX.utils.book_new();
    const resumo = [{ Item: 'Cópia de segurança — CASACOR', Valor: '' }, { Item: 'Gerada em', Valor: new Date().toLocaleString('pt-BR') }, { Item: 'Por', Valor: state.me.name },
      { Item: 'Franquias', Valor: unitsOn() ? myUnits().map((u) => u.name).join(', ') : 'Ceará' }, ...sheets.map(([n, rows]) => ({ Item: n, Valor: `${rows.length} registro(s)` }))];
    XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(resumo), 'Resumo');
    for (const [n, rows] of sheets) {
      const ws = XLSX.utils.json_to_sheet(rows.length ? rows : [{ '(vazio)': '' }]);
      if (rows.length) ws['!cols'] = Object.keys(rows[0]).map((k) => ({ wch: Math.min(40, Math.max(k.length + 2, ...rows.slice(0, 200).map((r) => String(r[k] ?? '').length + 1))) }));
      XLSX.utils.book_append_sheet(wb, ws, n.slice(0, 31));
    }
    const out = XLSX.write(wb, { bookType: 'xlsx', type: 'array' });
    const file = new File([out], `CASACOR - copia de seguranca ${todayISO()}.xlsx`, { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
    try { localStorage.setItem(BACKUP_KEY, new Date().toISOString()); } catch { /* ignora */ }
    const total = sheets.reduce((s, [, r]) => s + r.length, 0);
    openModal(`<h2>💾 Cópia pronta</h2>
      <p>${total} registro(s) em ${sheets.length} abas.<br><span class="muted">${esc(file.name)}</span></p>
      <p class="muted small">No iPhone/iPad, toque em <b>Salvar / enviar</b> e escolha <b>Salvar em Arquivos</b> (iCloud ou Google Drive) ou mande para o seu e-mail.</p>
      <button type="button" class="btn primary big" id="bkSave" style="width:100%">📤 Salvar / enviar</button>
      <div class="modal-actions"><span class="spacer"></span><button class="btn" value="cancel" formnovalidate>Fechar</button></div>`, () => {},
    () => $('#bkSave').addEventListener('click', async () => {
      try {
        if (navigator.canShare?.({ files: [file] })) { await navigator.share({ files: [file], title: file.name }); return; }
      } catch (e) { if (e?.name === 'AbortError') return; }
      const a = document.createElement('a'); a.href = URL.createObjectURL(file); a.download = file.name;
      document.body.appendChild(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(a.href), 5000);
    }));
    render();
  } catch (e) {
    toast(e.message || 'Não foi possível gerar a cópia');
  } finally {
    btns.forEach((b) => { if (document.contains(b)) { b.disabled = false; b.textContent = b.dataset.l; } });
  }
}
