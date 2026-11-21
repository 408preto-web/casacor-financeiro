'use strict';

/* =========================================================
   Garagem — controle de veículos
   Abastecimentos (com km/l), manutenções e despesas (com notas e fotos),
   lembretes de revisão, relatórios e o "Histórico do veículo" em PDF
   (para mostrar na hora de vender, com os documentos anexados).
   Dados no Supabase (tabelas vei_…), mesmo projeto da CASACOR.
   ========================================================= */

/* ---------- Utilitários ---------- */
const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const pad = (n) => String(n).padStart(2, '0');
const todayISO = () => { const d = new Date(); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; };
const addDaysISO = (iso, n) => { const [y, m, d] = iso.split('-').map(Number); const x = new Date(y, m - 1, d + n); return `${x.getFullYear()}-${pad(x.getMonth() + 1)}-${pad(x.getDate())}`; };
const dateDiffDays = (a, b) => { const [y1, m1, d1] = a.split('-').map(Number); const [y2, m2, d2] = b.split('-').map(Number); return Math.round((new Date(y2, m2 - 1, d2) - new Date(y1, m1 - 1, d1)) / 86400000); };
const fmtDate = (iso) => (iso ? String(iso).slice(0, 10).split('-').reverse().join('/') : '');
const monthOf = (iso) => String(iso || '').slice(0, 7);
const monthName = (ym) => { const [y, m] = ym.split('-').map(Number); const s = new Date(y, m - 1, 1).toLocaleDateString('pt-BR', { month: 'short', year: '2-digit' }); return s.charAt(0).toUpperCase() + s.slice(1); };
const brl = new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' });
const money = (v) => brl.format(Number(v) || 0);
const nf = (v, d = 0) => (v == null || Number.isNaN(Number(v)) ? '—' : Number(v).toLocaleString('pt-BR', { minimumFractionDigits: d, maximumFractionDigits: d }));
const km = (v) => (v == null ? '—' : `${nf(v)} km`);
function parseNum(str) {
  let s = String(str ?? '').replace(/[^\d,.-]/g, '');
  if (!s) return NaN;
  const c = s.lastIndexOf(','), d = s.lastIndexOf('.');
  if (c > d) s = s.replace(/\./g, '').replace(',', '.');
  else if (d > c && c !== -1) s = s.replace(/,/g, '');
  else if (c === -1 && /^-?\d{1,3}(\.\d{3})+$/.test(s)) s = s.replace(/\./g, '');
  return Number(s);
}
const numInput = (v, d = 2) => (v == null || v === '' ? '' : Number(v).toFixed(d).replace('.', ','));
const uuid = () => (crypto.randomUUID ? crypto.randomUUID() : 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => { const r = (Math.random() * 16) | 0; return (c === 'x' ? r : (r & 0x3) | 0x8).toString(16); }));
function loadScriptOnce(src) {
  return new Promise((res, rej) => {
    if ([...document.scripts].some((s) => s.src === src && s.dataset.ok)) return res();
    const s = document.createElement('script'); s.src = src;
    s.onload = () => { s.dataset.ok = '1'; res(); }; s.onerror = () => rej(new Error('Sem internet para carregar o gerador de PDF/planilha'));
    document.head.appendChild(s);
  });
}

/* ---------- Tabelas fixas ---------- */
const FUELS = { gasolina: 'Gasolina', etanol: 'Etanol', diesel: 'Diesel', gnv: 'GNV (m³)', eletrico: 'Elétrico (kWh)' };
const VFUELS = { flex: 'Flex (gasolina/etanol)', gasolina: 'Gasolina', etanol: 'Etanol', diesel: 'Diesel', gnv: 'GNV', eletrico: 'Elétrico', hibrido: 'Híbrido' };
// Manutenção (vai para o histórico do veículo) × outras despesas
const KINDS = {
  revisao: ['🛠️', 'Revisão', 'm'], oleo: ['🛢️', 'Troca de óleo e filtros', 'm'], pneus: ['🛞', 'Pneus', 'm'], freios: ['🛑', 'Freios', 'm'],
  suspensao: ['🔩', 'Suspensão', 'm'], alinhamento: ['🎯', 'Alinhamento e balanceamento', 'm'], bateria: ['🔋', 'Bateria', 'm'], eletrica: ['⚡', 'Elétrica', 'm'],
  mecanica: ['🔧', 'Mecânica (outros)', 'm'], arcond: ['❄️', 'Ar-condicionado', 'm'], funilaria: ['🎨', 'Funilaria e pintura', 'm'], vidros: ['🪟', 'Vidros', 'm'],
  acessorios: ['🧰', 'Acessórios', 'm'], lavagem: ['🧽', 'Lavagem e estética', 'd'], ipva: ['📄', 'IPVA e licenciamento', 'd'], seguro: ['🛡️', 'Seguro', 'd'],
  multa: ['🚨', 'Multa', 'd'], estacionamento: ['🅿️', 'Estacionamento e pedágio', 'd'], outro: ['📝', 'Outro', 'd'],
};
const kindLabel = (k) => (KINDS[k] ? `${KINDS[k][0]} ${KINDS[k][1]}` : k);
const isMaint = (k) => KINDS[k]?.[2] === 'm';
const ROLES = { owner: 'Administra', driver: 'Lança', pending: 'Aguardando aprovação', blocked: 'Sem acesso' };
const BUCKET = 'veiculos';

/* ---------- Estado ---------- */
const CACHE_KEY = 'garagem:cache';
const state = { me: null, members: [], vehicles: [], fuel: [], services: [], loadedAt: null };
const ui = { view: 'painel', vid: '', rep: { vid: '', from: '', to: '' }, loading: false, offline: false };
const isOwner = () => state.me?.role === 'owner';
const vById = (id) => state.vehicles.find((v) => v.id === id);
const vLabel = (v) => (v ? `${v.name}${v.plate ? ' · ' + v.plate : ''}` : '—');
const activeVehicles = () => state.vehicles.filter((v) => v.active);
const memberName = (id) => state.members.find((m) => m.user_id === id)?.name || '—';
function saveCache() { try { localStorage.setItem(CACHE_KEY, JSON.stringify(state)); } catch { /* ignora */ } }
function loadCache() { try { const c = JSON.parse(localStorage.getItem(CACHE_KEY)); if (c?.me?.user_id === api.session()?.user.id) Object.assign(state, c); } catch { /* ignora */ } }

/* ---------- Cálculos ---------- */
/** Consumo pelo método "tanque cheio a tanque cheio": km rodados ÷ litros colocados desde o último tanque cheio. */
function fuelCalc(vid) {
  const list = state.fuel.filter((f) => f.vehicle_id === vid).sort((a, b) => a.odometer - b.odometer || String(a.date).localeCompare(String(b.date)));
  const per = {}; let lastFull = null, accL = 0, accR = 0, prev = null;
  let segKm = 0, segL = 0, segR = 0;
  for (const f of list) {
    const r = { ran: prev ? f.odometer - prev.odometer : null };
    if (lastFull) {
      accL += Number(f.liters); accR += Number(f.total);
      if (f.full_tank) {
        const d = f.odometer - lastFull.odometer;
        if (d > 0 && accL > 0) { r.kml = d / accL; r.kmSeg = d; r.costKm = accR / d; segKm += d; segL += accL; segR += accR; }
        lastFull = f; accL = 0; accR = 0;
      }
    } else if (f.full_tank) lastFull = f;
    per[f.id] = r; prev = f;
  }
  const measured = list.filter((f) => per[f.id]?.kml);
  return { list, per, avg: segL ? segKm / segL : null, costKm: segKm ? segR / segKm : null, last: measured.length ? per[measured[measured.length - 1].id].kml : null };
}
function currentKm(vid) {
  const v = vById(vid);
  const odos = [Number(v?.initial_km) || 0, ...state.fuel.filter((f) => f.vehicle_id === vid).map((f) => Number(f.odometer)), ...state.services.filter((s) => s.vehicle_id === vid && s.odometer != null).map((s) => Number(s.odometer))];
  return Math.max(...odos);
}
/** Lembretes: próxima troca/revisão (por km ou data) de cada tipo, do serviço mais recente. */
function reminders(vid) {
  const out = []; const seen = new Set();
  const list = state.services.filter((s) => (!vid || s.vehicle_id === vid) && (s.next_km || s.next_date)).sort((a, b) => String(b.date).localeCompare(String(a.date)));
  for (const s of list) {
    const key = `${s.vehicle_id}|${s.kind}`; if (seen.has(key)) continue; seen.add(key);
    const cur = currentKm(s.vehicle_id); const t = todayISO();
    const kmLeft = s.next_km ? s.next_km - cur : null; const dLeft = s.next_date ? dateDiffDays(t, s.next_date) : null;
    const late = (kmLeft != null && kmLeft <= 0) || (dLeft != null && dLeft < 0);
    const soon = !late && ((kmLeft != null && kmLeft <= 1000) || (dLeft != null && dLeft <= 30));
    out.push({ s, kmLeft, dLeft, late, soon });
  }
  return out.sort((a, b) => (b.late - a.late) || (b.soon - a.soon) || ((a.dLeft ?? 9e9) - (b.dLeft ?? 9e9)));
}
const remText = (r) => [r.s.next_km ? (r.kmLeft <= 0 ? `passou ${nf(-r.kmLeft)} km` : `em ${nf(r.kmLeft)} km (aos ${nf(r.s.next_km)})`) : '',
  r.s.next_date ? (r.dLeft < 0 ? `venceu ${fmtDate(r.s.next_date)}` : `até ${fmtDate(r.s.next_date)}`) : ''].filter(Boolean).join(' · ');

/* ---------- Carregar ---------- */
async function loadAll({ quiet = false } = {}) {
  if (ui.loading && Date.now() - (ui.loadingSince || 0) < 60000) return;
  ui.loading = true; ui.loadingSince = Date.now(); updatePill();
  try {
    const [members, vehicles, fuel, services] = await Promise.all([
      api.select('vei_members', 'select=*&order=name'), api.select('vei_vehicles', 'select=*&order=name'),
      api.select('vei_fuel', 'select=*&order=date.desc,odometer.desc'), api.select('vei_services', 'select=*&order=date.desc'),
    ]);
    const me = members.find((m) => m.user_id === api.session().user.id);
    if (me) state.me = me;
    Object.assign(state, { members, vehicles, fuel, services, loadedAt: Date.now() });
    if (!vById(ui.vid)) ui.vid = activeVehicles()[0]?.id || '';
    ui.offline = false; saveCache();
    if (!me || !['driver', 'owner'].includes(me.role)) return boot();
    if (!modal.open && !document.activeElement?.matches?.('input, textarea, select')) render(); else updateBadges();
  } catch (e) {
    ui.offline = !navigator.onLine || /conexão/.test(e.message);
    if (!quiet) toast(e.message);
    if (/sessão expirou|login/i.test(e.message)) boot();
  } finally { ui.loading = false; updatePill(); }
}

/* ---------- Toast e modal ---------- */
let toastTimer;
function toast(msg) { const el = $('#toast'); el.textContent = msg; el.classList.add('show'); clearTimeout(toastTimer); toastTimer = setTimeout(() => el.classList.remove('show'), 2800); }
const modal = $('#modal'); const modalForm = $('#modalForm');
function openModal(html, onSubmit, onReady) {
  modalForm.innerHTML = html;
  modalForm.onsubmit = async (e) => {
    e.preventDefault();
    const action = e.submitter?.value || 'ok';
    if (action === 'cancel') { modal.close(); return; }
    const btns = $$('button', modalForm); btns.forEach((b) => (b.disabled = true));
    const sub = e.submitter; const label = sub?.textContent; if (sub) sub.textContent = 'Aguarde…';
    try { const r = await onSubmit(action, new FormData(modalForm), e.submitter); if (r !== false) modal.close(); }
    catch (err) { toast(err.message || String(err)); }
    finally { btns.forEach((b) => (b.disabled = false)); if (sub && document.contains(sub)) sub.textContent = label; }
  };
  if (!modal.open) modal.showModal();
  onReady?.();
}
modal.addEventListener('click', (e) => { if (e.target === modal) modal.close(); });

/* ---------- Telas de acesso ---------- */
function showGate(html) {
  $('#app').hidden = true; $('#fab').hidden = true;
  const g = $('#gate'); g.hidden = false;
  g.innerHTML = `<div class="gate-card"><div class="gate-brand brand-g"><img src="icons/icon.svg" alt=""><span>Garagem<small>Controle de veículos</small></span></div>${html}</div>`;
}
function gateLogin(mode = 'login', msg = '') {
  const signup = mode === 'signup';
  showGate(`
    <div class="seg gate-tabs">
      <input type="radio" name="gm" id="gmL" ${signup ? '' : 'checked'}><label for="gmL">Entrar</label>
      <input type="radio" name="gm" id="gmS" ${signup ? 'checked' : ''}><label for="gmS">Criar acesso</label>
    </div>
    <form id="gateForm" class="form-grid one">
      ${signup ? '<label class="field"><span>Seu nome</span><input name="name" autocomplete="name" required></label>' : ''}
      <label class="field"><span>E-mail</span><input name="email" type="email" autocomplete="username" inputmode="email" autocapitalize="off" required></label>
      <label class="field"><span>Senha ${signup ? '(mínimo 6 caracteres)' : ''}</span><input name="password" type="password" autocomplete="${signup ? 'new-password' : 'current-password'}" required minlength="6"></label>
      ${msg ? `<p class="gate-msg">${esc(msg)}</p>` : ''}
      <button class="btn primary big">${signup ? 'Criar acesso' : 'Entrar'}</button>
      ${signup ? '<p class="muted small">Quem já tem acesso à CASACOR pode entrar direto com o mesmo e-mail e senha (o administrador da Garagem aprova).</p>' : '<button type="button" class="link-btn" id="forgot">Esqueci minha senha</button>'}
    </form>`);
  $('#gmL').addEventListener('change', () => gateLogin('login'));
  $('#gmS').addEventListener('change', () => gateLogin('signup'));
  $('#forgot')?.addEventListener('click', async () => {
    const em = $('[name=email]').value.trim(); if (!em) { toast('Escreva seu e-mail primeiro'); return; }
    try { await api.recover(em); gateLogin('login', 'Se o e-mail estiver cadastrado, você vai receber um link para criar uma nova senha.'); } catch (e) { toast(e.message); }
  });
  $('#gateForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const fd = new FormData(e.target); const btn = $('button.primary', e.target); btn.disabled = true; btn.textContent = 'Aguarde…';
    try {
      if (signup) await api.signUp(fd.get('email').trim(), fd.get('password'), fd.get('name').trim());
      else await api.signIn(fd.get('email').trim(), fd.get('password'));
      await afterLogin(signup ? fd.get('name').trim() : '');
    } catch (err) {
      if (signup && /already|registered/i.test(err.message)) return gateLogin('login', 'Este e-mail já tem acesso (talvez da CASACOR). Entre com a mesma senha.');
      gateLogin(mode, err.message);
    }
  });
}
async function afterLogin(name = '') {
  try {
    const role = await api.rpc('vei_join', { p_name: name || api.session().user.email.split('@')[0] });
    if (role === 'pending' || role === 'blocked') return gateWaiting(role);
    await loadAll(); startApp();
  } catch (e) { gateLogin('login', /vei_join|não foi configurado/.test(e.message) ? 'O banco da Garagem ainda não foi configurado: rode o supabase-veiculos.sql no Supabase.' : e.message); }
}
function gateWaiting(role) {
  const s = api.session();
  showGate(role === 'blocked'
    ? `<h2>Acesso não liberado</h2><p class="muted">O acesso de <b>${esc(s?.user.email)}</b> foi recusado.</p><button class="btn" id="out">Sair</button>`
    : `<h2>⏳ Aguardando aprovação</h2><p class="muted">Seu acesso (<b>${esc(s?.user.email)}</b>) foi pedido. Quem administra a Garagem aprova em <b>Pessoas</b>. Depois toque em “Verificar”.</p>
       <div class="row-actions"><button class="btn primary" id="check">Verificar</button><button class="btn" id="out">Sair</button></div>`);
  $('#out').addEventListener('click', () => { api.signOut(); localStorage.removeItem(CACHE_KEY); gateLogin(); });
  $('#check')?.addEventListener('click', () => afterLogin());
}
function gateNewPassword(token) {
  showGate(`<h2>Criar nova senha</h2><form id="gateForm" class="form-grid one">
    <label class="field"><span>Nova senha (mínimo 6 caracteres)</span><input name="password" type="password" minlength="6" required autocomplete="new-password"></label>
    <button class="btn primary big">Salvar nova senha</button></form>`);
  $('#gateForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    try { await api.updatePassword(new FormData(e.target).get('password'), token); gateLogin('login', 'Senha alterada. Entre com a nova senha.'); } catch (err) { toast(err.message); }
  });
}

/* ---------- Início e navegação ---------- */
let started = false;
function startApp() {
  $('#gate').hidden = true; $('#gate').innerHTML = ''; $('#app').hidden = false; $('#fab').hidden = false;
  if (!started) {
    started = true;
    $$('.nav-item').forEach((b) => b.addEventListener('click', () => setView(b.dataset.view)));
    $('#addFuel').addEventListener('click', () => openFuelForm());
    $('#addService').addEventListener('click', () => openServiceForm());
    $('#fab').addEventListener('click', openQuickAdd);
    $('#syncPill').addEventListener('click', () => loadAll());
    window.addEventListener('online', () => loadAll({ quiet: true }));
    document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') loadAll({ quiet: true }); });
    setInterval(() => { if (document.visibilityState === 'visible' && !modal.open) loadAll({ quiet: true }); }, 90000);
  }
  setView(ui.view);
}
async function boot() {
  if (!cfg()) { showGate('<h2>Configuração pendente</h2><p class="muted">Falta o endereço do Supabase em config.js.</p>'); return; }
  const h = new URLSearchParams(location.hash.slice(1));
  if (h.get('type') === 'recovery' && h.get('access_token')) { history.replaceState(null, '', location.pathname); return gateNewPassword(h.get('access_token')); }
  if (!api.session()) return gateLogin();
  loadCache();
  if (state.me && ['driver', 'owner'].includes(state.me.role) && state.loadedAt) { startApp(); return loadAll({ quiet: true }); }
  return afterLogin();
}
const TITLES = { painel: 'Painel', abastecimentos: 'Abastecimentos', manutencao: 'Manutenção e despesas', relatorios: 'Relatórios', veiculos: 'Veículos', pessoas: 'Pessoas', ajustes: 'Ajustes' };
function setView(v) { ui.view = v; $$('.nav-item').forEach((b) => b.classList.toggle('active', b.dataset.view === v)); render(); window.scrollTo({ top: 0 }); }
function render() {
  if (!state.me) return;
  $('#viewTitle').textContent = TITLES[ui.view];
  $('#sidebarUser').innerHTML = `<b>${esc(state.me.name)}</b><span>${ROLES[state.me.role] || ''}</span>`;
  const views = { painel: renderPainel, abastecimentos: renderFuel, manutencao: renderServices, relatorios: renderReports, veiculos: renderVehicles, pessoas: renderPeople, ajustes: renderSettings };
  $('#view').innerHTML = views[ui.view]();
  bindView(); updateBadges(); updatePill();
}
function updatePill() {
  const el = $('#syncPill'); if (!el) return;
  const t = state.loadedAt ? new Date(state.loadedAt).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' }) : '';
  el.className = `sync-pill ${ui.offline ? 'warn' : 'ok'}`;
  el.innerHTML = ui.loading ? '🔄 <span class="sync-text">Atualizando…</span>' : ui.offline ? '📴 <span class="sync-text">Sem internet</span>' : `✅ <span class="sync-text">Atualizado ${t}</span>`;
}
function updateBadges() {
  const n = reminders().filter((r) => r.late || r.soon).length;
  const pb = $('.nav-item[data-view="painel"] .nav-badge'); if (pb) { pb.textContent = n; pb.hidden = !n; }
  const np = isOwner() ? state.members.filter((m) => m.role === 'pending').length : 0;
  const eb = $('.nav-item[data-view="pessoas"] .nav-badge'); if (eb) { eb.textContent = np; eb.hidden = !np; }
}
const vehicleChips = (withAll = false, sel = ui.vid, attr = 'data-vsel') => (state.vehicles.length > 1 || withAll
  ? `<div class="v-chips">${withAll ? `<button class="v-chip ${!sel ? 'sel' : ''}" ${attr}="">Todos</button>` : ''}${activeVehicles().map((v) => `<button class="v-chip ${sel === v.id ? 'sel' : ''}" ${attr}="${v.id}">🚗 ${esc(v.name)}</button>`).join('')}</div>` : '');

/* ---------- Painel ---------- */
function renderPainel() {
  if (!state.vehicles.length) {
    return `<div class="card"><div class="empty"><div style="font-size:48px">🚗</div><p>Nenhum veículo cadastrado ainda.</p>
      ${isOwner() ? '<button class="btn primary" id="firstVehicle">+ Cadastrar o primeiro veículo</button>' : '<p class="muted">Peça para quem administra cadastrar os veículos.</p>'}</div></div>`;
  }
  const pend = isOwner() ? state.members.filter((m) => m.role === 'pending') : [];
  const rems = reminders().filter((r) => r.late || r.soon);
  const t = todayISO(); const ym = monthOf(t);
  return `<p class="hello">Olá, <b>${esc(state.me.name.split(' ')[0])}</b> 👋</p>
  ${pend.length ? `<div class="alerts"><div class="alert info"><span class="alert-icon">⏳</span><div class="alert-text"><b>${pend.length} pessoa(s) aguardando aprovação</b> <span class="muted">${pend.map((m) => esc(m.name)).join(', ')}</span></div><button class="btn small primary" data-go="pessoas">Ver</button></div></div>` : ''}
  ${rems.length ? `<div class="alerts">${rems.map((r) => `<div class="alert ${r.late ? 'danger' : ''}"><span class="alert-icon">${r.late ? '🚨' : '🔔'}</span>
    <div class="alert-text"><b>${esc(vById(r.s.vehicle_id)?.name || '')}: ${esc(KINDS[r.s.kind]?.[1] || r.s.kind)}</b> ${esc(remText(r))}</div></div>`).join('')}</div>` : ''}
  <div class="v-cards">${activeVehicles().map((v) => {
    const c = fuelCalc(v.id); const cur = currentKm(v.id);
    const spent = state.fuel.filter((f) => f.vehicle_id === v.id && monthOf(f.date) === ym).reduce((s, f) => s + Number(f.total), 0)
      + state.services.filter((s) => s.vehicle_id === v.id && monthOf(s.date) === ym).reduce((s, x) => s + Number(x.cost), 0);
    const lastF = state.fuel.filter((f) => f.vehicle_id === v.id).sort((a, b) => b.odometer - a.odometer)[0];
    return `<div class="card v-card">
      <div class="v-head"><div class="v-ico">🚗</div><div><b>${esc(v.name)}</b><small>${esc([v.brand, v.model, v.year].filter(Boolean).join(' '))}</small></div>${v.plate ? `<span class="v-plate">${esc(v.plate)}</span>` : ''}</div>
      <div class="v-stats">
        <div class="v-stat"><span>Km atual</span><b>${nf(cur)}</b></div>
        <div class="v-stat"><span>Média</span><b>${c.avg ? nf(c.avg, 1) : '—'}</b><span>km/l${c.last ? ` · último ${nf(c.last, 1)}` : ''}</span></div>
        <div class="v-stat"><span>Gasto no mês</span><b style="font-size:15px">${money(spent)}</b></div>
      </div>
      ${lastF ? `<div class="muted small">Último abastecimento: ${fmtDate(lastF.date)} · ${nf(lastF.liters, 1)} L · ${money(lastF.total)}</div>` : '<div class="muted small">Nenhum abastecimento ainda.</div>'}
      <div class="v-actions"><button class="btn primary" data-addfuel="${v.id}">⛽ Abastecer</button><button class="btn" data-addserv="${v.id}">🔧 Despesa</button></div>
    </div>`;
  }).join('')}</div>
  <div class="card mt"><div class="card-head"><h2>Últimos lançamentos</h2></div>${recentList()}</div>`;
}
function recentList() {
  const items = [...state.fuel.map((f) => ({ t: 'f', d: f.date, x: f, c: f.created_at })), ...state.services.map((s) => ({ t: 's', d: s.date, x: s, c: s.created_at }))]
    .sort((a, b) => String(b.d).localeCompare(String(a.d)) || String(b.c).localeCompare(String(a.c))).slice(0, 8);
  if (!items.length) return '<div class="empty small">Nada lançado ainda.</div>';
  return `<ul class="tx-list">${items.map((i) => (i.t === 'f' ? fuelRow(i.x) : serviceRow(i.x))).join('')}</ul>`;
}

/* ---------- Abastecimentos ---------- */
function fuelRow(f, calc) {
  const c = (calc || fuelCalc(f.vehicle_id)).per[f.id] || {}; const v = vById(f.vehicle_id);
  return `<li class="tx" data-fuel="${f.id}"><div class="tx-icon">⛽</div><div class="tx-main">
    <div class="tx-title">${esc(f.station || FUELS[f.fuel] || 'Abastecimento')} <span class="muted">· ${nf(f.liters, 2)} L${f.price_l ? ` · ${money(f.price_l)}/L` : ''}</span>${f.full_tank ? '' : ' <span class="badge">parcial</span>'}</div>
    <div class="tx-meta">${fmtDate(f.date)} · ${esc(v?.name || '')} · ${nf(f.odometer)} km${c.ran != null ? ` · rodou ${nf(c.ran)} km` : ''}${f.attachments?.length ? ' · 📎' : ''}</div></div>
    <div class="tx-amount">${money(f.total)}${c.kml ? `<small class="kml ${c.kml < (fuelCalc(f.vehicle_id).avg || 0) * 0.85 ? 'low' : ''}">${nf(c.kml, 1)} km/l</small>` : ''}</div></li>`;
}
function renderFuel() {
  const vid = ui.vid; const calc = vid ? fuelCalc(vid) : null;
  const list = state.fuel.filter((f) => !vid || f.vehicle_id === vid);
  const ym = monthOf(todayISO()); const mon = list.filter((f) => monthOf(f.date) === ym);
  return `${vehicleChips()}
  ${calc ? `<div class="grid cols-4">
    <div class="card stat"><div class="label">Consumo médio</div><div class="value">${calc.avg ? nf(calc.avg, 1) : '—'}</div><div class="sub">km/l</div></div>
    <div class="card stat"><div class="label">Último consumo</div><div class="value">${calc.last ? nf(calc.last, 1) : '—'}</div><div class="sub">km/l</div></div>
    <div class="card stat"><div class="label">Combustível por km</div><div class="value">${calc.costKm ? money(calc.costKm) : '—'}</div><div class="sub">R$/km</div></div>
    <div class="card stat"><div class="label">Este mês</div><div class="value">${money(mon.reduce((s, f) => s + Number(f.total), 0))}</div><div class="sub">${nf(mon.reduce((s, f) => s + Number(f.liters), 0), 1)} L em ${mon.length} abastecimento(s)</div></div>
  </div>` : ''}
  <div class="card mt">${list.length ? `<ul class="tx-list">${list.map((f) => fuelRow(f, calc && calc)).join('')}</ul>` : '<div class="empty small">Nenhum abastecimento. Toque em ⛽ Abastecer.</div>'}
  <p class="muted small">O consumo (km/l) é calculado de um tanque cheio até o próximo: km rodados ÷ litros colocados. Abastecimentos "parciais" entram na conta do próximo tanque cheio.</p></div>`;
}

function openFuelForm(f, vid) {
  if (!state.vehicles.length) { toast('Cadastre um veículo primeiro'); return; }
  const isEdit = !!f;
  const v0 = vById(f?.vehicle_id || vid || ui.vid) || activeVehicles()[0];
  const x = f || { vehicle_id: v0.id, date: todayISO(), odometer: '', liters: '', price_l: '', total: '', fuel: ['etanol', 'diesel', 'gnv', 'eletrico'].includes(v0.fuel) ? v0.fuel : 'gasolina', full_tank: true, station: '', notes: '', attachments: [] };
  const lastP = state.fuel.filter((y) => y.vehicle_id === x.vehicle_id && y.id !== x.id).sort((a, b) => b.odometer - a.odometer)[0];
  let atts = [...(x.attachments || [])];
  openModal(`<h2>⛽ ${isEdit ? 'Editar abastecimento' : 'Abastecimento'}</h2>
    <div class="form-grid">
      <label class="field"><span>Veículo</span><select name="vehicle_id">${activeVehicles().map((v) => `<option value="${v.id}" ${v.id === x.vehicle_id ? 'selected' : ''}>${esc(vLabel(v))}</option>`).join('')}</select></label>
      <label class="field"><span>Data</span><input type="date" name="date" value="${x.date}" required></label>
      <label class="field full"><span>Km no painel (hodômetro) *</span><input name="odometer" inputmode="numeric" value="${x.odometer ?? ''}" required placeholder="Ex.: 45230" autocomplete="off">
        <small class="calc-hint" id="odoHint">${lastP ? `Último registro: ${nf(lastP.odometer)} km em ${fmtDate(lastP.date)}` : 'Primeiro abastecimento deste veículo.'}</small></label>
      <label class="field"><span>Litros *</span><input name="liters" inputmode="decimal" value="${numInput(x.liters, 2)}" placeholder="0,00" autocomplete="off"></label>
      <label class="field"><span>Preço por litro</span><input name="price_l" inputmode="decimal" value="${numInput(x.price_l, 2)}" placeholder="0,00" autocomplete="off"></label>
      <label class="field"><span>Total pago (R$) *</span><input class="amount-input" name="total" inputmode="decimal" value="${numInput(x.total, 2)}" placeholder="0,00" autocomplete="off"></label>
      <label class="field"><span>Combustível</span><select name="fuel">${Object.entries(FUELS).map(([k, l]) => `<option value="${k}" ${x.fuel === k ? 'selected' : ''}>${l}</option>`).join('')}</select></label>
      <label class="check full"><input type="checkbox" name="full_tank" ${x.full_tank ? 'checked' : ''}><span><b>Tanque cheio</b> (encheu até o fim — necessário para calcular o km/l)</span></label>
      <label class="field full"><span>Posto</span><input name="station" value="${esc(x.station)}" placeholder="Ex.: Posto Ipiranga da Santos Dumont" list="stations" autocomplete="off">
        <datalist id="stations">${[...new Set(state.fuel.map((y) => y.station).filter(Boolean))].slice(0, 30).map((s) => `<option value="${esc(s)}">`).join('')}</datalist></label>
      <div class="field full"><span>Cupom / foto (opcional)</span><div id="attBox">${attThumbs(atts, true)}</div><input type="file" name="files" accept="image/*,application/pdf" multiple></div>
      <label class="field full"><span>Observação</span><input name="notes" value="${esc(x.notes)}"></label>
    </div>
    <div id="fuelPreview" class="calc-hint"></div>
    <div class="modal-actions">${isEdit ? '<button class="btn danger" value="delete" formnovalidate>Excluir</button>' : ''}<span class="spacer"></span><button class="btn" value="cancel" formnovalidate>Cancelar</button><button class="btn primary" value="save">Salvar</button></div>`,
  async (action, fd) => {
    if (action === 'delete') {
      if (!confirm('Excluir este abastecimento?')) return false;
      await api.remove('vei_fuel', `id=eq.${f.id}`); api.deleteFiles(atts.map((a) => a.path), BUCKET).catch(() => {}); toast('Excluído'); return reloadAndRender();
    }
    const odo = Math.round(parseNum(fd.get('odometer'))); const L = parseNum(fd.get('liters')); const P = parseNum(fd.get('price_l')); let T = parseNum(fd.get('total'));
    if (!(odo >= 0)) { toast('Informe o km do painel'); return false; }
    if (!(L > 0)) { toast('Informe os litros'); return false; }
    if (!(T > 0) && P > 0) T = Math.round(L * P * 100) / 100;
    if (!(T > 0)) { toast('Informe o total pago'); return false; }
    const vid2 = fd.get('vehicle_id'); const date = fd.get('date');
    const prev = state.fuel.filter((y) => y.vehicle_id === vid2 && y.id !== x.id && String(y.date) <= date).sort((a, b) => b.odometer - a.odometer)[0];
    if (prev && odo <= prev.odometer && !confirm(`O km (${nf(odo)}) é menor ou igual ao do abastecimento de ${fmtDate(prev.date)} (${nf(prev.odometer)} km). Salvar assim mesmo?`)) return false;
    const files = $('[name=files]', modalForm).files;
    const newAtts = files.length ? await uploadFiles(files, `${vid2}/abastecimentos`, 'cupom') : [];
    const data = { vehicle_id: vid2, date, odometer: odo, liters: L, price_l: P > 0 ? P : Math.round((T / L) * 1000) / 1000, total: T, fuel: fd.get('fuel'), full_tank: fd.get('full_tank') === 'on',
      station: fd.get('station').trim(), notes: fd.get('notes').trim(), attachments: [...atts, ...newAtts] };
    let id = f?.id;
    if (isEdit) await api.update('vei_fuel', `id=eq.${f.id}`, data);
    else { const [row] = await api.insert('vei_fuel', data); id = row.id; }
    await loadAll({ quiet: true });
    const c = fuelCalc(vid2).per[id] || {};
    toast(c.kml ? `⛽ Rodou ${nf(c.kmSeg)} km · ${nf(c.kml, 1)} km/l` : c.ran ? `⛽ Salvo · rodou ${nf(c.ran)} km desde o último` : '⛽ Abastecimento salvo');
    render();
  }, () => {
    const sync = () => {
      const L = parseNum($('[name=liters]').value), P = parseNum($('[name=price_l]').value), T = parseNum($('[name=total]').value);
      const odo = parseNum($('[name=odometer]').value);
      const vid2 = $('[name=vehicle_id]').value; const lp = state.fuel.filter((y) => y.vehicle_id === vid2 && y.id !== x.id).sort((a, b) => b.odometer - a.odometer)[0];
      const bits = [];
      if (L > 0 && P > 0 && !(T > 0)) bits.push(`Total: <b>${money(L * P)}</b>`);
      if (L > 0 && T > 0 && !(P > 0)) bits.push(`Preço por litro: <b>${money(T / L)}</b>`);
      if (lp && odo > lp.odometer) bits.push(`Rodou <b>${nf(odo - lp.odometer)} km</b> desde ${fmtDate(lp.date)}${lp.full_tank && $('[name=full_tank]').checked && L > 0 ? ` · aprox. <b>${nf((odo - lp.odometer) / L, 1)} km/l</b>` : ''}`);
      $('#fuelPreview').innerHTML = bits.join(' · ');
      $('#odoHint').textContent = lp ? `Último registro: ${nf(lp.odometer)} km em ${fmtDate(lp.date)}` : 'Primeiro abastecimento deste veículo.';
    };
    $$('input, select', modalForm).forEach((el) => el.addEventListener('input', sync));
    $('[name=liters]').addEventListener('blur', () => { const L = parseNum($('[name=liters]').value), P = parseNum($('[name=price_l]').value), T = $('[name=total]'); if (L > 0 && P > 0 && !(parseNum(T.value) > 0)) T.value = numInput(L * P, 2); });
    $('[name=total]').addEventListener('blur', () => { const L = parseNum($('[name=liters]').value), T = parseNum($('[name=total]').value), P = $('[name=price_l]'); if (L > 0 && T > 0 && !(parseNum(P.value) > 0)) P.value = numInput(T / L, 2); });
    bindAttBox(atts, (a) => { atts = a; });
    sync();
    if (!isEdit) setTimeout(() => $('[name=odometer]').focus(), 80);
  });
}

/* ---------- Manutenção e despesas ---------- */
function serviceRow(s) {
  const v = vById(s.vehicle_id); const k = KINDS[s.kind] || ['📝', s.kind];
  const warr = s.warranty_until && s.warranty_until >= todayISO();
  return `<li class="tx" data-serv="${s.id}"><div class="tx-icon">${k[0]}</div><div class="tx-main">
    <div class="tx-title">${esc(k[1])}${s.description ? ` <span class="muted">— ${esc(s.description)}</span>` : ''}${warr ? ' <span class="badge paid">em garantia</span>' : ''}</div>
    <div class="tx-meta">${fmtDate(s.date)} · ${esc(v?.name || '')}${s.odometer != null ? ` · ${nf(s.odometer)} km` : ''}${s.shop ? ` · ${esc(s.shop)}` : ''}${s.attachments?.length ? ` · 📎 ${s.attachments.length}` : ''}</div></div>
    <div class="tx-amount">${money(s.cost)}</div></li>`;
}
function renderServices() {
  const vid = ui.vid;
  const list = state.services.filter((s) => !vid || s.vehicle_id === vid);
  const maint = list.filter((s) => isMaint(s.kind)); const other = list.filter((s) => !isMaint(s.kind));
  const rems = reminders(vid);
  return `${vehicleChips()}
  ${rems.length ? `<div class="card"><h2>🔔 Próximas trocas e revisões</h2>${rems.map((r) => `<div class="rem"><span><b>${esc(KINDS[r.s.kind]?.[1] || r.s.kind)}</b> <span class="muted">· ${esc(vById(r.s.vehicle_id)?.name || '')}</span></span><span class="${r.late ? 'late' : r.soon ? 'soon' : 'muted'}">${esc(remText(r))}</span></div>`).join('')}</div>` : ''}
  <div class="card mt"><div class="card-head"><h2>🔧 Manutenções</h2><span class="muted">${money(maint.reduce((s, x) => s + Number(x.cost), 0))}</span></div>
    ${maint.length ? `<ul class="tx-list">${maint.map(serviceRow).join('')}</ul>` : '<div class="empty small">Nenhuma manutenção lançada.</div>'}</div>
  <div class="card mt"><div class="card-head"><h2>📄 Outras despesas</h2><span class="muted">${money(other.reduce((s, x) => s + Number(x.cost), 0))}</span></div>
    ${other.length ? `<ul class="tx-list">${other.map(serviceRow).join('')}</ul>` : '<div class="empty small">IPVA, seguro, multas, lavagem, estacionamento…</div>'}</div>`;
}

function openServiceForm(s, vid) {
  if (!state.vehicles.length) { toast('Cadastre um veículo primeiro'); return; }
  const isEdit = !!s;
  const v0 = vById(s?.vehicle_id || vid || ui.vid) || activeVehicles()[0];
  const x = s || { vehicle_id: v0.id, date: todayISO(), odometer: currentKm(v0.id) || '', kind: 'revisao', description: '', shop: '', cost: '', warranty_until: '', next_km: '', next_date: '', notes: '', attachments: [] };
  let atts = [...(x.attachments || [])];
  openModal(`<h2>🔧 ${isEdit ? 'Editar' : 'Manutenção ou despesa'}</h2>
    <div class="form-grid">
      <label class="field"><span>Veículo</span><select name="vehicle_id">${activeVehicles().map((v) => `<option value="${v.id}" ${v.id === x.vehicle_id ? 'selected' : ''}>${esc(vLabel(v))}</option>`).join('')}</select></label>
      <label class="field"><span>Data</span><input type="date" name="date" value="${x.date}" required></label>
      <div class="field full"><span>O que foi feito *</span><div class="kind-grid">${Object.entries(KINDS).map(([k, [i, l]]) => `<label class="kind-opt"><input type="radio" name="kind" value="${k}" ${x.kind === k ? 'checked' : ''}><span>${i} ${l}</span></label>`).join('')}</div></div>
      <label class="field full"><span>Descrição</span><input name="description" value="${esc(x.description)}" placeholder="Ex.: troca de pastilhas dianteiras, óleo 5W30 sintético…"></label>
      <label class="field"><span>Oficina / loja</span><input name="shop" value="${esc(x.shop)}" list="shops" autocomplete="off"><datalist id="shops">${[...new Set(state.services.map((y) => y.shop).filter(Boolean))].slice(0, 30).map((y) => `<option value="${esc(y)}">`).join('')}</datalist></label>
      <label class="field"><span>Valor (R$)</span><input class="amount-input" name="cost" inputmode="decimal" value="${numInput(x.cost, 2)}" placeholder="0,00"></label>
      <label class="field"><span>Km no painel</span><input name="odometer" inputmode="numeric" value="${x.odometer ?? ''}" placeholder="opcional"></label>
      <label class="field"><span>Garantia até</span><input type="date" name="warranty_until" value="${x.warranty_until || ''}"></label>
      <div class="field full"><span>🔔 Lembrar a próxima (opcional)</span><div class="form-grid" style="margin:0">
        <label class="field"><span>No km</span><input name="next_km" inputmode="numeric" value="${x.next_km ?? ''}" placeholder="Ex.: 55000"></label>
        <label class="field"><span>Ou na data</span><input type="date" name="next_date" value="${x.next_date || ''}"></label></div>
        <small class="calc-hint" id="nextHint"></small></div>
      <div class="field full"><span>📎 Nota fiscal, recibo, fotos (o histórico do veículo usa estes documentos)</span><div id="attBox">${attThumbs(atts, true)}</div><input type="file" name="files" accept="image/*,application/pdf" multiple></div>
      <label class="field full"><span>Observação</span><input name="notes" value="${esc(x.notes)}"></label>
    </div>
    <div class="modal-actions">${isEdit ? '<button class="btn danger" value="delete" formnovalidate>Excluir</button>' : ''}<span class="spacer"></span><button class="btn" value="cancel" formnovalidate>Cancelar</button><button class="btn primary" value="save">Salvar</button></div>`,
  async (action, fd) => {
    if (action === 'delete') {
      if (!confirm('Excluir este lançamento e os documentos anexados?')) return false;
      await api.remove('vei_services', `id=eq.${s.id}`); api.deleteFiles(atts.map((a) => a.path), BUCKET).catch(() => {}); toast('Excluído'); return reloadAndRender();
    }
    const vid2 = fd.get('vehicle_id'); const odo = parseNum(fd.get('odometer')); const nk = parseNum(fd.get('next_km')); const cost = parseNum(fd.get('cost'));
    const files = $('[name=files]', modalForm).files;
    const newAtts = files.length ? await uploadFiles(files, `${vid2}/servicos`, 'documento') : [];
    const data = { vehicle_id: vid2, date: fd.get('date'), kind: fd.get('kind') || 'outro', description: fd.get('description').trim(), shop: fd.get('shop').trim(),
      cost: cost > 0 ? cost : 0, odometer: odo >= 0 ? Math.round(odo) : null, warranty_until: fd.get('warranty_until') || null,
      next_km: nk > 0 ? Math.round(nk) : null, next_date: fd.get('next_date') || null, notes: fd.get('notes').trim(), attachments: [...atts, ...newAtts] };
    if (isEdit) await api.update('vei_services', `id=eq.${s.id}`, data); else await api.insert('vei_services', data);
    toast(isEdit ? 'Atualizado ✅' : `${kindLabel(data.kind)} salvo ✅`); await reloadAndRender();
  }, () => {
    const hint = () => {
      const k = $('[name=kind]:checked')?.value; const odo = parseNum($('[name=odometer]').value);
      $('#nextHint').innerHTML = k === 'oleo' && odo > 0 ? `Sugestão: próxima troca de óleo em <b>${nf(odo + 10000)} km</b> ou em 1 ano. <button type="button" class="link-btn" id="sugOil">usar</button>`
        : k === 'revisao' && odo > 0 ? `Sugestão: próxima revisão em <b>${nf(odo + 10000)} km</b>. <button type="button" class="link-btn" id="sugRev">usar</button>` : '';
      $('#sugOil')?.addEventListener('click', () => { $('[name=next_km]').value = Math.round(odo + 10000); $('[name=next_date]').value = addDaysISO($('[name=date]').value || todayISO(), 365); });
      $('#sugRev')?.addEventListener('click', () => { $('[name=next_km]').value = Math.round(odo + 10000); });
    };
    $$('[name=kind], [name=odometer]', modalForm).forEach((el) => el.addEventListener('input', hint)); hint();
    bindAttBox(atts, (a) => { atts = a; });
  });
}

function openServiceDetail(s) {
  const v = vById(s.vehicle_id); const k = KINDS[s.kind] || ['📝', s.kind];
  openModal(`<h2>${k[0]} ${esc(k[1])}</h2><p class="muted" style="margin-top:-6px">${esc(vLabel(v))} · ${fmtDate(s.date)}</p>
    <dl class="detail">
      ${s.description ? `<dt>Descrição</dt><dd>${esc(s.description)}</dd>` : ''}
      ${s.shop ? `<dt>Oficina / loja</dt><dd>${esc(s.shop)}</dd>` : ''}
      <dt>Valor</dt><dd><b>${money(s.cost)}</b></dd>
      ${s.odometer != null ? `<dt>Km</dt><dd>${nf(s.odometer)} km</dd>` : ''}
      ${s.warranty_until ? `<dt>Garantia até</dt><dd>${fmtDate(s.warranty_until)}${s.warranty_until >= todayISO() ? ' ✅' : ' (vencida)'}</dd>` : ''}
      ${s.next_km || s.next_date ? `<dt>Próxima</dt><dd>${[s.next_km ? nf(s.next_km) + ' km' : '', s.next_date ? fmtDate(s.next_date) : ''].filter(Boolean).join(' ou ')}</dd>` : ''}
      ${s.notes ? `<dt>Observação</dt><dd>${esc(s.notes)}</dd>` : ''}
      <dt>Lançado por</dt><dd>${esc(memberName(s.created_by))}</dd>
    </dl>
    <h3 class="sub-h">Documentos</h3>${s.attachments?.length ? `<div class="att-grid">${attThumbs(s.attachments, false)}</div>` : '<p class="muted">Nenhum documento anexado.</p>'}
    <div class="modal-actions"><span class="spacer"></span><button class="btn" value="cancel" formnovalidate>Fechar</button>${isOwner() || s.created_by === state.me.user_id ? '<button class="btn primary" value="edit">Editar</button>' : ''}</div>`,
  async (action) => { if (action === 'edit') setTimeout(() => openServiceForm(s), 0); }, () => fillThumbs(modalForm));
}

/* ---------- Anexos ---------- */
async function prepareFile(file) {
  if (!/^image\//.test(file.type) || file.size < 500 * 1024) return file;
  try {
    const img = await createImageBitmap(file); const scale = Math.min(1, 1800 / Math.max(img.width, img.height));
    const c = document.createElement('canvas'); c.width = Math.round(img.width * scale); c.height = Math.round(img.height * scale);
    c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
    const blob = await new Promise((r) => c.toBlob(r, 'image/jpeg', 0.82));
    return blob ? new File([blob], file.name.replace(/\.\w+$/, '') + '.jpg', { type: 'image/jpeg' }) : file;
  } catch { return file; }
}
async function uploadFiles(fileList, folder, kind) {
  const out = [];
  for (const f0 of [...fileList]) {
    const f = await prepareFile(f0);
    const safe = f.name.normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^\w.-]+/g, '_').slice(-60) || 'arquivo';
    const path = `${folder}/${Date.now()}-${Math.random().toString(36).slice(2, 6)}-${safe}`;
    await api.upload(path, f, BUCKET);
    out.push({ path, name: f0.name, kind, type: f.type, at: new Date().toISOString() });
  }
  return out;
}
const urlCache = {};
async function fileUrl(path) {
  if (!urlCache[path] || urlCache[path].t < Date.now() - 40 * 60000) urlCache[path] = { u: await api.signedUrl(path, BUCKET), t: Date.now() };
  return urlCache[path].u;
}
const attThumbs = (atts, removable) => atts.map((a, i) => `<span style="position:relative;display:inline-block"><button type="button" class="att-thumb" data-open="${esc(a.path)}" title="${esc(a.name)}">${/pdf/.test(a.type) ? '📄' : `<img data-thumb="${esc(a.path)}" alt="">`}</button>${removable ? `<button type="button" class="btn small" data-rmatt="${i}" style="position:absolute;top:-6px;right:-6px;padding:0 6px;min-height:22px">✕</button>` : ''}</span>`).join('');
async function fillThumbs(root) {
  for (const img of $$('[data-thumb]', root)) { try { img.src = await fileUrl(img.dataset.thumb); } catch { /* ignora */ } }
  $$('[data-open]', root).forEach((b) => b.addEventListener('click', async () => { try { window.open(await fileUrl(b.dataset.open), '_blank', 'noopener'); } catch (e) { toast(e.message); } }));
}
function bindAttBox(atts, set) {
  const box = $('#attBox'); if (!box) return;
  const draw = () => { box.innerHTML = atts.length ? `<div class="att-grid">${attThumbs(atts, true)}</div>` : ''; fillThumbs(box);
    $$('[data-rmatt]', box).forEach((b) => b.addEventListener('click', () => { if (!confirm('Tirar este documento?')) return; atts = atts.filter((_, i) => i !== Number(b.dataset.rmatt)); set(atts); draw(); })); };
  draw();
}

/* ---------- Veículos ---------- */
function renderVehicles() {
  return `<div class="card"><div class="card-head"><h2>🚗 Veículos</h2>${isOwner() ? '<button class="btn small primary" id="newVehicle">+ Novo veículo</button>' : ''}</div>
    ${state.vehicles.length ? `<ul class="tx-list">${state.vehicles.map((v) => `<li class="member-row"><div class="v-ico">🚗</div>
      <div class="tx-main"><div class="tx-title">${esc(v.name)} ${v.active ? '' : '<span class="badge">vendido / inativo</span>'}</div>
      <div class="tx-meta">${esc([v.brand, v.model, v.year, v.color].filter(Boolean).join(' · '))}${v.plate ? ' · placa ' + esc(v.plate) : ''} · ${nf(currentKm(v.id))} km</div></div>
      ${isOwner() ? `<button class="btn small" data-editv="${v.id}">Editar</button>` : ''}</li>`).join('')}</ul>` : '<div class="empty small">Nenhum veículo.</div>'}</div>`;
}
function openVehicleForm(v) {
  const x = v || { name: '', brand: '', model: '', year: '', plate: '', color: '', fuel: 'flex', tank_l: '', initial_km: '', purchase_date: '', purchase_price: '', renavam: '', chassis: '', notes: '', active: true };
  openModal(`<h2>${v ? 'Editar veículo' : 'Novo veículo'}</h2>
    <div class="form-grid">
      <label class="field full"><span>Apelido *</span><input name="name" value="${esc(x.name)}" required placeholder="Ex.: Hilux, Carro da Neuma"></label>
      <label class="field"><span>Marca</span><input name="brand" value="${esc(x.brand)}" placeholder="Toyota"></label>
      <label class="field"><span>Modelo</span><input name="model" value="${esc(x.model)}" placeholder="Hilux SRX 2.8"></label>
      <label class="field"><span>Ano</span><input name="year" value="${esc(x.year)}" inputmode="numeric" placeholder="2022/2023"></label>
      <label class="field"><span>Placa</span><input name="plate" value="${esc(x.plate)}" autocapitalize="characters" placeholder="ABC1D23"></label>
      <label class="field"><span>Cor</span><input name="color" value="${esc(x.color)}"></label>
      <label class="field"><span>Combustível</span><select name="fuel">${Object.entries(VFUELS).map(([k, l]) => `<option value="${k}" ${x.fuel === k ? 'selected' : ''}>${l}</option>`).join('')}</select></label>
      <label class="field"><span>Tanque (litros)</span><input name="tank_l" inputmode="decimal" value="${x.tank_l ?? ''}"></label>
      <label class="field"><span>Km quando começou a controlar</span><input name="initial_km" inputmode="numeric" value="${x.initial_km ?? ''}"></label>
      <label class="field"><span>Data da compra</span><input type="date" name="purchase_date" value="${x.purchase_date || ''}"></label>
      <label class="field"><span>Valor da compra (R$)</span><input name="purchase_price" inputmode="decimal" value="${numInput(x.purchase_price, 2)}"></label>
      <label class="field"><span>Renavam</span><input name="renavam" value="${esc(x.renavam)}" inputmode="numeric"></label>
      <label class="field"><span>Chassi</span><input name="chassis" value="${esc(x.chassis)}" autocapitalize="characters"></label>
      <label class="field full"><span>Observações</span><input name="notes" value="${esc(x.notes)}"></label>
      <label class="check full"><input type="checkbox" name="active" ${x.active ? 'checked' : ''}><span>Em uso (desmarque quando vender — o histórico fica guardado)</span></label>
    </div>
    <div class="modal-actions">${v && isOwner() ? '<button class="btn danger" value="delete" formnovalidate>Excluir</button>' : ''}<span class="spacer"></span><button class="btn" value="cancel" formnovalidate>Cancelar</button><button class="btn primary" value="save">Salvar</button></div>`,
  async (action, fd) => {
    if (action === 'delete') {
      if (!confirm(`Excluir ${v.name} e TODO o histórico (abastecimentos, manutenções)? Para guardar o histórico, apenas desmarque "Em uso".`)) return false;
      await api.remove('vei_vehicles', `id=eq.${v.id}`); toast('Veículo excluído'); return reloadAndRender();
    }
    const n = (k) => { const z = parseNum(fd.get(k)); return z >= 0 ? z : null; };
    const data = { name: fd.get('name').trim(), brand: fd.get('brand').trim(), model: fd.get('model').trim(), year: fd.get('year').trim(), plate: fd.get('plate').trim().toUpperCase(),
      color: fd.get('color').trim(), fuel: fd.get('fuel'), tank_l: n('tank_l'), initial_km: Math.round(n('initial_km') || 0), purchase_date: fd.get('purchase_date') || null,
      purchase_price: n('purchase_price'), renavam: fd.get('renavam').trim(), chassis: fd.get('chassis').trim().toUpperCase(), notes: fd.get('notes').trim(), active: fd.get('active') === 'on' };
    if (v) await api.update('vei_vehicles', `id=eq.${v.id}`, data);
    else { const [row] = await api.insert('vei_vehicles', data); ui.vid = row.id; }
    toast('Veículo salvo ✅'); await reloadAndRender();
  });
}

/* ---------- Pessoas ---------- */
function renderPeople() {
  const pend = state.members.filter((m) => m.role === 'pending'); const act = state.members.filter((m) => m.role !== 'pending');
  const row = (m) => `<li class="member-row"><div class="avatar">${esc((m.name || '?')[0].toUpperCase())}</div>
    <div class="tx-main"><div class="tx-title">${esc(m.name)}${m.user_id === state.me.user_id ? ' <span class="muted">(você)</span>' : ''}</div><div class="tx-meta">${esc(m.email)}</div></div>
    <div class="row-actions">${isOwner() && m.user_id !== state.me.user_id ? `<select data-role="${m.user_id}">${['driver', 'owner', 'blocked'].map((r) => `<option value="${r}" ${m.role === r ? 'selected' : ''}>${ROLES[r]}</option>`).join('')}</select>` : `<span class="badge open">${ROLES[m.role]}</span>`}</div></li>`;
  return `${isOwner() && pend.length ? `<div class="card attention"><h2>⏳ Aguardando aprovação</h2><ul class="tx-list">${pend.map((m) => `<li class="member-row"><div class="avatar">${esc((m.name || '?')[0].toUpperCase())}</div>
      <div class="tx-main"><div class="tx-title">${esc(m.name)}</div><div class="tx-meta">${esc(m.email)}</div></div>
      <div class="row-actions"><button class="btn small primary" data-approve="${m.user_id}">Aprovar</button><button class="btn small" data-reject="${m.user_id}">Recusar</button></div></li>`).join('')}</ul></div>` : ''}
  <div class="card ${pend.length && isOwner() ? 'mt' : ''}"><h2>Pessoas</h2><ul class="tx-list">${act.map(row).join('')}</ul>
    <p class="muted small"><b>Lança:</b> registra abastecimentos e despesas e vê tudo. <b>Administra:</b> também cadastra veículos e aprova pessoas.</p></div>
  <div class="card mt"><h2>Convidar alguém</h2><p class="muted">Mande o endereço abaixo. A pessoa toca em <b>Criar acesso</b> (ou entra com o mesmo login da CASACOR) e você aprova aqui.</p>
    <div class="copy-field"><code id="appUrl">${esc(location.origin + location.pathname)}</code><button class="btn small" id="copyUrl">Copiar</button></div></div>`;
}
async function setRole(id, role, msg) { try { await api.update('vei_members', `user_id=eq.${id}`, { role }); toast(msg); await reloadAndRender(); } catch (e) { toast(e.message); render(); } }

/* ---------- Ajustes ---------- */
function renderSettings() {
  return `<div class="card"><h2>Meu perfil</h2><p><b>${esc(state.me.name)}</b><br><span class="muted">${esc(state.me.email)} · ${ROLES[state.me.role]}</span></p>
      <div class="row-actions"><button class="btn" id="editMe">Alterar meu nome</button><button class="btn danger" id="logout">Sair</button></div></div>
    <div class="card mt"><h2>Instalar como app</h2><p class="muted"><b>iPhone/iPad:</b> Compartilhar (□↑) → <b>Adicionar à Tela de Início</b>.<br><b>Android:</b> menu <b>⋮</b> → <b>Instalar app</b>.</p></div>
    <div class="card mt"><h2>💾 Cópia de segurança</h2><p class="muted">Planilha Excel com veículos, abastecimentos e despesas (uma aba para cada).</p><button class="btn" id="xlsAll">📊 Baixar planilha</button></div>`;
}

/* ---------- Ações rápidas ---------- */
function openQuickAdd() {
  openModal(`<h2>Lançar</h2><div class="v-actions" style="margin:10px 0 14px">
    <button type="button" class="btn primary big" id="qaF">⛽ Abastecimento</button><button type="button" class="btn big" id="qaS">🔧 Manutenção / despesa</button></div>
    <div class="modal-actions"><span class="spacer"></span><button class="btn" value="cancel" formnovalidate>Fechar</button></div>`, () => {},
  () => { $('#qaF').addEventListener('click', () => openFuelForm()); $('#qaS').addEventListener('click', () => openServiceForm()); });
}
async function reloadAndRender() { await loadAll({ quiet: true }); render(); }

/* ---------- Eventos ---------- */
function bindView() {
  const v = $('#view');
  $$('[data-vsel]', v).forEach((b) => b.addEventListener('click', () => { ui.vid = b.dataset.vsel; render(); }));
  $$('[data-go]', v).forEach((b) => b.addEventListener('click', () => setView(b.dataset.go)));
  $$('[data-addfuel]', v).forEach((b) => b.addEventListener('click', () => openFuelForm(null, b.dataset.addfuel)));
  $$('[data-addserv]', v).forEach((b) => b.addEventListener('click', () => openServiceForm(null, b.dataset.addserv)));
  $$('[data-fuel]', v).forEach((el) => el.addEventListener('click', () => { const f = state.fuel.find((x) => x.id === el.dataset.fuel); if (isOwner() || f.created_by === state.me.user_id) openFuelForm(f); else toast('Só quem lançou (ou quem administra) pode editar'); }));
  $$('[data-serv]', v).forEach((el) => el.addEventListener('click', () => openServiceDetail(state.services.find((x) => x.id === el.dataset.serv))));
  $('#firstVehicle', v)?.addEventListener('click', () => openVehicleForm());
  $('#newVehicle', v)?.addEventListener('click', () => openVehicleForm());
  $$('[data-editv]', v).forEach((b) => b.addEventListener('click', () => openVehicleForm(vById(b.dataset.editv))));
  $$('[data-approve]', v).forEach((b) => b.addEventListener('click', () => setRole(b.dataset.approve, 'driver', 'Acesso aprovado ✅')));
  $$('[data-reject]', v).forEach((b) => b.addEventListener('click', () => setRole(b.dataset.reject, 'blocked', 'Acesso recusado')));
  $$('[data-role]', v).forEach((s) => s.addEventListener('change', () => setRole(s.dataset.role, s.value, 'Função alterada')));
  $('#copyUrl', v)?.addEventListener('click', async () => { try { await navigator.clipboard.writeText($('#appUrl').textContent); toast('Copiado ✅'); } catch { prompt('Copie:', $('#appUrl').textContent); } });
  $('#logout', v)?.addEventListener('click', () => { if (confirm('Sair desta conta neste aparelho?')) { api.signOut(); localStorage.removeItem(CACHE_KEY); location.reload(); } });
  $('#editMe', v)?.addEventListener('click', () => {
    const n = prompt('Seu nome:', state.me.name); if (!n?.trim()) return;
    api.update('vei_members', `user_id=eq.${state.me.user_id}`, { name: n.trim() }).then(reloadAndRender).catch((e) => toast(e.message));
  });
  $('#xlsAll', v)?.addEventListener('click', () => exportXlsx());
  if (ui.view === 'relatorios') bindReports(v);
}

if ('serviceWorker' in navigator && location.protocol !== 'file:') {
  const hadController = !!navigator.serviceWorker.controller;
  navigator.serviceWorker.register('sw.js').catch(() => {});
  navigator.serviceWorker.addEventListener('controllerchange', () => { if (hadController && !modal.open) location.reload(); });
}
boot();
