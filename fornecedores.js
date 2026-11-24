'use strict';

/* =========================================================
   Fornecedores: montados a partir das contas já lançadas.
   - Ao lançar, digitar um fornecedor conhecido preenche Pix, dados bancários,
     forma, área e categoria da última compra.
   - Relatórios → Fornecedores: quanto foi pago a cada um, Pix e última compra.
   Usa as funções e o estado globais de app.js.
   ========================================================= */

const supKey = (s) => normR(String(s || '').trim()).replace(/\s+/g, ' ');
const fui = { q: '' };

/** Última conta do fornecedor (mais recente com dados de pagamento, se houver). */
function lastBillOf(name) {
  const k = supKey(name); if (!k) return null;
  const list = state.bills.filter((b) => supKey(b.supplier) === k && b.approval !== 'rejected').sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)));
  return list.find((b) => b.pix_key || b.bank_info) || list[0] || null;
}

/** No formulário de conta: preenche o que estiver vazio com os dados da última compra. */
function bindSupplierAutofill(isEdit) {
  const inp = $('[name="supplier"]', modalForm); if (!inp || isEdit) return;
  let done = '';
  const fill = () => {
    const last = lastBillOf(inp.value); if (!last || done === supKey(inp.value)) return;
    done = supKey(inp.value); const filled = [];
    const set = (name, val) => { const el = $(`[name="${name}"]`, modalForm); if (el && val && !el.value) { el.value = val; filled.push(name); } };
    if (last.method && last.method !== 'cartao') {
      const r = $(`[name="method"][value="${last.method}"]`, modalForm);
      if (r && !r.checked) { r.checked = true; r.dispatchEvent(new Event('change', { bubbles: true })); filled.push('method'); }
    }
    set('pix_key', last.pix_key); set('bank_info', last.bank_info);
    const area = $('[name="area_id"]', modalForm);
    if (area && !area.value && last.area_id && state.areas.some((a) => String(a.id) === String(last.area_id) && a.active)) {
      area.value = String(last.area_id); area.dispatchEvent(new Event('change', { bubbles: true })); filled.push('area');
      const cat = $('#bCat'); if (cat && last.category) { cat.innerHTML = catOptions(last.area_id, last.category); cat.disabled = false; }
    }
    if (filled.length) {
      let hint = $('#supHint', modalForm);
      if (!hint) { hint = document.createElement('small'); hint.id = 'supHint'; hint.className = 'calc-hint'; inp.closest('label').appendChild(hint); }
      hint.innerHTML = `✨ Preenchido com a última compra de <b>${esc(last.supplier)}</b> (${fmtDate(last.due_date)}): ${[last.pix_key ? 'Pix' : '', last.bank_info ? 'dados bancários' : '', filled.includes('area') ? 'área e categoria' : ''].filter(Boolean).join(', ') || 'forma de pagamento'}. Confira antes de salvar.`;
    }
  };
  inp.addEventListener('change', fill); inp.addEventListener('blur', fill);
}

/* ---------- Relatórios → Fornecedores ---------- */
function supplierRows() {
  const map = new Map();
  for (const b of state.bills) {
    if (b.status === 'cancelled' || !isApproved(b)) continue;
    const k = supKey(b.supplier); if (!k) continue;
    const r = map.get(k) || { name: b.supplier, n: 0, paid: 0, open: 0, last: null, areas: {}, pix: '', bank: '' };
    r.n++; if (b.status === 'paid') r.paid += billAmt(b); else r.open += b.cents;
    if (!r.last || String(b.due_date) > String(r.last.due_date)) r.last = b;
    if (!r.pix && b.pix_key) r.pix = b.pix_key; if (!r.bank && b.bank_info) r.bank = b.bank_info;
    const an = areaById(b.area_id).name; r.areas[an] = (r.areas[an] || 0) + 1;
    map.set(k, r);
  }
  return [...map.values()].sort((a, b) => (b.paid + b.open) - (a.paid + a.open));
}
function renderSuppliers() {
  const q = supKey(fui.q); const rows = supplierRows().filter((r) => !q || supKey(`${r.name} ${r.pix}`).includes(q));
  const tot = rows.reduce((s, r) => s + r.paid, 0);
  return `<div class="card"><div class="filters"><input id="supQ" placeholder="Procurar fornecedor ou chave Pix" value="${esc(fui.q)}" autocomplete="off"></div>
    <p class="muted small" style="margin:0">${rows.length} fornecedor(es) · ${money(tot)} já pagos. Os dados vêm das contas lançadas; ao lançar uma conta, o fornecedor conhecido é preenchido sozinho.</p></div>
  <div class="card mt">${rows.length ? `<ul class="tx-list">${rows.map((r) => `<li class="tx" data-supq="${esc(r.name)}"><div class="tx-icon">🏪</div><div class="tx-main">
      <div class="tx-title">${esc(r.name)} <span class="muted">· ${r.n} conta(s)</span></div>
      <div class="tx-meta">${esc(Object.entries(r.areas).sort((a, b) => b[1] - a[1])[0]?.[0] || '')} · última ${fmtDate(r.last?.due_date)}${r.pix ? ` · Pix ${esc(r.pix)}` : ''}${r.open ? ` · <b class="neg">${money(r.open)} a pagar</b>` : ''}</div></div>
      <div class="tx-amount pos">${money(r.paid)}<small>pago</small></div></li>`).join('')}</ul>` : '<div class="empty small">Nenhum fornecedor ainda.</div>'}</div>`;
}
function bindSuppliers(v) {
  const q = $('#supQ', v); q?.addEventListener('input', () => { fui.q = q.value; const p = q.selectionStart; render(); const n = $('#supQ'); n.focus(); n.setSelectionRange(p, p); });
  $$('[data-supq]', v).forEach((el) => el.addEventListener('click', () => { ui.filter.q = el.dataset.supq; ui.tab = 'all'; setView('contas'); }));
}
