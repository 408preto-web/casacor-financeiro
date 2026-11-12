'use strict';

/* =========================================================
   Casa Cor Ceará — Controle de Pagamentos
   Quem compra lança a conta; quem paga (financeiro) vê o que vence e marca como pago.
   Dados no Supabase (api.js), compartilhados pela equipe.
   ========================================================= */

/* ---------- Utilidades ---------- */
const $ = (sel, el = document) => el.querySelector(sel);
const $$ = (sel, el = document) => [...el.querySelectorAll(sel)];
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const uuid = () => (crypto.randomUUID ? crypto.randomUUID() : 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
  const r = (Math.random() * 16) | 0; return (c === 'x' ? r : (r & 0x3) | 0x8).toString(16);
}));
const brl = new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' });
const money = (cents) => brl.format((cents || 0) / 100);
const toCents = (n) => Math.round(Number(n || 0) * 100);
function parseMoney(str) {
  let s = String(str || '').replace(/[^\d,.-]/g, '');
  if (!s) return 0;
  const c = s.lastIndexOf(','), d = s.lastIndexOf('.');
  if (c > d) s = s.replace(/\./g, '').replace(',', '.');
  else if (d > c && c !== -1) s = s.replace(/,/g, '');
  else if (c === -1 && /^-?\d{1,3}(\.\d{3})+$/.test(s)) s = s.replace(/\./g, ''); // 2.200 = dois mil e duzentos
  const n = Number(s);
  return Number.isFinite(n) ? Math.round(n * 100) : 0;
}
const centsToInput = (c) => (c / 100).toFixed(2).replace('.', ',');
const pad = (n) => String(n).padStart(2, '0');
const todayISO = () => { const d = new Date(); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; };
const addDaysISO = (iso, n) => { const [y, m, d] = iso.split('-').map(Number); const x = new Date(y, m - 1, d + n); return `${x.getFullYear()}-${pad(x.getMonth() + 1)}-${pad(x.getDate())}`; };
function ymdClamp(y, m, d) {
  const first = new Date(y, m - 1, 1);
  const last = new Date(first.getFullYear(), first.getMonth() + 1, 0).getDate();
  return `${first.getFullYear()}-${pad(first.getMonth() + 1)}-${pad(Math.min(d, last))}`;
}
const addMonthsISO = (iso, n) => { const [y, m, d] = iso.split('-').map(Number); return ymdClamp(y, m + n, d); };
const fmtDate = (iso) => (iso ? iso.split('-').reverse().join('/') : '');
const shortDate = (iso) => (iso ? iso.split('-').reverse().slice(0, 2).join('/') : '');
const monthOf = (iso) => (iso || '').slice(0, 7);
const monthName = (ym) => { const [y, m] = ym.split('-').map(Number); const s = new Date(y, m - 1, 1).toLocaleDateString('pt-BR', { month: 'long', year: 'numeric' }); return s.charAt(0).toUpperCase() + s.slice(1); };
function daysUntil(iso) {
  const [y, m, d] = iso.split('-').map(Number); const [a, b, c] = todayISO().split('-').map(Number);
  return Math.round((new Date(y, m - 1, d) - new Date(a, b - 1, c)) / 86400000);
}
function dueText(iso) {
  const n = daysUntil(iso);
  if (n < 0) return `venceu há ${-n} dia${n === -1 ? '' : 's'}`;
  if (n === 0) return 'vence hoje';
  if (n === 1) return 'vence amanhã';
  return `vence em ${n} dias`;
}

const METHODS = {
  pix: { label: 'Pix', icon: '⚡' },
  boleto: { label: 'Boleto', icon: '🧾' },
  cartao: { label: 'Cartão da empresa', icon: '💳' },
  transferencia: { label: 'Transferência', icon: '🏦' },
  dinheiro: { label: 'Dinheiro', icon: '💵' },
};
const ROLES = {
  admin: { label: 'Administrador', desc: 'lança, paga e gerencia a equipe' },
  payer: { label: 'Pagador', desc: 'lança e paga contas' },
  member: { label: 'Comprador', desc: 'lança contas' },
  gate: { label: 'Porteiro', desc: 'só a portaria da obra' },
  pending: { label: 'Aguardando aprovação', desc: '' },
  blocked: { label: 'Sem acesso', desc: '' },
};

/* ---------- Estado ---------- */
const CACHE_KEY = 'casacor:cache';
const state = { me: null, members: [], areas: [], cards: [], settings: { edition: '' }, bills: [], loadedAt: null };
const ui = { view: 'painel', tab: 'pending', filter: { q: '', area: '', who: '', method: '', month: '', edition: '' }, report: { edition: '', from: '', to: '' }, loading: false, offline: false };

const isPayer = () => ['payer', 'admin'].includes(state.me?.role);
const isAdmin = () => state.me?.role === 'admin';
const areaById = (id) => state.areas.find((a) => String(a.id) === String(id)) || { name: 'Sem área', color: '#94a3b8' };
const memberName = (id) => { const m = state.members.find((x) => x.user_id === id); return m ? (m.name || m.email) : '—'; };
const firstName = (id) => memberName(id).split(' ')[0];
const cardById = (id) => state.cards.find((c) => c.id === id);
const cardLabel = (c) => (c ? `${c.name}${c.final ? ' •' + c.final : ''}` : 'Cartão');
const normBill = (b) => ({ ...b, cents: toCents(b.amount), paidCents: b.paid_amount == null ? null : toCents(b.paid_amount), attachments: Array.isArray(b.attachments) ? b.attachments : [] });

/** Em qual fatura cai uma compra no cartão (compras a partir do dia de fechamento vão para a seguinte). */
function invoiceDue(card, dateISO) {
  const [y, m, d] = dateISO.split('-').map(Number);
  const closeISO = ymdClamp(y, d >= card.closing_day ? m + 1 : m, card.closing_day);
  const [cy, cm] = closeISO.split('-').map(Number);
  return ymdClamp(cy, card.due_day > card.closing_day ? cm : cm + 1, card.due_day);
}

/* ---------- Carregamento ---------- */
function saveCache() { try { localStorage.setItem(CACHE_KEY, JSON.stringify({ ...state, loadedAt: state.loadedAt })); } catch { /* ignora */ } }
function loadCache() {
  try {
    const c = JSON.parse(localStorage.getItem(CACHE_KEY));
    if (c && c.me && c.me.user_id === api.session()?.user.id) Object.assign(state, c);
  } catch { /* ignora */ }
}

async function loadAll({ quiet = false } = {}) {
  if (ui.loading) return;
  ui.loading = true; updatePill();
  try {
    const [members, areas, cards, settings, bills] = await Promise.all([
      api.select('members', 'select=*&order=name'),
      api.select('areas', 'select=*&order=sort,name'),
      api.select('cards', 'select=*&order=name'),
      api.select('settings', 'select=*'),
      api.select('bills', 'select=*&order=due_date,created_at'),
    ]);
    const me = members.find((m) => m.user_id === api.session().user.id);
    if (me) state.me = me;
    Object.assign(state, { members, areas, cards, settings: settings[0] || { edition: '' }, bills: bills.map(normBill), loadedAt: Date.now() });
    await loadRH(); // funcionários e ocorrências (rh.js) — só para quem tem acesso ao RH
    await loadGate(); // portaria da obra (portaria.js)
    state.invites = me?.role === 'admin' ? await api.select('invites', 'select=*&used_at=is.null&order=created_at.desc').catch(() => null) : null;
    ui.offline = false;
    saveCache();
    if (!me || !['member', 'payer', 'admin', 'gate'].includes(me.role)) return boot();
    if (!modal.open && !document.activeElement?.matches?.('input, textarea, select')) render();
    else updateBadges();
  } catch (e) {
    ui.offline = !navigator.onLine || /conexão/.test(e.message);
    if (!quiet) toast(e.message);
    if (/sessão expirou|login/i.test(e.message)) boot();
  } finally {
    ui.loading = false; updatePill();
  }
}

/* ---------- Toast ---------- */
let toastTimer;
function toast(msg) {
  const el = $('#toast');
  el.textContent = msg; el.classList.add('show');
  clearTimeout(toastTimer); toastTimer = setTimeout(() => el.classList.remove('show'), 2600);
}

/* ---------- Telas de acesso ---------- */
function showGate(html) {
  $('#app').hidden = true; $('#fab').hidden = true;
  const g = $('#gate'); g.hidden = false;
  g.innerHTML = `<div class="gate-card"><div class="gate-brand"><img src="icons/icon.svg" alt="" width="56" height="56">
    <div><b>Casa Cor Ceará</b><span>Controle de pagamentos</span></div></div>${html}</div>`;
}

function gateLogin(mode = 'login', msg = '') {
  const signup = mode === 'signup';
  showGate(`
    <div class="seg gate-tabs">
      <input type="radio" name="gm" id="gmL" ${signup ? '' : 'checked'}><label for="gmL">Entrar</label>
      <input type="radio" name="gm" id="gmS" ${signup ? 'checked' : ''}><label for="gmS">Criar acesso</label>
    </div>
    <form id="gateForm" class="form-grid one">
      ${signup ? '<label class="field"><span>Seu nome</span><input name="name" autocomplete="name" required placeholder="Ex.: Vitor"></label>' : ''}
      <label class="field"><span>E-mail</span><input name="email" type="email" autocomplete="username" inputmode="email" autocapitalize="off" required></label>
      <label class="field"><span>Senha ${signup ? '(mínimo 6 caracteres)' : ''}</span><input name="password" type="password" autocomplete="${signup ? 'new-password' : 'current-password'}" required minlength="6"></label>
      ${msg ? `<p class="gate-msg">${esc(msg)}</p>` : ''}
      <button class="btn primary big">${signup ? 'Criar acesso' : 'Entrar'}</button>
      ${signup ? '<p class="muted small">Depois de criar, o administrador precisa aprovar seu acesso.</p>' : '<button type="button" class="link-btn" id="forgot">Esqueci minha senha</button>'}
    </form>`);
  $('#gmL').addEventListener('change', () => gateLogin('login'));
  $('#gmS').addEventListener('change', () => gateLogin('signup'));
  $('#forgot')?.addEventListener('click', gateForgot);
  $('#gateForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const fd = new FormData(e.target);
    const btn = $('button.primary', e.target); btn.disabled = true; btn.textContent = 'Aguarde…';
    try {
      if (signup) await api.signUp(fd.get('email').trim(), fd.get('password'), fd.get('name').trim());
      else await api.signIn(fd.get('email').trim(), fd.get('password'));
      await afterLogin(signup ? fd.get('name').trim() : '');
    } catch (err) { gateLogin(mode, err.message); }
  });
}

/* Convite: link #convite=TOKEN&nome=…&funcao=… enviado pela administração (WhatsApp) */
const INVITE_KEY = 'casacor-convite';
function pendingInvite() { try { return JSON.parse(sessionStorage.getItem(INVITE_KEY)); } catch { return null; } }
function gateInvite(mode = 'signup', msg = '') {
  const inv = pendingInvite(); const signup = mode === 'signup';
  const first = (inv.name || '').split(' ')[0];
  showGate(`
    <h2>Olá${first ? ', ' + esc(first) : ''}! 👋</h2>
    <p class="muted" style="margin-top:-4px">Você foi convidado(a) para o sistema da Casa Cor Ceará${ROLES[inv.role] ? ' como <b>' + esc(ROLES[inv.role].label) + '</b>' : ''}. ${signup ? 'Só falta criar sua senha.' : 'Entre com seu e-mail e senha.'}</p>
    <form id="gateForm" class="form-grid one">
      ${signup ? `<label class="field"><span>Seu nome</span><input name="name" autocomplete="name" required value="${esc(inv.name || '')}"></label>` : ''}
      <label class="field"><span>E-mail</span><input name="email" type="email" autocomplete="username" inputmode="email" autocapitalize="off" required></label>
      <label class="field"><span>${signup ? 'Crie uma senha (mínimo 6 letras ou números)' : 'Senha'}</span><input name="password" type="password" autocomplete="${signup ? 'new-password' : 'current-password'}" required minlength="6"></label>
      ${msg ? `<p class="gate-msg">${esc(msg)}</p>` : ''}
      <button class="btn primary big">${signup ? 'Criar meu acesso' : 'Entrar'}</button>
      <button type="button" class="link-btn" id="invSwitch">${signup ? 'Já tenho acesso — entrar' : 'Ainda não tenho acesso — criar'}</button>
    </form>`);
  $('#invSwitch').addEventListener('click', () => gateInvite(signup ? 'login' : 'signup'));
  $('#gateForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const fd = new FormData(e.target);
    const btn = $('button.primary', e.target); btn.disabled = true; btn.textContent = 'Aguarde…';
    try {
      if (signup) await api.signUp(fd.get('email').trim(), fd.get('password'), fd.get('name').trim());
      else await api.signIn(fd.get('email').trim(), fd.get('password'));
    } catch (err) {
      return gateInvite(mode, /already|registered|cadastrad/i.test(err.message) ? 'Este e-mail já tem acesso. Toque em “Já tenho acesso — entrar”.' : err.message);
    }
    acceptInvite(signup ? fd.get('name').trim() : '');
  });
}
async function acceptInvite(name = '') {
  const inv = pendingInvite();
  try {
    await api.rpc('accept_invite', { p_token: inv.token, p_name: name || inv.name || '' });
    sessionStorage.removeItem(INVITE_KEY);
    afterLogin(name);
  } catch (e) {
    sessionStorage.removeItem(INVITE_KEY);
    showGate(`<h2>Convite não aceito</h2><p class="muted">${esc(e.message)}</p><button class="btn" id="out">Voltar</button>`);
    $('#out').addEventListener('click', () => { api.signOut(); gateLogin(); });
  }
}

function gateForgot() {
  showGate(`<h2>Recuperar senha</h2>
    <form id="gateForm" class="form-grid one">
      <label class="field"><span>E-mail cadastrado</span><input name="email" type="email" required autocapitalize="off"></label>
      <button class="btn primary big">Enviar link</button>
      <button type="button" class="link-btn" id="back">Voltar</button>
    </form>`);
  $('#back').addEventListener('click', () => gateLogin());
  $('#gateForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    try { await api.recover(new FormData(e.target).get('email').trim()); gateLogin('login', 'Se o e-mail estiver cadastrado, você vai receber um link para criar uma nova senha.'); }
    catch (err) { toast(err.message); }
  });
}

function gateNewPassword(token) {
  showGate(`<h2>Criar nova senha</h2>
    <form id="gateForm" class="form-grid one">
      <label class="field"><span>Nova senha (mínimo 6 caracteres)</span><input name="password" type="password" minlength="6" required autocomplete="new-password"></label>
      <button class="btn primary big">Salvar nova senha</button>
    </form>`);
  $('#gateForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    try { await api.updatePassword(new FormData(e.target).get('password'), token); gateLogin('login', 'Senha alterada. Entre com a nova senha.'); }
    catch (err) { toast(err.message); }
  });
}

async function afterLogin(name = '') {
  try {
    const role = await api.rpc('join_team', { p_name: name || api.session().user.email.split('@')[0] });
    if (role === 'pending' || role === 'blocked') return gateWaiting(role);
    await loadAll();
    startApp();
  } catch (e) {
    gateLogin('login', e.message);
  }
}

function gateWaiting(role) {
  const s = api.session();
  showGate(role === 'blocked'
    ? `<h2>Acesso não liberado</h2><p class="muted">O acesso de <b>${esc(s?.user.email)}</b> foi recusado pelo administrador.</p>
       <button class="btn" id="out">Sair</button>`
    : `<h2>⏳ Aguardando aprovação</h2>
       <p class="muted">Seu acesso (<b>${esc(s?.user.email)}</b>) foi criado. Peça para o administrador aprovar em <b>Equipe</b>. Depois toque em “Verificar”.</p>
       <div class="row-actions"><button class="btn primary" id="check">Verificar</button><button class="btn" id="out">Sair</button></div>`);
  $('#out').addEventListener('click', () => { api.signOut(); localStorage.removeItem(CACHE_KEY); gateLogin(); });
  $('#check')?.addEventListener('click', () => afterLogin());
}

function gateNoConfig() {
  showGate(`<h2>Configuração pendente</h2><p class="muted">O endereço e a chave do Supabase ainda não foram colocados em <code>config.js</code>.</p>`);
}

/* ---------- Início ---------- */
let started = false;
function startApp() {
  $('#gate').hidden = true; $('#gate').innerHTML = ''; $('#app').hidden = false;
  if (!started) {
    started = true;
    $$('.nav-item').forEach((b) => b.addEventListener('click', () => setView(b.dataset.view)));
    $('#addBtn').addEventListener('click', () => openBillForm());
    $('#fab').addEventListener('click', () => openBillForm());
    $('#syncPill').addEventListener('click', () => loadAll());
    window.addEventListener('online', () => loadAll({ quiet: true }));
    window.addEventListener('offline', () => { ui.offline = true; updatePill(); });
    document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') loadAll({ quiet: true }); });
    setInterval(() => { if (document.visibilityState === 'visible' && !modal.open) loadAll({ quiet: true }); }, 60000);
  }
  setView(ui.view);
}

async function boot() {
  if (!cfg()) return gateNoConfig();
  // Link de "esqueci a senha" (volta com #access_token=…&type=recovery)
  const h = new URLSearchParams(location.hash.slice(1));
  if (h.get('type') === 'recovery' && h.get('access_token')) {
    history.replaceState(null, '', location.pathname);
    return gateNewPassword(h.get('access_token'));
  }
  if (h.get('convite')) {
    sessionStorage.setItem(INVITE_KEY, JSON.stringify({ token: h.get('convite'), name: h.get('nome') || '', role: h.get('funcao') || '' }));
    history.replaceState(null, '', location.pathname);
  }
  if (pendingInvite()) return api.session() ? acceptInvite() : gateInvite();
  if (!api.session()) return gateLogin();
  loadCache();
  if (state.me && ['member', 'payer', 'admin', 'gate'].includes(state.me.role) && state.bills) {
    startApp(); // mostra o que já tinha enquanto atualiza
    return loadAll({ quiet: true });
  }
  return afterLogin();
}

/* ---------- Navegação ---------- */
const TITLES = { painel: 'Painel', contas: 'Contas', cartoes: 'Cartões da empresa', relatorios: 'Relatórios', rh: 'RH — Pessoal', portaria: 'Portaria da obra', equipe: 'Equipe', ajustes: 'Ajustes' };
function setView(v) {
  ui.view = v;
  $$('.nav-item').forEach((b) => b.classList.toggle('active', b.dataset.view === v));
  render();
  window.scrollTo({ top: 0 });
}
function render() {
  if (!state.me) return;
  $('#viewTitle').textContent = TITLES[ui.view];
  $('#fab').hidden = false;
  $('#sidebarUser').innerHTML = `<b>${esc(state.me.name)}</b><span>${ROLES[state.me.role]?.label || ''}</span>`;
  if (ui.view === 'rh' && !isHR()) ui.view = 'painel';
  // Porteiro: só a tela da portaria, grande e simples
  document.body.classList.toggle('gate-mode', isGateOnly());
  if (isGateOnly()) ui.view = 'portaria';
  $('.nav-item[data-view="rh"]').hidden = !isHR();
  const views = { painel: renderPainel, contas: renderContas, cartoes: renderCartoes, relatorios: renderRelatorios, rh: renderRH, portaria: renderPortaria, equipe: renderEquipe, ajustes: renderAjustes };
  $('#view').innerHTML = views[ui.view]();
  bindView();
  updateBadges(); updatePill();
}
function updatePill() {
  const el = $('#syncPill');
  if (!el) return;
  const t = state.loadedAt ? new Date(state.loadedAt).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' }) : '';
  el.className = `sync-pill ${ui.offline ? 'warn' : 'ok'}`;
  el.innerHTML = ui.loading ? '🔄 <span class="sync-text">Atualizando…</span>' : ui.offline ? '📴 <span class="sync-text">Sem internet</span>' : `✅ <span class="sync-text">Atualizado ${t}</span>`;
}
function updateBadges() {
  const n = isPayer() ? pendingBills().filter((b) => b.due_date <= todayISO()).length : 0;
  const pb = $('.nav-item[data-view="painel"] .nav-badge'); if (pb) { pb.textContent = n; pb.hidden = !n; }
  const np = isAdmin() ? state.members.filter((m) => m.role === 'pending').length : 0;
  const eb = $('.nav-item[data-view="equipe"] .nav-badge'); if (eb) { eb.textContent = np; eb.hidden = !np; }
  const nh = isHR() ? rhAlerts().filter((a) => a.level !== 'info').length + payrollReminders().filter((r) => r.n <= 1).length : 0;
  const hb = $('.nav-item[data-view="rh"] .nav-badge'); if (hb) { hb.textContent = nh; hb.hidden = !nh; }
  try { n + np ? navigator.setAppBadge?.(n + np) : navigator.clearAppBadge?.(); } catch { /* sem suporte */ }
}

/* ---------- Componentes ---------- */
const pendingBills = () => state.bills.filter((b) => b.status === 'pending');

/** Agrupa compras no cartão em faturas; demais contas ficam como estão. */
function payables(list) {
  const out = []; const inv = {};
  for (const b of list) {
    if (b.method === 'cartao' && b.card_id) {
      const k = `${b.card_id}|${b.due_date}`;
      if (!inv[k]) { inv[k] = { invoice: true, key: k, card: cardById(b.card_id), due_date: b.due_date, items: [], cents: 0 }; out.push(inv[k]); }
      inv[k].items.push(b); inv[k].cents += b.cents;
    } else out.push(b);
  }
  return out.sort((a, b) => a.due_date.localeCompare(b.due_date));
}

function statusBadge(b) {
  if (b.status === 'paid') return '<span class="badge paid">pago</span>';
  if (b.status === 'cancelled') return '<span class="badge">cancelado</span>';
  const n = daysUntil(b.due_date);
  if (n < 0) return '<span class="badge overdue">atrasado</span>';
  if (n === 0) return '<span class="badge today">hoje</span>';
  return '';
}

function billRow(b, { showDue = true } = {}) {
  const a = areaById(b.area_id);
  const m = METHODS[b.method];
  const sub = [
    `<span class="area-dot" style="--c:${a.color}"></span>${esc(a.name)}`,
    `${m.icon} ${b.method === 'cartao' ? esc(cardLabel(cardById(b.card_id))) : m.label}`,
    `por ${esc(firstName(b.created_by))}`,
    b.installment ? `parcela ${esc(b.installment)}` : '',
    b.attachments.length ? `📎 ${b.attachments.length}` : '',
  ].filter(Boolean).join(' · ');
  const when = b.status === 'paid' ? `pago ${shortDate(b.paid_at)}` : showDue ? `${shortDate(b.due_date)}` : '';
  return `<li class="tx" data-bill="${b.id}">
    <div class="tx-icon" style="background:${a.color}22">${m.icon}</div>
    <div class="tx-main">
      <div class="tx-title">${esc(b.supplier)}${b.description ? ` <span class="muted">— ${esc(b.description)}</span>` : ''} ${statusBadge(b)}</div>
      <div class="tx-meta">${sub}</div>
    </div>
    <div class="tx-amount ${b.status === 'paid' ? 'pos' : 'neg'}">${money(b.status === 'paid' && b.paidCents != null ? b.paidCents : b.cents)}<small>${when}</small></div>
  </li>`;
}

function invoiceRow(inv) {
  const c = inv.card;
  const late = daysUntil(inv.due_date) < 0;
  return `<li class="tx" data-invoice="${inv.key}">
    <div class="tx-icon" style="background:${c?.color || '#475569'}22">💳</div>
    <div class="tx-main">
      <div class="tx-title">Fatura ${esc(cardLabel(c))} ${late ? '<span class="badge overdue">atrasada</span>' : daysUntil(inv.due_date) === 0 ? '<span class="badge today">hoje</span>' : ''}</div>
      <div class="tx-meta">${inv.items.length} compra${inv.items.length === 1 ? '' : 's'} · ${dueText(inv.due_date)}</div>
    </div>
    <div class="tx-amount neg">${money(inv.cents)}<small>${shortDate(inv.due_date)}</small></div>
  </li>`;
}
const payableRow = (p) => (p.invoice ? invoiceRow(p) : billRow(p));
const sumCents = (list) => list.reduce((s, b) => s + (b.cents || 0), 0);

/* ---------- Painel ---------- */
function renderPainel() {
  const today = todayISO();
  const pend = pendingBills();
  const late = pend.filter((b) => b.due_date < today);
  const now = pend.filter((b) => b.due_date === today);
  const week = pend.filter((b) => b.due_date > today && b.due_date <= addDaysISO(today, 7));
  const later = pend.filter((b) => b.due_date > addDaysISO(today, 7));
  const paidMonth = state.bills.filter((b) => b.status === 'paid' && monthOf(b.paid_at) === monthOf(today));
  const mine = state.bills.filter((b) => b.created_by === state.me.user_id).sort((a, b) => b.created_at.localeCompare(a.created_at)).slice(0, 6);
  const recent = [...state.bills].sort((a, b) => b.created_at.localeCompare(a.created_at)).slice(0, 8);

  const section = (title, list, empty, cls = '') => `<div class="card ${cls}">
      <div class="card-head"><h2>${title}</h2><span class="muted">${money(sumCents(list))}</span></div>
      ${list.length ? `<ul class="tx-list">${payables(list).map(payableRow).join('')}</ul>` : `<div class="empty small">${empty}</div>`}
    </div>`;

  const alert = isPayer() && (late.length || now.length)
    ? `<div class="alerts"><div class="alert ${late.length ? 'danger' : ''}"><span class="alert-icon">${late.length ? '🚨' : '⏰'}</span>
        <div class="alert-text">${late.length ? `<b>${late.length} conta${late.length > 1 ? 's' : ''} atrasada${late.length > 1 ? 's' : ''}</b> (${money(sumCents(late))})` : ''}
        ${late.length && now.length ? ' e ' : ''}${now.length ? `<b>${now.length} vence${now.length > 1 ? 'm' : ''} hoje</b> (${money(sumCents(now))})` : ''}</div></div></div>` : '';
  const tomorrow = pend.filter((b) => b.due_date === addDaysISO(today, 1));
  const tomorrowAlert = isPayer() && tomorrow.length
    ? `<div class="alerts"><div class="alert info"><span class="alert-icon">📅</span>
        <div class="alert-text"><b>${tomorrow.length} conta${tomorrow.length > 1 ? 's vencem' : ' vence'} amanhã</b> (${money(sumCents(tomorrow))})
        <span class="muted">${payables(tomorrow).slice(0, 4).map((p) => esc(p.invoice ? `Fatura ${cardLabel(p.card)}` : p.supplier)).join(', ')}${tomorrow.length > 4 ? '…' : ''}</span></div></div></div>` : '';

  const waiting = isAdmin() ? state.members.filter((m) => m.role === 'pending') : [];
  const waitingAlert = waiting.length
    ? `<div class="alerts"><div class="alert info"><span class="alert-icon">⏳</span>
        <div class="alert-text"><b>${waiting.length === 1 ? `${esc(waiting[0].name)} está` : `${waiting.length} pessoas estão`} aguardando sua aprovação</b>
        ${waiting.length > 1 ? `<span class="muted">(${waiting.map((m) => esc(m.name)).join(', ')})</span>` : `<span class="muted">(${esc(waiting[0].email)})</span>`}</div>
        <button class="btn small primary" data-go="equipe">Ver e aprovar</button></div></div>` : '';

  return `
  <p class="hello">Olá, <b>${esc(state.me.name.split(' ')[0])}</b> 👋 ${state.settings.edition ? `<span class="muted">· Edição ${esc(state.settings.edition)}</span>` : ''}</p>
  ${waitingAlert}
  ${alert}
  ${tomorrowAlert}
  ${isHR() ? payrollBanner() : ''}
  ${isHR() ? rhAlertsBanner() : ''}
  <div class="grid cols-4">
    <div class="card stat ${late.length ? 'stat-danger' : ''}"><div class="label">Atrasadas</div><div class="value ${late.length ? 'neg' : ''}">${money(sumCents(late))}</div><div class="sub">${late.length} conta(s)</div></div>
    <div class="card stat ${now.length ? 'stat-warn' : ''}"><div class="label">Vencem hoje</div><div class="value">${money(sumCents(now))}</div><div class="sub">${now.length} conta(s)</div></div>
    <div class="card stat"><div class="label">Próximos 7 dias</div><div class="value">${money(sumCents(week))}</div><div class="sub">${week.length} conta(s)</div></div>
    <div class="card stat"><div class="label">Pago em ${monthName(monthOf(today)).split(' ')[0].toLowerCase()}</div><div class="value pos">${money(paidMonth.reduce((s, b) => s + (b.paidCents ?? b.cents), 0))}</div><div class="sub">${paidMonth.length} conta(s)</div></div>
  </div>
  <div class="grid cols-2 mt">
    ${section('🔴 Atrasadas', late, 'Nenhuma conta atrasada 🎉')}
    ${section('🟠 Vencem hoje', now, 'Nada vence hoje')}
  </div>
  <div class="grid cols-2 mt">
    ${section('📅 Próximos 7 dias', week, 'Nada nos próximos 7 dias')}
    ${section('🗓️ Depois', later.slice(0, 12), 'Nada agendado depois')}
  </div>
  <div class="grid cols-2 mt">
    <div class="card"><div class="card-head"><h2>🧾 Lançadas por mim</h2></div>
      ${mine.length ? `<ul class="tx-list">${mine.map((b) => billRow(b)).join('')}</ul>` : '<div class="empty small">Você ainda não lançou contas. Toque em “+ Lançar conta”.</div>'}</div>
    <div class="card"><div class="card-head"><h2>🕘 Últimos lançamentos da equipe</h2><button class="btn small" data-go="contas">Ver todas</button></div>
      ${recent.length ? `<ul class="tx-list">${recent.map((b) => billRow(b)).join('')}</ul>` : '<div class="empty small">Nenhuma conta lançada ainda.</div>'}</div>
  </div>`;
}

/* ---------- Contas ---------- */
function filteredBills() {
  const f = ui.filter; const q = f.q.trim().toLowerCase();
  return state.bills.filter((b) =>
    (ui.tab === 'all' || b.status === ui.tab) &&
    (!f.area || String(b.area_id) === f.area) &&
    (!f.who || b.created_by === f.who) &&
    (!f.method || b.method === f.method) &&
    (!f.edition || b.edition === f.edition) &&
    (!f.month || monthOf(b.status === 'paid' ? b.paid_at : b.due_date) === f.month) &&
    (!q || `${b.supplier} ${b.description} ${b.notes} ${b.pix_key}`.toLowerCase().includes(q)));
}
const editions = () => [...new Set(state.bills.map((b) => b.edition).concat(state.settings.edition).filter(Boolean))].sort().reverse();

function renderContas() {
  const f = ui.filter;
  const list = filteredBills().sort((a, b) => (ui.tab === 'paid' ? (b.paid_at || '').localeCompare(a.paid_at || '') : a.due_date.localeCompare(b.due_date)));
  const total = list.reduce((s, b) => s + (b.status === 'paid' && b.paidCents != null ? b.paidCents : b.cents), 0);
  const groups = {};
  for (const b of list) { const k = b.status === 'paid' ? b.paid_at : b.due_date; (groups[k] ||= []).push(b); }
  const opt = (v, l, sel) => `<option value="${esc(v)}" ${sel === v ? 'selected' : ''}>${esc(l)}</option>`;
  const tabs = [['pending', 'A pagar'], ['paid', 'Pagas'], ['cancelled', 'Canceladas'], ['all', 'Todas']];
  return `
  <div class="tabs">${tabs.map(([k, l]) => `<button class="tab ${ui.tab === k ? 'active' : ''}" data-tab="${k}">${l}</button>`).join('')}</div>
  <div class="card">
    <div class="filters">
      <input type="search" id="fq" placeholder="Buscar fornecedor, descrição…" value="${esc(f.q)}">
      <select id="farea"><option value="">Todas as áreas</option>${state.areas.map((a) => opt(String(a.id), a.name, f.area)).join('')}</select>
      <select id="fwho"><option value="">Quem lançou: todos</option>${state.members.filter((m) => m.role !== 'pending').map((m) => opt(m.user_id, m.name, f.who)).join('')}</select>
      <select id="fmethod"><option value="">Todas as formas</option>${Object.entries(METHODS).map(([k, m]) => opt(k, m.label, f.method)).join('')}</select>
      <select id="fedition"><option value="">Todas as edições</option>${editions().map((e) => opt(e, 'Edição ' + e, f.edition)).join('')}</select>
      <input type="month" id="fmonth" value="${esc(f.month)}" title="Mês do vencimento (ou do pagamento, nas pagas)">
    </div>
    <div class="list-total"><span>${list.length} conta(s)</span><b>${money(total)}</b>
      ${Object.values(f).some(Boolean) ? '<button class="link-btn" id="fclear">limpar filtros</button>' : ''}</div>
  </div>
  <div class="card mt">
    ${list.length ? Object.entries(groups).map(([d, items]) => `<div class="day-head">${d ? `${fmtDate(d)} · ${new Date(d + 'T12:00').toLocaleDateString('pt-BR', { weekday: 'long' })}` : 'Sem data'} <span class="muted">${money(sumCents(items))}</span></div>
      <ul class="tx-list">${items.map((b) => billRow(b, { showDue: false })).join('')}</ul>`).join('') : '<div class="empty">Nenhuma conta encontrada.</div>'}
  </div>`;
}

/* ---------- Cartões ---------- */
function renderCartoes() {
  if (!state.cards.length) {
    return `<div class="card"><div class="empty"><div style="font-size:44px">💳</div>
      <p>Cadastre os cartões de crédito da empresa (nome, final, dia de fechamento e de vencimento).<br>As compras no cartão são agrupadas em faturas: paga-se a fatura, não cada compra.</p>
      ${isPayer() ? '<button class="btn primary" id="newCard">+ Cadastrar cartão</button>' : '<p class="muted">Peça para quem paga cadastrar os cartões.</p>'}</div></div>`;
  }
  const cards = state.cards.map((c) => {
    const bills = state.bills.filter((b) => b.card_id === c.id && b.status !== 'cancelled');
    const invs = {};
    for (const b of bills) (invs[b.due_date] ||= []).push(b);
    const rows = Object.entries(invs).sort(([a], [b]) => a.localeCompare(b)).filter(([d, items]) => items.some((b) => b.status === 'pending') || d >= addDaysISO(todayISO(), -62)).map(([d, items]) => {
      const pend = items.filter((b) => b.status === 'pending');
      const paid = !pend.length;
      return `<li class="inv-row">
        <div><b>Vence ${fmtDate(d)}</b> ${paid ? '<span class="badge paid">paga</span>' : daysUntil(d) < 0 ? '<span class="badge overdue">atrasada</span>' : '<span class="badge open">aberta</span>'}
          <div class="tx-meta">${items.length} compra(s)${paid ? ` · paga em ${shortDate(items[0].paid_at)}` : ''}</div></div>
        <b class="inv-total">${money(sumCents(items))}</b>
        <div class="row-actions"><button class="btn small" data-invoice="${c.id}|${d}">${paid ? 'Ver' : 'Ver / pagar'}</button></div>
      </li>`;
    }).join('');
    return `<div class="card">
      <div class="card-head"><div style="display:flex;gap:12px;align-items:center"><div class="cc-chip" style="background:${c.color}">💳</div>
        <div><h2 style="margin:0">${esc(cardLabel(c))}</h2><div class="tx-meta">Fecha dia ${c.closing_day} · vence dia ${c.due_day}</div></div></div>
        ${isPayer() ? `<button class="btn small" data-editcard="${c.id}">Editar</button>` : ''}</div>
      ${rows ? `<ul class="inv-list">${rows}</ul>` : '<div class="muted small">Nenhuma compra neste cartão.</div>'}
    </div>`;
  }).join('');
  return `${isPayer() ? '<div class="card-head"><span></span><button class="btn primary" id="newCard">+ Novo cartão</button></div>' : ''}<div class="grid cols-2">${cards}</div>`;
}

/* ---------- Relatórios ---------- */
function reportBills() {
  const r = ui.report;
  return state.bills.filter((b) => b.status !== 'cancelled' &&
    (!r.edition || b.edition === r.edition) &&
    (!r.from || (b.status === 'paid' ? b.paid_at : b.due_date) >= r.from) &&
    (!r.to || (b.status === 'paid' ? b.paid_at : b.due_date) <= r.to));
}
function bars(rows, total) {
  if (!rows.length) return '<div class="empty small">Sem dados.</div>';
  const max = Math.max(...rows.map((r) => r.v), 1);
  return `<ul class="bars">${rows.map((r) => `<li><div class="bar-top"><span>${r.label}</span><b>${money(r.v)} <span class="muted">${total ? Math.round((r.v / total) * 100) : 0}%</span></b></div>
    <div class="bar"><div style="width:${(r.v / max) * 100}%;background:${r.color || 'var(--primary)'}"></div></div></li>`).join('')}</ul>`;
}
function group(list, keyFn, labelFn, colorFn) {
  const m = {};
  for (const b of list) { const k = keyFn(b); m[k] = (m[k] || 0) + (b.status === 'paid' && b.paidCents != null ? b.paidCents : b.cents); }
  return Object.entries(m).map(([k, v]) => ({ k, v, label: labelFn(k), color: colorFn?.(k) })).sort((a, b) => b.v - a.v);
}
function renderRelatorios() {
  const r = ui.report;
  const list = reportBills();
  const paid = list.filter((b) => b.status === 'paid');
  const pend = list.filter((b) => b.status === 'pending');
  const amt = (b) => (b.status === 'paid' && b.paidCents != null ? b.paidCents : b.cents);
  const totPaid = paid.reduce((s, b) => s + amt(b), 0);
  const totPend = pend.reduce((s, b) => s + amt(b), 0);
  const total = totPaid + totPend;
  const byArea = group(list, (b) => b.area_id, (k) => esc(areaById(Number(k)).name), (k) => areaById(Number(k)).color);
  const byWho = group(list, (b) => b.created_by, (k) => esc(memberName(k)));
  const byMethod = group(list, (b) => b.method, (k) => `${METHODS[k].icon} ${METHODS[k].label}`);
  const byMonth = group(list, (b) => monthOf(b.status === 'paid' ? b.paid_at : b.due_date), (k) => monthName(k)).sort((a, b) => a.k.localeCompare(b.k));
  const bySupplier = group(list, (b) => b.supplier.trim().toUpperCase(), (k) => esc(list.find((b) => b.supplier.trim().toUpperCase() === k).supplier)).slice(0, 10);
  return `
  <div class="card">
    <div class="filters">
      <select id="redition"><option value="">Todas as edições</option>${editions().map((e) => `<option value="${esc(e)}" ${r.edition === e ? 'selected' : ''}>Edição ${esc(e)}</option>`).join('')}</select>
      <label class="inline">De <input type="date" id="rfrom" value="${esc(r.from)}"></label>
      <label class="inline">Até <input type="date" id="rto" value="${esc(r.to)}"></label>
      <button class="btn" id="csv">⬇️ Exportar planilha</button>
    </div>
  </div>
  <div class="grid cols-4 mt">
    <div class="card stat"><div class="label">Total</div><div class="value">${money(total)}</div><div class="sub">${list.length} conta(s)</div></div>
    <div class="card stat"><div class="label">Já pago</div><div class="value pos">${money(totPaid)}</div><div class="sub">${paid.length} conta(s)</div></div>
    <div class="card stat"><div class="label">A pagar</div><div class="value neg">${money(totPend)}</div><div class="sub">${pend.length} conta(s)</div></div>
    <div class="card stat"><div class="label">Maior área</div><div class="value" style="font-size:20px">${byArea[0] ? byArea[0].label : '—'}</div><div class="sub">${byArea[0] ? money(byArea[0].v) : ''}</div></div>
  </div>
  <div class="grid cols-2 mt">
    <div class="card"><h2>Por área (setor)</h2>${bars(byArea, total)}</div>
    <div class="card"><h2>Por quem comprou</h2>${bars(byWho, total)}</div>
  </div>
  <div class="grid cols-2 mt">
    <div class="card"><h2>Por mês</h2>${bars(byMonth, total)}</div>
    <div class="card"><h2>Por forma de pagamento</h2>${bars(byMethod, total)}</div>
  </div>
  <div class="card mt"><h2>Maiores fornecedores</h2>${bars(bySupplier, total)}</div>`;
}

function exportCsv() {
  const list = reportBills();
  const rows = [['Fornecedor', 'Descrição', 'Área', 'Edição', 'Lançado por', 'Data da compra', 'Vencimento', 'Forma', 'Cartão', 'Parcela', 'Valor', 'Situação', 'Pago em', 'Pago por', 'Valor pago', 'Observações']];
  for (const b of list) {
    rows.push([b.supplier, b.description, areaById(b.area_id).name, b.edition, memberName(b.created_by), fmtDate(b.purchase_date), fmtDate(b.due_date),
      METHODS[b.method].label, b.card_id ? cardLabel(cardById(b.card_id)) : '', b.installment, centsToInput(b.cents),
      { pending: 'A pagar', paid: 'Pago', cancelled: 'Cancelado' }[b.status], fmtDate(b.paid_at), b.paid_by ? memberName(b.paid_by) : '',
      b.paidCents != null ? centsToInput(b.paidCents) : '', b.notes]);
  }
  const csv = rows.map((r) => r.map((v) => `"${String(v ?? '').replace(/"/g, '""')}"`).join(';')).join('\r\n');
  const blob = new Blob(['﻿' + csv], { type: 'text/csv;charset=utf-8' });
  const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = `casacor-pagamentos-${todayISO()}.csv`;
  document.body.appendChild(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(a.href), 2000);
}

/* ---------- Equipe ---------- */
function renderEquipe() {
  const pending = state.members.filter((m) => m.role === 'pending');
  const active = state.members.filter((m) => !['pending', 'blocked'].includes(m.role));
  const blocked = state.members.filter((m) => m.role === 'blocked');
  const roleSel = (m) => `<select data-role="${m.user_id}" ${isAdmin() ? '' : 'disabled'}>${['member', 'payer', 'admin', 'gate', 'blocked'].map((r) => `<option value="${r}" ${m.role === r ? 'selected' : ''}>${ROLES[r].label}</option>`).join('')}</select>`;
  const row = (m) => `<li class="member-row">
      <div class="avatar">${esc((m.name || '?').charAt(0).toUpperCase())}</div>
      <div class="tx-main"><div class="tx-title">${esc(m.name)}${m.user_id === state.me.user_id ? ' <span class="muted">(você)</span>' : ''}</div>
        <div class="tx-meta">${esc(m.email)}${m.area ? ' · ' + esc(m.area) : ''}${m.role === 'admin' || m.can_hr ? ' · <span class="badge open">🔒 RH</span>' : ''}</div></div>
      <div class="row-actions">${isAdmin() ? `${roleSel(m)}${m.role !== 'admin' && 'can_hr' in m ? `<label class="check hr-toggle"><input type="checkbox" data-hr="${m.user_id}" ${m.can_hr ? 'checked' : ''}><span>Acesso ao RH</span></label>` : ''}<button class="btn small" data-editmember="${m.user_id}">Editar</button>` : `<span class="badge open">${ROLES[m.role].label}</span>`}</div>
    </li>`;
  return `
  ${isAdmin() && pending.length ? `<div class="card attention"><h2>⏳ Aguardando sua aprovação</h2><ul class="tx-list">${pending.map((m) => `<li class="member-row">
      <div class="avatar">${esc((m.name || '?').charAt(0).toUpperCase())}</div>
      <div class="tx-main"><div class="tx-title">${esc(m.name)}</div><div class="tx-meta">${esc(m.email)} · pediu acesso em ${new Date(m.created_at).toLocaleDateString('pt-BR')}</div></div>
      <div class="row-actions"><button class="btn small primary" data-approve="${m.user_id}">Aprovar</button><button class="btn small" data-reject="${m.user_id}">Recusar</button></div>
    </li>`).join('')}</ul></div>` : ''}
  <div class="card ${pending.length && isAdmin() ? 'mt' : ''}">
    <h2>Equipe</h2>
    <ul class="tx-list">${active.map(row).join('')}</ul>
    <div class="role-help muted small">
      <b>Comprador:</b> lança contas e acompanha tudo. · <b>Pagador:</b> também marca contas como pagas. · <b>Administrador:</b> também aprova pessoas e altera configurações.
      <br><b>🔒 Acesso ao RH:</b> vê funcionários, salários e a folha (o administrador sempre tem).
    </div>
  </div>
  ${blocked.length && isAdmin() ? `<div class="card mt"><h2>Sem acesso</h2><ul class="tx-list">${blocked.map(row).join('')}</ul></div>` : ''}
  ${isAdmin() && state.invites ? `<div class="card mt"><div class="card-head"><h2>Convidar alguém</h2><button class="btn small primary" id="newInvite">+ Convidar pessoa</button></div>
    <p class="muted">Gere um link e mande pelo WhatsApp. A pessoa abre, cria a senha e já entra com a função escolhida — sem precisar aprovar.</p>
    ${state.invites.length ? `<ul class="tx-list">${state.invites.map((i) => `<li class="member-row">
      <div class="avatar">✉️</div>
      <div class="tx-main"><div class="tx-title">${esc(i.name)} <span class="badge open">${esc(ROLES[i.role]?.label || i.role)}</span></div>
        <div class="tx-meta">${new Date(i.expires_at) < new Date() ? 'convite vencido' : 'aguardando · vale até ' + new Date(i.expires_at).toLocaleDateString('pt-BR')}</div></div>
      <div class="row-actions"><button class="btn small" data-invlink="${i.token}">Ver link</button><button class="btn small" data-invdel="${i.token}">Cancelar</button></div>
    </li>`).join('')}</ul>` : ''}
  </div>` : `<div class="card mt"><h2>Convidar alguém</h2>
    <p class="muted">Envie o endereço do sistema. A pessoa toca em <b>Criar acesso</b>, e a administração aprova aqui.</p>
    <div class="copy-field"><code id="appUrl">${esc(location.origin + location.pathname)}</code><button class="btn small" data-copy="appUrl">Copiar</button></div>
  </div>`}`;
}

/* ---------- Ajustes ---------- */
function renderAjustes() {
  return `<div class="grid cols-2">
    <div>
      <div class="card"><h2>Meu perfil</h2>
        <p><b>${esc(state.me.name)}</b><br><span class="muted">${esc(state.me.email)} · ${ROLES[state.me.role].label}</span></p>
        <div class="row-actions"><button class="btn" id="editMe">Alterar meu nome</button><button class="btn danger" id="logout">Sair</button></div>
      </div>
      <div class="card mt"><h2>Edição do evento</h2>
        <p class="muted">As contas novas são marcadas com a edição atual, para separar os gastos de cada ano nos relatórios.</p>
        <p>Edição atual: <b>${esc(state.settings.edition || '—')}</b></p>
        ${isAdmin() ? '<button class="btn" id="editEdition">Alterar edição atual</button>' : ''}
      </div>
      <div class="card mt"><h2>Instalar como app</h2>
        <p class="muted"><b>iPhone/iPad:</b> no Safari, Compartilhar (□↑) → <b>Adicionar à Tela de Início</b>.<br>
        <b>Android:</b> no Chrome, menu <b>⋮</b> → <b>Instalar app</b>.</p>
      </div>
    </div>
    <div>
      <div class="card"><div class="card-head"><h2>Áreas (setores)</h2>${isAdmin() ? '<button class="btn small primary" id="newArea">+ Nova</button>' : ''}</div>
        <ul class="tx-list">${state.areas.map((a) => `<li class="member-row"><span class="area-dot big" style="--c:${a.color}"></span>
          <div class="tx-main"><div class="tx-title">${esc(a.name)} ${a.active ? '' : '<span class="badge">inativa</span>'}</div>
          <div class="tx-meta">${state.bills.filter((b) => String(b.area_id) === String(a.id)).length} conta(s)</div></div>
          ${isAdmin() ? `<button class="btn small" data-editarea="${a.id}">Editar</button>` : ''}</li>`).join('')}</ul>
      </div>
    </div>
  </div>`;
}

/* ---------- Eventos ---------- */
function bindView() {
  const v = $('#view');
  $$('[data-bill]', v).forEach((el) => el.addEventListener('click', () => openBill(el.dataset.bill)));
  $$('[data-invoice]', v).forEach((el) => el.addEventListener('click', () => openInvoice(el.dataset.invoice)));
  $$('[data-go]', v).forEach((el) => el.addEventListener('click', () => setView(el.dataset.go)));
  $$('[data-copy]', v).forEach((b) => b.addEventListener('click', (e) => { e.stopPropagation(); copyText($('#' + b.dataset.copy).textContent); }));

  if (ui.view === 'contas') {
    $$('[data-tab]', v).forEach((b) => b.addEventListener('click', () => { ui.tab = b.dataset.tab; render(); }));
    const fq = $('#fq');
    fq.addEventListener('input', () => { ui.filter.q = fq.value; const p = fq.selectionStart; render(); const n = $('#fq'); n.focus(); n.setSelectionRange(p, p); });
    [['farea', 'area'], ['fwho', 'who'], ['fmethod', 'method'], ['fedition', 'edition'], ['fmonth', 'month']].forEach(([id, k]) =>
      $('#' + id).addEventListener('change', (e) => { ui.filter[k] = e.target.value; render(); }));
    $('#fclear')?.addEventListener('click', () => { ui.filter = { q: '', area: '', who: '', method: '', month: '', edition: '' }; render(); });
  }
  if (ui.view === 'cartoes') {
    $('#newCard')?.addEventListener('click', () => openCardForm());
    $$('[data-editcard]', v).forEach((b) => b.addEventListener('click', () => openCardForm(cardById(b.dataset.editcard))));
  }
  if (ui.view === 'relatorios') {
    $('#redition').addEventListener('change', (e) => { ui.report.edition = e.target.value; render(); });
    $('#rfrom').addEventListener('change', (e) => { ui.report.from = e.target.value; render(); });
    $('#rto').addEventListener('change', (e) => { ui.report.to = e.target.value; render(); });
    $('#csv').addEventListener('click', exportCsv);
  }
  if (ui.view === 'portaria') bindPortaria(v);
  if (ui.view === 'rh') bindRH(v);
  else $$('[data-emp]', v).forEach((el) => el.addEventListener('click', () => openEmployee(el.dataset.emp)));
  $$('[data-genfolha]', v).forEach((b) => b.addEventListener('click', () => { const [t, d] = b.dataset.genfolha.split('|'); goToPayroll(t, d); }));
  if (ui.view === 'equipe') {
    $$('[data-hr]', v).forEach((c) => c.addEventListener('change', async () => {
      try {
        await api.update('members', `user_id=eq.${c.dataset.hr}`, { can_hr: c.checked });
        toast(c.checked ? 'Acesso ao RH liberado' : 'Acesso ao RH retirado'); await loadAll({ quiet: true }); render();
      } catch (e) { toast(e.message); render(); }
    }));
    $$('[data-approve]', v).forEach((b) => b.addEventListener('click', () => openApprove(b.dataset.approve)));
    $('#newInvite')?.addEventListener('click', openInviteForm);
    $$('[data-invlink]', v).forEach((b) => b.addEventListener('click', () => showInviteLink(state.invites.find((i) => i.token === b.dataset.invlink))));
    $$('[data-invdel]', v).forEach((b) => b.addEventListener('click', async () => {
      if (!confirm('Cancelar este convite? O link deixa de funcionar.')) return;
      try { await api.remove('invites', `token=eq.${b.dataset.invdel}`); toast('Convite cancelado'); await loadAll({ quiet: true }); render(); } catch (e) { toast(e.message); }
    }));
    $$('[data-reject]', v).forEach((b) => b.addEventListener('click', () => setRole(b.dataset.reject, 'blocked', 'Acesso recusado')));
    $$('[data-role]', v).forEach((s) => s.addEventListener('change', () => setRole(s.dataset.role, s.value, 'Função alterada')));
    $$('[data-editmember]', v).forEach((b) => b.addEventListener('click', () => openMemberForm(state.members.find((m) => m.user_id === b.dataset.editmember))));
  }
  if (ui.view === 'ajustes') {
    $('#logout').addEventListener('click', () => {
      if (!confirm('Sair desta conta neste aparelho?')) return;
      api.signOut(); localStorage.removeItem(CACHE_KEY); location.reload();
    });
    $('#editMe').addEventListener('click', () => openMemberForm(state.me, true));
    $('#editEdition')?.addEventListener('click', openEditionForm);
    $('#newArea')?.addEventListener('click', () => openAreaForm());
    $$('[data-editarea]', v).forEach((b) => b.addEventListener('click', () => openAreaForm(state.areas.find((a) => String(a.id) === b.dataset.editarea))));
  }
}

async function copyText(t) {
  try { await navigator.clipboard.writeText(t); toast('Copiado ✅'); } catch { prompt('Copie:', t); }
}

/* ---------- Modais ---------- */
const modal = $('#modal');
const modalForm = $('#modalForm');
function openModal(html, onSubmit, onReady) {
  modalForm.innerHTML = html;
  modalForm.onsubmit = async (e) => {
    e.preventDefault();
    const action = e.submitter?.value || 'ok';
    if (action === 'cancel') { modal.close(); return; }
    const btns = $$('button', modalForm); btns.forEach((b) => (b.disabled = true));
    const sub = e.submitter; const label = sub?.textContent; if (sub) sub.textContent = 'Aguarde…';
    try {
      const r = await onSubmit(action, new FormData(modalForm), e.submitter);
      if (r !== false) modal.close();
    } catch (err) {
      toast(err.message || String(err));
    } finally {
      btns.forEach((b) => (b.disabled = false)); if (sub && document.contains(sub)) sub.textContent = label;
    }
  };
  if (!modal.open) modal.showModal();
  onReady?.();
}
modal.addEventListener('click', (e) => { if (e.target === modal) modal.close(); });

/* ---------- Anexos ---------- */
/** Reduz fotos grandes (economiza espaço e internet). PDFs vão como estão. */
async function prepareFile(file) {
  if (!/^image\//.test(file.type) || file.size < 500 * 1024) return file;
  try {
    const img = await createImageBitmap(file);
    const scale = Math.min(1, 1800 / Math.max(img.width, img.height));
    const c = document.createElement('canvas'); c.width = Math.round(img.width * scale); c.height = Math.round(img.height * scale);
    c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
    const blob = await new Promise((r) => c.toBlob(r, 'image/jpeg', 0.82));
    return blob ? new File([blob], file.name.replace(/\.\w+$/, '') + '.jpg', { type: 'image/jpeg' }) : file;
  } catch { return file; }
}
async function uploadFiles(fileList, folder, kind, bucket = 'anexos') {
  const out = [];
  for (const f0 of [...fileList]) {
    const f = await prepareFile(f0);
    const safe = f.name.normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^\w.-]+/g, '_').slice(-60) || 'arquivo';
    const path = `${folder}/${Date.now()}-${Math.random().toString(36).slice(2, 6)}-${safe}`;
    await api.upload(path, f, bucket);
    out.push({ path, name: f0.name, kind, type: f.type, by: state.me.user_id, at: new Date().toISOString(), ...(bucket !== 'anexos' ? { bucket } : {}) });
  }
  return out;
}
const KIND_LABEL = { nf: 'Nota fiscal', boleto: 'Boleto', comprovante: 'Comprovante', outro: 'Anexo' };
function attachmentList(atts, removable = false) {
  if (!atts.length) return '<div class="muted small">Nenhum anexo.</div>';
  return `<ul class="att-list">${atts.map((a, i) => `<li><button type="button" class="att" data-open="${esc(a.path)}" data-bucket="${esc(a.bucket || 'anexos')}">${/pdf/.test(a.type) ? '📄' : '🖼️'} <b>${KIND_LABEL[a.kind] || 'Anexo'}</b> <span class="muted">${esc(a.name)}</span></button>
    ${removable ? `<button type="button" class="btn small" data-rmatt="${i}" aria-label="Remover">✕</button>` : ''}</li>`).join('')}</ul>`;
}
function bindAttachments(root) {
  $$('[data-open]', root).forEach((b) => b.addEventListener('click', async () => {
    const w = window.open('', '_blank');
    try { const url = await api.signedUrl(b.dataset.open, b.dataset.bucket || 'anexos'); if (w) w.location = url; else location.href = url; }
    catch (e) { w?.close(); toast(e.message); }
  }));
}

/* ---------- Lançar / editar conta ---------- */
const TERMS = [['0', 'No dia'], ['7', '7 dias'], ['15', '15 dias'], ['30', '30 dias'], ['custom', 'Outra data']];

/** Vencimento da parcela i (0 = primeira): cartão → fatura de cada mês; senão, pelo intervalo escolhido. */
function installmentDue(i, { card, purchase, due, interval }) {
  if (card) return invoiceDue(card, addMonthsISO(purchase, i));
  if (!interval || interval === 'month') return addMonthsISO(due, i);
  return addDaysISO(due, i * Number(interval));
}

function openBillForm(bill, defaults = {}) {
  const isEdit = !!bill;
  const myArea = state.areas.find((a) => a.name.toLowerCase() === (state.me.area || '').toLowerCase());
  const b = bill || { supplier: '', description: '', area_id: myArea?.id || '', cents: 0, purchase_date: todayISO(), due_date: '', method: 'pix', pix_key: '', boleto_code: '', bank_info: '', card_id: '', notes: '', edition: state.settings.edition, attachments: [], ...defaults };
  let atts = [...(b.attachments || [])];
  const suppliers = [...new Set(state.bills.map((x) => x.supplier))].sort();
  const activeCards = state.cards.filter((c) => c.active || c.id === b.card_id);
  const html = `
    <h2>${isEdit ? 'Editar conta' : 'Lançar conta a pagar'}</h2>
    <div class="form-grid">
      <label class="field full"><span>Fornecedor *</span><input name="supplier" list="suppliers" value="${esc(b.supplier)}" required placeholder="Quem vai receber o pagamento" autocomplete="off">
        <datalist id="suppliers">${suppliers.map((s) => `<option value="${esc(s)}">`).join('')}</datalist></label>
      <label class="field full"><span>O que foi comprado</span><input name="description" value="${esc(b.description)}" placeholder="Ex.: Tinta para o ambiente 3, buffet da abertura…"></label>
      <label class="field"><span>Valor (R$) *</span><input class="amount-input" name="amount" inputmode="decimal" placeholder="0,00" value="${b.cents ? centsToInput(b.cents) : ''}" required autocomplete="off"></label>
      <label class="field"><span>Área *</span><select name="area_id" required><option value="">Escolha…</option>${state.areas.filter((a) => a.active || String(a.id) === String(b.area_id)).map((a) => `<option value="${a.id}" ${String(a.id) === String(b.area_id) ? 'selected' : ''}>${esc(a.name)}</option>`).join('')}</select></label>
      <label class="field"><span>Data da compra</span><input type="date" name="purchase_date" value="${b.purchase_date}" required></label>
      <label class="field"><span>Edição</span><input name="edition" value="${esc(b.edition)}" inputmode="numeric" placeholder="Ex.: 2027"></label>
      <div class="field full"><span>Forma de pagamento *</span>
        <div class="chips-select">${Object.entries(METHODS).map(([k, m]) => `<label class="chip-opt"><input type="radio" name="method" value="${k}" ${b.method === k ? 'checked' : ''}><span>${m.icon} ${m.label}</span></label>`).join('')}</div></div>
      <label class="field full" data-for="pix"><span>Chave Pix</span><input name="pix_key" value="${esc(b.pix_key)}" placeholder="CPF/CNPJ, e-mail, telefone ou chave aleatória" autocomplete="off"></label>
      <label class="field full" data-for="boleto"><span>Código de barras / linha digitável</span><input name="boleto_code" value="${esc(b.boleto_code)}" inputmode="numeric" placeholder="Opcional se anexar o boleto" autocomplete="off"></label>
      <label class="field full" data-for="transferencia"><span>Dados bancários</span><textarea name="bank_info" rows="2" placeholder="Banco, agência, conta, CPF/CNPJ, nome">${esc(b.bank_info)}</textarea></label>
      <label class="field full" data-for="cartao"><span>Cartão</span><select name="card_id">${activeCards.length ? activeCards.map((c) => `<option value="${c.id}" ${c.id === b.card_id ? 'selected' : ''}>${esc(cardLabel(c))}</option>`).join('') : '<option value="">Nenhum cartão cadastrado (aba Cartões)</option>'}</select>
        <small class="muted" id="cardHint"></small></label>
      <div class="field full pay-section"><span class="pay-title">📅 Pagamento</span></div>
      <div class="field full" id="termWrap"><span>Prazo para pagar</span>
        <div class="chips-select">${TERMS.map(([v, l]) => `<label class="chip-opt"><input type="radio" name="term" value="${v}" ${(isEdit ? 'custom' : '0') === v ? 'checked' : ''}><span>${l}</span></label>`).join('')}</div></div>
      <label class="field" id="dueWrap"><span id="dueLabel">Data do pagamento *</span><input type="date" name="due_date" value="${b.due_date || (isEdit ? '' : b.purchase_date)}"></label>
      ${isEdit ? '' : `<label class="field"><span>Parcelas</span><select name="installments">${Array.from({ length: 24 }, (_, i) => `<option value="${i + 1}">${i === 0 ? 'À vista (1x)' : `${i + 1}x (valor total dividido)`}</option>`).join('')}</select></label>
      <label class="field" id="intervalWrap"><span>Intervalo entre as parcelas</span><select name="interval">
        <option value="30">A cada 30 dias (30/60/90…)</option><option value="month">Todo mês, no mesmo dia</option><option value="15">A cada 15 dias</option><option value="7">A cada 7 dias</option></select></label>
      <div class="field full" id="instPreview"></div>`}
      <label class="field full"><span>Observações</span><textarea name="notes" rows="2">${esc(b.notes)}</textarea></label>
      <div class="field full"><span>Anexos (foto ou PDF)</span>
        <div id="attBox">${attachmentList(atts, true)}</div>
        <div class="row-actions">
          <label class="btn small file-btn">📄 Nota fiscal<input type="file" name="f_nf" accept="image/*,application/pdf" multiple hidden></label>
          <label class="btn small file-btn">🧾 Boleto<input type="file" name="f_boleto" accept="image/*,application/pdf" multiple hidden></label>
          <label class="btn small file-btn">📎 Outro<input type="file" name="f_outro" accept="image/*,application/pdf" multiple hidden></label>
        </div>
        <small class="muted" id="newFiles"></small>
      </div>
    </div>
    <div class="modal-actions">
      <span class="spacer"></span>
      <button class="btn" value="cancel" formnovalidate>Cancelar</button>
      <button class="btn primary" value="save">${isEdit ? 'Salvar' : 'Lançar conta'}</button>
    </div>`;

  openModal(html, async (action, fd) => {
    const cents = parseMoney(fd.get('amount'));
    if (cents <= 0) { toast('Informe o valor'); return false; }
    const method = fd.get('method');
    const card = method === 'cartao' ? cardById(fd.get('card_id')) : null;
    if (method === 'cartao' && !card) { toast('Cadastre um cartão na aba Cartões primeiro'); return false; }
    const purchase = fd.get('purchase_date');
    const due = card ? invoiceDue(card, purchase) : fd.get('due_date');
    if (!due) { toast('Informe a data para pagar'); return false; }
    const n = isEdit ? 1 : Number(fd.get('installments') || 1);
    const base = {
      supplier: fd.get('supplier').trim(), description: fd.get('description').trim(), area_id: Number(fd.get('area_id')),
      purchase_date: purchase, edition: fd.get('edition').trim(), method,
      pix_key: method === 'pix' ? fd.get('pix_key').trim() : '', boleto_code: method === 'boleto' ? fd.get('boleto_code').trim() : '',
      bank_info: method === 'transferencia' ? fd.get('bank_info').trim() : '', card_id: card ? card.id : null, notes: fd.get('notes').trim(),
    };
    if (!base.supplier || !base.area_id) { toast('Preencha fornecedor e área'); return false; }
    const id = isEdit ? bill.id : uuid();
    const groupId = n > 1 ? uuid() : null;
    const folder = groupId || id;
    const newAtts = [];
    for (const kind of ['nf', 'boleto', 'outro']) {
      const files = $(`[name="f_${kind}"]`, modalForm).files;
      if (files.length) newAtts.push(...await uploadFiles(files, folder, kind));
    }
    const attachments = [...atts, ...newAtts];
    if (isEdit) {
      const removed = (bill.attachments || []).filter((a) => !attachments.some((x) => x.path === a.path)).map((a) => a.path);
      const rows = await api.update('bills', `id=eq.${id}`, { ...base, amount: cents / 100, due_date: due, attachments });
      if (!rows?.length) throw new Error('Você não tem permissão para alterar esta conta.');
      api.deleteFiles(removed.filter((p) => !state.bills.some((x) => x.id !== id && x.attachments.some((a) => a.path === p))));
      toast('Conta atualizada');
    } else {
      const per = Math.floor(cents / n), rest = cents - per * n;
      const rows = Array.from({ length: n }, (_, i) => ({
        ...base, id: i === 0 ? id : uuid(), group_id: groupId,
        amount: (per + (i === 0 ? rest : 0)) / 100,
        due_date: installmentDue(i, { card, purchase, due, interval: fd.get('interval') }),
        installment: n > 1 ? `${i + 1}/${n}` : '', attachments,
      }));
      await api.insert('bills', rows);
      toast(n > 1 ? `Conta lançada em ${n} parcelas ✅` : 'Conta lançada ✅');
    }
    await loadAll({ quiet: true });
    render();
  }, () => {
    const val = (n) => $(`[name="${n}"]`, modalForm)?.value;
    const sync = () => {
      const m = $('[name="method"]:checked', modalForm)?.value;
      const isCard = m === 'cartao';
      $$('[data-for]', modalForm).forEach((el) => { el.style.display = el.dataset.for === m ? '' : 'none'; });
      $('#dueWrap').style.display = isCard ? 'none' : '';
      $('#termWrap').style.display = isCard ? 'none' : '';
      $('[name="due_date"]', modalForm).required = !isCard;
      const card = cardById(val('card_id'));
      const pd = val('purchase_date');
      // Prazo rápido: calcula a data do pagamento a partir da data da compra
      const term = $('[name="term"]:checked', modalForm)?.value;
      if (!isCard && pd && term && term !== 'custom') $('[name="due_date"]', modalForm).value = addDaysISO(pd, Number(term));
      $('#cardHint').innerHTML = isCard && card && pd ? `Entra na fatura que vence em <b>${fmtDate(invoiceDue(card, pd))}</b>.` : '';
      // Parcelas
      const n = Number(val('installments') || 1);
      $('#dueLabel').textContent = n > 1 ? 'Data da 1ª parcela *' : 'Data do pagamento *';
      if ($('#intervalWrap')) $('#intervalWrap').style.display = n > 1 && !isCard ? '' : 'none';
      const prev = $('#instPreview');
      if (prev) {
        const cents = parseMoney(val('amount'));
        const due = isCard ? (card && pd ? invoiceDue(card, pd) : '') : val('due_date');
        if (n > 1 && due && (!isCard || card)) {
          const per = Math.floor(cents / n), rest = cents - per * n;
          prev.innerHTML = `<div class="inst-preview"><b>${n} parcelas${cents ? ` de ${money(per)}` : ''}${isCard ? ' (uma em cada fatura)' : ''}:</b>
            ${Array.from({ length: n }, (_, i) => `<span>${i + 1}ª ${fmtDate(installmentDue(i, { card: isCard ? card : null, purchase: pd, due, interval: val('interval') }))}${cents ? ' · ' + money(per + (i === 0 ? rest : 0)) : ''}</span>`).join('')}</div>`;
        } else prev.innerHTML = '';
      }
    };
    $$('[name="method"], [name="card_id"], [name="purchase_date"], [name="term"], [name="installments"], [name="interval"]', modalForm).forEach((el) => el.addEventListener('change', sync));
    $('[name="amount"]', modalForm).addEventListener('input', sync);
    // Data digitada à mão → prazo "Outra data"
    $('[name="due_date"]', modalForm).addEventListener('change', () => { const c = $('[name="term"][value="custom"]', modalForm); if (c) c.checked = true; sync(); });
    const showFiles = () => {
      const names = $$('input[type=file]', modalForm).flatMap((i) => [...i.files].map((f) => f.name));
      $('#newFiles').textContent = names.length ? `Novos: ${names.join(', ')}` : '';
    };
    $$('input[type=file]', modalForm).forEach((i) => i.addEventListener('change', showFiles));
    const bindRm = () => {
      bindAttachments($('#attBox'));
      $$('[data-rmatt]', modalForm).forEach((x) => x.addEventListener('click', () => { atts.splice(Number(x.dataset.rmatt), 1); $('#attBox').innerHTML = attachmentList(atts, true); bindRm(); }));
    };
    bindRm();
    sync();
    if (!isEdit) setTimeout(() => $('[name="supplier"]', modalForm).focus(), 60);
  });
}

/* ---------- Detalhe da conta ---------- */
function openBill(id) {
  const b = state.bills.find((x) => x.id === id);
  if (!b) return;
  const a = areaById(b.area_id); const m = METHODS[b.method];
  const canEdit = b.status === 'pending' || isPayer();
  const canDelete = isAdmin() || (b.created_by === state.me.user_id && b.status === 'pending');
  const copyRow = (label, value) => value ? `<div class="copy-field"><span>${label}</span><code>${esc(value)}</code><button type="button" class="btn small" data-copyval="${esc(value)}">Copiar</button></div>` : '';
  const group = b.group_id ? state.bills.filter((x) => x.group_id === b.group_id).length : 0;
  openModal(`
    <div class="detail-head"><div><h2 style="margin:0">${esc(b.supplier)}</h2><div class="muted">${esc(b.description || '')}</div></div>
      <div class="detail-amount">${money(b.cents)} ${statusBadge(b)}</div></div>
    <dl class="detail">
      <dt>Área</dt><dd><span class="area-dot" style="--c:${a.color}"></span>${esc(a.name)}${b.edition ? ` · edição ${esc(b.edition)}` : ''}</dd>
      <dt>Lançada por</dt><dd>${esc(memberName(b.created_by))} · ${new Date(b.created_at).toLocaleString('pt-BR', { dateStyle: 'short', timeStyle: 'short' })}</dd>
      <dt>Data da compra</dt><dd>${fmtDate(b.purchase_date)}</dd>
      <dt>${b.method === 'cartao' ? 'Fatura vence' : 'Pagar até'}</dt><dd><b>${fmtDate(b.due_date)}</b>${b.status === 'pending' ? ` · ${dueText(b.due_date)}` : ''}</dd>
      <dt>Forma</dt><dd>${m.icon} ${b.method === 'cartao' ? esc(cardLabel(cardById(b.card_id))) : m.label}${b.installment ? ` · parcela ${esc(b.installment)}` : ''}</dd>
      ${b.status === 'paid' ? `<dt>Pagamento</dt><dd class="pos">Pago em <b>${fmtDate(b.paid_at)}</b> por ${esc(memberName(b.paid_by))}${b.paidCents != null && b.paidCents !== b.cents ? ` · valor pago ${money(b.paidCents)}` : ''}${b.payment_notes ? `<br>${esc(b.payment_notes)}` : ''}</dd>` : ''}
      ${b.notes ? `<dt>Observações</dt><dd>${esc(b.notes)}</dd>` : ''}
    </dl>
    ${group > 1 ? `<div class="inst-list"><b>Parcelas</b>${state.bills.filter((x) => x.group_id === b.group_id).sort((x, y) => x.due_date.localeCompare(y.due_date)).map((x) =>
      `<div class="${x.id === b.id ? 'cur' : ''}"><span>${esc(x.installment)} · ${fmtDate(x.due_date)}</span><span>${money(x.cents)} ${x.status === 'paid' ? '<span class="badge paid">pago</span>' : x.status === 'cancelled' ? '<span class="badge">cancelada</span>' : daysUntil(x.due_date) < 0 ? '<span class="badge overdue">atrasada</span>' : ''}</span></div>`).join('')}</div>` : ''}
    ${copyRow('Chave Pix', b.pix_key)}${copyRow('Código do boleto', b.boleto_code)}${copyRow('Dados bancários', b.bank_info)}
    <h3 class="sub-h">Anexos</h3><div id="attView">${attachmentList(b.attachments)}</div>
    <div class="modal-actions">
      ${canDelete ? `<button class="btn danger" value="delete" formnovalidate>Excluir</button>` : ''}
      ${canDelete && group > 1 ? `<button class="btn danger" value="deleteGroup" formnovalidate>Excluir parcelas futuras</button>` : ''}
      ${isPayer() && b.status === 'pending' ? '<button class="btn" value="cancelBill" formnovalidate>Cancelar conta</button>' : ''}
      ${isPayer() && b.status !== 'pending' ? '<button class="btn" value="reopen" formnovalidate>Voltar para “a pagar”</button>' : ''}
      <span class="spacer"></span>
      ${canEdit ? '<button class="btn" value="edit" formnovalidate>Editar</button>' : ''}
      ${isPayer() && b.status === 'pending' ? `<button class="btn primary" value="pay">✅ ${b.method === 'cartao' ? 'Pagar fatura' : 'Marcar como pago'}</button>` : ''}
      <button class="btn" value="cancel" formnovalidate>Fechar</button>
    </div>`,
  async (action) => {
    if (action === 'edit') { setTimeout(() => openBillForm(b), 0); return; }
    if (action === 'pay') { setTimeout(() => (b.method === 'cartao' ? openInvoice(`${b.card_id}|${b.due_date}`) : openPay([b])), 0); return; }
    if (action === 'delete' || action === 'deleteGroup') {
      const targets = action === 'deleteGroup' ? state.bills.filter((x) => x.group_id === b.group_id && x.due_date >= b.due_date && (isAdmin() || x.status === 'pending')) : [b];
      if (!confirm(action === 'deleteGroup' ? `Excluir esta e as próximas parcelas (${targets.length})?` : 'Excluir esta conta? Esta ação não pode ser desfeita.')) return false;
      const del = await api.remove('bills', `id=in.(${targets.map((x) => x.id).join(',')})`);
      if (!del?.length) throw new Error('Você não tem permissão para excluir esta conta.');
      const ids = new Set(targets.map((x) => x.id));
      const paths = [...new Set(targets.flatMap((x) => x.attachments.map((a) => a.path)))];
      api.deleteFiles(paths.filter((p) => !state.bills.some((x) => !ids.has(x.id) && x.attachments.some((a) => a.path === p))));
      toast('Excluída'); await loadAll({ quiet: true }); render(); return;
    }
    if (action === 'cancelBill') {
      if (!confirm('Cancelar esta conta? Ela sai da lista de “a pagar”, mas continua no histórico.')) return false;
      await api.update('bills', `id=eq.${b.id}`, { status: 'cancelled' });
      toast('Conta cancelada'); await loadAll({ quiet: true }); render(); return;
    }
    if (action === 'reopen') {
      if (!confirm('Voltar esta conta para “a pagar”?')) return false;
      await api.update('bills', `id=eq.${b.id}`, { status: 'pending', paid_at: null, paid_by: null, paid_amount: null, payment_notes: '' });
      toast('Conta reaberta'); await loadAll({ quiet: true }); render(); return;
    }
  }, () => {
    bindAttachments(modalForm);
    $$('[data-copyval]', modalForm).forEach((x) => x.addEventListener('click', () => copyText(x.dataset.copyval)));
  });
}

/* ---------- Pagar ---------- */
function openPay(bills, title) {
  const total = sumCents(bills);
  const payers = state.members.filter((m) => ['payer', 'admin'].includes(m.role));
  const one = bills.length === 1 ? bills[0] : null;
  openModal(`
    <h2>✅ ${title || 'Marcar como pago'}</h2>
    <p class="muted" style="margin-top:-6px">${one ? `<b>${esc(one.supplier)}</b> · vencimento ${fmtDate(one.due_date)}` : `${bills.length} compras`}</p>
    <div class="form-grid">
      <label class="field"><span>Valor pago (R$)</span><input class="amount-input" name="amount" inputmode="decimal" value="${centsToInput(total)}" ${one ? '' : 'readonly'} required></label>
      <label class="field"><span>Data do pagamento</span><input type="date" name="paid_at" value="${todayISO()}" required></label>
      <label class="field"><span>Pago por</span><select name="paid_by">${payers.map((p) => `<option value="${p.user_id}" ${p.user_id === state.me.user_id ? 'selected' : ''}>${esc(p.name)}</option>`).join('')}</select></label>
      <label class="field"><span>Comprovante (foto ou PDF)</span><input type="file" name="receipt" accept="image/*,application/pdf" multiple></label>
      <label class="field full"><span>Observação do pagamento</span><input name="payment_notes" placeholder="Ex.: pago com desconto, juros…"></label>
    </div>
    <div class="modal-actions"><span class="spacer"></span><button class="btn" value="cancel" formnovalidate>Cancelar</button><button class="btn primary" value="save">Confirmar pagamento</button></div>`,
  async (action, fd) => {
    const paidCents = one ? parseMoney(fd.get('amount')) : null;
    if (one && paidCents <= 0) { toast('Informe o valor pago'); return false; }
    const files = $('[name="receipt"]', modalForm).files;
    const receipts = files.length ? await uploadFiles(files, `pagamentos/${uuid()}`, 'comprovante') : [];
    for (const b of bills) {
      const rows = await api.update('bills', `id=eq.${b.id}`, {
        status: 'paid', paid_at: fd.get('paid_at'), paid_by: fd.get('paid_by'), paid_amount: (one ? paidCents : b.cents) / 100,
        payment_notes: fd.get('payment_notes').trim(), attachments: [...b.attachments, ...receipts],
      });
      if (!rows?.length) throw new Error('Não foi possível marcar como pago (permissão).');
    }
    toast(bills.length > 1 ? `${bills.length} contas pagas ✅` : 'Conta paga ✅');
    await loadAll({ quiet: true }); render();
  });
}

function openInvoice(key) {
  const [cardId, due] = key.split('|');
  const card = cardById(cardId);
  const items = state.bills.filter((b) => b.card_id === cardId && b.due_date === due && b.status !== 'cancelled');
  const pend = items.filter((b) => b.status === 'pending');
  openModal(`
    <h2>💳 Fatura ${esc(cardLabel(card))}</h2>
    <p class="muted" style="margin-top:-6px">Vencimento <b>${fmtDate(due)}</b> · ${pend.length ? dueText(due) : 'paga'}</p>
    <ul class="tx-list">${items.map((b) => billRow(b, { showDue: false })).join('')}</ul>
    <div class="list-total"><span>Total</span><b>${money(sumCents(items))}</b></div>
    <div class="modal-actions"><span class="spacer"></span><button class="btn" value="cancel" formnovalidate>Fechar</button>
      ${isPayer() && pend.length ? `<button class="btn primary" value="pay">✅ Pagar fatura (${money(sumCents(pend))})</button>` : ''}</div>`,
  async (action) => { if (action === 'pay') setTimeout(() => openPay(pend, `Pagar fatura ${cardLabel(card)}`), 0); },
  () => $$('[data-bill]', modalForm).forEach((el) => el.addEventListener('click', () => openBill(el.dataset.bill))));
}

/* ---------- Cartões, áreas, equipe, edição ---------- */
function openCardForm(card) {
  const c = card || { name: '', final: '', closing_day: 5, due_day: 12, color: '#475569', active: true };
  openModal(`
    <h2>${card ? 'Editar cartão' : 'Novo cartão da empresa'}</h2>
    <div class="form-grid">
      <label class="field"><span>Nome</span><input name="name" value="${esc(c.name)}" required placeholder="Ex.: Santander Empresas"></label>
      <label class="field"><span>Final (4 dígitos)</span><input name="final" value="${esc(c.final)}" maxlength="4" inputmode="numeric"></label>
      <label class="field"><span>Dia de fechamento</span><input type="number" name="closing_day" min="1" max="31" value="${c.closing_day}" required></label>
      <label class="field"><span>Dia de vencimento</span><input type="number" name="due_day" min="1" max="31" value="${c.due_day}" required></label>
      <label class="field"><span>Cor</span><input type="color" name="color" value="${c.color}"></label>
      <label class="check"><input type="checkbox" name="active" ${c.active ? 'checked' : ''}><span>Ativo</span></label>
    </div>
    <div class="modal-actions"><span class="spacer"></span><button class="btn" value="cancel" formnovalidate>Cancelar</button><button class="btn primary" value="save">Salvar</button></div>`,
  async (action, fd) => {
    const data = { name: fd.get('name').trim(), final: fd.get('final').replace(/\D/g, ''), closing_day: Number(fd.get('closing_day')), due_day: Number(fd.get('due_day')), color: fd.get('color'), active: fd.get('active') === 'on' };
    if (card) await api.update('cards', `id=eq.${card.id}`, data); else await api.insert('cards', data);
    toast('Cartão salvo'); await loadAll({ quiet: true }); render();
  });
}

function openAreaForm(area) {
  const a = area || { name: '', color: '#64748b', active: true, sort: state.areas.length + 1 };
  openModal(`
    <h2>${area ? 'Editar área' : 'Nova área'}</h2>
    <div class="form-grid">
      <label class="field"><span>Nome</span><input name="name" value="${esc(a.name)}" required></label>
      <label class="field"><span>Cor</span><input type="color" name="color" value="${a.color}"></label>
      <label class="check full"><input type="checkbox" name="active" ${a.active ? 'checked' : ''}><span>Ativa (aparece ao lançar contas)</span></label>
    </div>
    <div class="modal-actions"><span class="spacer"></span><button class="btn" value="cancel" formnovalidate>Cancelar</button><button class="btn primary" value="save">Salvar</button></div>`,
  async (action, fd) => {
    const data = { name: fd.get('name').trim(), color: fd.get('color'), active: fd.get('active') === 'on' };
    if (area) await api.update('areas', `id=eq.${area.id}`, data); else await api.insert('areas', { ...data, sort: a.sort });
    toast('Área salva'); await loadAll({ quiet: true }); render();
  });
}

function openApprove(userId) {
  const m = state.members.find((x) => x.user_id === userId);
  openModal(`
    <h2>Aprovar ${esc(m.name)}</h2>
    <p class="muted" style="margin-top:-6px">${esc(m.email)}</p>
    <div class="form-grid one">
      <label class="field"><span>Nome</span><input name="name" value="${esc(m.name)}" required></label>
      <label class="field"><span>Função</span><select name="role">
        <option value="member">Comprador — lança contas</option><option value="payer">Pagador — lança e paga</option><option value="admin">Administrador — tudo</option><option value="gate">Porteiro — só a portaria da obra</option></select></label>
      <label class="field"><span>Área principal (sugerida ao lançar)</span><select name="area"><option value="">—</option>${state.areas.map((a) => `<option>${esc(a.name)}</option>`).join('')}</select></label>
    </div>
    <div class="modal-actions"><span class="spacer"></span><button class="btn" value="cancel" formnovalidate>Cancelar</button><button class="btn primary" value="save">Aprovar</button></div>`,
  async (action, fd) => {
    await api.update('members', `user_id=eq.${userId}`, { name: fd.get('name').trim(), role: fd.get('role'), area: fd.get('area') });
    toast('Acesso aprovado ✅'); await loadAll({ quiet: true }); render();
  });
}

function openInviteForm() {
  openModal(`
    <h2>Convidar pessoa</h2>
    <div class="form-grid one">
      <label class="field"><span>Nome</span><input name="name" required placeholder="Ex.: Amsterdã"></label>
      <label class="field"><span>Função</span><select name="role">
        <option value="member">Comprador — lança contas</option><option value="payer">Pagador — lança e paga</option><option value="gate">Porteiro — só a portaria da obra</option></select></label>
      <p class="muted small" style="margin:0">Administrador e acesso ao RH você libera depois, aqui em Equipe.</p>
    </div>
    <div class="modal-actions"><span class="spacer"></span><button class="btn" value="cancel" formnovalidate>Cancelar</button><button class="btn primary" value="save">Gerar convite</button></div>`,
  async (action, fd) => {
    const [inv] = await api.insert('invites', { name: fd.get('name').trim(), role: fd.get('role') });
    await loadAll({ quiet: true }); render();
    setTimeout(() => showInviteLink(inv), 0);
  });
}

function inviteUrl(i) {
  return `${location.origin}${location.pathname}#convite=${i.token}&nome=${encodeURIComponent(i.name)}&funcao=${i.role}`;
}

function showInviteLink(i) {
  const url = inviteUrl(i); const first = i.name.split(' ')[0];
  const msg = `Olá, ${first}! Este é o seu acesso ao sistema da Casa Cor Ceará${i.role === 'gate' ? ' (portaria da obra)' : ''}. Toque no link, coloque seu e-mail e crie uma senha:\n${url}`;
  openModal(`
    <h2>✉️ Convite de ${esc(i.name)}</h2>
    <p class="muted" style="margin-top:-6px">${esc(ROLES[i.role]?.label || '')} · o link vale por 7 dias e só pode ser usado uma vez.</p>
    <a class="btn primary big wa-btn" href="https://wa.me/?text=${encodeURIComponent(msg)}" target="_blank" rel="noopener">📲 Enviar pelo WhatsApp</a>
    <div class="copy-field"><code id="invUrl">${esc(url)}</code><button type="button" class="btn small" id="invCopy">Copiar</button></div>
    <div class="modal-actions"><span class="spacer"></span><button class="btn" value="cancel" formnovalidate>Fechar</button></div>`,
  () => {}, () => $('#invCopy').addEventListener('click', () => copyText(url)));
}

async function setRole(userId, role, msg) {
  try {
    if (userId === state.me.user_id && role !== state.me.role && !confirm('Mudar a sua própria função?')) { render(); return; }
    await api.update('members', `user_id=eq.${userId}`, { role });
    toast(msg); await loadAll({ quiet: true }); render();
  } catch (e) { toast(e.message); render(); }
}

function openMemberForm(m, self = false) {
  openModal(`
    <h2>${self ? 'Meu nome' : 'Editar ' + esc(m.name)}</h2>
    <div class="form-grid one">
      <label class="field"><span>Nome</span><input name="name" value="${esc(m.name)}" required></label>
      ${self ? '' : `<label class="field"><span>Área principal</span><select name="area"><option value="">—</option>${state.areas.map((a) => `<option ${a.name === m.area ? 'selected' : ''}>${esc(a.name)}</option>`).join('')}</select></label>`}
    </div>
    <div class="modal-actions"><span class="spacer"></span><button class="btn" value="cancel" formnovalidate>Cancelar</button><button class="btn primary" value="save">Salvar</button></div>`,
  async (action, fd) => {
    const data = { name: fd.get('name').trim() };
    if (!self) data.area = fd.get('area');
    await api.update('members', `user_id=eq.${m.user_id}`, data);
    toast('Salvo'); await loadAll({ quiet: true }); render();
  });
}

function openEditionForm() {
  openModal(`
    <h2>Edição atual do evento</h2>
    <label class="field"><span>Edição (ex.: 2027)</span><input name="edition" value="${esc(state.settings.edition)}" required></label>
    <p class="muted small">Contas já lançadas mantêm a edição que tinham.</p>
    <div class="modal-actions"><span class="spacer"></span><button class="btn" value="cancel" formnovalidate>Cancelar</button><button class="btn primary" value="save">Salvar</button></div>`,
  async (action, fd) => {
    await api.update('settings', 'id=eq.1', { edition: fd.get('edition').trim() });
    ui.filter.edition = ''; ui.report.edition = '';
    toast('Edição alterada'); await loadAll({ quiet: true }); render();
  });
}

/* ---------- Atalhos ---------- */
document.addEventListener('keydown', (e) => {
  if (modal.open || $('#app').hidden || e.target.matches('input, textarea, select') || isGateOnly()) return;
  if (e.key === 'n' || e.key === 'N') { e.preventDefault(); openBillForm(); }
  const map = { 1: 'painel', 2: 'contas', 3: 'cartoes', 4: 'relatorios', 5: 'equipe', 6: 'ajustes' };
  if (map[e.key]) setView(map[e.key]);
});

if ('serviceWorker' in navigator && location.protocol !== 'file:') navigator.serviceWorker.register('sw.js').catch(() => {});
boot();
