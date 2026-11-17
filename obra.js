'use strict';

/* =========================================================
   Obra — cronograma por ambiente (os mesmos ambientes da Portaria),
   QR Code em cada ambiente e atualização pelo celular de quem está na obra.
   - Equipe (login): monta etapas e datas, vê o cronograma, imprime os QR Codes.
   - Quem escaneia o QR (sem login): informa o andamento das etapas daquele ambiente.
   Usa as funções e o estado globais de app.js / portaria.js.
   ========================================================= */

const STAGE_TEMPLATES = ['Demolição / retirada', 'Alvenaria', 'Instalações elétricas', 'Instalações hidráulicas', 'Nivelamento de piso',
  'Assentamento de piso', 'Gesso / forro', 'Pintura', 'Marcenaria', 'Serralheria / vidros', 'Iluminação', 'Limpeza fina', 'Decoração / montagem', 'Entrega do ambiente'];
const STAGE_STATUS = {
  todo: { label: 'Não começou', icon: '⏳' },
  doing: { label: 'Em andamento', icon: '🔨' },
  done: { label: 'Concluído', icon: '✅' },
  blocked: { label: 'Parado', icon: '⛔' },
};
// Botões grandes do QR (quem está na obra)
const QR_CHOICES = [
  ['todo', 0, '⏳', 'Não começou'], ['doing', 10, '🔨', 'Começou'], ['doing', 50, '🌗', 'Metade'],
  ['doing', 80, '🔜', 'Quase pronto'], ['done', 100, '✅', 'Concluído'], ['blocked', null, '⛔', 'Parado / problema'],
];
const QR_LIB = 'https://cdnjs.cloudflare.com/ajax/libs/qrcode-generator/1.4.4/qrcode.min.js';
const oui = { tab: 'cron', open: {}, envF: '' };

const canObra = () => ['member', 'payer', 'admin'].includes(state.me?.role);
const bySortStage = (a, b) => (a.sort - b.sort) || String(a.start_date || '9').localeCompare(String(b.start_date || '9')) || a.name.localeCompare(b.name);
const stagesOf = (envId) => (state.obraStages || []).filter((s) => String(s.env_id) === String(envId)).sort(bySortStage);
const milestones = () => (state.obraStages || []).filter((s) => s.env_id == null).sort((a, b) => String(a.start_date || '').localeCompare(String(b.start_date || '')));
const stagePct = (s) => (s.status === 'done' ? 100 : Number(s.progress) || 0);
const stageLate = (s) => s.status !== 'done' && s.end_date && s.end_date < todayISO();
const stageShouldStart = (s) => s.status === 'todo' && s.start_date && s.start_date <= todayISO() && !stageLate(s);
function envProgress(envId) { const st = stagesOf(envId); return st.length ? Math.round(st.reduce((a, s) => a + stagePct(s), 0) / st.length) : null; }
const obraEnvs = () => envsSorted();
const shortD = (iso) => (iso ? `${iso.slice(8, 10)}/${iso.slice(5, 7)}` : '');
const qrUrl = (env) => `${location.origin}${location.pathname}#obra=${env.qr_token}`;
const statusChip = (s) => `<span class="st-chip ${stageLate(s) ? 'late' : s.status}">${STAGE_STATUS[s.status].icon} ${stageLate(s) ? 'Atrasada' : STAGE_STATUS[s.status].label}${s.status === 'doing' && s.progress ? ` ${s.progress}%` : ''}</span>`;

/* ---------- Carregamento ---------- */
async function loadObra() {
  state.obraStages = state.obraStages || []; state.obraUpdates = state.obraUpdates || [];
  if (!canObra()) return;
  try {
    const [st, up] = await Promise.all([
      api.select('obra_stages', 'select=*&order=sort,start_date'),
      api.select('obra_updates', 'select=*&order=created_at.desc&limit=200'),
    ]);
    Object.assign(state, { obraStages: st, obraUpdates: up, obraMissing: false });
  } catch (e) {
    if (/não foi configurado/.test(e.message)) state.obraMissing = true; else throw e;
  }
}
async function reloadObra() { await loadObra(); saveCache(); render(); }

/* ---------- Tela ---------- */
function renderObra() {
  if (state.obraMissing) {
    return `<div class="card"><div class="empty"><div style="font-size:44px">🏗️</div>
      <p>O cronograma da obra ainda não foi ativado no banco de dados.<br>Rode o script <b>supabase-obra.sql</b> no SQL Editor do Supabase.</p></div></div>`;
  }
  const tabs = [['cron', '📅 Cronograma'], ['amb', '🏠 Ambientes'], ['qr', '🔳 QR Codes'], ['upd', '📰 Atualizações']];
  const body = { cron: obraCronograma, amb: obraAmbientes, qr: obraQrTab, upd: obraUpdatesTab }[oui.tab]();
  return `<div class="tabs">${tabs.map(([k, l]) => `<button class="tab ${oui.tab === k ? 'active' : ''}" data-otab="${k}">${l}</button>`).join('')}</div>${body}`;
}

function obraCronograma() {
  const envs = obraEnvs();
  const all = (state.obraStages || []).filter((s) => s.env_id != null && envs.some((e) => String(e.id) === String(s.env_id)));
  if (!envs.length) return '<div class="card"><div class="empty">Cadastre os ambientes em <b>Portaria → Ambientes</b> primeiro.</div></div>';
  const withSt = envs.filter((e) => stagesOf(e.id).length);
  const overall = withSt.length ? Math.round(withSt.reduce((a, e) => a + envProgress(e.id), 0) / withSt.length) : 0;
  const late = all.filter(stageLate); const doing = all.filter((s) => s.status === 'doing'); const done = all.filter((s) => s.status === 'done');
  const blocked = all.filter((s) => s.status === 'blocked'); const shouldStart = all.filter(stageShouldStart);
  const today = todayISO();
  const nowList = all.filter((s) => s.start_date && s.end_date && s.start_date <= today && s.end_date >= today && s.status !== 'done');
  const envOf = (s) => gEnv(s.env_id);
  const li = (s, extra) => `<li data-oenv="${s.env_id}"><span class="o-li-name"><b>${esc(s.name)}</b> · ${esc(envLabel(envOf(s)))}</span><span>${extra}</span></li>`;
  return `
  <div class="grid cols-4">
    <div class="card stat"><div class="label">Obra concluída</div><div class="value">${overall}%</div><div class="o-bar big"><i style="width:${overall}%"></i></div></div>
    <div class="card stat ${late.length ? 'stat-danger' : ''}"><div class="label">Etapas atrasadas</div><div class="value ${late.length ? 'neg' : ''}">${late.length}</div><div class="sub">${blocked.length ? `${blocked.length} parada(s)` : 'nenhuma parada'}</div></div>
    <div class="card stat"><div class="label">Em andamento</div><div class="value">${doing.length}</div><div class="sub">${shouldStart.length ? `${shouldStart.length} deveria(m) ter começado` : 'tudo no tempo'}</div></div>
    <div class="card stat"><div class="label">Concluídas</div><div class="value pos">${done.length}<small class="muted"> / ${all.length}</small></div><div class="sub">${withSt.length} de ${envs.length} ambientes com cronograma</div></div>
  </div>
  ${late.length || blocked.length || shouldStart.length ? `<div class="card mt attention"><h2>⚠️ Precisa de atenção</h2><ul class="o-list">
    ${late.map((s) => li(s, `<span class="neg">devia terminar ${shortD(s.end_date)}</span> ${statusChip(s)}`)).join('')}
    ${blocked.filter((s) => !stageLate(s)).map((s) => li(s, statusChip(s))).join('')}
    ${shouldStart.map((s) => li(s, `<span class="muted">devia começar ${shortD(s.start_date)}</span>`)).join('')}</ul></div>` : ''}
  ${nowList.length ? `<div class="card mt"><h2>🔨 Deve estar acontecendo hoje</h2><ul class="o-list">${nowList.map((s) => li(s, `<span class="muted">até ${shortD(s.end_date)}</span> ${statusChip(s)}`)).join('')}</ul></div>` : ''}
  <div class="card mt">
    <div class="card-head"><h2>📅 Cronograma</h2><div class="row-actions"><button class="btn small" id="oExpand">${Object.values(oui.open).some(Boolean) ? 'Recolher etapas' : 'Mostrar etapas'}</button><button class="btn small" id="oNewMs">+ Marco</button></div></div>
    ${gantt(envs)}
    <div class="o-legend"><span class="st-chip todo">⏳ Não começou</span><span class="st-chip doing">🔨 Em andamento</span><span class="st-chip done">✅ Concluído</span><span class="st-chip late">Atrasada</span><span class="st-chip blocked">⛔ Parado</span><span class="muted small">Linha vermelha = hoje · toque no ambiente para ver as etapas</span></div>
  </div>
  ${milestones().length ? `<div class="card mt"><h2>🚩 Marcos da obra</h2><ul class="o-list">${milestones().map((m) => `<li data-ms="${m.id}"><span class="o-li-name"><b>${esc(m.name)}</b></span><span>${fmtDate(m.start_date)} ${m.status === 'done' ? '<span class="st-chip done">✅ feito</span>' : m.start_date < today ? '<span class="st-chip late">passou</span>' : `<span class="muted">${dateDiffDays(today, m.start_date)} dia(s)</span>`}</span></li>`).join('')}</ul></div>` : ''}`;
}

function gantt(envs) {
  const dated = (state.obraStages || []).filter((s) => s.start_date || s.end_date);
  if (!dated.length) return '<div class="empty small">Ainda não há datas. Na aba <b>Ambientes</b>, toque em <b>Montar etapas</b> para criar o cronograma de cada ambiente.</div>';
  const today = todayISO();
  let from = dated.reduce((m, s) => [s.start_date, s.end_date].filter(Boolean).reduce((x, d) => (d < x ? d : x), m), today);
  let to = dated.reduce((m, s) => [s.start_date, s.end_date].filter(Boolean).reduce((x, d) => (d > x ? d : x), m), today);
  from = addDaysISO(from, -2); to = addDaysISO(to, 3);
  const days = dateDiffDays(from, to) + 1;
  const pos = (d) => dateDiffDays(from, d);
  const bar = (s, cls = '') => {
    const st = s.start_date || s.end_date; const en = s.end_date || s.start_date;
    if (!st) return '';
    const left = pos(st), w = Math.max(1, dateDiffDays(st, en) + 1);
    return `<div class="gt-bar ${cls} ${stageLate(s) ? 'late' : s.status}" style="left:calc(${left} * var(--dw));width:calc(${w} * var(--dw))" title="${esc(s.name)}: ${shortD(st)} a ${shortD(en)}"><i style="width:${stagePct(s)}%"></i><span>${esc(s.name)}</span></div>`;
  };
  const head = [];
  for (let i = 0; i < days; i++) {
    const d = addDaysISO(from, i); const dt = new Date(d + 'T12:00'); const wd = dt.getDay();
    head.push(`<div class="gt-day ${wd === 0 || wd === 6 ? 'we' : ''} ${d === today ? 'today' : ''}">${d.slice(8) === '01' || i === 0 ? `<b>${dt.toLocaleDateString('pt-BR', { month: 'short' }).replace('.', '')}</b>` : ''}<span>${Number(d.slice(8))}</span></div>`);
  }
  const todayLine = `<div class="gt-today" style="left:calc(${pos(today)} * var(--dw) + var(--dw) / 2)"></div>`;
  const rows = [];
  const ms = milestones().filter((m) => m.start_date);
  if (ms.length) rows.push(`<div class="gt-row ms"><div class="gt-lab">🚩 Marcos</div><div class="gt-track">${todayLine}${ms.map((m) => `<div class="gt-ms" style="left:calc(${pos(m.start_date)} * var(--dw))" title="${esc(m.name)} — ${fmtDate(m.start_date)}">◆<span>${esc(m.name)}</span></div>`).join('')}</div></div>`);
  for (const e of envs.filter((x) => !oui.envF || String(x.id) === oui.envF)) {
    const st = stagesOf(e.id).filter((s) => s.start_date || s.end_date);
    const pct = envProgress(e.id);
    const anyLate = stagesOf(e.id).some(stageLate);
    const envSpan = st.length ? { start_date: st.reduce((m, s) => (s.start_date && s.start_date < m ? s.start_date : m), st[0].start_date || st[0].end_date), end_date: st.reduce((m, s) => ((s.end_date || s.start_date) > m ? (s.end_date || s.start_date) : m), st[0].end_date || st[0].start_date), status: pct === 100 ? 'done' : pct ? 'doing' : 'todo', progress: pct, name: `${pct ?? 0}%` } : null;
    rows.push(`<div class="gt-row env" data-oexp="${e.id}"><div class="gt-lab"><span class="gt-caret">${oui.open[e.id] ? '▾' : '▸'}</span>${e.number ? `<b class="g-num">${esc(e.number)}</b> ` : ''}${esc(e.name)}${anyLate ? ' <span class="neg">⚠️</span>' : ''}<small>${pct == null ? 'sem etapas' : pct + '%'}</small></div>
      <div class="gt-track">${todayLine}${envSpan ? bar({ ...envSpan, status: anyLate ? envSpan.status : envSpan.status }, 'env') : ''}</div></div>`);
    if (oui.open[e.id]) for (const s of stagesOf(e.id)) rows.push(`<div class="gt-row st" data-oenv="${e.id}"><div class="gt-lab sub">${esc(s.name)}</div><div class="gt-track">${todayLine}${bar(s)}</div></div>`);
  }
  return `<div class="gt-wrap"><div class="gantt" style="--days:${days}"><div class="gt-row head"><div class="gt-lab"></div><div class="gt-track gt-scale">${head.join('')}</div></div>${rows.join('')}</div></div>`;
}

function obraAmbientes() {
  const envs = obraEnvs();
  if (!envs.length) return '<div class="card"><div class="empty">Cadastre os ambientes em <b>Portaria → Ambientes</b> primeiro.</div></div>';
  const noSt = envs.filter((e) => !stagesOf(e.id).length);
  return `${noSt.length ? `<div class="alerts"><div class="alert info"><span class="alert-icon">🧩</span><div class="alert-text"><b>${noSt.length} ambiente(s) sem cronograma.</b> <span class="muted">Monte as etapas de todos de uma vez, com datas distribuídas automaticamente.</span></div><button class="btn small primary" id="oTplAll">Montar etapas</button></div></div>` : ''}
  <div class="o-envs">${envs.map((e) => {
    const st = stagesOf(e.id); const pct = envProgress(e.id);
    const cur = st.filter((s) => s.status === 'doing' || s.status === 'blocked'); const late = st.filter(stageLate);
    const last = (state.obraUpdates || []).find((u) => String(u.env_id) === String(e.id));
    return `<div class="card o-env ${late.length ? 'late' : ''}" data-oedit="${e.id}">
      <div class="o-env-head">${e.number ? `<b class="g-num">${esc(e.number)}</b>` : ''}<div><b>${esc(e.name)}</b><small>${esc(e.architect || '')}</small></div><span class="o-pct">${pct == null ? '—' : pct + '%'}</span></div>
      <div class="o-bar"><i style="width:${pct || 0}%"></i></div>
      <div class="o-env-body">${!st.length ? '<span class="muted">Sem etapas ainda</span>'
        : cur.length ? cur.map((s) => `<div>${statusChip(s)} <b>${esc(s.name)}</b></div>`).join('')
        : st.every((s) => s.status === 'done') ? '<div class="pos"><b>✅ Ambiente concluído</b></div>'
        : `<div class="muted">Próxima: <b>${esc((st.find((s) => s.status === 'todo') || {}).name || '')}</b>${(st.find((s) => s.status === 'todo') || {}).start_date ? ' · ' + shortD(st.find((s) => s.status === 'todo').start_date) : ''}</div>`}
        ${late.length ? `<div class="neg small">⚠️ ${late.length} etapa(s) atrasada(s)</div>` : ''}
        ${last ? `<div class="muted small">Última atualização: ${esc(last.author || '—')} · ${new Date(last.created_at).toLocaleString('pt-BR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' })}</div>` : ''}</div>
      <div class="row-actions"><button class="btn small primary" data-oedit="${e.id}">${st.length ? 'Etapas e datas' : 'Montar etapas'}</button><button class="btn small" data-oqr="${e.id}">🔳 QR</button></div>
    </div>`;
  }).join('')}</div>`;
}

function obraQrTab() {
  const envs = obraEnvs();
  if (!envs.length) return '<div class="card"><div class="empty">Cadastre os ambientes em <b>Portaria → Ambientes</b> primeiro.</div></div>';
  if (!envs[0].qr_token) return '<div class="card"><div class="empty">Rode o script <b>supabase-obra.sql</b> para gerar os QR Codes.</div></div>';
  return `<div class="card"><div class="card-head"><h2>🔳 QR Codes dos ambientes</h2><button class="btn primary" id="oPrintQr">🖨️ Imprimir todos</button></div>
    <p class="muted">Imprima e cole na entrada de cada ambiente. Quem estiver na obra aponta a câmera do celular, toca na etapa e diz como está — sem precisar de senha.
    Cada QR só atualiza o próprio ambiente.</p></div>
    <div class="o-qrs mt">${envs.map((e) => `<div class="card o-qr"><div class="o-qr-img" data-qrsvg="${e.id}"></div>
      <div><b>${e.number ? esc(e.number) + ' · ' : ''}${esc(e.name)}</b><small>${esc(e.architect || '')}</small></div>
      <div class="row-actions"><button class="btn small" data-oprint1="${e.id}">🖨️ Imprimir</button><button class="btn small" data-ocopy="${e.id}">Copiar link</button></div></div>`).join('')}</div>`;
}

function obraUpdatesTab() {
  const list = (state.obraUpdates || []).filter((u) => !oui.envF || String(u.env_id) === oui.envF);
  return `<div class="card filters"><select id="oEnvF"><option value="">Todos os ambientes</option>${obraEnvs().map((e) => `<option value="${e.id}" ${oui.envF === String(e.id) ? 'selected' : ''}>${esc(envLabel(e))}</option>`).join('')}</select></div>
  <div class="card">${list.length ? `<ul class="o-feed">${list.map(updateItem).join('')}</ul>` : '<div class="empty small">Nenhuma atualização ainda. Elas aparecem aqui quando alguém usa o QR Code do ambiente.</div>'}</div>`;
}

function updateItem(u) {
  const s = (state.obraStages || []).find((x) => x.id === u.stage_id); const e = gEnv(u.env_id);
  const st = STAGE_STATUS[u.status];
  return `<li class="o-upd"><div class="o-upd-top"><b>${esc(s?.name || 'Etapa')}</b> · ${esc(envLabel(e))}
      ${st ? `<span class="st-chip ${u.status}">${st.icon} ${st.label}${u.status === 'doing' && u.progress != null ? ' ' + u.progress + '%' : ''}</span>` : ''}</div>
    ${u.note ? `<div class="o-note">“${esc(u.note)}”</div>` : ''}
    ${(u.photos || []).length ? `<div class="o-photos">${u.photos.map((p) => `<button type="button" class="o-ph" data-ophoto="${esc(p.path)}"><img alt="foto" data-obraphoto="${esc(p.path)}"></button>`).join('')}</div>` : ''}
    <div class="muted small">${esc(u.author || '—')} · ${new Date(u.created_at).toLocaleString('pt-BR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' })}${u.via !== 'app' ? ' · pelo QR' : ''}
      ${isAdmin() ? ` · <button type="button" class="link-btn" data-odelupd="${u.id}">apagar</button>` : ''}</div></li>`;
}

/* ---------- Fotos (URLs assinadas, guardadas por alguns minutos) ---------- */
const photoUrlCache = {};
async function fillObraPhotos(root) {
  for (const img of $$('[data-obraphoto]', root)) {
    const p = img.dataset.obraphoto;
    try {
      if (!photoUrlCache[p] || photoUrlCache[p].t < Date.now() - 40 * 60000) photoUrlCache[p] = { u: await api.signedUrl(p, 'obra'), t: Date.now() };
      img.src = photoUrlCache[p].u;
    } catch { img.alt = 'foto indisponível'; }
  }
}

/* ---------- Etapas de um ambiente (editar datas e situação) ---------- */
function openEnvStages(env, draft) {
  const existing = stagesOf(env.id);
  const rows = draft || existing.map((s) => ({ ...s }));
  const ups = (state.obraUpdates || []).filter((u) => String(u.env_id) === String(env.id)).slice(0, 8);
  const others = obraEnvs().filter((e) => String(e.id) !== String(env.id) && stagesOf(e.id).length);
  openModal(`
    <h2>🏠 ${esc(envLabel(env))}</h2>
    <p class="muted" style="margin-top:-6px">Etapas, datas previstas e situação. ${rows.length ? '' : 'Use as etapas padrão ou copie de outro ambiente.'}</p>
    ${!rows.length ? `<div class="row-actions" style="margin-bottom:10px"><button type="button" class="btn primary" id="oTpl1">🧩 Etapas padrão</button>${others.length ? `<select id="oCopyFrom"><option value="">Copiar de outro ambiente…</option>${others.map((e) => `<option value="${e.id}">${esc(envLabel(e))}</option>`).join('')}</select>` : ''}</div>` : ''}
    <div class="o-edit">${rows.map((s, i) => `<div class="o-edit-row" data-i="${i}">
      <input name="n${i}" value="${esc(s.name)}" placeholder="Etapa" required>
      <label><span>Início</span><input type="date" name="s${i}" value="${s.start_date || ''}"></label>
      <label><span>Fim</span><input type="date" name="e${i}" value="${s.end_date || ''}"></label>
      <select name="t${i}">${Object.entries(STAGE_STATUS).map(([k, v]) => `<option value="${k}" ${s.status === k ? 'selected' : ''}>${v.icon} ${v.label}</option>`).join('')}</select>
      <label class="o-pc"><input type="number" name="p${i}" min="0" max="100" step="5" value="${stagePct(s)}"><span>%</span></label>
      <button type="button" class="btn small" data-odel="${i}" title="Remover">✕</button></div>`).join('')}</div>
    <button type="button" class="btn small" id="oAddStage">+ Etapa</button>
    ${ups.length ? `<h3 class="sub-h">Últimas atualizações</h3><ul class="o-feed small">${ups.map(updateItem).join('')}</ul>` : ''}
    <div class="modal-actions"><button type="button" class="btn" data-oqr="${env.id}">🔳 QR</button><span class="spacer"></span><button class="btn" value="cancel" formnovalidate>Cancelar</button><button class="btn primary" value="save">Salvar</button></div>`,
  async (action, fd) => {
    const now = readRows(fd, rows);
    for (const r of now) if (r.start_date && r.end_date && r.end_date < r.start_date) { toast(`"${r.name}": o fim é antes do início`); return false; }
    const keep = new Set(now.filter((r) => r.id).map((r) => r.id));
    const removed = existing.filter((s) => !keep.has(s.id));
    if (removed.length && !confirm(`Remover ${removed.length} etapa(s) e o histórico delas?`)) return false;
    for (const s of removed) await api.remove('obra_stages', `id=eq.${s.id}`);
    const inserts = [];
    for (const [i, r] of now.entries()) {
      const data = { name: r.name, start_date: r.start_date || null, end_date: r.end_date || null, status: r.status, progress: r.status === 'done' ? 100 : r.status === 'todo' ? 0 : r.progress, sort: i + 1 };
      const old = existing.find((s) => s.id === r.id);
      if (!old) inserts.push({ ...data, env_id: env.id, updated_by: state.me.name });
      else if (['name', 'start_date', 'end_date', 'status', 'progress', 'sort'].some((k) => String(old[k] ?? '') !== String(data[k] ?? ''))) {
        await api.update('obra_stages', `id=eq.${r.id}`, { ...data, updated_at: new Date().toISOString(), updated_by: state.me.name });
        if (old.status !== data.status || Number(old.progress) !== Number(data.progress)) {
          await api.insert('obra_updates', { env_id: env.id, stage_id: r.id, author: state.me.name, status: data.status, progress: data.progress, note: '', via: 'app' });
        }
      }
    }
    if (inserts.length) await api.insert('obra_stages', inserts);
    toast('Cronograma salvo ✅'); await reloadObra();
  }, () => {
    const keepDraft = () => readRows(new FormData(modalForm), rows);
    $('#oAddStage').addEventListener('click', () => openEnvStages(env, [...keepDraft(), { name: '', start_date: '', end_date: '', status: 'todo', progress: 0 }]));
    $$('[data-odel]', modalForm).forEach((b) => b.addEventListener('click', () => { const d = keepDraft(); d.splice(Number(b.dataset.odel), 1); openEnvStages(env, d); }));
    $('#oTpl1')?.addEventListener('click', () => openStageTemplate([env]));
    $('#oCopyFrom')?.addEventListener('change', (e) => { if (e.target.value) openEnvStages(env, stagesOf(e.target.value).map((s) => ({ name: s.name, start_date: s.start_date, end_date: s.end_date, status: 'todo', progress: 0 }))); });
    $$('[data-oqr]', modalForm).forEach((b) => b.addEventListener('click', () => showEnvQr(env)));
    fillObraPhotos(modalForm);
  });
}
function readRows(fd, rows) {
  return rows.map((r, i) => ({ id: r.id, name: String(fd.get('n' + i) || '').trim(), start_date: fd.get('s' + i) || '', end_date: fd.get('e' + i) || '', status: fd.get('t' + i) || 'todo', progress: Math.max(0, Math.min(100, Number(fd.get('p' + i)) || 0)) }))
    .filter((r) => r.name);
}

/** Etapas padrão: escolhe as etapas e distribui as datas entre o início da obra e a entrega. */
function openStageTemplate(envs) {
  const start = todayISO();
  openModal(`
    <h2>🧩 Montar etapas</h2>
    <p class="muted" style="margin-top:-6px">${envs.length === 1 ? esc(envLabel(envs[0])) : `${envs.length} ambientes sem cronograma`} · desmarque o que não se aplica. Dá para ajustar as datas depois.</p>
    <div class="o-tpl">${STAGE_TEMPLATES.map((n, i) => `<label class="check"><input type="checkbox" name="tpl" value="${i}" ${['Demolição / retirada', 'Serralheria / vidros'].includes(n) ? '' : 'checked'}><span>${esc(n)}</span></label>`).join('')}</div>
    <div class="form-grid">
      <label class="field"><span>Início da obra</span><input type="date" name="from" value="${start}" required></label>
      <label class="field"><span>Entrega dos ambientes</span><input type="date" name="to" value="${addDaysISO(start, 45)}" required></label>
    </div>
    <p class="muted small">As etapas são distribuídas em sequência nesse período (cada uma começa quando a anterior está na metade).</p>
    <div class="modal-actions"><span class="spacer"></span><button class="btn" value="cancel" formnovalidate>Cancelar</button><button class="btn primary" value="save">Criar etapas</button></div>`,
  async (action, fd) => {
    const names = fd.getAll('tpl').map((i) => STAGE_TEMPLATES[Number(i)]);
    const from = fd.get('from'), to = fd.get('to');
    if (!names.length) { toast('Marque pelo menos uma etapa'); return false; }
    if (to <= from) { toast('A entrega precisa ser depois do início'); return false; }
    const total = dateDiffDays(from, to) + 1; const n = names.length;
    const len = Math.max(1, Math.round((total * 2) / (n + 1))); // com sobreposição de meia etapa
    const rows = [];
    for (const env of envs) names.forEach((name, i) => {
      const s = addDaysISO(from, Math.round((i * len) / 2)); let e = addDaysISO(s, len - 1); if (e > to) e = to;
      rows.push({ env_id: env.id, name, sort: i + 1, start_date: s < to ? s : to, end_date: e, status: 'todo', progress: 0, updated_by: state.me.name });
    });
    await api.insert('obra_stages', rows);
    toast(`${rows.length} etapa(s) criadas ✅`); await reloadObra();
  });
}

function openMilestone(m) {
  openModal(`<h2>🚩 ${m ? 'Marco da obra' : 'Novo marco'}</h2>
    <div class="form-grid one">
      <label class="field"><span>O quê</span><input name="name" value="${esc(m?.name || '')}" placeholder="Ex.: Entrega aos arquitetos, Abertura do evento" required></label>
      <label class="field"><span>Data</span><input type="date" name="date" value="${m?.start_date || ''}" required></label>
      ${m ? `<label class="check"><input type="checkbox" name="done" ${m.status === 'done' ? 'checked' : ''}><span>Já aconteceu / concluído</span></label>` : ''}
    </div>
    <div class="modal-actions">${m ? '<button class="btn danger" value="delete" formnovalidate>Excluir</button>' : ''}<span class="spacer"></span><button class="btn" value="cancel" formnovalidate>Cancelar</button><button class="btn primary" value="save">Salvar</button></div>`,
  async (action, fd) => {
    if (action === 'delete') { await api.remove('obra_stages', `id=eq.${m.id}`); toast('Marco excluído'); return reloadObra(); }
    const data = { name: fd.get('name').trim(), start_date: fd.get('date'), end_date: fd.get('date'), status: fd.get('done') === 'on' ? 'done' : 'todo', progress: fd.get('done') === 'on' ? 100 : 0, updated_by: state.me.name };
    if (m) await api.update('obra_stages', `id=eq.${m.id}`, data); else await api.insert('obra_stages', { ...data, env_id: null });
    toast('Marco salvo ✅'); await reloadObra();
  });
}

/* ---------- QR Codes ---------- */
let qrReady = null;
const loadQrLib = () => (qrReady ||= loadScriptOnce(QR_LIB).catch((e) => { qrReady = null; throw e; }));
function qrSvg(text) {
  const q = qrcode(0, 'M'); q.addData(text); q.make();
  return q.createSvgTag(4, 0).replace(/width="\d+px" height="\d+px"/, 'width="100%" height="100%"');
}
async function fillQrCodes(root) {
  const boxes = $$('[data-qrsvg]', root); if (!boxes.length) return;
  try { await loadQrLib(); } catch (e) { boxes.forEach((b) => { b.textContent = 'Sem internet para gerar o QR'; }); return; }
  boxes.forEach((b) => { const env = gEnv(b.dataset.qrsvg); if (env?.qr_token) b.innerHTML = qrSvg(qrUrl(env)); });
}
function showEnvQr(env) {
  openModal(`<h2>🔳 ${esc(envLabel(env))}</h2>
    <div class="o-qr-big" data-qrsvg="${env.id}"></div>
    <p class="muted small" style="text-align:center">Aponte a câmera do celular para atualizar este ambiente.</p>
    <div class="modal-actions"><button type="button" class="btn" id="oCopy1">Copiar link</button><span class="spacer"></span><button type="button" class="btn" id="oPrint1">🖨️ Imprimir</button><button class="btn primary" value="cancel" formnovalidate>Fechar</button></div>`, () => {}, () => {
    fillQrCodes(modalForm);
    $('#oCopy1').addEventListener('click', () => copyText(qrUrl(env)));
    $('#oPrint1').addEventListener('click', () => printQrSheet([env]));
  });
}
async function printQrSheet(envs) {
  try { await loadQrLib(); } catch (e) { toast(e.message); return; }
  let area = $('#printArea');
  if (!area) { area = document.createElement('div'); area.id = 'printArea'; document.body.appendChild(area); }
  area.innerHTML = `<div class="qr-sheet">${envs.map((e) => `<div class="qr-card">
    <div class="qr-brand"><img src="icons/casacor.png" alt="CASACOR"><b>${esc(unitName())}</b></div>
    <div class="qr-num">${esc(e.number || '')}</div><div class="qr-name">${esc(e.name)}</div><div class="qr-arch">${esc(e.architect || '')}</div>
    <div class="qr-code">${qrSvg(qrUrl(e))}</div>
    <div class="qr-help">📱 Aponte a câmera do celular<br>para atualizar a obra deste ambiente</div></div>`).join('')}</div>`;
  const done = () => { document.body.classList.remove('printing'); area.innerHTML = ''; };
  document.body.classList.add('printing');
  window.addEventListener('afterprint', done, { once: true });
  setTimeout(() => { window.print(); setTimeout(() => { if (!window.matchMedia('print').matches) done(); }, 1500); }, 300);
}

/* ---------- Eventos ---------- */
function bindObra(v) {
  $$('[data-otab]', v).forEach((b) => b.addEventListener('click', () => { oui.tab = b.dataset.otab; render(); }));
  $$('[data-oexp]', v).forEach((el) => el.addEventListener('click', () => { oui.open[el.dataset.oexp] = !oui.open[el.dataset.oexp]; render(); }));
  $('#oExpand', v)?.addEventListener('click', () => { const any = Object.values(oui.open).some(Boolean); oui.open = {}; if (!any) obraEnvs().forEach((e) => { oui.open[e.id] = true; }); render(); });
  $$('[data-oenv]', v).forEach((el) => el.addEventListener('click', () => { const e = gEnv(el.dataset.oenv); if (e) openEnvStages(e); }));
  $$('[data-oedit]', v).forEach((el) => el.addEventListener('click', (ev) => { ev.stopPropagation(); const e = gEnv(el.dataset.oedit); if (e) openEnvStages(e); }));
  $$('[data-oqr]', v).forEach((el) => el.addEventListener('click', (ev) => { ev.stopPropagation(); const e = gEnv(el.dataset.oqr); if (e) showEnvQr(e); }));
  $('#oTplAll', v)?.addEventListener('click', () => openStageTemplate(obraEnvs().filter((e) => !stagesOf(e.id).length)));
  $('#oNewMs', v)?.addEventListener('click', () => openMilestone());
  $$('[data-ms]', v).forEach((el) => el.addEventListener('click', () => openMilestone((state.obraStages || []).find((s) => s.id === el.dataset.ms))));
  $('#oPrintQr', v)?.addEventListener('click', () => printQrSheet(obraEnvs()));
  $$('[data-oprint1]', v).forEach((b) => b.addEventListener('click', () => printQrSheet([gEnv(b.dataset.oprint1)])));
  $$('[data-ocopy]', v).forEach((b) => b.addEventListener('click', () => copyText(qrUrl(gEnv(b.dataset.ocopy)))));
  $('#oEnvF', v)?.addEventListener('change', (e) => { oui.envF = e.target.value; render(); });
  $$('[data-odelupd]', v).forEach((b) => b.addEventListener('click', async () => {
    if (!confirm('Apagar esta atualização? (a situação da etapa não muda)')) return;
    try { await api.remove('obra_updates', `id=eq.${b.dataset.odelupd}`); toast('Apagada'); await reloadObra(); } catch (e) { toast(e.message); }
  }));
  $$('[data-ophoto]', v).forEach((b) => b.addEventListener('click', () => { const u = photoUrlCache[b.dataset.ophoto]?.u; if (u) window.open(u, '_blank', 'noopener'); }));
  fillObraPhotos(v); fillQrCodes(v);
}

/* =========================================================
   Página do QR Code (sem login): quem está na obra atualiza o ambiente
   ========================================================= */
const OP_NAME_KEY = 'casacor:obra:nome';
async function obraPublicPage(token, msg = '') {
  $('#app').hidden = true; $('#fab').hidden = true;
  const g = $('#gate'); g.hidden = false; g.classList.add('op-gate');
  g.innerHTML = '<div class="op"><div class="empty">Carregando…</div></div>';
  let info;
  try { info = await api.publicRpc('obra_info', { p_token: token }); }
  catch (e) { g.innerHTML = `<div class="op"><div class="card"><h2>QR Code</h2><p>${esc(e.message)}</p><a class="btn" href="./">Abrir o sistema</a></div></div>`; return; }
  let name = ''; try { name = localStorage.getItem(OP_NAME_KEY) || ''; } catch { /* ignora */ }
  const env = info.env; const stages = info.stages || [];
  const today = todayISO();
  g.innerHTML = `<div class="op">
    <div class="op-head"><span class="cc-logo big"><img src="icons/casacor.png" alt="CASACOR" class="cc-word"><b>${esc(info.unit || '')}</b></span>
      <div class="op-env">${env.number ? `<b class="g-num">${esc(env.number)}</b>` : ''}<div><b>${esc(env.name)}</b><small>${esc(env.architect || '')}</small></div></div></div>
    ${msg ? `<div class="op-ok">${esc(msg)}</div>` : ''}
    <label class="field"><span>Seu nome</span><input id="opName" class="g-input" value="${esc(name)}" placeholder="Ex.: José — mestre de obras" autocomplete="name" autocapitalize="words"></label>
    <h3 class="g-h">Toque na etapa para dizer como está</h3>
    ${stages.length ? `<ul class="op-stages">${stages.map((s) => {
      const late = s.status !== 'done' && s.end_date && s.end_date < today;
      return `<li><button type="button" class="op-stage ${late ? 'late' : s.status}" data-opst="${s.id}">
        <span class="op-st-name">${esc(s.name)}</span>
        <span class="st-chip ${late ? 'late' : s.status}">${STAGE_STATUS[s.status].icon} ${late ? 'Atrasada' : STAGE_STATUS[s.status].label}</span>
        <span class="o-bar"><i style="width:${s.status === 'done' ? 100 : s.progress}%"></i></span>
        <span class="muted small">${s.start_date ? `Previsto ${shortD(s.start_date)} a ${shortD(s.end_date || s.start_date)}` : 'Sem data prevista'}${s.updated_by ? ` · último: ${esc(s.updated_by)}` : ''}</span></button></li>`;
    }).join('')}</ul>` : '<div class="card"><div class="empty small">O cronograma deste ambiente ainda não foi montado. Avise a administração da obra.</div></div>'}
    ${(info.recent || []).length ? `<h3 class="g-h">Últimas atualizações</h3><ul class="op-recent">${info.recent.map((u) => `<li><b>${esc(u.stage || '')}</b> · ${STAGE_STATUS[u.status]?.icon || ''} ${esc(STAGE_STATUS[u.status]?.label || '')}${u.status === 'doing' && u.progress != null ? ' ' + u.progress + '%' : ''}${u.note ? ` — “${esc(u.note)}”` : ''}<small>${esc(u.author)} · ${new Date(u.created_at).toLocaleString('pt-BR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' })}</small></li>`).join('')}</ul>` : ''}
    <p class="op-foot"><a href="./" class="link-btn">Sou da equipe: abrir o sistema</a></p>
  </div>`;
  $$('[data-opst]', g).forEach((b) => b.addEventListener('click', () => {
    const nm = $('#opName').value.trim();
    if (nm.length < 2) { toast('Escreva seu nome primeiro'); $('#opName').focus(); return; }
    try { localStorage.setItem(OP_NAME_KEY, nm); } catch { /* ignora */ }
    openPublicStage(token, stages.find((s) => s.id === b.dataset.opst), nm);
  }));
}

function openPublicStage(token, s, author) {
  let choice = null;
  openModal(`<div class="g-modal"><h2>${esc(s.name)}</h2>
    <p class="muted" style="margin-top:-6px">Agora: ${STAGE_STATUS[s.status].icon} ${STAGE_STATUS[s.status].label}${s.status === 'doing' ? ` (${s.progress}%)` : ''}</p>
    <div class="op-choices">${QR_CHOICES.map(([st, pc, ic, lb], i) => `<button type="button" class="op-choice ${st}" data-opc="${i}"><span>${ic}</span>${lb}</button>`).join('')}</div>
    <label class="field"><span>Observação (opcional)</span><textarea name="note" rows="2" maxlength="600" placeholder="Ex.: falta material, terminamos a primeira demão…"></textarea></label>
    <label class="field"><span>📷 Foto (opcional, até 3)</span><input type="file" name="photos" accept="image/*" multiple></label>
    <p id="opErr" class="g-err"></p>
    <div class="modal-actions"><button class="btn big" value="cancel" formnovalidate>Cancelar</button><button class="btn primary big" value="save">Enviar</button></div></div>`,
  async (action, fd) => {
    const err = (m) => { $('#opErr').textContent = m; return false; };
    if (choice == null) return err('Toque em como está a etapa.');
    const [st, pc] = QR_CHOICES[choice];
    const note = String(fd.get('note') || '').trim();
    if (st === 'blocked' && !note) return err('Conte na observação o que está parado.');
    const files = [...($('[name=photos]', modalForm).files || [])].slice(0, 3);
    const paths = []; let photoFail = false;
    for (const [i, f] of files.entries()) {
      try {
        const small = await prepareFile(f);
        const path = `${token}/${Date.now()}-${i}-${Math.random().toString(36).slice(2, 7)}.jpg`;
        await api.publicUpload(path, small, 'obra'); paths.push(path);
      } catch { photoFail = true; }
    }
    const progress = st === 'doing' ? Math.max(Number(s.progress) || 0, pc) : pc;
    await api.publicRpc('obra_post', { p_token: token, p_stage: s.id, p_status: st, p_progress: progress, p_note: note, p_author: author, p_photos: paths });
    setTimeout(() => obraPublicPage(token, `✅ Obrigado, ${author.split(' ')[0]}! "${s.name}" atualizada${photoFail ? ' (a foto não foi enviada)' : ''}.`), 0);
  }, () => {
    $$('[data-opc]', modalForm).forEach((b) => b.addEventListener('click', () => {
      choice = Number(b.dataset.opc);
      $('#opErr').textContent = '';
      $$('[data-opc]', modalForm).forEach((x) => x.classList.toggle('sel', x === b));
    }));
  });
}
