'use strict';

/* =========================================================
   Portaria da obra — entradas e saídas de pessoas por ambiente.
   O porteiro (função "Porteiro") só vê esta tela, com botões grandes:
   ENTRADA (CPF/nome → ambiente → trabalho → confirmar) e SAÍDA.
   A equipe vê também Relatório, Ambientes e Pessoas.
   Usa as funções e o estado globais de app.js (chamadas só em tempo de execução).
   ========================================================= */

const SERVICES = [
  ['Pedreiro', '🧱'], ['Servente', '🪣'], ['Pintor', '🎨'], ['Eletricista', '💡'], ['Marceneiro', '🪚'], ['Gesseiro', '◻️'],
  ['Encanador', '🚰'], ['Serralheiro', '🔩'], ['Vidraceiro', '🪟'], ['Montador', '🔧'], ['Ar-condicionado', '❄️'], ['Jardineiro', '🌿'],
  ['Entrega', '📦'], ['Limpeza', '🧹'], ['Visita', '👀'], ['Equipe Casa Cor', '🏠'],
];
const gui = { tab: 'op', date: '', env: '', q: '', peopleQ: '', report: null };

const isGateOnly = () => state.me?.role === 'gate';
const canGate = () => ['gate', 'member', 'payer', 'admin'].includes(state.me?.role);
const gPerson = (id) => state.gatePeople?.find((p) => p.id === id);
const gEnv = (id) => state.gateEnvs?.find((e) => String(e.id) === String(id));
const envLabel = (e) => (e ? `${e.number ? e.number + ' · ' : ''}${e.name}${e.architect ? ' — ' + e.architect : ''}` : 'Sem ambiente');
const fmtTime = (ts) => (ts ? new Date(ts).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' }) : '');
const onlyDigits = (s) => String(s || '').replace(/\D/g, '');
const fmtCpfG = (c) => { const d = onlyDigits(c); return d.length === 11 ? d.replace(/(\d{3})(\d{3})(\d{3})(\d{2})/, '$1.$2.$3-$4') : c || 'sem CPF'; };
const openEntries = () => (state.gateEntries || []).filter((x) => !x.exited_at);
const openEntryOf = (personId) => openEntries().find((x) => x.person_id === personId);
const normG = (s) => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
const envsSorted = () => [...(state.gateEnvs || [])].filter((e) => e.active).sort((a, b) => (a.number || '~').localeCompare(b.number || '~', 'pt', { numeric: true }) || a.name.localeCompare(b.name));

/** Confere os dígitos verificadores do CPF. */
function cpfValid(cpf) {
  const d = onlyDigits(cpf);
  if (d.length !== 11 || /^(\d)\1{10}$/.test(d)) return false;
  const calc = (n) => { let s = 0; for (let i = 0; i < n; i++) s += Number(d[i]) * (n + 1 - i); const r = (s * 10) % 11; return r === 10 ? 0 : r; };
  return calc(9) === Number(d[9]) && calc(10) === Number(d[10]);
}

const startOfDayISO = (dateISO) => { const [y, m, d] = dateISO.split('-').map(Number); return new Date(y, m - 1, d).toISOString(); };

/* ---------- Carregamento ---------- */
async function loadGate() {
  state.gateEnvs = state.gateEnvs || []; state.gatePeople = state.gatePeople || []; state.gateEntries = state.gateEntries || [];
  if (!canGate()) return;
  try {
    const [envs, people, today, open] = await Promise.all([
      api.select('gate_envs', 'select=*'),
      api.select('gate_people', 'select=*&order=name'),
      api.select('gate_entries', `select=*&entered_at=gte.${encodeURIComponent(startOfDayISO(todayISO()))}&order=entered_at.desc`),
      api.select('gate_entries', 'select=*&exited_at=is.null&order=entered_at.desc'),
    ]);
    const byId = new Map([...open, ...today].map((x) => [x.id, x]));
    Object.assign(state, { gateEnvs: envs, gatePeople: people, gateEntries: [...byId.values()].sort((a, b) => b.entered_at.localeCompare(a.entered_at)), gateMissing: false });
  } catch (e) {
    if (/não foi configurado/.test(e.message)) state.gateMissing = true; else throw e;
  }
}
async function reloadGate() { await loadGate(); saveCache(); render(); }

/* ---------- Tela ---------- */
function renderPortaria() {
  if (state.gateMissing) {
    return `<div class="card"><div class="empty"><div style="font-size:44px">🚧</div>
      <p>A portaria ainda não foi ativada no banco de dados.<br>Rode o script <b>supabase-portaria.sql</b> no SQL Editor do Supabase.</p></div></div>`;
  }
  if (isGateOnly()) return gateOperation();
  const tabs = [['op', '🚧 Portaria'], ['rel', '📊 Relatório'], ['amb', '🏠 Ambientes'], ['pes', '👷 Pessoas']];
  const body = { op: gateOperation, rel: gateReport, amb: gateEnvsView, pes: gatePeopleView }[gui.tab]();
  return `<div class="tabs">${tabs.map(([k, l]) => `<button class="tab ${gui.tab === k ? 'active' : ''}" data-gtab="${k}">${l}</button>`).join('')}</div>${body}`;
}

function entryRow(x, big = false) {
  const p = gPerson(x.person_id) || { name: '—' };
  return `<li class="g-row ${x.exited_at ? 'out' : 'in'}" ${!x.exited_at ? `data-gexit="${x.id}"` : ''}>
    <div class="g-time">${fmtTime(x.entered_at)}</div>
    <div class="g-main"><div class="g-name">${esc(p.name)} ${p.is_team ? '<span class="badge open">Equipe</span>' : ''}</div>
      <div class="g-meta">${esc(envLabel(gEnv(x.env_id)))} · ${esc(x.service || '—')}${p.company ? ' · ' + esc(p.company) : ''}</div></div>
    <div class="g-status">${x.exited_at ? `saiu ${fmtTime(x.exited_at)}` : big ? '<span class="g-in">NA OBRA</span>' : '<span class="g-in">na obra</span>'}</div>
  </li>`;
}

function gateOperation() {
  const open = openEntries();
  const todayList = (state.gateEntries || []).filter((x) => x.entered_at >= startOfDayISO(todayISO())).slice(0, 30);
  return `<div class="gate-op">
    <div class="gate-count"><span>👷 Na obra agora</span><b>${open.length}</b></div>
    <div class="gate-big">
      <button class="gbtn in" id="gIn">➡️<span>ENTRADA</span></button>
      <button class="gbtn out" id="gOut">⬅️<span>SAÍDA</span></button>
    </div>
    <h3 class="g-h">Entradas de hoje (${todayList.length})</h3>
    ${todayList.length ? `<ul class="g-list">${todayList.map((x) => entryRow(x, true)).join('')}</ul>` : '<div class="empty small">Ninguém entrou ainda hoje.</div>'}
    ${isGateOnly() ? `<div class="g-foot"><span class="muted">Porteiro: <b>${esc(state.me.name)}</b></span><button class="btn small" id="gLogout">Sair</button></div>` : ''}
  </div>`;
}

/* ---------- Fluxo de ENTRADA ---------- */
function openEntryFlow() { stepSearch(''); }

function searchPeople(q) {
  const t = normG(q).trim(); const d = onlyDigits(q);
  if (!t) return [];
  return (state.gatePeople || []).filter((p) => (d.length >= 3 && onlyDigits(p.cpf).includes(d)) || normG(p.name).includes(t))
    .sort((a, b) => (b.is_team - a.is_team) || a.name.localeCompare(b.name)).slice(0, 8);
}

function stepSearch(q) {
  openModal(`
    <div class="g-modal">
      <h2>➡️ Entrada</h2>
      <label class="field"><span>Digite o CPF ou o nome</span><input id="gq" class="g-input" value="${esc(q)}" autocomplete="off" autocapitalize="words"></label>
      <div id="gResults"></div>
      <button type="button" class="gbtn-wide new" id="gNew">➕ PESSOA NOVA</button>
      <div class="modal-actions"><button class="btn big" value="cancel" formnovalidate>Cancelar</button></div>
    </div>`, () => false, () => {
    const input = $('#gq'); const box = $('#gResults');
    const show = () => {
      const r = searchPeople(input.value);
      box.innerHTML = !input.value.trim() ? '<p class="muted g-hint">Comece a digitar. Quem já veio antes aparece aqui.</p>'
        : r.length ? `<ul class="g-pick">${r.map((p) => {
          const o = openEntryOf(p.id);
          return `<li><button type="button" data-gpick="${p.id}" class="${p.blocked ? 'blocked' : ''}"><b>${esc(p.name)}</b>
            <span>${fmtCpfG(p.cpf)}${p.company ? ' · ' + esc(p.company) : ''}${p.is_team ? ' · Equipe Casa Cor' : ''}${o ? ' · <i>já está na obra</i>' : ''}${p.blocked ? ' · ⛔ BLOQUEADO' : ''}</span></button></li>`;
        }).join('')}</ul>` : '<p class="muted g-hint">Ninguém encontrado. Toque em <b>PESSOA NOVA</b>.</p>';
      $$('[data-gpick]', box).forEach((b) => b.addEventListener('click', () => pickPerson(gPerson(b.dataset.gpick))));
    };
    input.addEventListener('input', show); show();
    $('#gNew').addEventListener('click', () => stepNewPerson(input.value));
    setTimeout(() => input.focus(), 80);
  });
}

function stepNewPerson(q) {
  const digits = onlyDigits(q);
  openModal(`
    <div class="g-modal">
      <h2>➕ Pessoa nova</h2>
      <label class="field"><span>Nome completo</span><input name="name" class="g-input" value="${digits.length >= 3 ? '' : esc(q)}" autocapitalize="words" required></label>
      <label class="field"><span>CPF</span><input name="cpf" class="g-input" inputmode="numeric" value="${digits.length >= 3 ? esc(digits) : ''}" required></label>
      <label class="field"><span>Empresa (de quem trabalha)</span><input name="company" class="g-input" placeholder="Ex.: Marcenaria Silva" autocapitalize="words"></label>
      <p id="gErr" class="g-err"></p>
      <div class="modal-actions"><button class="btn big" value="cancel" formnovalidate>Cancelar</button><button class="btn primary big" value="save">Continuar ➡️</button></div>
    </div>`, async (action, fd) => {
    const name = fd.get('name').trim().replace(/\s+/g, ' '); const cpf = onlyDigits(fd.get('cpf'));
    const err = (m) => { $('#gErr').textContent = m; return false; };
    if (name.split(' ').length < 2) return err('Escreva o nome e o sobrenome.');
    if (!cpfValid(cpf)) return err('CPF inválido. Confira os números com o documento.');
    const existing = state.gatePeople.find((p) => onlyDigits(p.cpf) === cpf);
    if (existing) { setTimeout(() => pickPerson(existing), 0); return; }
    const [p] = await api.insert('gate_people', { name: name.toUpperCase() === name ? titleCaseG(name) : name, cpf, company: fd.get('company').trim() });
    state.gatePeople.push(p);
    setTimeout(() => stepEnv(p, {}), 0);
  }, () => setTimeout(() => $('[name=name]', modalForm).value ? $('[name=cpf]', modalForm).focus() : $('[name=name]', modalForm).focus(), 80));
}
const titleCaseG = (s) => s.toLowerCase().replace(/(^|\s)(\S)/g, (m, a, b) => a + b.toUpperCase()).replace(/\s(D[aeo]s?|E)\s/g, (m) => m.toLowerCase());

function pickPerson(p) {
  if (!p) return;
  if (p.blocked) {
    openModal(`<div class="g-modal g-blocked"><div class="g-stop">⛔</div><h2>NÃO PERMITIR A ENTRADA</h2>
      <p><b>${esc(p.name)}</b><br>${fmtCpfG(p.cpf)}</p>${p.block_reason ? `<p>Motivo: ${esc(p.block_reason)}</p>` : ''}
      <p class="muted">Em caso de dúvida, fale com a administração.</p>
      <div class="modal-actions"><button class="btn big primary" value="cancel" formnovalidate>Entendi</button></div></div>`, () => {});
    return;
  }
  const open = openEntryOf(p.id);
  if (open) {
    openModal(`<div class="g-modal"><h2>${esc(p.name)} já está na obra</h2>
      <p class="g-big-text">Entrou às <b>${fmtTime(open.entered_at)}</b><br>${esc(envLabel(gEnv(open.env_id)))}</p>
      <div class="modal-actions"><button class="btn big" value="cancel" formnovalidate>Voltar</button><button class="btn big primary" value="exit">⬅️ Registrar SAÍDA</button></div></div>`,
    async (action) => { if (action === 'exit') await registerExit([open]); });
    return;
  }
  const env = gEnv(p.last_env_id);
  if (env && env.active && p.last_service) stepConfirm(p, { env, service: p.last_service });
  else stepEnv(p, { service: p.last_service || (p.is_team ? 'Equipe Casa Cor' : '') });
}

function stepEnv(p, sel) {
  const envs = envsSorted();
  openModal(`
    <div class="g-modal"><h2>🏠 Para qual ambiente?</h2><p class="g-who">${esc(p.name)}</p>
      <div class="g-tiles">${envs.map((e) => `<button type="button" class="g-tile ${sel.env && sel.env.id === e.id ? 'sel' : ''}" data-genv="${e.id}">
        ${e.number ? `<b class="g-num">${esc(e.number)}</b>` : ''}<span>${esc(e.name)}</span>${e.architect ? `<small>${esc(e.architect)}</small>` : ''}</button>`).join('')}</div>
      <div class="modal-actions"><button class="btn big" value="cancel" formnovalidate>Cancelar</button></div></div>`, () => false, () => {
    $$('[data-genv]', modalForm).forEach((b) => b.addEventListener('click', () => {
      const env = gEnv(b.dataset.genv);
      if (sel.service) stepConfirm(p, { ...sel, env }); else stepService(p, { ...sel, env });
    }));
  });
}

function stepService(p, sel) {
  openModal(`
    <div class="g-modal"><h2>🔨 Qual trabalho?</h2><p class="g-who">${esc(p.name)} · ${esc(envLabel(sel.env))}</p>
      <div class="g-tiles svc">${SERVICES.map(([s, i]) => `<button type="button" class="g-tile ${sel.service === s ? 'sel' : ''}" data-gsvc="${s}"><span class="g-ico">${i}</span><span>${s}</span></button>`).join('')}</div>
      <label class="field"><span>Outro trabalho (escreva)</span><input id="gOther" class="g-input" autocapitalize="sentences"></label>
      <div class="modal-actions"><button class="btn big" value="cancel" formnovalidate>Cancelar</button><button class="btn big primary" type="button" id="gOtherOk">Continuar ➡️</button></div></div>`, () => false, () => {
    $$('[data-gsvc]', modalForm).forEach((b) => b.addEventListener('click', () => stepConfirm(p, { ...sel, service: b.dataset.gsvc })));
    $('#gOtherOk').addEventListener('click', () => { const v = $('#gOther').value.trim(); if (!v) { toast('Escolha ou escreva o trabalho'); return; } stepConfirm(p, { ...sel, service: v }); });
  });
}

function stepConfirm(p, sel) {
  openModal(`
    <div class="g-modal"><h2>Confirmar entrada</h2>
      <div class="g-summary">
        <div class="g-sum-name">${esc(p.name)}</div>
        <div>${fmtCpfG(p.cpf)}${p.company ? ' · ' + esc(p.company) : ''}${p.is_team ? ' · Equipe Casa Cor' : ''}</div>
        <div class="g-sum-line"><span>🏠 ${esc(envLabel(sel.env))}</span><button type="button" class="btn small" id="gChEnv">Mudar</button></div>
        <div class="g-sum-line"><span>🔨 ${esc(sel.service)}</span><button type="button" class="btn small" id="gChSvc">Mudar</button></div>
      </div>
      <button class="gbtn-wide go" value="save">✅ CONFIRMAR ENTRADA</button>
      <div class="modal-actions"><button class="btn big" value="cancel" formnovalidate>Cancelar</button></div></div>`,
  async () => {
    const [row] = await api.insert('gate_entries', { person_id: p.id, env_id: sel.env?.id ?? null, service: sel.service });
    state.gateEntries.unshift(row);
    api.update('gate_people', `id=eq.${p.id}`, { last_env_id: sel.env?.id ?? null, last_service: sel.service }).then(() => { p.last_env_id = sel.env?.id; p.last_service = sel.service; }).catch(() => {});
    setTimeout(() => showDone(`${p.name.split(' ')[0]} entrou`, `${fmtTime(row.entered_at)} · ${envLabel(sel.env)} · ${sel.service}`), 0);
  }, () => {
    $('#gChEnv').addEventListener('click', () => stepEnv(p, sel));
    $('#gChSvc').addEventListener('click', () => stepService(p, sel));
  });
}

function showDone(title, sub) {
  openModal(`<div class="g-modal g-done"><div class="g-check">✅</div><h2>${esc(title)}</h2><p class="g-big-text">${esc(sub)}</p>
    <button class="gbtn-wide go" value="cancel" formnovalidate>OK</button></div>`, () => {});
  render();
  const t = setTimeout(() => { if (modal.open && $('.g-done', modalForm)) modal.close(); }, 3000);
  modal.addEventListener('close', () => clearTimeout(t), { once: true });
}

/* ---------- Fluxo de SAÍDA ---------- */
function openExitFlow() {
  openModal(`
    <div class="g-modal"><h2>⬅️ Saída</h2>
      <label class="field"><span>Procurar quem está saindo</span><input id="gxq" class="g-input" autocomplete="off" placeholder="Nome ou CPF"></label>
      <ul class="g-list" id="gxList"></ul>
      <button type="button" class="btn danger" id="gAllOut">Fim do dia: registrar saída de TODOS</button>
      <div class="modal-actions"><button class="btn big" value="cancel" formnovalidate>Fechar</button></div></div>`, () => false, () => {
    const input = $('#gxq'); const box = $('#gxList');
    const show = () => {
      const t = normG(input.value).trim(); const d = onlyDigits(input.value);
      const list = openEntries().map((x) => ({ x, p: gPerson(x.person_id) || { name: '—', cpf: '' } }))
        .filter(({ p }) => !t || normG(p.name).includes(t) || (d.length >= 3 && onlyDigits(p.cpf).includes(d)))
        .sort((a, b) => a.p.name.localeCompare(b.p.name));
      box.innerHTML = list.length ? list.map(({ x, p }) => `<li class="g-row in"><div class="g-time">${fmtTime(x.entered_at)}</div>
        <div class="g-main"><div class="g-name">${esc(p.name)}</div><div class="g-meta">${esc(envLabel(gEnv(x.env_id)))} · ${esc(x.service)}</div></div>
        <button type="button" class="btn primary g-saiu" data-gout="${x.id}">SAIU</button></li>`).join('')
        : `<div class="empty small">${openEntries().length ? 'Ninguém com esse nome na obra.' : 'Ninguém na obra agora.'}</div>`;
      $$('[data-gout]', box).forEach((b) => b.addEventListener('click', async () => {
        b.disabled = true; b.textContent = '…';
        try { await registerExit([state.gateEntries.find((x) => x.id === b.dataset.gout)], { keepOpen: true }); show(); } catch (e) { toast(e.message); b.disabled = false; b.textContent = 'SAIU'; }
      }));
    };
    input.addEventListener('input', show); show();
    $('#gAllOut').addEventListener('click', async () => {
      const all = openEntries();
      if (!all.length) { toast('Ninguém na obra'); return; }
      if (!confirm(`Registrar a saída de todas as ${all.length} pessoas que estão na obra agora?`)) return;
      await registerExit(all, { keepOpen: true }); show();
    });
  });
}

async function registerExit(entries, { keepOpen = false } = {}) {
  const now = new Date().toISOString();
  const ids = entries.map((x) => x.id);
  await api.update('gate_entries', `id=in.(${ids.join(',')})`, { exited_at: now, exited_by: state.me.user_id });
  entries.forEach((x) => { x.exited_at = now; });
  toast(entries.length > 1 ? `Saída de ${entries.length} pessoas registrada` : `Saída de ${(gPerson(entries[0].person_id) || {}).name || ''} registrada`);
  saveCache();
  if (!keepOpen) render(); else { const v = $('#view'); if (v && ui.view === 'portaria') { v.innerHTML = renderPortaria(); bindView(); } }
}

/* ---------- Relatório (equipe) ---------- */
function gateReport() {
  if (!gui.date) gui.date = todayISO();
  const isToday = gui.date === todayISO();
  const r = gui.report && gui.report.date === gui.date ? gui.report.rows : isToday ? state.gateEntries.filter((x) => x.entered_at >= startOfDayISO(gui.date)) : null;
  if (!r) { loadReport(gui.date); return '<div class="card"><div class="empty small">Carregando…</div></div>'; }
  const t = normG(gui.q).trim();
  const rows = r.filter((x) => (!gui.env || String(x.env_id) === gui.env) && (!t || normG(`${gPerson(x.person_id)?.name} ${gPerson(x.person_id)?.company} ${x.service}`).includes(t)))
    .sort((a, b) => a.entered_at.localeCompare(b.entered_at));
  const byEnv = {}; r.forEach((x) => { byEnv[x.env_id] = (byEnv[x.env_id] || 0) + 1; });
  const people = new Set(r.map((x) => x.person_id)).size;
  return `
  <div class="card"><div class="filters">
    <input type="date" id="gDate" value="${gui.date}">
    <select id="gEnvF"><option value="">Todos os ambientes</option>${envsSorted().map((e) => `<option value="${e.id}" ${gui.env === String(e.id) ? 'selected' : ''}>${esc(envLabel(e))}</option>`).join('')}</select>
    <input type="search" id="gQ" placeholder="Nome, empresa ou trabalho" value="${esc(gui.q)}">
    <button class="btn" id="gCsv">⬇️ Planilha</button>
  </div></div>
  <div class="grid cols-4 mt">
    <div class="card stat"><div class="label">Entradas</div><div class="value">${r.length}</div><div class="sub">${fmtDate(gui.date)}</div></div>
    <div class="card stat"><div class="label">Pessoas diferentes</div><div class="value">${people}</div></div>
    <div class="card stat"><div class="label">${isToday ? 'Na obra agora' : 'Sem saída registrada'}</div><div class="value">${r.filter((x) => !x.exited_at).length}</div></div>
    <div class="card stat"><div class="label">Ambientes com gente</div><div class="value">${Object.keys(byEnv).length}</div></div>
  </div>
  <div class="grid cols-2 mt">
    <div class="card"><h2>Por ambiente</h2>${Object.keys(byEnv).length ? `<ul class="bars">${Object.entries(byEnv).sort((a, b) => b[1] - a[1]).map(([id, n]) => `<li><div class="bar-top"><span>${esc(envLabel(gEnv(id)))}</span><b>${n}</b></div><div class="bar"><div style="width:${(n / Math.max(...Object.values(byEnv))) * 100}%;background:var(--primary)"></div></div></li>`).join('')}</ul>` : '<div class="empty small">Sem entradas.</div>'}</div>
    <div class="card"><h2>Por empresa</h2>${(() => { const c = {}; r.forEach((x) => { const k = gPerson(x.person_id)?.company || (gPerson(x.person_id)?.is_team ? 'Equipe Casa Cor' : 'Sem empresa'); c[k] = (c[k] || 0) + 1; }); const e = Object.entries(c).sort((a, b) => b[1] - a[1]).slice(0, 12); return e.length ? `<ul class="bars">${e.map(([k, n]) => `<li><div class="bar-top"><span>${esc(k)}</span><b>${n}</b></div><div class="bar"><div style="width:${(n / e[0][1]) * 100}%;background:var(--primary)"></div></div></li>`).join('')}</ul>` : '<div class="empty small">Sem entradas.</div>'; })()}</div>
  </div>
  <div class="card mt"><h2>Registros (${rows.length})</h2>
    ${rows.length ? `<div class="g-table-wrap"><table class="pay-table g-table"><thead><tr><th>Entrada</th><th>Saída</th><th>Nome</th><th>CPF</th><th>Empresa</th><th>Ambiente</th><th>Trabalho</th></tr></thead><tbody>
      ${rows.map((x) => { const p = gPerson(x.person_id) || {}; return `<tr><td>${fmtTime(x.entered_at)}</td><td>${x.exited_at ? fmtTime(x.exited_at) : '<span class="g-in">na obra</span>'}</td><td><b>${esc(p.name || '—')}</b></td><td>${fmtCpfG(p.cpf)}</td><td>${esc(p.company || (p.is_team ? 'Equipe Casa Cor' : ''))}</td><td>${esc(envLabel(gEnv(x.env_id)))}</td><td>${esc(x.service)}</td></tr>`; }).join('')}
    </tbody></table></div>` : '<div class="empty small">Nenhum registro.</div>'}
  </div>`;
}

async function loadReport(date) {
  try {
    const rows = await api.select('gate_entries', `select=*&entered_at=gte.${encodeURIComponent(startOfDayISO(date))}&entered_at=lt.${encodeURIComponent(startOfDayISO(addDaysISO(date, 1)))}&order=entered_at`);
    gui.report = { date, rows };
  } catch (e) { toast(e.message); gui.report = { date, rows: [] }; }
  if (ui.view === 'portaria' && gui.tab === 'rel') render();
}

function exportGateCsv() {
  const r = gui.report && gui.report.date === gui.date ? gui.report.rows : state.gateEntries.filter((x) => x.entered_at >= startOfDayISO(gui.date));
  const rows = [['Data', 'Entrada', 'Saída', 'Nome', 'CPF', 'Empresa', 'Ambiente', 'Arquiteto', 'Trabalho']];
  r.slice().sort((a, b) => a.entered_at.localeCompare(b.entered_at)).forEach((x) => {
    const p = gPerson(x.person_id) || {}; const e = gEnv(x.env_id) || {};
    rows.push([fmtDate(gui.date), fmtTime(x.entered_at), fmtTime(x.exited_at), p.name, fmtCpfG(p.cpf), p.company || (p.is_team ? 'Equipe Casa Cor' : ''), `${e.number ? e.number + ' · ' : ''}${e.name || ''}`, e.architect || '', x.service]);
  });
  const csv = rows.map((l) => l.map((v) => `"${String(v ?? '').replace(/"/g, '""')}"`).join(';')).join('\r\n');
  const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob(['﻿' + csv], { type: 'text/csv;charset=utf-8' }));
  a.download = `portaria-${gui.date}.csv`; document.body.appendChild(a); a.click(); a.remove();
}

/* ---------- Ambientes (equipe) ---------- */
function gateEnvsView() {
  const inside = {}; openEntries().forEach((x) => { inside[x.env_id] = (inside[x.env_id] || 0) + 1; });
  const all = [...(state.gateEnvs || [])].sort((a, b) => (a.number || '~').localeCompare(b.number || '~', 'pt', { numeric: true }) || a.name.localeCompare(b.name));
  return `<div class="card"><div class="card-head"><h2>Ambientes da obra</h2><button class="btn small primary" id="gNewEnv">+ Novo ambiente</button></div>
    <p class="muted small" style="margin-top:-6px">Cadastre cada ambiente com o número, o nome e o arquiteto responsável. O porteiro escolhe por eles.</p>
    <ul class="tx-list">${all.map((e) => `<li class="member-row"><div class="avatar">${esc(e.number || '•')}</div>
      <div class="tx-main"><div class="tx-title">${esc(e.name)} ${e.active ? '' : '<span class="badge">inativo</span>'}</div><div class="tx-meta">${esc(e.architect || 'Sem arquiteto')}${inside[e.id] ? ` · <b>${inside[e.id]} na obra agora</b>` : ''}</div></div>
      <button class="btn small" data-genvedit="${e.id}">Editar</button></li>`).join('')}</ul></div>`;
}

function openEnvForm(env) {
  const e = env || { number: '', name: '', architect: '', active: true };
  openModal(`<h2>${env ? 'Editar ambiente' : 'Novo ambiente'}</h2>
    <div class="form-grid">
      <label class="field"><span>Número</span><input name="number" value="${esc(e.number)}" placeholder="Ex.: 12"></label>
      <label class="field"><span>Nome do ambiente *</span><input name="name" value="${esc(e.name)}" required placeholder="Ex.: Cozinha gourmet"></label>
      <label class="field full"><span>Arquiteto(a) / escritório responsável</span><input name="architect" value="${esc(e.architect)}" placeholder="Ex.: Sofia Andrade"></label>
      <label class="check full"><input type="checkbox" name="active" ${e.active ? 'checked' : ''}><span>Ativo (aparece para o porteiro)</span></label>
    </div>
    <div class="modal-actions"><span class="spacer"></span><button class="btn" value="cancel" formnovalidate>Cancelar</button><button class="btn primary" value="save">Salvar</button></div>`,
  async (action, fd) => {
    const data = { number: fd.get('number').trim(), name: fd.get('name').trim(), architect: fd.get('architect').trim(), active: fd.get('active') === 'on' };
    if (env) await api.update('gate_envs', `id=eq.${env.id}`, data); else await api.insert('gate_envs', data);
    toast('Ambiente salvo'); await reloadGate();
  });
}

/* ---------- Pessoas (equipe) ---------- */
function gatePeopleView() {
  const t = normG(gui.peopleQ).trim(); const d = onlyDigits(gui.peopleQ);
  const list = (state.gatePeople || []).filter((p) => !t || normG(`${p.name} ${p.company}`).includes(t) || (d.length >= 3 && onlyDigits(p.cpf).includes(d)));
  const importable = isHR() ? (state.employees || []).filter((e) => e.status === 'active' && !state.gatePeople.some((p) => (e.cpf && onlyDigits(p.cpf) === onlyDigits(e.cpf)) || normG(p.name) === normG(e.name))) : [];
  return `<div class="card">
    <div class="card-head"><h2>Pessoas cadastradas (${state.gatePeople.length})</h2>
      ${importable.length ? `<button class="btn small primary" id="gImport">Importar equipe do RH (${importable.length})</button>` : ''}</div>
    <div class="filters"><input type="search" id="gPQ" placeholder="Nome, CPF ou empresa" value="${esc(gui.peopleQ)}"></div>
    <ul class="tx-list">${list.slice(0, 200).map((p) => `<li class="member-row" data-gperson="${p.id}"><div class="avatar">${esc(p.name.charAt(0))}</div>
      <div class="tx-main"><div class="tx-title">${esc(p.name)} ${p.is_team ? '<span class="badge open">Equipe</span>' : ''} ${p.blocked ? '<span class="badge overdue">bloqueado</span>' : ''}</div>
      <div class="tx-meta">${fmtCpfG(p.cpf)}${p.company ? ' · ' + esc(p.company) : ''}${p.last_service ? ' · ' + esc(p.last_service) : ''}${openEntryOf(p.id) ? ' · <b>na obra agora</b>' : ''}</div></div>
      <button class="btn small" data-gpedit="${p.id}">Editar</button></li>`).join('')}</ul>
    ${list.length > 200 ? '<p class="muted small">Mostrando 200. Use a busca.</p>' : ''}</div>`;
}

function openPersonForm(p) {
  openModal(`<h2>Editar pessoa</h2>
    <div class="form-grid">
      <label class="field full"><span>Nome</span><input name="name" value="${esc(p.name)}" required></label>
      <label class="field"><span>CPF</span><input name="cpf" value="${esc(fmtCpfG(p.cpf) === 'sem CPF' ? '' : fmtCpfG(p.cpf))}" inputmode="numeric"></label>
      <label class="field"><span>Empresa</span><input name="company" value="${esc(p.company)}"></label>
      <label class="field"><span>Telefone</span><input name="phone" value="${esc(p.phone)}" inputmode="tel"></label>
      <label class="check full"><input type="checkbox" name="is_team" ${p.is_team ? 'checked' : ''}><span>Equipe Casa Cor (crachá)</span></label>
      <label class="check full"><input type="checkbox" name="blocked" ${p.blocked ? 'checked' : ''}><span>⛔ Bloquear entrada</span></label>
      <label class="field full"><span>Motivo do bloqueio</span><input name="block_reason" value="${esc(p.block_reason)}"></label>
    </div>
    <div class="modal-actions">${isAdmin() ? '<button class="btn danger" value="delete" formnovalidate>Excluir</button>' : ''}<span class="spacer"></span>
      <button class="btn" value="cancel" formnovalidate>Cancelar</button><button class="btn primary" value="save">Salvar</button></div>`,
  async (action, fd) => {
    if (action === 'delete') {
      if (!confirm(`Excluir ${p.name} e todo o histórico de entradas?`)) return false;
      await api.remove('gate_people', `id=eq.${p.id}`); toast('Excluído'); await reloadGate(); return;
    }
    const cpf = onlyDigits(fd.get('cpf'));
    if (cpf && !cpfValid(cpf)) { toast('CPF inválido'); return false; }
    await api.update('gate_people', `id=eq.${p.id}`, { name: fd.get('name').trim(), cpf, company: fd.get('company').trim(), phone: fd.get('phone').trim(), is_team: fd.get('is_team') === 'on', blocked: fd.get('blocked') === 'on', block_reason: fd.get('block_reason').trim() });
    toast('Salvo'); await reloadGate();
  });
}

async function importTeamFromRH() {
  const common = envsSorted().find((e) => /comu|geral/i.test(e.name));
  const list = (state.employees || []).filter((e) => e.status === 'active' && !state.gatePeople.some((p) => (e.cpf && onlyDigits(p.cpf) === onlyDigits(e.cpf)) || normG(p.name) === normG(e.name)));
  if (!list.length || !confirm(`Importar ${list.length} funcionário(s) do RH como "Equipe Casa Cor"?`)) return;
  await api.insert('gate_people', list.map((e) => ({ name: e.name, cpf: e.cpf || '', is_team: true, company: 'Casa Cor', last_env_id: common?.id ?? null, last_service: e.job_title || 'Equipe Casa Cor' })));
  toast(`${list.length} importado(s) ✅`); await reloadGate();
}

/* ---------- Eventos ---------- */
function bindPortaria(v) {
  $$('[data-gtab]', v).forEach((b) => b.addEventListener('click', () => { gui.tab = b.dataset.gtab; render(); }));
  $('#gIn', v)?.addEventListener('click', openEntryFlow);
  $('#gOut', v)?.addEventListener('click', openExitFlow);
  $('#gLogout', v)?.addEventListener('click', () => { if (confirm('Sair do sistema neste aparelho?')) { api.signOut(); localStorage.removeItem(CACHE_KEY); location.reload(); } });
  $$('[data-gexit]', v).forEach((el) => el.addEventListener('click', () => {
    const x = state.gateEntries.find((y) => y.id === el.dataset.gexit); const p = gPerson(x.person_id);
    openModal(`<div class="g-modal"><h2>${esc(p?.name || '')}</h2><p class="g-big-text">Entrou às <b>${fmtTime(x.entered_at)}</b><br>${esc(envLabel(gEnv(x.env_id)))} · ${esc(x.service)}</p>
      <div class="modal-actions"><button class="btn big" value="cancel" formnovalidate>Voltar</button><button class="btn big primary" value="exit">⬅️ Registrar SAÍDA</button></div></div>`,
    async (action) => { if (action === 'exit') await registerExit([x]); });
  }));
  $('#gDate', v)?.addEventListener('change', (e) => { gui.date = e.target.value || todayISO(); gui.report = null; render(); });
  $('#gEnvF', v)?.addEventListener('change', (e) => { gui.env = e.target.value; render(); });
  const q = $('#gQ', v); q?.addEventListener('input', () => { gui.q = q.value; const pos = q.selectionStart; render(); const n = $('#gQ'); n.focus(); n.setSelectionRange(pos, pos); });
  $('#gCsv', v)?.addEventListener('click', exportGateCsv);
  $('#gNewEnv', v)?.addEventListener('click', () => openEnvForm());
  $$('[data-genvedit]', v).forEach((b) => b.addEventListener('click', () => openEnvForm(gEnv(b.dataset.genvedit))));
  const pq = $('#gPQ', v); pq?.addEventListener('input', () => { gui.peopleQ = pq.value; const pos = pq.selectionStart; render(); const n = $('#gPQ'); n.focus(); n.setSelectionRange(pos, pos); });
  $$('[data-gpedit]', v).forEach((b) => b.addEventListener('click', (e) => { e.stopPropagation(); openPersonForm(gPerson(b.dataset.gpedit)); }));
  $('#gImport', v)?.addEventListener('click', importTeamFromRH);
}
