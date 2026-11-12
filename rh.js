'use strict';

/* =========================================================
   RH — funcionários (mensalistas e semanalistas), ocorrências
   (faltas, horas extras, férias, atestados, adiantamentos…),
   folha de pagamento (gera contas a pagar) e avisos.
   Só aparece para quem tem acesso ao RH (administração e quem for liberado em Equipe).
   Usa as funções e o estado globais de app.js (carregado depois; chamadas só em tempo de execução).
   ========================================================= */

const HR_KINDS = {
  falta: { label: 'Falta', icon: '🚫', unit: 'dias', sign: -1 },
  hora_extra: { label: 'Hora extra', icon: '⏱️', unit: 'horas', sign: 1 },
  ferias: { label: 'Férias', icon: '🏖️', unit: 'dias', sign: 0 },
  atestado: { label: 'Atestado médico', icon: '🩺', unit: 'dias', sign: 0 },
  adiantamento: { label: 'Adiantamento / vale', icon: '💸', unit: '', sign: -1 },
  desconto: { label: 'Desconto', icon: '➖', unit: '', sign: -1 },
  bonus: { label: 'Bônus / gratificação', icon: '🎁', unit: '', sign: 1 },
  outro: { label: 'Outro', icon: '📝', unit: '', sign: 0 },
};
const WEEKDAYS = ['domingo', 'segunda', 'terça', 'quarta', 'quinta', 'sexta', 'sábado'];
const EXPERIENCE = [[90, '90 dias (45 + 45)'], [45, '45 dias'], [30, '30 dias'], [0, 'Sem experiência']];
const rhui = { tab: 'func', showTerminated: false, evMonth: '', evEmp: '', pay: { type: 'M30', month: '', week: '' } };

const isHR = () => !!state.me && (state.me.role === 'admin' || (state.me.can_hr === true && ['member', 'payer'].includes(state.me.role)));
const empById = (id) => state.employees?.find((e) => e.id === id);
const empCents = (e) => toCents(e.salary);
const fmtCpf = (c) => { const d = String(c || '').replace(/\D/g, ''); return d.length === 11 ? d.replace(/(\d{3})(\d{3})(\d{3})(\d{2})/, '$1.$2.$3-$4') : c || ''; };
const lastDay = (ym) => { const [y, m] = ym.split('-').map(Number); return new Date(y, m, 0).getDate(); };
const dateDiffDays = (a, b) => { const [y1, m1, d1] = a.split('-').map(Number); const [y2, m2, d2] = b.split('-').map(Number); return Math.round((new Date(y2, m2 - 1, d2) - new Date(y1, m1 - 1, d1)) / 86400000); };
const pessoalArea = () => state.areas.find((a) => a.name.toLowerCase() === 'pessoal');

/* ---------- Carregamento ---------- */
async function loadRH() {
  state.employees = state.employees || []; state.hrEvents = state.hrEvents || [];
  if (!isHR()) { state.employees = []; state.hrEvents = []; return; }
  try {
    const [emps, evs] = await Promise.all([
      api.select('employees', 'select=*&order=name'),
      api.select('hr_events', 'select=*&order=date.desc'),
    ]);
    state.employees = emps; state.hrEvents = evs; state.rhMissing = false;
  } catch (e) {
    if (/não foi configurado/.test(e.message)) state.rhMissing = true; else throw e;
  }
}

/* ---------- Cálculos ---------- */
/** Valor de 1 dia e de 1 hora (para sugerir descontos de falta e horas extras). */
function dayRate(e) { return e.pay_type === 'weekly' ? empCents(e) / 6 : empCents(e) / 30; }
function hourRate(e) { return e.pay_type === 'weekly' ? empCents(e) / 44 : empCents(e) / 220; }
function suggestAmount(e, kind, qty) {
  if (!e || !qty) return 0;
  if (kind === 'falta') return Math.round(dayRate(e) * qty);
  if (kind === 'hora_extra') return Math.round(hourRate(e) * 1.5 * qty); // 50% a mais
  return 0;
}

/** Datas de fim da experiência (45 e/ou 90 dias contando o dia da admissão). */
function experienceDates(e) {
  if (!e.experience_days) return [];
  const out = [];
  if (e.experience_days === 90) out.push({ label: '1º período da experiência (45 dias)', date: addDaysISO(e.admission_date, 44) });
  out.push({ label: `Fim da experiência (${e.experience_days} dias)`, date: addDaysISO(e.admission_date, e.experience_days - 1) });
  return out;
}

/** Situação das férias: períodos completos, dias tirados e prazo-limite do período mais antigo em aberto. */
function vacationInfo(e, ref = todayISO()) {
  const [ay, am, ad] = e.admission_date.split('-').map(Number);
  const [ry, rm, rd] = ref.split('-').map(Number);
  let months = (ry - ay) * 12 + (rm - am) - (rd < ad ? 1 : 0);
  const completed = Math.max(0, Math.floor(months / 12));
  const taken = state.hrEvents.filter((x) => x.employee_id === e.id && x.kind === 'ferias').reduce((s, x) => s + Number(x.quantity || 0), 0);
  const settled = Number(e.vacation_periods_settled || 0); // períodos quitados antes de usar o sistema
  const used = settled + Math.floor(taken / 30);
  const owed = Math.max(0, completed - used);
  const k = used; // índice do período mais antigo ainda não gozado
  const periodStart = addMonthsISO(e.admission_date, 12 * k);
  const periodEnd = addDaysISO(addMonthsISO(e.admission_date, 12 * (k + 1)), -1);
  const limit = addDaysISO(addMonthsISO(e.admission_date, 12 * (k + 2)), -1);
  const nextComplete = addDaysISO(addMonthsISO(e.admission_date, 12 * (completed + 1)), -1);
  return { completed, taken, settled, owed, periodStart, periodEnd, limit, nextComplete };
}

/** Períodos aquisitivos completos desde a admissão (para o campo "Férias já quitadas até"). */
function completedPeriods(admission, ref = todayISO()) {
  if (!admission) return [];
  const out = [];
  for (let i = 1; i <= 80; i++) {
    const end = addDaysISO(addMonthsISO(admission, 12 * i), -1);
    if (end >= ref) break;
    out.push({ n: i, start: addMonthsISO(admission, 12 * (i - 1)), end, limit: addDaysISO(addMonthsISO(admission, 12 * (i + 1)), -1) });
  }
  return out;
}
/** Sugestão: quitados os períodos cujo prazo para tirar já passou (em aberto só o que ainda está no prazo). */
const suggestedSettled = (admission) => completedPeriods(admission).filter((p) => p.limit < todayISO()).length;
const hasSettledField = () => !state.employees.length || 'vacation_periods_settled' in state.employees[0];

/** Avisos de RH: experiência, férias e aniversários. */
function rhAlerts() {
  if (!isHR() || !state.employees) return [];
  const today = todayISO(); const out = [];
  for (const e of state.employees.filter((x) => x.status === 'active')) {
    for (const x of experienceDates(e)) {
      const n = dateDiffDays(today, x.date);
      if (n >= 0 && n <= 10) out.push({ emp: e, level: n <= 3 ? 'warn' : 'soon', date: x.date, text: `${x.label} ${n === 0 ? 'termina hoje' : `termina em ${n} dia${n > 1 ? 's' : ''}`} (${fmtDate(x.date)})` });
    }
    const v = vacationInfo(e);
    if (v.owed > 0) {
      const n = dateDiffDays(today, v.limit);
      if (n < 0) out.push({ emp: e, level: 'danger', date: v.limit, text: `Férias VENCIDAS desde ${fmtDate(v.limit)} (devem ser pagas em dobro) — ${v.owed} período(s) em aberto` });
      else if (n <= 90) out.push({ emp: e, level: 'warn', date: v.limit, text: `Férias: precisa sair até ${fmtDate(v.limit)} (faltam ${n} dias)` });
      else out.push({ emp: e, level: 'info', date: v.limit, text: `Tem direito a férias (prazo até ${fmtDate(v.limit)})` });
    }
    if (e.birth_date) {
      const [, bm, bd] = e.birth_date.split('-');
      let next = `${today.slice(0, 4)}-${bm}-${bd}`;
      if (next < today) next = `${Number(today.slice(0, 4)) + 1}-${bm}-${bd}`;
      const n = dateDiffDays(today, next);
      if (n <= 7) out.push({ emp: e, level: 'info', date: next, text: n === 0 ? 'Aniversário hoje 🎂' : `Aniversário em ${n} dia${n > 1 ? 's' : ''} (${fmtDate(next).slice(0, 5)}) 🎂` });
    }
  }
  const order = { danger: 0, warn: 1, soon: 2, info: 3 };
  return out.sort((a, b) => order[a.level] - order[b.level] || a.date.localeCompare(b.date));
}

function rhAlertsBanner() {
  const al = rhAlerts().filter((a) => a.level !== 'info' || /Aniversário hoje/.test(a.text));
  if (!al.length) return '';
  return `<div class="card rh-alerts"><div class="card-head"><h2>🧑‍💼 Avisos de RH</h2><button class="btn small" data-go="rh">Abrir RH</button></div>
    <ul class="tx-list">${al.slice(0, 6).map((a) => `<li class="rh-alert ${a.level}" data-emp="${a.emp.id}"><b>${esc(a.emp.name)}</b> <span>${esc(a.text)}</span></li>`).join('')}</ul></div>`;
}

/* ---------- Folha de pagamento ---------- */
/** Monta a folha: quem recebe, valor base, ajustes do período e total sugerido. */
function payrollRows(type, refDate) {
  const ym = refDate.slice(0, 7);
  const isWeekly = type === 'W';
  const from = isWeekly ? addDaysISO(refDate, -6) : `${ym}-01`;
  const to = isWeekly ? refDate : `${ym}-${pad(lastDay(ym))}`;
  const existing = new Set(state.bills.map((b) => b.payroll_ref).filter(Boolean));
  return state.employees
    .filter((e) => (isWeekly ? e.pay_type === 'weekly' : e.pay_type === 'monthly') && e.admission_date <= refDate &&
      (e.status === 'active' || (e.termination_date && e.termination_date >= from)))
    .map((e) => {
      const salary = empCents(e);
      const firstPart = Math.round((salary * Number(e.first_pay_percent)) / 100);
      let base = isWeekly ? salary : type === 'M15' ? firstPart : salary - firstPart;
      const events = type === 'M15' ? [] : state.hrEvents.filter((x) => x.employee_id === e.id && x.date >= from && x.date <= to && toCents(x.amount) !== 0);
      const adj = events.reduce((s, x) => s + toCents(x.amount), 0);
      const ref = `${e.id}:${type}:${refDate}`;
      return { emp: e, base, events, adj, total: Math.max(0, base + adj), ref, done: existing.has(ref) };
    });
}

function payDateFor(type, month, week) {
  if (type === 'W') return week;
  return type === 'M15' ? `${month}-15` : `${month}-${pad(Math.min(30, lastDay(month)))}`;
}

/* ---------- Tela ---------- */
function renderRH() {
  if (state.rhMissing) {
    return `<div class="card"><div class="empty"><div style="font-size:44px">🧑‍💼</div>
      <p>O módulo de RH ainda não foi ativado no banco de dados.<br>Rode o script <b>supabase-rh.sql</b> no SQL Editor do Supabase.</p></div></div>`;
  }
  const tabs = [['func', '👷 Funcionários'], ['ocor', '📝 Ocorrências'], ['folha', '💰 Folha']];
  const body = { func: rhFuncionarios, ocor: rhOcorrencias, folha: rhFolha }[rhui.tab]();
  return `<div class="tabs">${tabs.map(([k, l]) => `<button class="tab ${rhui.tab === k ? 'active' : ''}" data-rhtab="${k}">${l}</button>`).join('')}</div>${body}`;
}

function empRow(e) {
  const a = areaById(e.area_id);
  const exp = experienceDates(e).find((x) => x.date >= todayISO());
  const v = vacationInfo(e);
  const badges = [
    e.status === 'terminated' ? '<span class="badge">desligado</span>' : '',
    e.status === 'active' && exp ? `<span class="badge open">experiência até ${shortDate(exp.date)}</span>` : '',
    e.status === 'active' && v.owed > 0 ? `<span class="badge ${dateDiffDays(todayISO(), v.limit) < 0 ? 'overdue' : 'today'}">férias${v.owed > 1 ? ` ×${v.owed}` : ''} até ${shortDate(v.limit)}</span>` : '',
  ].join(' ');
  return `<li class="tx" data-emp="${e.id}">
    <div class="avatar">${esc(e.name.charAt(0).toUpperCase())}</div>
    <div class="tx-main"><div class="tx-title">${esc(e.name)} ${badges}</div>
      <div class="tx-meta">${esc(e.job_title || 'Sem cargo')} · <span class="area-dot" style="--c:${a.color}"></span>${esc(a.name)} · ${e.pay_type === 'weekly' ? `semanal (${WEEKDAYS[e.pay_weekday]})` : 'mensal (15 e 30)'} · desde ${fmtDate(e.admission_date)}</div></div>
    <div class="tx-amount">${money(empCents(e))}<small>${e.pay_type === 'weekly' ? 'por semana' : 'por mês'}</small></div>
  </li>`;
}

function rhFuncionarios() {
  const list = state.employees.filter((e) => rhui.showTerminated || e.status === 'active');
  const active = state.employees.filter((e) => e.status === 'active');
  const monthly = active.filter((e) => e.pay_type === 'monthly');
  const weekly = active.filter((e) => e.pay_type === 'weekly');
  const alerts = rhAlerts();
  return `
  <div class="grid cols-4">
    <div class="card stat"><div class="label">Funcionários ativos</div><div class="value">${active.length}</div><div class="sub">${monthly.length} mensal · ${weekly.length} semanal</div></div>
    <div class="card stat"><div class="label">Folha mensal</div><div class="value">${money(monthly.reduce((s, e) => s + empCents(e), 0))}</div><div class="sub">mensalistas (dia 15 + dia 30)</div></div>
    <div class="card stat"><div class="label">Semanais</div><div class="value">${money(weekly.reduce((s, e) => s + empCents(e), 0))}</div><div class="sub">por semana</div></div>
    <div class="card stat ${alerts.some((a) => a.level === 'danger') ? 'stat-danger' : alerts.length ? 'stat-warn' : ''}"><div class="label">Avisos</div><div class="value">${alerts.length}</div><div class="sub">experiência, férias, aniversários</div></div>
  </div>
  ${alerts.length ? `<div class="card mt"><h2>⚠️ Avisos</h2><ul class="tx-list">${alerts.map((a) => `<li class="rh-alert ${a.level}" data-emp="${a.emp.id}"><b>${esc(a.emp.name)}</b> <span>${esc(a.text)}</span></li>`).join('')}</ul></div>` : ''}
  <div class="card mt">
    <div class="card-head"><h2>Funcionários</h2>
      <div class="row-actions"><label class="check"><input type="checkbox" id="showTerm" ${rhui.showTerminated ? 'checked' : ''}><span>mostrar desligados</span></label>
      <button class="btn small primary" id="newEmp">+ Novo funcionário</button></div></div>
    ${list.length ? `<ul class="tx-list">${list.map(empRow).join('')}</ul>` : '<div class="empty small">Nenhum funcionário cadastrado. Toque em “+ Novo funcionário”.</div>'}
  </div>`;
}

function eventRow(x, showEmp = true) {
  const k = HR_KINDS[x.kind]; const e = empById(x.employee_id);
  const qty = Number(x.quantity) ? `${String(Number(x.quantity)).replace('.', ',')} ${k.unit}` : '';
  const period = x.end_date && x.end_date !== x.date ? `${shortDate(x.date)} a ${shortDate(x.end_date)}` : fmtDate(x.date);
  const c = toCents(x.amount);
  return `<li class="tx" data-ev="${x.id}">
    <div class="tx-icon">${k.icon}</div>
    <div class="tx-main"><div class="tx-title">${showEmp ? `${esc(e?.name || '—')} · ` : ''}${k.label}${qty ? ` <span class="muted">(${qty})</span>` : ''}</div>
      <div class="tx-meta">${period}${x.notes ? ' · ' + esc(x.notes) : ''}${x.attachments?.length ? ` · 📎 ${x.attachments.length}` : ''}</div></div>
    <div class="tx-amount ${c > 0 ? 'pos' : c < 0 ? 'neg' : ''}">${c ? (c > 0 ? '+ ' : '− ') + money(Math.abs(c)) : '—'}</div>
  </li>`;
}

function rhOcorrencias() {
  const list = state.hrEvents.filter((x) => (!rhui.evMonth || monthOf(x.date) === rhui.evMonth || monthOf(x.end_date || '') === rhui.evMonth) && (!rhui.evEmp || x.employee_id === rhui.evEmp));
  return `
  <div class="card">
    <div class="filters">
      <select id="evEmp"><option value="">Todos os funcionários</option>${state.employees.map((e) => `<option value="${e.id}" ${rhui.evEmp === e.id ? 'selected' : ''}>${esc(e.name)}</option>`).join('')}</select>
      <input type="month" id="evMonth" value="${esc(rhui.evMonth)}">
      <button class="btn primary" id="newEv">+ Lançar ocorrência</button>
    </div>
    <p class="muted small" style="margin:0">Faltas, descontos e adiantamentos entram como <b class="neg">−</b> e horas extras e bônus como <b class="pos">+</b> no pagamento do período (mensalistas: no dia 30; semanalistas: na semana).</p>
  </div>
  <div class="card mt">${list.length ? `<ul class="tx-list">${list.map((x) => eventRow(x)).join('')}</ul>` : '<div class="empty small">Nenhuma ocorrência.</div>'}</div>`;
}

function rhFolha() {
  const today = todayISO();
  const p = rhui.pay;
  if (!p.month) p.month = monthOf(today);
  if (!p.week) { // próxima sexta (ou o dia de pagamento mais comum dos semanalistas)
    const wd = state.employees.find((e) => e.pay_type === 'weekly')?.pay_weekday ?? 5;
    let d = today; for (let i = 0; i < 7 && new Date(d + 'T12:00').getDay() !== wd; i++) d = addDaysISO(d, 1);
    p.week = d;
  }
  const date = payDateFor(p.type, p.month, p.week);
  const rows = payrollRows(p.type, date);
  const pending = rows.filter((r) => !r.done && r.total > 0);
  const tot = pending.reduce((s, r) => s + r.total, 0);
  const label = { M15: 'Mensalistas — dia 15 (1ª parte)', M30: 'Mensalistas — dia 30 (fechamento do mês)', W: 'Semanalistas — pagamento da semana' };
  return `
  <div class="card">
    <div class="chips-select" style="margin-bottom:12px">${Object.entries(label).map(([k, l]) => `<label class="chip-opt"><input type="radio" name="paytype" value="${k}" ${p.type === k ? 'checked' : ''}><span>${l}</span></label>`).join('')}</div>
    <div class="filters">
      ${p.type === 'W' ? `<label class="inline">Dia do pagamento <input type="date" id="payWeek" value="${p.week}"></label>` : `<label class="inline">Mês <input type="month" id="payMonth" value="${p.month}"></label>`}
      <div class="muted small" style="flex:2 1 260px">${p.type === 'W' ? `Semana de ${fmtDate(addDaysISO(date, -6))} a ${fmtDate(date)}` : p.type === 'M15' ? `Pagamento em ${fmtDate(date)}: a parte combinada de cada um (ex.: 40% ou 50%). Ajustes entram no dia 30.` : `Pagamento em ${fmtDate(date)}: restante do salário + horas extras/bônus − faltas/descontos/adiantamentos do mês.`}</div>
    </div>
  </div>
  <div class="card mt">
    ${rows.length ? `<table class="pay-table"><thead><tr><th></th><th>Funcionário</th><th>Base</th><th>Ajustes</th><th>A pagar</th></tr></thead><tbody>
      ${rows.map((r) => `<tr class="${r.done ? 'done' : ''}">
        <td>${r.done ? '✅' : `<input type="checkbox" data-payrow="${r.emp.id}" ${r.total > 0 ? 'checked' : ''}>`}</td>
        <td><b>${esc(r.emp.name)}</b><div class="tx-meta">${esc(r.emp.job_title || '')}${r.emp.pix_key ? ' · Pix' : r.emp.bank_info ? ' · transferência' : ' · <span class="neg">sem Pix/conta</span>'}</div></td>
        <td>${money(r.base)}</td>
        <td>${r.events.length ? `<span class="${r.adj >= 0 ? 'pos' : 'neg'}">${r.adj >= 0 ? '+' : '−'} ${money(Math.abs(r.adj))}</span><div class="tx-meta">${r.events.map((x) => `${HR_KINDS[x.kind].label}${Number(x.quantity) ? ` ${String(Number(x.quantity)).replace('.', ',')}${HR_KINDS[x.kind].unit === 'horas' ? 'h' : 'd'}` : ''}`).join(', ')}</div>` : '—'}</td>
        <td>${r.done ? `<span class="muted">já gerado</span>` : `<input class="pay-input" data-payval="${r.emp.id}" inputmode="decimal" value="${centsToInput(r.total)}">`}</td>
      </tr>`).join('')}</tbody></table>
      <div class="list-total"><span>${pending.length} pagamento(s) a gerar · vencimento ${fmtDate(date)}</span><b>${money(tot)}</b></div>
      <div class="row-actions mt"><button class="btn primary" id="genPay" ${pending.length ? '' : 'disabled'}>Gerar contas a pagar</button></div>
      <p class="muted small">Cada pagamento vira uma conta a pagar na área <b>Pessoal</b> (visível só para quem tem acesso ao RH). Não é possível gerar o mesmo pagamento duas vezes.</p>`
    : `<div class="empty small">Nenhum ${p.type === 'W' ? 'semanalista' : 'mensalista'} ativo nesta data.</div>`}
  </div>`;
}

/* ---------- Eventos da tela ---------- */
function bindRH(v) {
  $$('[data-rhtab]', v).forEach((b) => b.addEventListener('click', () => { rhui.tab = b.dataset.rhtab; render(); }));
  $$('[data-emp]', v).forEach((el) => el.addEventListener('click', () => openEmployee(el.dataset.emp)));
  $$('[data-ev]', v).forEach((el) => el.addEventListener('click', () => openEventForm(state.hrEvents.find((x) => x.id === el.dataset.ev))));
  $('#newEmp')?.addEventListener('click', () => openEmployeeForm());
  $('#showTerm')?.addEventListener('change', (e) => { rhui.showTerminated = e.target.checked; render(); });
  $('#newEv')?.addEventListener('click', () => openEventForm(null, { employee_id: rhui.evEmp }));
  $('#evEmp')?.addEventListener('change', (e) => { rhui.evEmp = e.target.value; render(); });
  $('#evMonth')?.addEventListener('change', (e) => { rhui.evMonth = e.target.value; render(); });
  $$('[name=paytype]', v).forEach((r) => r.addEventListener('change', () => { rhui.pay.type = r.value; render(); }));
  $('#payMonth')?.addEventListener('change', (e) => { rhui.pay.month = e.target.value; render(); });
  $('#payWeek')?.addEventListener('change', (e) => { rhui.pay.week = e.target.value; render(); });
  $('#genPay')?.addEventListener('click', generatePayroll);
}

async function generatePayroll() {
  const p = rhui.pay; const date = payDateFor(p.type, p.month, p.week);
  const rows = payrollRows(p.type, date).filter((r) => !r.done && $(`[data-payrow="${r.emp.id}"]`)?.checked);
  const area = pessoalArea();
  const bills = [];
  for (const r of rows) {
    const cents = parseMoney($(`[data-payval="${r.emp.id}"]`).value);
    if (cents <= 0) continue;
    const e = r.emp;
    const desc = p.type === 'W' ? `Pagamento semanal (${fmtDate(addDaysISO(date, -6))} a ${fmtDate(date)})`
      : p.type === 'M15' ? `Salário ${monthName(p.month).toLowerCase()} — 1ª parte (dia 15)` : `Salário ${monthName(p.month).toLowerCase()} — fechamento (dia 30)`;
    bills.push({
      id: uuid(), supplier: e.name, description: desc, area_id: area?.id || null, purchase_date: date, edition: state.settings.edition,
      amount: cents / 100, due_date: date, method: e.pix_key ? 'pix' : 'transferencia', pix_key: e.pix_key || '', bank_info: e.pix_key ? '' : e.bank_info || '',
      notes: r.events.map((x) => `${HR_KINDS[x.kind].label} ${fmtDate(x.date)}: ${toCents(x.amount) >= 0 ? '+' : '−'}${money(Math.abs(toCents(x.amount)))}`).join(' · '),
      employee_id: e.id, payroll_ref: r.ref, attachments: [],
    });
  }
  if (!bills.length) { toast('Nenhum pagamento selecionado'); return; }
  if (!confirm(`Gerar ${bills.length} pagamento(s) com vencimento em ${fmtDate(date)}, total ${money(bills.reduce((s, b) => s + Math.round(b.amount * 100), 0))}?`)) return;
  try {
    await api.insert('bills', bills);
    toast(`${bills.length} pagamento(s) gerados ✅`);
    await loadAll({ quiet: true }); render();
  } catch (e) {
    toast(/duplicate|bills_payroll_ref/.test(e.message) ? 'Algum desses pagamentos já tinha sido gerado. Atualize e tente de novo.' : e.message);
    await loadAll({ quiet: true }); render();
  }
}

/* ---------- Funcionário: detalhe ---------- */
function openEmployee(id) {
  const e = empById(id); if (!e) return;
  const a = areaById(e.area_id); const v = vacationInfo(e);
  const evs = state.hrEvents.filter((x) => x.employee_id === id).slice(0, 15);
  const pays = state.bills.filter((b) => b.employee_id === id).sort((x, y) => y.due_date.localeCompare(x.due_date)).slice(0, 8);
  const exp = experienceDates(e);
  openModal(`
    <div class="detail-head"><div><h2 style="margin:0">${esc(e.name)}</h2><div class="muted">${esc(e.job_title || 'Sem cargo')} · ${esc(a.name)}</div></div>
      <div class="detail-amount">${money(empCents(e))}<div class="muted small">${e.pay_type === 'weekly' ? `por semana · paga ${WEEKDAYS[e.pay_weekday]}` : `por mês · ${Number(e.first_pay_percent)}% dia 15`}</div></div></div>
    <dl class="detail">
      <dt>Situação</dt><dd>${e.status === 'active' ? 'Ativo' : `Desligado em ${fmtDate(e.termination_date)}`}</dd>
      <dt>Admissão</dt><dd>${fmtDate(e.admission_date)}${exp.length ? ' · ' + exp.map((x) => `${x.label.replace(/ \(.*/, '')}: ${fmtDate(x.date)}`).join(' · ') : ''}</dd>
      ${e.cpf ? `<dt>CPF</dt><dd>${esc(fmtCpf(e.cpf))}</dd>` : ''}
      ${e.phone ? `<dt>Telefone</dt><dd>${esc(e.phone)}</dd>` : ''}
      ${e.birth_date ? `<dt>Nascimento</dt><dd>${fmtDate(e.birth_date)}</dd>` : ''}
      <dt>Férias</dt><dd>${v.completed ? (v.owed
        ? `<b class="${dateDiffDays(todayISO(), v.limit) < 0 ? 'neg' : ''}">${v.owed} período(s) em aberto</b> — o mais antigo: ${fmtDate(v.periodStart)} a ${fmtDate(v.periodEnd)}, <b>tirar até ${fmtDate(v.limit)}</b>`
        : `Em dia ✅ · próximo período completa em ${fmtDate(v.nextComplete)}`)
        + `<br><span class="muted small">${v.settled ? `${v.settled} período(s) quitado(s) antes do sistema` : ''}${v.settled && v.taken ? ' · ' : ''}${v.taken ? `${v.taken} dia(s) de férias lançados` : ''}</span>`
        : `1º período completa em ${fmtDate(v.nextComplete)}`}</dd>
      ${e.notes ? `<dt>Observações</dt><dd>${esc(e.notes)}</dd>` : ''}
    </dl>
    ${e.pix_key ? `<div class="copy-field"><span>Chave Pix</span><code>${esc(e.pix_key)}</code><button type="button" class="btn small" data-copyval="${esc(e.pix_key)}">Copiar</button></div>` : ''}
    ${e.bank_info ? `<div class="copy-field"><span>Dados bancários</span><code>${esc(e.bank_info)}</code><button type="button" class="btn small" data-copyval="${esc(e.bank_info)}">Copiar</button></div>` : ''}
    <h3 class="sub-h">Documentos</h3>${attachmentList(e.attachments || [])}
    <h3 class="sub-h">Ocorrências recentes</h3>${evs.length ? `<ul class="tx-list">${evs.map((x) => eventRow(x, false)).join('')}</ul>` : '<div class="muted small">Nenhuma.</div>'}
    <h3 class="sub-h">Pagamentos</h3>${pays.length ? `<ul class="tx-list">${pays.map((b) => billRow(b)).join('')}</ul>` : '<div class="muted small">Nenhum pagamento gerado ainda.</div>'}
    <div class="modal-actions">
      <button class="btn" value="ev" formnovalidate>+ Ocorrência</button>
      <span class="spacer"></span>
      <button class="btn" value="edit" formnovalidate>Editar</button>
      <button class="btn primary" value="cancel" formnovalidate>Fechar</button>
    </div>`,
  async (action) => {
    if (action === 'edit') setTimeout(() => openEmployeeForm(e), 0);
    if (action === 'ev') setTimeout(() => openEventForm(null, { employee_id: e.id }), 0);
  }, () => {
    bindAttachments(modalForm);
    $$('[data-copyval]', modalForm).forEach((x) => x.addEventListener('click', () => copyText(x.dataset.copyval)));
    $$('[data-ev]', modalForm).forEach((el) => el.addEventListener('click', () => openEventForm(state.hrEvents.find((x) => x.id === el.dataset.ev))));
    $$('[data-bill]', modalForm).forEach((el) => el.addEventListener('click', () => openBill(el.dataset.bill)));
  });
}

/* ---------- Funcionário: cadastro ---------- */
function openEmployeeForm(emp) {
  const isEdit = !!emp;
  const e = emp || { name: '', cpf: '', job_title: '', area_id: '', phone: '', birth_date: '', admission_date: todayISO(), experience_days: 90, status: 'active', termination_date: '', pay_type: 'monthly', salary: 0, first_pay_percent: 50, pay_weekday: 5, pix_key: '', bank_info: '', notes: '', attachments: [] };
  let atts = [...(e.attachments || [])];
  openModal(`
    <h2>${isEdit ? 'Editar funcionário' : 'Novo funcionário'}</h2>
    <div class="form-grid">
      <label class="field full"><span>Nome completo *</span><input name="name" value="${esc(e.name)}" required></label>
      <label class="field"><span>CPF</span><input name="cpf" value="${esc(fmtCpf(e.cpf))}" inputmode="numeric" autocomplete="off"></label>
      <label class="field"><span>Cargo / função</span><input name="job_title" value="${esc(e.job_title)}" placeholder="Ex.: pedreiro, recepcionista"></label>
      <label class="field"><span>Área</span><select name="area_id"><option value="">—</option>${state.areas.map((a) => `<option value="${a.id}" ${String(a.id) === String(e.area_id) ? 'selected' : ''}>${esc(a.name)}</option>`).join('')}</select></label>
      <label class="field"><span>Telefone</span><input name="phone" value="${esc(e.phone)}" inputmode="tel"></label>
      <label class="field"><span>Data de nascimento</span><input type="date" name="birth_date" value="${e.birth_date || ''}"></label>
      <label class="field"><span>Data de admissão *</span><input type="date" name="admission_date" value="${e.admission_date}" required></label>
      <label class="field"><span>Contrato de experiência</span><select name="experience_days">${EXPERIENCE.map(([d, l]) => `<option value="${d}" ${Number(e.experience_days) === d ? 'selected' : ''}>${l}</option>`).join('')}</select></label>
      ${hasSettledField() ? `<label class="field full" id="settledWrap"><span>Férias já quitadas até</span><select name="vacation_periods_settled"></select>
        <small class="muted" id="settledHint"></small></label>` : ''}
      <div class="field full pay-section"><span class="pay-title">💰 Pagamento</span></div>
      <div class="field full"><span>Tipo</span><div class="chips-select">
        <label class="chip-opt"><input type="radio" name="pay_type" value="monthly" ${e.pay_type === 'monthly' ? 'checked' : ''}><span>Mensalista (dias 15 e 30)</span></label>
        <label class="chip-opt"><input type="radio" name="pay_type" value="weekly" ${e.pay_type === 'weekly' ? 'checked' : ''}><span>Semanalista (obra)</span></label></div></div>
      <label class="field"><span id="salLabel">Salário mensal (R$) *</span><input class="amount-input" name="salary" inputmode="decimal" value="${toCents(e.salary) ? centsToInput(toCents(e.salary)) : ''}" required></label>
      <label class="field" data-pt="monthly"><span>% pago no dia 15</span><input type="number" name="first_pay_percent" min="0" max="100" step="1" value="${Number(e.first_pay_percent)}"><small class="muted" id="splitHint"></small></label>
      <label class="field" data-pt="weekly"><span>Dia do pagamento</span><select name="pay_weekday">${WEEKDAYS.map((w, i) => `<option value="${i}" ${Number(e.pay_weekday) === i ? 'selected' : ''}>${w}</option>`).join('')}</select></label>
      <label class="field full"><span>Chave Pix</span><input name="pix_key" value="${esc(e.pix_key)}" autocomplete="off"></label>
      <label class="field full"><span>Dados bancários (se não tiver Pix)</span><textarea name="bank_info" rows="2">${esc(e.bank_info)}</textarea></label>
      ${isEdit ? `<label class="field"><span>Situação</span><select name="status"><option value="active" ${e.status === 'active' ? 'selected' : ''}>Ativo</option><option value="terminated" ${e.status === 'terminated' ? 'selected' : ''}>Desligado</option></select></label>
      <label class="field" id="termWrap2"><span>Data do desligamento</span><input type="date" name="termination_date" value="${e.termination_date || ''}"></label>` : ''}
      <label class="field full"><span>Observações</span><textarea name="notes" rows="2">${esc(e.notes)}</textarea></label>
      <div class="field full"><span>Documentos (contrato, carteira de trabalho, exame admissional…)</span>
        <div id="attBox">${attachmentList(atts, true)}</div>
        <label class="btn small file-btn">📎 Adicionar documento<input type="file" name="f_doc" accept="image/*,application/pdf" multiple hidden></label>
        <small class="muted" id="newFiles"></small></div>
    </div>
    <div class="modal-actions">${isEdit && isAdmin() ? '<button class="btn danger" value="delete" formnovalidate>Excluir</button>' : ''}<span class="spacer"></span>
      <button class="btn" value="cancel" formnovalidate>Cancelar</button><button class="btn primary" value="save">Salvar</button></div>`,
  async (action, fd) => {
    if (action === 'delete') {
      if (!confirm(`Excluir ${e.name} e todas as ocorrências? Os pagamentos já gerados continuam nas contas. Para quem saiu da empresa, prefira marcar como “Desligado”.`)) return false;
      await api.remove('employees', `id=eq.${e.id}`);
      api.deleteFiles((e.attachments || []).map((x) => x.path), 'rh');
      toast('Funcionário excluído'); await loadAll({ quiet: true }); render(); return;
    }
    const salary = parseMoney(fd.get('salary'));
    if (salary <= 0) { toast('Informe o salário'); return false; }
    const id = isEdit ? e.id : uuid();
    const files = $('[name="f_doc"]', modalForm).files;
    const newAtts = files.length ? await uploadFiles(files, `funcionarios/${id}`, 'outro', 'rh') : [];
    const status = isEdit ? fd.get('status') : 'active';
    const data = {
      name: fd.get('name').trim(), cpf: String(fd.get('cpf')).replace(/\D/g, ''), job_title: fd.get('job_title').trim(),
      area_id: fd.get('area_id') ? Number(fd.get('area_id')) : null, phone: fd.get('phone').trim(), birth_date: fd.get('birth_date') || null,
      admission_date: fd.get('admission_date'), experience_days: Number(fd.get('experience_days')), pay_type: fd.get('pay_type'),
      salary: salary / 100, first_pay_percent: Number(fd.get('first_pay_percent') || 50), pay_weekday: Number(fd.get('pay_weekday') || 5),
      ...(hasSettledField() ? { vacation_periods_settled: Number(fd.get('vacation_periods_settled') || 0) } : {}),
      pix_key: fd.get('pix_key').trim(), bank_info: fd.get('bank_info').trim(), notes: fd.get('notes').trim(),
      status, termination_date: status === 'terminated' ? (fd.get('termination_date') || todayISO()) : null,
      attachments: [...atts, ...newAtts],
    };
    if (isEdit) {
      const removed = (e.attachments || []).filter((x) => !data.attachments.some((y) => y.path === x.path)).map((x) => x.path);
      await api.update('employees', `id=eq.${id}`, data);
      api.deleteFiles(removed, 'rh');
    } else {
      try { await api.insert('employees', { id, ...data }); }
      catch (err) { // banco sem o campo de férias quitadas (script supabase-rh-ferias.sql ainda não rodado)
        if (!/vacation_periods_settled/.test(err.message)) throw err;
        delete data.vacation_periods_settled; await api.insert('employees', { id, ...data });
      }
    }
    toast(isEdit ? 'Funcionário atualizado' : 'Funcionário cadastrado ✅');
    await loadAll({ quiet: true }); render();
  }, () => {
    const sync = () => {
      const t = $('[name=pay_type]:checked', modalForm).value;
      $$('[data-pt]', modalForm).forEach((el) => { el.style.display = el.dataset.pt === t ? '' : 'none'; });
      $('#salLabel').textContent = t === 'weekly' ? 'Valor por semana (R$) *' : 'Salário mensal (R$) *';
      const s = parseMoney($('[name=salary]', modalForm).value); const pct = Number($('[name=first_pay_percent]', modalForm).value || 0);
      $('#splitHint').textContent = s && t === 'monthly' ? `Dia 15: ${money(Math.round((s * pct) / 100))} · Dia 30: ${money(s - Math.round((s * pct) / 100))}` : '';
      const st = $('[name=status]', modalForm); if (st) $('#termWrap2').style.display = st.value === 'terminated' ? '' : 'none';
    };
    $$('[name=pay_type], [name=status]', modalForm).forEach((x) => x.addEventListener('change', sync));
    $$('[name=salary], [name=first_pay_percent]', modalForm).forEach((x) => x.addEventListener('input', sync));
    const showFiles = () => { const f = [...$('[name="f_doc"]', modalForm).files].map((x) => x.name); $('#newFiles').textContent = f.length ? `Novos: ${f.join(', ')}` : ''; };
    $('[name="f_doc"]', modalForm).addEventListener('change', showFiles);
    const bindRm = () => { bindAttachments($('#attBox')); $$('[data-rmatt]', modalForm).forEach((x) => x.addEventListener('click', () => { atts.splice(Number(x.dataset.rmatt), 1); $('#attBox').innerHTML = attachmentList(atts, true); bindRm(); })); };
    bindRm(); sync();
    // Férias já quitadas até: lista os períodos completos conforme a data de admissão
    const sel = $('[name=vacation_periods_settled]', modalForm);
    if (sel) {
      let chosen = isEdit ? Number(e.vacation_periods_settled || 0) : null;
      const fill = () => {
        const adm = $('[name=admission_date]', modalForm).value;
        const ps = completedPeriods(adm);
        if (chosen === null || chosen > ps.length) chosen = suggestedSettled(adm);
        sel.innerHTML = `<option value="0">${ps.length ? 'Nenhum (todas em aberto)' : 'Ainda não completou 1 ano'}</option>` +
          ps.map((p) => `<option value="${p.n}">Período ${p.start.slice(0, 4)}/${p.end.slice(0, 4)} (${fmtDate(p.start)} a ${fmtDate(p.end)})</option>`).join('');
        sel.value = String(chosen);
        const open = ps.slice(chosen);
        $('#settledHint').innerHTML = !ps.length ? '' : open.length
          ? `Em aberto: ${open.map((p) => `<b>${p.start.slice(0, 4)}/${p.end.slice(0, 4)}</b> (tirar até ${fmtDate(p.limit)})`).join(', ')}`
          : 'Férias em dia ✅';
      };
      sel.addEventListener('change', () => { chosen = Number(sel.value); fill(); });
      $('[name=admission_date]', modalForm).addEventListener('change', () => { if (!isEdit) chosen = null; fill(); });
      fill();
    }
  });
}

/* ---------- Ocorrência ---------- */
function openEventForm(ev, defaults = {}) {
  const isEdit = !!ev;
  const x = ev || { employee_id: '', kind: 'falta', date: todayISO(), end_date: '', quantity: 1, amount: 0, notes: '', attachments: [], ...defaults };
  let atts = [...(x.attachments || [])];
  const actives = state.employees.filter((e) => e.status === 'active' || e.id === x.employee_id);
  if (!actives.length) { toast('Cadastre um funcionário primeiro'); return; }
  openModal(`
    <h2>${isEdit ? 'Editar ocorrência' : 'Lançar ocorrência'}</h2>
    <div class="form-grid">
      <label class="field full"><span>Funcionário *</span><select name="employee_id" required><option value="">Escolha…</option>${actives.map((e) => `<option value="${e.id}" ${e.id === x.employee_id ? 'selected' : ''}>${esc(e.name)}</option>`).join('')}</select></label>
      <div class="field full"><span>Tipo</span><div class="chips-select">${Object.entries(HR_KINDS).map(([k, d]) => `<label class="chip-opt"><input type="radio" name="kind" value="${k}" ${x.kind === k ? 'checked' : ''}><span>${d.icon} ${d.label}</span></label>`).join('')}</div></div>
      <label class="field"><span id="dateLbl">Data</span><input type="date" name="date" value="${x.date}" required></label>
      <label class="field" id="endWrap"><span>Até</span><input type="date" name="end_date" value="${x.end_date || ''}"></label>
      <label class="field" id="qtyWrap"><span id="qtyLbl">Quantidade</span><input type="number" name="quantity" min="0" step="0.5" value="${Number(x.quantity) || ''}"></label>
      <label class="field" id="amtWrap"><span id="amtLbl">Valor (R$)</span><input name="amount" inputmode="decimal" value="${toCents(x.amount) ? centsToInput(Math.abs(toCents(x.amount))) : ''}" placeholder="0,00">
        <small class="muted" id="amtHint"></small></label>
      <div class="field" id="signWrap"><span>Na folha</span><div class="chips-select">
        <label class="chip-opt"><input type="radio" name="sign" value="-1" ${toCents(x.amount) < 0 ? 'checked' : ''}><span>− descontar</span></label>
        <label class="chip-opt"><input type="radio" name="sign" value="1" ${toCents(x.amount) >= 0 ? 'checked' : ''}><span>+ acrescentar</span></label></div></div>
      <label class="field full"><span>Observação</span><input name="notes" value="${esc(x.notes)}"></label>
      <div class="field full"><span>Anexo (ex.: foto do atestado)</span><div id="attBox">${attachmentList(atts, true)}</div>
        <label class="btn small file-btn">📎 Anexar<input type="file" name="f_ev" accept="image/*,application/pdf" multiple hidden></label></div>
    </div>
    <div class="modal-actions">${isEdit ? '<button class="btn danger" value="delete" formnovalidate>Excluir</button>' : ''}<span class="spacer"></span>
      <button class="btn" value="cancel" formnovalidate>Cancelar</button><button class="btn primary" value="save">Salvar</button></div>`,
  async (action, fd) => {
    if (action === 'delete') {
      if (!confirm('Excluir esta ocorrência?')) return false;
      await api.remove('hr_events', `id=eq.${x.id}`); api.deleteFiles(atts.map((a) => a.path), 'rh');
      toast('Ocorrência excluída'); await loadAll({ quiet: true }); render(); return;
    }
    const kind = fd.get('kind'); const k = HR_KINDS[kind];
    const cents = parseMoney(fd.get('amount'));
    const sign = k.sign || Number(fd.get('sign') || 1);
    const empId = fd.get('employee_id'); if (!empId) { toast('Escolha o funcionário'); return false; }
    const files = $('[name="f_ev"]', modalForm).files;
    const newAtts = files.length ? await uploadFiles(files, `ocorrencias/${empId}`, 'outro', 'rh') : [];
    const ranged = ['ferias', 'atestado'].includes(kind);
    const data = {
      employee_id: empId, kind, date: fd.get('date'), end_date: ranged ? (fd.get('end_date') || null) : null,
      quantity: Number(fd.get('quantity') || 0), amount: (['ferias', 'atestado'].includes(kind) ? 0 : sign * cents) / 100,
      notes: fd.get('notes').trim(), attachments: [...atts, ...newAtts],
    };
    if (isEdit) await api.update('hr_events', `id=eq.${x.id}`, data); else await api.insert('hr_events', data);
    toast('Ocorrência salva ✅'); await loadAll({ quiet: true }); render();
  }, () => {
    let touched = isEdit;
    const sync = () => {
      const kind = $('[name=kind]:checked', modalForm).value; const k = HR_KINDS[kind];
      const ranged = ['ferias', 'atestado'].includes(kind);
      $('#endWrap').style.display = ranged ? '' : 'none';
      $('#dateLbl').textContent = ranged ? 'De' : 'Data';
      $('#qtyWrap').style.display = k.unit ? '' : 'none';
      $('#qtyLbl').textContent = k.unit === 'horas' ? 'Horas extras' : 'Dias';
      $('#amtWrap').style.display = ranged ? 'none' : '';
      $('#signWrap').style.display = k.sign === 0 && !ranged ? '' : 'none';
      $('#amtLbl').textContent = k.sign < 0 ? 'Valor a descontar (R$)' : k.sign > 0 ? 'Valor a acrescentar (R$)' : 'Valor (R$)';
      if (ranged) { // conta os dias do período
        const a = $('[name=date]', modalForm).value, b = $('[name=end_date]', modalForm).value;
        if (a && b && b >= a) $('[name=quantity]', modalForm).value = dateDiffDays(a, b) + 1;
      }
      const e = empById($('[name=employee_id]', modalForm).value);
      const sug = suggestAmount(e, kind, Number($('[name=quantity]', modalForm).value || 0));
      $('#amtHint').innerHTML = sug ? `Sugestão: ${money(sug)} ${kind === 'hora_extra' ? '(valor da hora + 50%)' : '(salário ÷ ' + (e.pay_type === 'weekly' ? '6 dias' : '30 dias') + ')'}` : (kind === 'ferias' ? 'Férias não alteram a folha aqui; o contador calcula o pagamento.' : '');
      if (sug && !touched) $('[name=amount]', modalForm).value = centsToInput(sug);
    };
    $$('[name=kind], [name=employee_id], [name=date], [name=end_date]', modalForm).forEach((el) => el.addEventListener('change', sync));
    $('[name=quantity]', modalForm).addEventListener('input', sync);
    $('[name=amount]', modalForm).addEventListener('input', () => { touched = true; });
    const bindRm = () => { bindAttachments($('#attBox')); $$('[data-rmatt]', modalForm).forEach((y) => y.addEventListener('click', () => { atts.splice(Number(y.dataset.rmatt), 1); $('#attBox').innerHTML = attachmentList(atts, true); bindRm(); })); };
    bindRm(); sync();
  });
}
