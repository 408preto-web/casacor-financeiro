'use strict';

/* =========================================================
   Estoque (por franquia): cabos, cimento, areia…
   - Levantamento (contagem) define o saldo; entradas somam; saídas subtraem.
   - Compra lançada com itens entra sozinha quando a conta é paga (gatilho no banco).
   - Só quantidades (sem valores): compradores também usam.
   Usa as funções e o estado globais de app.js.
   ========================================================= */

const STOCK_MEASURES = ['m', 'unidade', 'peça', 'saco', 'm³', 'kg', 'litro', 'rolo', 'caixa', 'barra', 'galão', 'lata', 'par', 'metro²'];
const STOCK_GROUPS = ['Elétrica', 'Iluminação', 'Hidráulica', 'Construção', 'Pintura', 'Marcenaria', 'Ferramentas', 'EPI', 'Limpeza', 'Escritório', 'Outros'];
const sui = { q: '', grp: '' };

const canStock = () => ['member', 'payer', 'admin'].includes(state.me?.role);
const stockOn = () => Array.isArray(state.stockItems);
const sItem = (id) => (state.stockItems || []).find((i) => i.id === id);
const qtyFmt = (v) => (v == null ? '—' : Number(v).toLocaleString('pt-BR', { maximumFractionDigits: 3 }));
const findItemByName = (name) => (state.stockItems || []).find((i) => i.name.trim().toLowerCase() === String(name).trim().toLowerCase());
/** Grupo provável pelo nome do material (senão, pela área da compra). */
function guessGroup(name, areaName = '') {
  const n = normR(name);
  const rules = [['Elétrica', /cabo|fio|disjunt|tomada|interrupt|quadro|eletrod|conduite|terminal|fita isolante|extens|plug|rele/], ['Iluminação', /lampad|refletor|spot|luminar|led|fita de led|trilho/],
    ['Hidráulica', /cano|tubo|joelho|registro|pvc|torneira|sifao|ralo|conexao|caixa d.agua/], ['Construção', /cimento|areia|brita|argamassa|tijolo|bloco|cal |cal$|reboco|concreto|ferro|vergalh|telha|gesso|drywall|massa/],
    ['Pintura', /tinta|selador|lixa|rolo|pincel|fundo prep|verniz|solvente|thinner/], ['Marcenaria', /mdf|madeira|compensado|cola|parafuso|dobradica|corredica/], ['EPI', /luva|capacete|oculos|bota|protetor|mascara|cinto/]];
  for (const [g, re] of rules) if (re.test(n)) return g;
  return /el[eé]tric|ilumina/i.test(areaName) ? 'Elétrica' : /obra/i.test(areaName) ? 'Construção' : 'Outros';
}
const stockGroups = () => [...new Set([...STOCK_GROUPS, ...(state.stockItems || []).map((i) => i.grp).filter(Boolean)])];

async function loadStock() {
  if (!canStock()) { state.stockItems = null; state.stockMoves = []; return; }
  try {
    const [items, moves] = await Promise.all([api.select('stock_items', 'select=*&order=grp,name'), api.select('stock_moves', 'select=*&order=date,created_at')]);
    Object.assign(state, { stockItems: items, stockMoves: moves });
  } catch (e) {
    if (/não foi configurado/.test(e.message)) { state.stockItems = null; state.stockMoves = []; } else throw e;
  }
}

/** Saldo: a contagem define o valor; depois disso, entradas somam e saídas subtraem. */
function stockBalances() {
  const bal = {}; const last = {};
  for (const m of state.stockMoves || []) {
    const q = Number(m.qty) || 0;
    if (m.kind === 'count') bal[m.item_id] = q; else bal[m.item_id] = (bal[m.item_id] || 0) + (m.kind === 'in' ? q : -q);
    last[m.item_id] = m;
  }
  return { bal, last };
}
/** "A chegar": itens de compras lançadas que ainda não foram pagas. */
function stockIncoming() {
  const inc = {};
  for (const b of state.bills || []) {
    if (b.status !== 'pending' || b.approval === 'requested' || b.approval === 'rejected' || !Array.isArray(b.items)) continue;
    for (const x of b.items) if (x.item_id && Number(x.qty) > 0) (inc[x.item_id] ||= []).push({ qty: Number(x.qty), bill: b });
  }
  return inc;
}

/* ---------- Tela ---------- */
function renderEstoque() {
  if (!stockOn()) {
    return `<div class="card"><div class="empty"><div style="font-size:44px">📦</div><p>O estoque ainda não foi ativado no banco de dados.<br>Rode o script <b>supabase-estoque.sql</b> no SQL Editor do Supabase.</p></div></div>`;
  }
  const { bal, last } = stockBalances(); const inc = stockIncoming();
  const q = normR(sui.q);
  const items = state.stockItems.filter((i) => i.active && (!sui.grp || i.grp === sui.grp) && (!q || normR(`${i.name} ${i.grp}`).includes(q)));
  const low = state.stockItems.filter((i) => i.active && i.min_qty != null && (bal[i.id] || 0) < Number(i.min_qty));
  const groups = [...new Set(state.stockItems.filter((i) => i.active).map((i) => i.grp))].sort();
  const byGrp = {}; items.forEach((i) => (byGrp[i.grp] ||= []).push(i));
  return `
  <div class="card"><div class="row-actions st-actions">
      <button class="btn primary" id="stCount">📋 Levantamento / contagem</button>
      <button class="btn" id="stOut">➖ Dar saída</button>
      <button class="btn" id="stIn">➕ Entrada</button>
      <button class="btn" id="stNew">+ Item</button>
      <button class="btn" id="stXls">📊 Planilha</button></div>
    <div class="filters" style="margin-top:10px"><input id="stQ" placeholder="Procurar item (ex.: cabo, cimento)" value="${esc(sui.q)}" autocomplete="off">
      <select id="stGrp"><option value="">Todos os grupos</option>${groups.map((g) => `<option ${sui.grp === g ? 'selected' : ''}>${esc(g)}</option>`).join('')}</select></div>
    <p class="muted small" style="margin:0">Compra lançada com itens entra aqui sozinha quando a conta é paga. Enquanto não paga, aparece como <b>a chegar</b>.</p></div>
  ${low.length ? `<div class="alerts mt"><div class="alert danger"><span class="alert-icon">📉</span><div class="alert-text"><b>Estoque baixo:</b> ${low.map((i) => `${esc(i.name)} (${qtyFmt(bal[i.id] || 0)} ${esc(i.measure)})`).join(', ')}</div></div></div>` : ''}
  ${!state.stockItems.length ? `<div class="card mt"><div class="empty"><p>Nenhum item ainda.</p><p class="muted">Comece pelo <b>📋 Levantamento</b>: escreva cada material e a quantidade contada (ex.: Cabo 2 mm — 1.000 m).</p></div></div>` : ''}
  ${Object.entries(byGrp).sort(([a], [b]) => a.localeCompare(b)).map(([g, list]) => `<div class="card mt"><h2>${esc(g)}</h2><ul class="tx-list">${list.map((i) => {
    const b = bal[i.id] || 0; const arr = (inc[i.id] || []).reduce((s, x) => s + x.qty, 0); const lw = i.min_qty != null && b < Number(i.min_qty);
    return `<li class="tx st-row" data-stitem="${i.id}"><div class="tx-icon">📦</div><div class="tx-main"><div class="tx-title">${esc(i.name)}${lw ? ' <span class="badge late">baixo</span>' : ''}</div>
      <div class="tx-meta">${last[i.id] ? `última movimentação ${fmtDate(last[i.id].date)}` : 'sem movimentação'}${arr ? ` · <b class="pos">+${qtyFmt(arr)} ${esc(i.measure)} a chegar</b>` : ''}</div></div>
      <div class="tx-amount st-bal ${b < 0 ? 'neg' : ''}">${qtyFmt(b)}<small>${esc(i.measure)}</small></div></li>`;
  }).join('')}</ul></div>`).join('')}`;
}

/* ---------- Item: histórico e edição ---------- */
function openStockItem(item) {
  const { bal } = stockBalances(); const moves = (state.stockMoves || []).filter((m) => m.item_id === item.id).slice().reverse();
  const inc = stockIncoming()[item.id] || [];
  const lbl = { in: '➕ Entrada', out: '➖ Saída', count: '📋 Contagem' };
  openModal(`<h2>📦 ${esc(item.name)}</h2><p class="muted" style="margin-top:-6px">${esc(item.grp)} · saldo <b>${qtyFmt(bal[item.id] || 0)} ${esc(item.measure)}</b>${item.min_qty != null ? ` · mínimo ${qtyFmt(item.min_qty)}` : ''}</p>
    <div class="row-actions"><button type="button" class="btn small" data-stq="in">➕ Entrada</button><button type="button" class="btn small" data-stq="out">➖ Saída</button><button type="button" class="btn small" data-stq="count">📋 Contagem</button><button type="button" class="btn small" id="stEdit">Editar item</button></div>
    ${inc.length ? `<h3 class="sub-h">A chegar (compras ainda não pagas)</h3><ul class="tx-list">${inc.map((x) => `<li class="tx"><div class="tx-main"><div class="tx-title">+${qtyFmt(x.qty)} ${esc(item.measure)}</div><div class="tx-meta">${esc(x.bill.supplier)} · lançada por ${esc(memberName(x.bill.created_by))}</div></div></li>`).join('')}</ul>` : ''}
    <h3 class="sub-h">Movimentações</h3>
    ${moves.length ? `<ul class="tx-list">${moves.map((m) => `<li class="tx"><div class="tx-main"><div class="tx-title">${lbl[m.kind]} ${m.kind === 'count' ? '= ' : m.kind === 'in' ? '+' : '−'}${qtyFmt(m.qty)} ${esc(item.measure)}</div>
      <div class="tx-meta">${fmtDate(m.date)} · ${esc(memberName(m.created_by))}${m.dest ? ' · para ' + esc(m.dest) : ''}${m.note ? ' · ' + esc(m.note) : ''}${m.bill_id ? ' · 🧾 compra paga' : ''}</div></div>
      ${!m.bill_id && (isAdmin() || m.created_by === state.me.user_id) ? `<button type="button" class="btn small" data-stdel="${m.id}">Apagar</button>` : ''}</li>`).join('')}</ul>` : '<p class="muted">Nenhuma movimentação.</p>'}
    <div class="modal-actions"><span class="spacer"></span><button class="btn" value="cancel" formnovalidate>Fechar</button></div>`, () => {}, () => {
    $$('[data-stq]', modalForm).forEach((b) => b.addEventListener('click', () => openStockMove(b.dataset.stq, item)));
    $('#stEdit').addEventListener('click', () => openStockItemForm(item));
    $$('[data-stdel]', modalForm).forEach((b) => b.addEventListener('click', async () => {
      if (!confirm('Apagar esta movimentação? O saldo é recalculado.')) return;
      try { await api.remove('stock_moves', `id=eq.${b.dataset.stdel}`); await loadStock(); saveCache(); openStockItem(item); render(); } catch (e) { toast(e.message); }
    }));
  });
}

function openStockItemForm(item) {
  const x = item || { name: '', measure: 'unidade', grp: 'Elétrica', min_qty: null, notes: '' };
  openModal(`<h2>${item ? 'Editar item' : 'Novo item'}</h2>
    <div class="form-grid">
      <label class="field full"><span>Nome *</span><input name="name" value="${esc(x.name)}" required placeholder="Ex.: Cabo flexível 2,5 mm"></label>
      <label class="field"><span>Medida</span><select name="measure">${[...new Set([...STOCK_MEASURES, x.measure])].map((m) => `<option ${m === x.measure ? 'selected' : ''}>${esc(m)}</option>`).join('')}</select></label>
      <label class="field"><span>Grupo</span><input name="grp" value="${esc(x.grp)}" list="stGroups"><datalist id="stGroups">${stockGroups().map((g) => `<option value="${esc(g)}">`).join('')}</datalist></label>
      <label class="field"><span>Avisar quando ficar abaixo de</span><input name="min_qty" inputmode="decimal" value="${x.min_qty ?? ''}" placeholder="opcional"></label>
      <label class="field full"><span>Observação</span><input name="notes" value="${esc(x.notes)}"></label>
    </div>
    <div class="modal-actions">${item && isAdmin() ? '<button class="btn danger" value="delete" formnovalidate>Excluir</button>' : ''}<span class="spacer"></span><button class="btn" value="cancel" formnovalidate>Cancelar</button><button class="btn primary" value="save">Salvar</button></div>`,
  async (action, fd) => {
    if (action === 'delete') {
      if (!confirm(`Excluir "${item.name}" e todo o histórico dele?`)) return false;
      await api.remove('stock_items', `id=eq.${item.id}`); toast('Item excluído'); await loadStock(); saveCache(); render(); return;
    }
    const name = fd.get('name').trim(); const other = findItemByName(name);
    if (other && other.id !== item?.id) { toast(`Já existe "${other.name}"`); return false; }
    const mq = parseQty(fd.get('min_qty'));
    const data = { name, measure: fd.get('measure'), grp: fd.get('grp').trim() || 'Outros', min_qty: mq >= 0 ? mq : null, notes: fd.get('notes').trim() };
    if (item) await api.update('stock_items', `id=eq.${item.id}`, data); else await api.insert('stock_items', data);
    toast('Item salvo ✅'); await loadStock(); saveCache(); render();
  });
}
const parseQty = (s) => { const v = parseMoney(s) / 100; return String(s ?? '').trim() === '' ? NaN : v; };

/* ---------- Entrada / saída / contagem de um item ---------- */
function openStockMove(kind, item) {
  const { bal } = stockBalances();
  const items = state.stockItems.filter((i) => i.active);
  const t = { in: ['➕ Entrada', 'Quantidade que entrou'], out: ['➖ Saída', 'Quantidade que saiu'], count: ['📋 Contagem', 'Quantidade contada agora'] }[kind];
  const dests = [...new Set([...(state.gateEnvs || []).filter((e) => e.active).map((e) => envLabel(e)), ...(state.stockMoves || []).map((m) => m.dest).filter(Boolean)])].slice(0, 60);
  openModal(`<h2>${t[0]}</h2>
    <div class="form-grid">
      <label class="field full"><span>Item *</span><select name="item_id" required>${items.map((i) => `<option value="${i.id}" ${item?.id === i.id ? 'selected' : ''}>${esc(i.name)} — saldo ${qtyFmt(bal[i.id] || 0)} ${esc(i.measure)}</option>`).join('')}</select></label>
      <label class="field"><span>${t[1]} *</span><input name="qty" inputmode="decimal" required autocomplete="off"></label>
      <label class="field"><span>Data</span><input type="date" name="date" value="${todayISO()}"></label>
      ${kind === 'out' ? `<label class="field full"><span>Para onde foi (ambiente, obra, evento)</span><input name="dest" list="stDests" placeholder="Ex.: 12 · Cozinha gourmet"><datalist id="stDests">${dests.map((d) => `<option value="${esc(d)}">`).join('')}</datalist></label>` : ''}
      <label class="field full"><span>Observação</span><input name="note" placeholder="${kind === 'in' ? 'Ex.: doação, devolução, sobra de outro evento' : ''}"></label>
    </div>
    <p id="stMoveHint" class="muted small"></p>
    <div class="modal-actions"><span class="spacer"></span><button class="btn" value="cancel" formnovalidate>Cancelar</button><button class="btn primary" value="save">Salvar</button></div>`,
  async (action, fd) => {
    const it = sItem(fd.get('item_id')); const q = parseQty(fd.get('qty'));
    if (!it || !(q >= 0) || (kind !== 'count' && q === 0)) { toast('Informe a quantidade'); return false; }
    if (kind === 'out' && q > (bal[it.id] || 0) && !confirm(`O saldo de ${it.name} é ${qtyFmt(bal[it.id] || 0)} ${it.measure}. Registrar a saída de ${qtyFmt(q)} assim mesmo?`)) return false;
    await api.insert('stock_moves', { item_id: it.id, kind, qty: q, date: fd.get('date') || todayISO(), dest: kind === 'out' ? (fd.get('dest') || '').trim() : '', note: (fd.get('note') || '').trim() });
    await loadStock(); saveCache();
    const nb = stockBalances().bal[it.id] || 0;
    toast(`${t[0]} registrada · saldo ${qtyFmt(nb)} ${it.measure}`); render();
  }, () => {
    const hint = () => { const it = sItem($('[name=item_id]').value); const q = parseQty($('[name=qty]').value); const b = bal[it?.id] || 0;
      $('#stMoveHint').textContent = it && q >= 0 ? `Saldo fica ${qtyFmt(kind === 'count' ? q : kind === 'in' ? b + q : b - q)} ${it.measure}` : ''; };
    $$('[name=item_id], [name=qty]', modalForm).forEach((el) => el.addEventListener('input', hint));
    setTimeout(() => $('[name=qty]', modalForm)?.focus(), 80);
  });
}

/* ---------- Levantamento: vários itens de uma vez (e itens novos) ---------- */
function openStockCount(extra = 3) {
  const { bal } = stockBalances(); const items = state.stockItems.filter((i) => i.active);
  openModal(`<h2>📋 Levantamento do estoque</h2>
    <p class="muted" style="margin-top:-6px">Escreva a quantidade contada de cada item (deixe em branco o que não contou). Itens novos: use as linhas no final.</p>
    ${items.length ? `<div class="st-count">${items.map((i) => `<label class="st-count-row"><span><b>${esc(i.name)}</b><small>${esc(i.grp)} · hoje ${qtyFmt(bal[i.id] || 0)} ${esc(i.measure)}</small></span>
      <input name="c_${i.id}" inputmode="decimal" placeholder="contado" autocomplete="off"><em>${esc(i.measure)}</em></label>`).join('')}</div>` : ''}
    <h3 class="sub-h">Itens novos</h3>
    <div class="st-new">${Array.from({ length: extra }, (_, k) => `<div class="st-new-row">
      <input name="n_name${k}" placeholder="Material (ex.: Cabo 2,5 mm)" list="stNames" autocomplete="off">
      <input name="n_qty${k}" inputmode="decimal" placeholder="Qtd.">
      <select name="n_measure${k}">${STOCK_MEASURES.map((m) => `<option>${esc(m)}</option>`).join('')}</select>
      <input name="n_grp${k}" placeholder="Grupo" list="stGroups" value="${esc(sui.grp || 'Elétrica')}"></div>`).join('')}</div>
    <datalist id="stGroups">${stockGroups().map((g) => `<option value="${esc(g)}">`).join('')}</datalist>
    <datalist id="stNames">${(state.stockItems || []).map((i) => `<option value="${esc(i.name)}">`).join('')}</datalist>
    <button type="button" class="btn small" id="stMore">+ mais linhas</button>
    <div class="modal-actions"><span class="spacer"></span><button class="btn" value="cancel" formnovalidate>Cancelar</button><button class="btn primary" value="save">Salvar levantamento</button></div>`,
  async (action, fd) => {
    const moves = []; let created = 0;
    for (const i of items) { const q = parseQty(fd.get('c_' + i.id)); if (q >= 0) moves.push({ item_id: i.id, kind: 'count', qty: q, date: todayISO(), note: 'Levantamento' }); }
    for (let k = 0; k < 200; k++) {
      const name = (fd.get('n_name' + k) || '').trim(); if (fd.get('n_name' + k) == null) break; if (!name) continue;
      const q = parseQty(fd.get('n_qty' + k));
      let it = findItemByName(name);
      if (!it) { [it] = await api.insert('stock_items', { name, measure: fd.get('n_measure' + k), grp: (fd.get('n_grp' + k) || '').trim() || 'Outros' }); state.stockItems.push(it); created++; }
      if (q >= 0) moves.push({ item_id: it.id, kind: 'count', qty: q, date: todayISO(), note: 'Levantamento' });
    }
    if (!moves.length && !created) { toast('Nada para salvar'); return false; }
    if (moves.length) await api.insert('stock_moves', moves);
    toast(`Levantamento salvo: ${moves.length} item(ns)${created ? `, ${created} novo(s)` : ''} ✅`); await loadStock(); saveCache(); render();
  }, () => {
    $('.st-new', modalForm).addEventListener('change', (e) => { if (!/n_name/.test(e.target.name)) return; const row = e.target.closest('.st-new-row'); const g = row.querySelector('[name^=n_grp]'); const it = findItemByName(e.target.value); if (it) { row.querySelector('select').value = it.measure; g.value = it.grp; } else if (e.target.value.trim()) g.value = guessGroup(e.target.value); });
    $('#stMore').addEventListener('click', () => {
    const box = $('.st-new', modalForm); const k = box.children.length; const row = box.children[0].cloneNode(true);
    row.querySelectorAll('input, select').forEach((el) => { el.name = el.name.replace(/\d+$/, k); if (el.tagName === 'INPUT' && !/grp/.test(el.name)) el.value = ''; });
    box.appendChild(row);
  }); });
}

/* ---------- Itens na conta (lançar compra com itens) ---------- */
function billItemsField(items = []) {
  if (!stockOn()) return '';
  const rows = items.length ? items : [{}];
  return `<div class="field full"><span>📦 Itens para o estoque <small class="muted">(opcional — entram no estoque quando a conta for paga)</small></span>
    <div class="st-new" id="biRows">${rows.map((x, k) => biRow(x, k)).join('')}</div>
    <datalist id="stNames">${(state.stockItems || []).filter((i) => i.active).map((i) => `<option value="${esc(i.name)}">`).join('')}</datalist>
    <button type="button" class="btn small" id="biMore" style="justify-self:start">+ item</button></div>`;
}
const biRow = (x, k) => `<div class="st-new-row bi-row">
  <input name="bi_name${k}" value="${esc(x.name || '')}" placeholder="Material (ex.: Cimento CP-II)" list="stNames" autocomplete="off">
  <input name="bi_qty${k}" inputmode="decimal" value="${x.qty ?? ''}" placeholder="Qtd.">
  <select name="bi_measure${k}">${[...new Set([...STOCK_MEASURES, x.measure || 'unidade'])].map((m) => `<option ${m === (x.measure || 'unidade') ? 'selected' : ''}>${esc(m)}</option>`).join('')}</select></div>`;
function bindBillItems() {
  const box = $('#biRows'); if (!box) return;
  const sync = (row) => { const it = findItemByName(row.querySelector('[name^=bi_name]').value); if (it) row.querySelector('select').value = it.measure; };
  box.addEventListener('change', (e) => { const row = e.target.closest('.bi-row'); if (row && /bi_name/.test(e.target.name)) sync(row); });
  $('#biMore').addEventListener('click', () => { box.insertAdjacentHTML('beforeend', biRow({}, box.children.length)); });
}
/** Lê os itens do formulário; cria no estoque os materiais que ainda não existem. */
async function readBillItems(fd, areaName) {
  if (!stockOn() || !$('#biRows')) return null;
  const out = [];
  for (let k = 0; k < 200; k++) {
    if (fd.get('bi_name' + k) == null) break;
    const name = fd.get('bi_name' + k).trim(); const q = parseQty(fd.get('bi_qty' + k));
    if (!name && !(q > 0)) continue;
    if (!name || !(q > 0)) throw new Error('Complete o material e a quantidade de cada item (ou apague a linha).');
    let it = findItemByName(name);
    if (!it) {
      const grp = guessGroup(name, areaName);
      [it] = await api.insert('stock_items', { name, measure: fd.get('bi_measure' + k), grp });
      state.stockItems.push(it);
    }
    out.push({ item_id: it.id, name: it.name, qty: q, measure: it.measure });
  }
  return out;
}
const billItemsText = (b) => (Array.isArray(b.items) && b.items.length ? b.items.map((x) => `${x.name} — ${qtyFmt(x.qty)} ${x.measure || ''}`).join(' · ') : '');

/* ---------- Planilha ---------- */
async function exportStockXlsx() {
  try { await loadScriptOnce(XLSX_LIB); } catch (e) { toast(e.message); return; }
  const { bal } = stockBalances(); const inc = stockIncoming();
  const wb = XLSX.utils.book_new();
  const add = (n, rows) => { const ws = XLSX.utils.json_to_sheet(rows.length ? rows : [{ '(vazio)': '' }]); if (rows.length) ws['!cols'] = Object.keys(rows[0]).map((k) => ({ wch: Math.min(40, Math.max(k.length + 2, ...rows.slice(0, 200).map((r) => String(r[k] ?? '').length + 1))) })); XLSX.utils.book_append_sheet(wb, ws, n); };
  add('Saldo', state.stockItems.filter((i) => i.active).map((i) => ({ Grupo: i.grp, Item: i.name, Saldo: Number((bal[i.id] || 0).toFixed(3)), Medida: i.measure, 'A chegar': (inc[i.id] || []).reduce((s, x) => s + x.qty, 0) || '', Mínimo: i.min_qty ?? '' })));
  const lbl = { in: 'Entrada', out: 'Saída', count: 'Contagem' };
  add('Movimentações', (state.stockMoves || []).map((m) => ({ Data: fmtDate(m.date), Item: sItem(m.item_id)?.name || '', Tipo: lbl[m.kind], Quantidade: Number(m.qty), Medida: sItem(m.item_id)?.measure || '', 'Para onde': m.dest, Observação: m.note, Quem: memberName(m.created_by), 'Da compra': m.bill_id ? 'sim' : '' })));
  const out = XLSX.write(wb, { bookType: 'xlsx', type: 'array' });
  const file = new File([out], `Estoque CASACOR ${unitName()} ${todayISO()}.xlsx`, { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
  try { if (navigator.canShare?.({ files: [file] })) { await navigator.share({ files: [file], title: file.name }); return; } } catch (e) { if (e?.name === 'AbortError') return; }
  const a = document.createElement('a'); a.href = URL.createObjectURL(file); a.download = file.name; document.body.appendChild(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(a.href), 5000);
}

function bindEstoque(v) {
  $('#stCount', v)?.addEventListener('click', () => openStockCount());
  $('#stOut', v)?.addEventListener('click', () => (state.stockItems.length ? openStockMove('out') : toast('Cadastre os itens no Levantamento primeiro')));
  $('#stIn', v)?.addEventListener('click', () => (state.stockItems.length ? openStockMove('in') : toast('Cadastre os itens no Levantamento primeiro')));
  $('#stNew', v)?.addEventListener('click', () => openStockItemForm());
  $('#stXls', v)?.addEventListener('click', exportStockXlsx);
  $('#stGrp', v)?.addEventListener('change', (e) => { sui.grp = e.target.value; render(); });
  const q = $('#stQ', v); q?.addEventListener('input', () => { sui.q = q.value; const p = q.selectionStart; render(); const n = $('#stQ'); n.focus(); n.setSelectionRange(p, p); });
  $$('[data-stitem]', v).forEach((el) => el.addEventListener('click', () => openStockItem(sItem(el.dataset.stitem))));
}
