'use strict';

/* =========================================================
   Fluxo de caixa: próximas semanas — contas a pagar (aprovadas), folha prevista
   (dia 15, dia 30 e semanal, ainda não gerada) e saldo projetado a partir do
   saldo em conta informado. Só para quem paga.
   Usa as funções e o estado globais de app.js e rh.js.
   ========================================================= */

const FLOW_WEEKS = 8;
const weekStart = (iso) => { const d = new Date(iso + 'T12:00'); const wd = (d.getDay() + 6) % 7; return addDaysISO(iso, -wd); }; // segunda-feira

/** Folha que ainda vai ser gerada no período (só para quem tem acesso ao RH). */
function payrollForecast(from, to) {
  if (typeof isHR !== 'function' || !isHR() || !Array.isArray(state.employees) || typeof payrollRows !== 'function') return [];
  const out = [];
  const months = new Set([from.slice(0, 7), to.slice(0, 7), addDaysISO(from, 32).slice(0, 7)]);
  for (const ym of months) for (const t of ['M15', 'M30']) {
    const d = payDateFor(t, ym); if (d < from || d > to) continue;
    const total = payrollRows(t, d).filter((r) => !r.done).reduce((s, r) => s + r.total, 0);
    if (total > 0) out.push({ date: d, cents: total, label: `Folha ${t === 'M15' ? 'dia 15' : 'dia 30'} (prevista)` });
  }
  const wds = [...new Set(state.employees.filter((e) => e.pay_type === 'weekly' && e.status === 'active').map((e) => Number(e.pay_weekday)))];
  for (let d = from; d <= to; d = addDaysISO(d, 1)) {
    if (!wds.includes(new Date(d + 'T12:00').getDay())) continue;
    const total = payrollRows('W', d).filter((r) => !r.done && Number(r.emp.pay_weekday) === new Date(d + 'T12:00').getDay()).reduce((s, r) => s + r.total, 0);
    if (total > 0) out.push({ date: d, cents: total, label: 'Folha semanal (prevista)' });
  }
  return out;
}

function cashFlowData() {
  const today = todayISO(); const start = weekStart(today); const end = addDaysISO(start, FLOW_WEEKS * 7 - 1);
  const bills = pendingBills();
  const late = bills.filter((b) => b.due_date < today);
  const weeks = Array.from({ length: FLOW_WEEKS }, (_, i) => ({ from: addDaysISO(start, i * 7), to: addDaysISO(start, i * 7 + 6), bills: [], payroll: [], billsC: 0, payC: 0 }));
  for (const b of bills) { if (b.due_date < today || b.due_date > end) continue; const w = weeks.find((x) => b.due_date >= x.from && b.due_date <= x.to); if (w) { w.bills.push(b); w.billsC += b.cents; } }
  for (const p of payrollForecast(today, end)) { const w = weeks.find((x) => p.date >= x.from && p.date <= x.to); if (w) { w.payroll.push(p); w.payC += p.cents; } }
  const bal = state.settings.cash_balance != null ? toCents(state.settings.cash_balance) : null;
  let run = bal == null ? null : bal - late.reduce((s, b) => s + b.cents, 0);
  for (const w of weeks) { w.out = w.billsC + w.payC; if (run != null) { run -= w.out; w.balance = run; } }
  const reqs = typeof requestBills === 'function' ? requestBills() : [];
  return { weeks, late, lateC: late.reduce((s, b) => s + b.cents, 0), bal, reqs, reqC: reqs.reduce((s, b) => s + b.cents, 0), total: weeks.reduce((s, w) => s + w.out, 0) };
}

function renderCashFlow() {
  if (!isPayer()) return '<div class="card"><div class="empty small">O fluxo de caixa é para quem paga as contas.</div></div>';
  const d = cashFlowData(); const s = state.settings;
  const max = Math.max(1, ...d.weeks.map((w) => w.out));
  const neg = d.weeks.find((w) => w.balance != null && w.balance < 0);
  return `<div class="card"><div class="card-head"><h2>💰 Saldo em conta</h2><button class="btn small primary" id="cfBal">Atualizar saldo</button></div>
    ${d.bal == null ? '<p class="muted">Informe o saldo atual da conta da empresa para ver o saldo projetado semana a semana.</p>'
      : `<p style="margin:0"><b style="font-size:22px">${money(d.bal)}</b> <span class="muted">informado em ${fmtDate(s.cash_at)}</span></p>`}</div>
  ${neg ? `<div class="alerts mt"><div class="alert danger"><span class="alert-icon">🚨</span><div class="alert-text"><b>O saldo fica negativo na semana de ${fmtDate(neg.from).slice(0, 5)}</b> (${money(neg.balance)}). Antecipe recebimentos ou reorganize pagamentos.</div></div></div>` : ''}
  <div class="grid cols-4 mt">
    <div class="card stat ${d.lateC ? 'stat-danger' : ''}"><div class="label">Atrasadas (pagar já)</div><div class="value ${d.lateC ? 'neg' : ''}">${money(d.lateC)}</div><div class="sub">${d.late.length} conta(s)</div></div>
    <div class="card stat"><div class="label">Próximas ${FLOW_WEEKS} semanas</div><div class="value">${money(d.total)}</div><div class="sub">contas + folha prevista</div></div>
    <div class="card stat"><div class="label">Saldo no fim</div><div class="value ${d.weeks.at(-1).balance < 0 ? 'neg' : 'pos'}">${d.bal == null ? '—' : money(d.weeks.at(-1).balance)}</div><div class="sub">${d.bal == null ? 'informe o saldo' : 'projetado'}</div></div>
    <div class="card stat"><div class="label">Solicitações</div><div class="value">${money(d.reqC)}</div><div class="sub">${d.reqs.length} aguardando aprovação (fora da conta)</div></div>
  </div>
  <div class="card mt"><h2>Semana a semana</h2><div class="table-wrap"><table class="fr-table cf-table">
    <thead><tr><th>Semana</th><th class="num">Contas</th><th class="num">Folha prevista</th><th class="num">Total que sai</th><th></th><th class="num">Saldo projetado</th></tr></thead>
    <tbody>${d.weeks.map((w, i) => `<tr data-cfw="${i}"><td><b>${fmtDate(w.from).slice(0, 5)} – ${fmtDate(w.to).slice(0, 5)}</b><div class="muted small">${w.bills.length} conta(s)${w.payroll.length ? ' · folha' : ''}</div></td>
      <td class="num">${w.billsC ? money(w.billsC) : '—'}</td><td class="num">${w.payC ? money(w.payC) : '—'}</td><td class="num"><b>${w.out ? money(w.out) : '—'}</b></td>
      <td style="min-width:90px"><div class="cf-bar"><i style="width:${(w.out / max) * 100}%"></i></div></td>
      <td class="num ${w.balance < 0 ? 'neg' : ''}">${w.balance == null ? '—' : money(w.balance)}</td></tr>`).join('')}</tbody></table></div>
    <p class="muted small">Contas a pagar aprovadas (inclui faturas de cartão) pelo vencimento. A folha prevista entra só para quem tem acesso ao RH e enquanto ainda não foi gerada. Toque numa semana para ver o que vence.</p></div>`;
}

function openCashWeek(w) {
  const items = [...w.bills.map((b) => ({ d: b.due_date, t: `${b.supplier}${b.description ? ' — ' + b.description : ''}`, c: b.cents, id: b.id })), ...w.payroll.map((p) => ({ d: p.date, t: p.label, c: p.cents }))].sort((a, b) => a.d.localeCompare(b.d));
  openModal(`<h2>Semana ${fmtDate(w.from).slice(0, 5)} – ${fmtDate(w.to).slice(0, 5)}</h2>
    ${items.length ? `<ul class="tx-list">${items.map((x) => `<li class="tx" ${x.id ? `data-cfbill="${x.id}"` : ''}><div class="tx-main"><div class="tx-title">${esc(x.t)}</div><div class="tx-meta">${fmtDate(x.d)}</div></div><div class="tx-amount">${money(x.c)}</div></li>`).join('')}</ul>
      <div class="list-total"><span>Total</span><b>${money(w.out)}</b></div>` : '<p class="muted">Nada vence nesta semana.</p>'}
    <div class="modal-actions"><span class="spacer"></span><button class="btn" value="cancel" formnovalidate>Fechar</button></div>`, () => {},
  () => $$('[data-cfbill]', modalForm).forEach((el) => el.addEventListener('click', () => openBill(el.dataset.cfbill))));
}

function openCashBalance() {
  const s = state.settings;
  openModal(`<h2>💰 Saldo em conta</h2><p class="muted" style="margin-top:-6px">Quanto tem hoje na conta da empresa${typeof unitName === 'function' && unitsOn() ? ` (CASACOR ${esc(unitName())})` : ''}.</p>
    <label class="field"><span>Saldo (R$)</span><input class="amount-input" name="bal" inputmode="decimal" value="${s.cash_balance != null ? centsToInput(toCents(s.cash_balance)) : ''}" required></label>
    <div class="modal-actions"><span class="spacer"></span><button class="btn" value="cancel" formnovalidate>Cancelar</button><button class="btn primary" value="save">Salvar</button></div>`,
  async (action, fd) => {
    const raw = String(fd.get('bal') || '').trim(); const neg = /^-/.test(raw); const c = parseMoney(raw.replace(/^-/, '')) * (neg ? -1 : 1);
    try { await api.update('settings', unitsOn() ? `unit=eq.${state.unit}` : 'id=eq.1', { cash_balance: c / 100, cash_at: todayISO() }); }
    catch (e) { throw new Error(/cash_balance|não foi configurado/.test(e.message) ? 'Rode o supabase-melhorias.sql no Supabase para guardar o saldo.' : e.message); }
    toast('Saldo atualizado ✅'); await loadAll({ quiet: true }); render();
  });
}

function bindCashFlow(v) {
  $('#cfBal', v)?.addEventListener('click', openCashBalance);
  const d = $$('[data-cfw]', v).length ? cashFlowData() : null;
  $$('[data-cfw]', v).forEach((el) => el.addEventListener('click', () => openCashWeek(d.weeks[Number(el.dataset.cfw)])));
}
