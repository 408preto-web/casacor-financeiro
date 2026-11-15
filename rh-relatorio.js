'use strict';

/* =========================================================
   RH — Relatório da folha de pagamento (para a diretoria financeira).
   Junta os pagamentos gerados pela Folha (contas com payroll_ref) do mês:
   salário, VA, VT, acréscimos (hora extra, bônus), descontos (faltas,
   adiantamentos, descontos), total, situação (pago / a pagar).
   Imprime / salva em PDF e exporta para Excel (CSV).
   Usa as funções e o estado globais de app.js e rh.js.
   ========================================================= */

const rrep = { month: '', type: 'all' };
const PAY_TYPE_LABEL = { M15: 'Dia 15 (1ª parte)', M30: 'Dia 30 (fechamento)', W: 'Semanal' };

/** Lê a composição gravada nas observações do pagamento gerado pela Folha. */
function payBreakdown(b) {
  const notes = String(b.notes || '');
  const amount = b.cents;
  const get = (re) => { const m = notes.match(re); return m ? parseMoney(m[1]) : 0; };
  const base0 = get(/Salário: (R\$\s?[\d.,]+)/);
  const vaM = notes.match(/Vale-alimentação: (\d+) dia\(s\) = (R\$\s?[\d.,]+)/);
  const vtM = notes.match(/Vale-transporte: (\d+) dia\(s\) = (R\$\s?[\d.,]+)/);
  const va = vaM ? parseMoney(vaM[2]) : 0; const vt = vtM ? parseMoney(vtM[2]) : 0;
  let plus = 0, minus = 0; const items = [];
  for (const part of notes.split(' · ')) {
    const m = part.match(/^(.+?) (\d{2}\/\d{2}\/\d{4}): ([+−-])(R\$\s?[\d.,]+)$/);
    if (!m) continue;
    const v = parseMoney(m[4]);
    if (m[3] === '+') plus += v; else minus += v;
    items.push(`${m[1]} ${m[2].slice(0, 5)}: ${m[3] === '+' ? '+' : '−'}${money(v)}`);
  }
  if (!/Salário: R\$/.test(notes)) return { base: amount, va: 0, vt: 0, plus: 0, minus: 0, days: 0, items: [] }; // sem composição gravada
  const adjust = amount - (base0 + va + vt + plus - minus); // valor mudado à mão na hora de gerar
  if (adjust) items.push(`Ajuste na folha: ${adjust > 0 ? '+' : '−'}${money(Math.abs(adjust))}`);
  return { base: base0, va, vt, plus: plus + Math.max(0, adjust), minus: minus + Math.max(0, -adjust), days: Number(vaM?.[1] || vtM?.[1] || 0), items };
}

function folhaReportData() {
  const month = rrep.month || todayISO().slice(0, 7);
  const pays = state.bills.filter((b) => b.payroll_ref && b.status !== 'cancelled' && b.due_date.slice(0, 7) === month)
    .map((b) => {
      const [empId, type] = b.payroll_ref.split(':');
      const e = empById(empId) || { id: empId, name: b.supplier, job_title: '', area_id: null, pay_type: type === 'W' ? 'weekly' : 'monthly' };
      return { b, e, type, ...payBreakdown(b) };
    })
    .filter((p) => rrep.type === 'all' || (rrep.type === 'weekly') === (p.type === 'W'))
    .sort((x, y) => x.e.name.localeCompare(y.e.name) || x.b.due_date.localeCompare(y.b.due_date));
  const byEmp = new Map();
  for (const p of pays) {
    const r = byEmp.get(p.e.id) || { e: p.e, pays: [], base: 0, va: 0, vt: 0, plus: 0, minus: 0, total: 0, paid: 0 };
    r.pays.push(p); r.base += p.base; r.va += p.va; r.vt += p.vt; r.plus += p.plus; r.minus += p.minus; r.total += p.b.cents;
    if (p.b.status === 'paid') r.paid += p.b.paidCents ?? p.b.cents;
    byEmp.set(p.e.id, r);
  }
  const rows = [...byEmp.values()];
  const sum = (k) => rows.reduce((s, r) => s + r[k], 0);
  const tot = { base: sum('base'), va: sum('va'), vt: sum('vt'), plus: sum('plus'), minus: sum('minus'), total: sum('total'), paid: sum('paid') };
  const areas = new Map();
  for (const r of rows) { const a = areaById(r.e.area_id).name; const x = areas.get(a) || { n: 0, total: 0 }; x.n++; x.total += r.total; areas.set(a, x); }
  // Mensalistas ativos sem a folha gerada no mês
  const missing = [];
  if (rrep.type !== 'weekly') {
    for (const e of state.employees.filter((x) => x.pay_type === 'monthly' && x.admission_date <= `${month}-31` && (x.status === 'active' || (x.termination_date || '') >= `${month}-01`))) {
      for (const t of ['M15', 'M30']) {
        const d = payDateFor(t, month);
        if (!state.bills.some((b) => b.payroll_ref === `${e.id}:${t}:${d}` && b.status !== 'cancelled')) missing.push(`${e.name} (${t === 'M15' ? 'dia 15' : 'dia 30'})`);
      }
    }
  }
  return { month, pays, rows, tot, areas: [...areas.entries()].sort((a, b) => b[1].total - a[1].total), missing };
}

function rhRelatorio() {
  const d = folhaReportData();
  const t = d.tot;
  const status = (r) => (r.paid >= r.total && r.total ? '<span class="badge paid">pago</span>' : r.paid ? '<span class="badge open">parcial</span>' : '<span class="badge late">a pagar</span>');
  return `
  <div class="card filters">
    <label class="field"><span>Mês</span><input type="month" id="frMonth" value="${d.month}"></label>
    <label class="field"><span>Funcionários</span><select id="frType">
      <option value="all" ${rrep.type === 'all' ? 'selected' : ''}>Todos</option><option value="monthly" ${rrep.type === 'monthly' ? 'selected' : ''}>Mensalistas</option><option value="weekly" ${rrep.type === 'weekly' ? 'selected' : ''}>Semanalistas (obra)</option></select></label>
    <div class="row-actions fr-actions"><button class="btn primary" id="frPrint" ${d.pays.length ? '' : 'disabled'}>🖨️ Imprimir / PDF</button><button class="btn" id="frCsv" ${d.pays.length ? '' : 'disabled'}>📊 Excel</button></div>
  </div>
  ${d.missing.length ? `<div class="alerts mt"><div class="alert info"><span class="alert-icon">ℹ️</span><div class="alert-text"><b>Ainda não gerado neste mês:</b> <span class="muted">${esc(d.missing.join(', '))}</span></div><button class="btn small" data-rhtab="folha">Ir para a Folha</button></div></div>` : ''}
  <div class="grid cols-4 mt">
    <div class="card stat"><div class="label">Total da folha</div><div class="value">${money(t.total)}</div><div class="sub">${d.rows.length} funcionário(s) · ${d.pays.length} pagamento(s)</div></div>
    <div class="card stat"><div class="label">Salários</div><div class="value">${money(t.base)}</div><div class="sub">${t.plus ? `+ ${money(t.plus)} extras/bônus` : 'sem extras'}</div></div>
    <div class="card stat"><div class="label">VA + VT</div><div class="value">${money(t.va + t.vt)}</div><div class="sub">VA ${money(t.va)} · VT ${money(t.vt)}</div></div>
    <div class="card stat"><div class="label">Pago / a pagar</div><div class="value pos">${money(t.paid)}</div><div class="sub">${t.total - t.paid > 0 ? `faltam ${money(t.total - t.paid)}` : 'tudo pago'}${t.minus ? ` · descontos ${money(t.minus)}` : ''}</div></div>
  </div>
  <div class="card mt">
    <div class="card-head"><h2>Folha de ${esc(monthName(d.month).toLowerCase())}</h2></div>
    ${d.rows.length ? `<div class="table-wrap"><table class="fr-table">
      <thead><tr><th>Funcionário</th><th>Área</th><th class="num">Salário</th><th class="num">Extras</th><th class="num">VA</th><th class="num">VT</th><th class="num">Descontos</th><th class="num">Total</th><th>Situação</th></tr></thead>
      <tbody>${d.rows.map((r) => `<tr data-emp="${r.e.id}">
        <td><b>${esc(r.e.name)}</b><div class="muted small">${esc(r.e.job_title || '')}${r.e.job_title ? ' · ' : ''}${r.e.pay_type === 'weekly' ? 'semanal' : 'mensal'} · ${r.pays.map((p) => fmtDate(p.b.due_date).slice(0, 5)).join(', ')}</div></td>
        <td>${esc(areaById(r.e.area_id).name)}</td><td class="num">${money(r.base)}</td><td class="num">${r.plus ? money(r.plus) : '—'}</td>
        <td class="num">${r.va ? money(r.va) : '—'}</td><td class="num">${r.vt ? money(r.vt) : '—'}</td><td class="num neg">${r.minus ? '−' + money(r.minus) : '—'}</td>
        <td class="num"><b>${money(r.total)}</b></td><td>${status(r)}</td></tr>`).join('')}</tbody>
      <tfoot><tr><td colspan="2"><b>Total</b></td><td class="num">${money(t.base)}</td><td class="num">${money(t.plus)}</td><td class="num">${money(t.va)}</td><td class="num">${money(t.vt)}</td><td class="num neg">${t.minus ? '−' + money(t.minus) : '—'}</td><td class="num"><b>${money(t.total)}</b></td><td></td></tr></tfoot>
    </table></div>` : `<div class="empty small">Nenhum pagamento de folha gerado em ${esc(monthName(d.month).toLowerCase())}. Gere na aba <b>Folha</b>.</div>`}
  </div>
  ${d.areas.length > 1 ? `<div class="card mt"><h2>Por área</h2><ul class="tx-list">${d.areas.map(([a, x]) => `<li class="member-row"><div class="tx-main"><div class="tx-title">${esc(a)}</div><div class="tx-meta">${x.n} funcionário(s)</div></div><div class="tx-amount">${money(x.total)}</div></li>`).join('')}</ul></div>` : ''}`;
}

/* ---------- Impressão (PDF) ---------- */
function folhaPrintHTML(d) {
  const t = d.tot; const gen = new Date().toLocaleString('pt-BR', { dateStyle: 'short', timeStyle: 'short' });
  const typeLbl = { all: 'Mensalistas e semanalistas', monthly: 'Mensalistas', weekly: 'Semanalistas (obra)' }[rrep.type];
  return `<div class="pr">
    <div class="pr-head"><div><h1>Folha de pagamento — ${esc(monthName(d.month))}</h1><p>Casa Cor Ceará${state.settings.edition ? ' · Edição ' + esc(state.settings.edition) : ''} · ${typeLbl}</p></div>
      <div class="pr-meta">Emitido em ${gen}<br>por ${esc(state.me.name)}</div></div>
    <table class="pr-sum"><tr>
      <td><span>Total da folha</span><b>${money(t.total)}</b></td><td><span>Salários</span><b>${money(t.base)}</b></td>
      <td><span>Extras / bônus</span><b>${money(t.plus)}</b></td><td><span>VA + VT</span><b>${money(t.va + t.vt)}</b></td>
      <td><span>Descontos</span><b>${t.minus ? '−' + money(t.minus) : money(0)}</b></td><td><span>Pago</span><b>${money(t.paid)}</b></td><td><span>A pagar</span><b>${money(t.total - t.paid)}</b></td></tr></table>
    <h2>Resumo por funcionário (${d.rows.length})</h2>
    <table class="pr-t"><thead><tr><th>Funcionário</th><th>Cargo</th><th>Área</th><th>Tipo</th><th class="n">Salário</th><th class="n">Extras</th><th class="n">VA</th><th class="n">VT</th><th class="n">Descontos</th><th class="n">Total</th><th>Situação</th></tr></thead>
      <tbody>${d.rows.map((r) => `<tr><td>${esc(r.e.name)}</td><td>${esc(r.e.job_title || '')}</td><td>${esc(areaById(r.e.area_id).name)}</td><td>${r.e.pay_type === 'weekly' ? 'Semanal' : 'Mensal'}</td>
        <td class="n">${money(r.base)}</td><td class="n">${r.plus ? money(r.plus) : '—'}</td><td class="n">${r.va ? money(r.va) : '—'}</td><td class="n">${r.vt ? money(r.vt) : '—'}</td>
        <td class="n">${r.minus ? '−' + money(r.minus) : '—'}</td><td class="n"><b>${money(r.total)}</b></td><td>${r.paid >= r.total ? 'Pago' : r.paid ? 'Parcial' : 'A pagar'}</td></tr>`).join('')}</tbody>
      <tfoot><tr><td colspan="4">Total</td><td class="n">${money(t.base)}</td><td class="n">${money(t.plus)}</td><td class="n">${money(t.va)}</td><td class="n">${money(t.vt)}</td><td class="n">${t.minus ? '−' + money(t.minus) : '—'}</td><td class="n">${money(t.total)}</td><td></td></tr></tfoot></table>
    ${d.areas.length > 1 ? `<h2>Por área</h2><table class="pr-t pr-small"><tbody>${d.areas.map(([a, x]) => `<tr><td>${esc(a)}</td><td>${x.n} funcionário(s)</td><td class="n">${money(x.total)}</td></tr>`).join('')}</tbody></table>` : ''}
    <h2>Detalhamento dos pagamentos (${d.pays.length})</h2>
    <table class="pr-t"><thead><tr><th>Data</th><th>Funcionário</th><th>Pagamento</th><th>Composição</th><th class="n">Valor</th><th>Situação</th></tr></thead>
      <tbody>${d.pays.map((p) => `<tr><td>${fmtDate(p.b.due_date)}</td><td>${esc(p.e.name)}</td><td>${PAY_TYPE_LABEL[p.type] || ''}</td>
        <td class="pr-comp">Salário ${money(p.base)}${p.va ? ` · VA ${p.days ? p.days + 'd ' : ''}${money(p.va)}` : ''}${p.vt ? ` · VT ${p.days ? p.days + 'd ' : ''}${money(p.vt)}` : ''}${p.items.length ? '<br>' + p.items.map(esc).join(' · ') : ''}</td>
        <td class="n">${money(p.b.cents)}</td><td>${p.b.status === 'paid' ? `Pago ${fmtDate(p.b.paid_at)}${p.b.paidCents != null && p.b.paidCents !== p.b.cents ? ' (' + money(p.b.paidCents) + ')' : ''}` : 'A pagar'}</td></tr>`).join('')}</tbody></table>
    ${d.missing.length ? `<p class="pr-note">Ainda não gerado no sistema: ${esc(d.missing.join(', '))}.</p>` : ''}
    <div class="pr-sign"><div>Elaborado por<br><br>_____________________________<br>${esc(state.me.name)}</div><div>Aprovado por<br><br>_____________________________<br>Diretoria financeira</div></div>
  </div>`;
}

function printFolha() {
  const d = folhaReportData(); if (!d.pays.length) return;
  let area = $('#printArea');
  if (!area) { area = document.createElement('div'); area.id = 'printArea'; document.body.appendChild(area); }
  area.innerHTML = folhaPrintHTML(d);
  const old = document.title; document.title = `Folha de pagamento ${monthName(d.month)} - Casa Cor Ceara`;
  document.body.classList.add('printing');
  const done = () => { document.body.classList.remove('printing'); area.innerHTML = ''; document.title = old; };
  window.addEventListener('afterprint', done, { once: true });
  setTimeout(() => { window.print(); setTimeout(() => { if (!window.matchMedia('print').matches) done(); }, 1500); }, 50);
}

function exportFolhaCsv() {
  const d = folhaReportData(); if (!d.pays.length) return;
  const c = (v) => centsToInput(v);
  const rows = [['Data', 'Funcionário', 'CPF', 'Cargo', 'Área', 'Tipo', 'Pagamento', 'Salário', 'Dias VA/VT', 'VA', 'VT', 'Extras/bônus', 'Descontos', 'Total', 'Situação', 'Pago em', 'Valor pago', 'Detalhes']];
  for (const p of d.pays) {
    rows.push([fmtDate(p.b.due_date), p.e.name, p.e.cpf || '', p.e.job_title || '', areaById(p.e.area_id).name, p.e.pay_type === 'weekly' ? 'Semanal' : 'Mensal', PAY_TYPE_LABEL[p.type] || '',
      c(p.base), p.days || '', c(p.va), c(p.vt), c(p.plus), c(p.minus), c(p.b.cents), p.b.status === 'paid' ? 'Pago' : 'A pagar', fmtDate(p.b.paid_at),
      p.b.paidCents != null ? c(p.b.paidCents) : '', p.items.join(' | ')]);
  }
  const t = d.tot;
  rows.push(['', 'TOTAL', '', '', '', '', '', c(t.base), '', c(t.va), c(t.vt), c(t.plus), c(t.minus), c(t.total), '', '', c(t.paid), '']);
  const csv = rows.map((r) => r.map((v) => `"${String(v ?? '').replace(/"/g, '""')}"`).join(';')).join('\r\n');
  const blob = new Blob(['﻿' + csv], { type: 'text/csv;charset=utf-8' });
  const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = `folha-${d.month}.csv`;
  document.body.appendChild(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(a.href), 2000);
}

function bindFolhaReport(v) {
  $('#frMonth', v)?.addEventListener('change', (e) => { rrep.month = e.target.value; render(); });
  $('#frType', v)?.addEventListener('change', (e) => { rrep.type = e.target.value; render(); });
  $('#frPrint', v)?.addEventListener('click', printFolha);
  $('#frCsv', v)?.addEventListener('click', exportFolhaCsv);
}
