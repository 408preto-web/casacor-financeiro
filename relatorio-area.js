'use strict';

/* =========================================================
   Relatório por área: quanto foi gasto em cada área (Obra, Marketing…)
   e em quê (categorias: mão de obra, material, frete…).
   A folha de cada funcionário entra na área dele (cadastro do RH),
   como "Folha de pagamento (CLT)" — ex.: semanalistas da obra → Obra.
   Usa as funções e o estado globais de app.js, rh.js e rh-relatorio.js.
   ========================================================= */

const PAYROLL_CAT = 'Folha de pagamento (CLT)';
const NO_CAT = 'Sem categoria';
const catsOn = () => (state.areas || []).some((a) => Array.isArray(a.categories));
const areaCats = (areaId) => (areaById(areaId).categories || []);

/** Área "de verdade" do gasto: salário vai para a área do funcionário. */
function effArea(b) {
  if (b.employee_id) { const e = typeof empById === 'function' ? empById(b.employee_id) : null; if (e?.area_id) return String(e.area_id); }
  return String(b.area_id ?? '');
}
const effCat = (b) => b.category || (b.employee_id ? PAYROLL_CAT : NO_CAT);
const billAmt = (b) => (b.status === 'paid' && b.paidCents != null ? b.paidCents : b.cents);

function areaReportData() {
  const r = ui.report;
  const st = r.status || 'all';
  const list = reportBills().filter((b) => st === 'all' || b.status === st);
  const areaId = r.area || '';
  // Na área escolhida entra o que foi lançado nela (ex.: Pessoal = toda a folha) e a folha dos funcionários dessa área
  // (ex.: Obra = gastos da obra + folha dos semanalistas da obra). Em "Todas", cada conta conta uma vez só.
  const inArea = areaId ? list.filter((b) => effArea(b) === String(areaId) || String(b.area_id) === String(areaId)) : list;
  const cats = new Map();
  for (const b of inArea) {
    const k = effCat(b); const c = cats.get(k) || { name: k, total: 0, paid: 0, n: 0, bills: [] };
    c.total += billAmt(b); if (b.status === 'paid') c.paid += billAmt(b); c.n++; c.bills.push(b); cats.set(k, c);
  }
  const catList = [...cats.values()].sort((a, b) => (a.name === NO_CAT) - (b.name === NO_CAT) || b.total - a.total);
  catList.forEach((c) => c.bills.sort((a, b) => String(a.status === 'paid' ? a.paid_at : a.due_date).localeCompare(String(b.status === 'paid' ? b.paid_at : b.due_date))));
  const byArea = new Map();
  for (const b of list) { const k = effArea(b); const x = byArea.get(k) || { id: k, total: 0, paid: 0, n: 0 }; x.total += billAmt(b); if (b.status === 'paid') x.paid += billAmt(b); x.n++; byArea.set(k, x); }
  const total = inArea.reduce((s, b) => s + billAmt(b), 0);
  const paid = inArea.filter((b) => b.status === 'paid').reduce((s, b) => s + billAmt(b), 0);
  return { areaId, list: inArea, catList, total, paid, pending: total - paid, areas: [...byArea.values()].sort((a, b) => b.total - a.total), uncategorized: inArea.filter((b) => !b.category && !b.employee_id) };
}

const periodLabel = () => {
  const r = ui.report;
  return [r.edition ? `Edição ${r.edition}` : 'Todas as edições', r.from ? `de ${fmtDate(r.from)}` : '', r.to ? `até ${fmtDate(r.to)}` : '',
    { all: '', paid: '· só pagas', pending: '· só a pagar' }[r.status || 'all']].filter(Boolean).join(' ');
};

function renderAreaReport() {
  const r = ui.report; const d = areaReportData();
  const a = d.areaId ? areaById(d.areaId) : null;
  const color = a?.color || 'var(--primary)';
  const head = `<div class="card">
    <div class="ar-areas">${[['', 'Todas'], ...state.areas.map((x) => [String(x.id), x.name])].map(([id, n]) => `<button class="ar-chip ${String(r.area || '') === id ? 'sel' : ''}" data-rarea="${id}" ${id ? `style="--c:${areaById(id).color}"` : ''}>${id ? '<span class="area-dot" style="--c:' + areaById(id).color + '"></span>' : ''}${esc(n)}</button>`).join('')}</div>
    <div class="filters">
      <select id="redition"><option value="">Todas as edições</option>${editions().map((e) => `<option value="${esc(e)}" ${r.edition === e ? 'selected' : ''}>Edição ${esc(e)}</option>`).join('')}</select>
      <label class="inline">De <input type="date" id="rfrom" value="${esc(r.from)}"></label>
      <label class="inline">Até <input type="date" id="rto" value="${esc(r.to)}"></label>
      <select id="rstatus"><option value="all">Pagas e a pagar</option><option value="paid" ${r.status === 'paid' ? 'selected' : ''}>Só pagas</option><option value="pending" ${r.status === 'pending' ? 'selected' : ''}>Só a pagar</option></select>
    </div>
    <div class="row-actions"><button class="btn wa-btn fr-wa" id="arShare" ${d.list.length ? '' : 'disabled'}>📲 Enviar pelo WhatsApp</button><button class="btn" id="arPrint" ${d.list.length ? '' : 'disabled'}>🖨️ Imprimir</button><button class="btn" id="arCsv" ${d.list.length ? '' : 'disabled'}>📊 Excel</button></div>
  </div>`;
  const cards = `<div class="grid cols-4 mt">
    <div class="card stat"><div class="label">${a ? 'Gasto em ' + esc(a.name) : 'Total gasto'}</div><div class="value">${money(d.total)}</div><div class="sub">${d.list.length} conta(s)</div></div>
    <div class="card stat"><div class="label">Já pago</div><div class="value pos">${money(d.paid)}</div></div>
    <div class="card stat"><div class="label">A pagar</div><div class="value neg">${money(d.pending)}</div></div>
    <div class="card stat"><div class="label">Maior gasto</div><div class="value" style="font-size:18px">${esc(d.catList.find((c) => c.name !== NO_CAT)?.name || '—')}</div><div class="sub">${d.catList.find((c) => c.name !== NO_CAT) ? money(d.catList.find((c) => c.name !== NO_CAT).total) : ''}</div></div>
  </div>`;
  const uncat = d.uncategorized.length && catsOn() ? `<div class="alerts mt"><div class="alert info"><span class="alert-icon">🏷️</span><div class="alert-text"><b>${d.uncategorized.length} conta(s) sem categoria</b> (${money(d.uncategorized.reduce((s, b) => s + billAmt(b), 0))}). <span class="muted">Classifique para o relatório ficar completo.</span></div><button class="btn small primary" id="arClassify">Classificar agora</button></div></div>` : '';
  const byAreaCard = !d.areaId ? `<div class="card mt"><h2>Por área</h2>${bars(d.areas.map((x) => ({ label: `<span data-rarea="${x.id}" class="ar-link">${esc(areaById(x.id).name)}</span>`, v: x.total, color: areaById(x.id).color })), d.total)}</div>` : '';
  const catCard = `<div class="card mt"><h2>${a ? 'O que foi gasto em ' + esc(a.name) : 'Por categoria (todas as áreas)'}</h2>${bars(d.catList.map((c) => ({ label: `${esc(c.name)} <span class="muted">(${c.n})</span>`, v: c.total, color: c.name === NO_CAT ? '#94a3b8' : color })), d.total)}</div>`;
  const detail = d.list.length ? `<div class="card mt"><h2>Detalhamento</h2>${d.catList.map((c) => `
    <details class="ar-cat" ${d.catList.length <= 3 ? 'open' : ''}><summary><b>${esc(c.name)}</b><span>${c.n} conta(s) · <b>${money(c.total)}</b></span></summary>
      <ul class="tx-list">${c.bills.map((b) => `<li class="tx" data-bill="${b.id}"><div class="tx-main"><div class="tx-title">${esc(b.supplier)}${b.description ? ` <span class="muted">— ${esc(b.description)}</span>` : ''}</div>
        <div class="tx-meta">${b.status === 'paid' ? `pago ${fmtDate(b.paid_at)}` : `vence ${fmtDate(b.due_date)}`}${!d.areaId ? ' · ' + esc(areaById(effArea(b)).name) : ''}${b.employee_id && String(b.area_id) !== effArea(b) ? ' · folha' : ''}</div></div>
        <div class="tx-amount ${b.status === 'paid' ? 'pos' : 'neg'}">${money(billAmt(b))}<small>${b.status === 'paid' ? 'pago' : 'a pagar'}</small></div></li>`).join('')}</ul></details>`).join('')}</div>` : `<div class="card mt"><div class="empty small">Nenhuma conta ${a ? 'em ' + esc(a.name) : ''} neste período.</div></div>`;
  const note = isHR() ? '<p class="muted small mt">A folha de pagamento aparece em <b>Pessoal</b> (folha completa) e também na área de cada funcionário (cadastro do RH) — ex.: os semanalistas da obra contam em <b>Obra</b>. Em <b>Todas</b>, cada pagamento é somado uma vez só.</p>' : '';
  return head + cards + uncat + byAreaCard + catCard + detail + note;
}

/* ---------- Classificar contas sem categoria ---------- */
function openClassify() {
  const d = areaReportData(); const list = d.uncategorized.slice(0, 40);
  openModal(`<h2>🏷️ Classificar contas</h2>
    <p class="muted" style="margin-top:-6px">Escolha a categoria de cada conta. ${d.uncategorized.length > 40 ? `Mostrando 40 de ${d.uncategorized.length}.` : ''}</p>
    <ul class="ar-cls">${list.map((b) => `<li><div><b>${esc(b.supplier)}</b>${b.description ? ` <span class="muted">— ${esc(b.description)}</span>` : ''}<div class="muted small">${esc(areaById(b.area_id).name)} · ${money(billAmt(b))} · ${fmtDate(b.status === 'paid' ? b.paid_at : b.due_date)}</div></div>
      <select data-cls="${b.id}"><option value="">—</option>${areaCats(b.area_id).map((c) => `<option>${esc(c)}</option>`).join('')}</select></li>`).join('')}</ul>
    <div class="modal-actions"><span class="spacer"></span><button class="btn" value="cancel" formnovalidate>Cancelar</button><button class="btn primary" value="save">Salvar</button></div>`,
  async () => {
    let n = 0, fail = 0;
    for (const s of $$('[data-cls]', modalForm)) {
      if (!s.value) continue;
      try { await api.update('bills', `id=eq.${s.dataset.cls}`, { category: s.value }); n++; } catch { fail++; }
    }
    toast(`${n} conta(s) classificada(s)${fail ? ` · ${fail} sem permissão (contas já pagas: só quem paga altera)` : ''}`);
    await loadAll({ quiet: true }); render();
  });
}

/* ---------- PDF, impressão e Excel ---------- */
function areaReportTitle(d) { return d.areaId ? `Gastos — ${areaById(d.areaId).name}` : 'Gastos por área'; }

function areaPrintHTML(d) {
  const gen = new Date().toLocaleString('pt-BR', { dateStyle: 'short', timeStyle: 'short' });
  return `<div class="pr">
    <div class="pr-head"><div><div class="pr-logo"><img src="icons/casacor.png" alt="CASACOR"><b>${esc(unitName())}</b></div><h1>${esc(areaReportTitle(d))}</h1><p>${esc(periodLabel())}</p></div>
      <div class="pr-meta">Emitido em ${gen}<br>por ${esc(state.me.name)}</div></div>
    <table class="pr-sum"><tr><td><span>Total</span><b>${money(d.total)}</b></td><td><span>Já pago</span><b>${money(d.paid)}</b></td><td><span>A pagar</span><b>${money(d.pending)}</b></td><td><span>Contas</span><b>${d.list.length}</b></td></tr></table>
    ${!d.areaId ? `<h2>Por área</h2><table class="pr-t pr-small"><tbody>${d.areas.map((x) => `<tr><td>${esc(areaById(x.id).name)}</td><td>${x.n} conta(s)</td><td class="n">${money(x.total)}</td><td class="n">${d.total ? Math.round((x.total / d.total) * 100) : 0}%</td></tr>`).join('')}</tbody></table>` : ''}
    <h2>Por categoria</h2>
    <table class="pr-t pr-small"><thead><tr><th>Categoria</th><th>Contas</th><th class="n">Pago</th><th class="n">Total</th><th class="n">%</th></tr></thead><tbody>${d.catList.map((c) => `<tr><td>${esc(c.name)}</td><td>${c.n}</td><td class="n">${money(c.paid)}</td><td class="n"><b>${money(c.total)}</b></td><td class="n">${d.total ? Math.round((c.total / d.total) * 100) : 0}%</td></tr>`).join('')}</tbody>
      <tfoot><tr><td>Total</td><td>${d.list.length}</td><td class="n">${money(d.paid)}</td><td class="n">${money(d.total)}</td><td class="n">100%</td></tr></tfoot></table>
    <h2>Detalhamento</h2>
    <table class="pr-t"><thead><tr><th>Categoria</th><th>Data</th><th>Fornecedor</th><th>Descrição</th>${!d.areaId ? '<th>Área</th>' : ''}<th class="n">Valor</th><th>Situação</th></tr></thead><tbody>
      ${d.catList.flatMap((c) => c.bills.map((b) => `<tr><td>${esc(c.name)}</td><td>${fmtDate(b.status === 'paid' ? b.paid_at : b.due_date)}</td><td>${esc(b.supplier)}</td><td>${esc(b.description || '')}</td>${!d.areaId ? `<td>${esc(areaById(effArea(b)).name)}</td>` : ''}<td class="n">${money(billAmt(b))}</td><td>${b.status === 'paid' ? 'Pago' : 'A pagar'}</td></tr>`)).join('')}</tbody></table>
  </div>`;
}

function printAreaReport() {
  const d = areaReportData(); if (!d.list.length) return;
  let area = $('#printArea');
  if (!area) { area = document.createElement('div'); area.id = 'printArea'; document.body.appendChild(area); }
  area.innerHTML = areaPrintHTML(d);
  const old = document.title; document.title = `${areaReportTitle(d)} - CASACOR ${unitName()}`;
  document.body.classList.add('printing');
  const done = () => { document.body.classList.remove('printing'); area.innerHTML = ''; document.title = old; };
  window.addEventListener('afterprint', done, { once: true });
  setTimeout(() => { window.print(); setTimeout(() => { if (!window.matchMedia('print').matches) done(); }, 1500); }, 50);
}

function areaPdfFile(d) {
  const { jsPDF } = window.jspdf;
  const doc = new jsPDF({ orientation: 'portrait', unit: 'mm', format: 'a4' });
  const W = doc.internal.pageSize.getWidth(); const M = 12; const BR = [154, 52, 18];
  const m = (c) => money(c).replace(/ /g, ' ');
  if (ccLogo) { const h = 4.2, w = (ccLogo.w / ccLogo.h) * h; doc.addImage(ccLogo.data, 'PNG', M, 4.5, w, h); doc.setFont('helvetica', 'normal'); doc.setFontSize(11); doc.setTextColor(20); doc.text(unitName(), M + w + 1.8, 8.4); }
  doc.setTextColor(20); doc.setFont('helvetica', 'bold'); doc.setFontSize(16); doc.text(areaReportTitle(d), M, 16);
  doc.setFont('helvetica', 'normal'); doc.setFontSize(9); doc.setTextColor(80);
  doc.text(periodLabel(), M, 22);
  doc.text(`Emitido em ${new Date().toLocaleString('pt-BR', { dateStyle: 'short', timeStyle: 'short' })} por ${state.me.name}`, W - M, 22, { align: 'right' });
  doc.setDrawColor(...BR); doc.setLineWidth(0.8); doc.line(M, 25, W - M, 25);
  const boxes = [['Total', m(d.total)], ['Já pago', m(d.paid)], ['A pagar', m(d.pending)], ['Contas', String(d.list.length)]];
  const bw = (W - 2 * M - 3 * 3) / 4;
  boxes.forEach(([l, v], i) => {
    const x = M + i * (bw + 3);
    doc.setDrawColor(210); doc.setLineWidth(0.2); doc.roundedRect(x, 29, bw, 14, 1.5, 1.5);
    doc.setTextColor(100); doc.setFontSize(7.5); doc.text(l, x + 2.5, 33.5);
    doc.setTextColor(20); doc.setFont('helvetica', 'bold'); doc.setFontSize(11); doc.text(v, x + 2.5, 40); doc.setFont('helvetica', 'normal');
  });
  const base = { theme: 'plain', margin: { left: M, right: M }, styles: { fontSize: 8, cellPadding: 1.6, textColor: 20, lineColor: 225, lineWidth: { bottom: 0.2 } },
    headStyles: { fillColor: [243, 240, 238], fontStyle: 'bold', fontSize: 7.5 }, footStyles: { fillColor: [250, 248, 246], fontStyle: 'bold' } };
  const title = (txt, y) => { doc.setTextColor(...BR); doc.setFont('helvetica', 'bold'); doc.setFontSize(11); doc.text(txt, M, y); doc.setDrawColor(...BR); doc.setLineWidth(0.5); doc.line(M, y + 1.5, W - M, y + 1.5); doc.setFont('helvetica', 'normal'); return y + 4; };
  const num = { halign: 'right' }; const pct = (v) => `${d.total ? Math.round((v / d.total) * 100) : 0}%`;
  let y = 52;
  if (!d.areaId) {
    doc.autoTable({ ...base, startY: title('Por área', y), head: [['Área', 'Contas', 'Total', '%']], body: d.areas.map((x) => [areaById(x.id).name, x.n, m(x.total), pct(x.total)]), columnStyles: { 2: num, 3: num } });
    y = doc.lastAutoTable.finalY + 8;
  }
  doc.autoTable({ ...base, startY: title('Por categoria', y), head: [['Categoria', 'Contas', 'Pago', 'Total', '%']],
    body: d.catList.map((c) => [c.name, c.n, m(c.paid), m(c.total), pct(c.total)]), foot: [['Total', d.list.length, m(d.paid), m(d.total), '100%']],
    columnStyles: { 2: num, 3: { ...num, fontStyle: 'bold' }, 4: num }, didParseCell: (c) => { if (c.section !== 'body' && c.column.index >= 2) c.cell.styles.halign = 'right'; } });
  y = doc.lastAutoTable.finalY + 8;
  const rows = d.catList.flatMap((c) => c.bills.map((b) => [c.name, fmtDate(b.status === 'paid' ? b.paid_at : b.due_date), b.supplier, b.description || '', ...(d.areaId ? [] : [areaById(effArea(b)).name]), m(billAmt(b)), b.status === 'paid' ? 'Pago' : 'A pagar']));
  const vIdx = d.areaId ? 4 : 5;
  doc.autoTable({ ...base, startY: title('Detalhamento', y), head: [['Categoria', 'Data', 'Fornecedor', 'Descrição', ...(d.areaId ? [] : ['Área']), 'Valor', 'Situação']], body: rows,
    columnStyles: { [vIdx]: num }, didParseCell: (c) => { if (c.section === 'head' && c.column.index === vIdx) c.cell.styles.halign = 'right'; } });
  const pages = doc.getNumberOfPages();
  for (let i = 1; i <= pages; i++) { doc.setPage(i); doc.setFontSize(7.5); doc.setTextColor(140); doc.text(`Página ${i} de ${pages}`, W - M, doc.internal.pageSize.getHeight() - 6, { align: 'right' }); }
  const name = `${areaReportTitle(d)} - CASACOR ${unitName()}.pdf`.replace(/[\\/:*?"<>|]/g, '');
  return new File([doc.output('blob')], name, { type: 'application/pdf' });
}

const areaShareText = (d) => `CASACOR ${unitName()} — ${areaReportTitle(d)}\n${periodLabel()}\nTotal: ${money(d.total)} · Pago: ${money(d.paid)} · A pagar: ${money(d.pending)}\n` +
  d.catList.slice(0, 6).map((c) => `• ${c.name}: ${money(c.total)}`).join('\n');

async function shareAreaReport() {
  const d = areaReportData(); if (!d.list.length) return;
  const btn = $('#arShare'); const label = btn?.textContent;
  if (btn) { btn.disabled = true; btn.textContent = 'Gerando PDF…'; }
  let file;
  try { await loadPdfLibs(); file = areaPdfFile(d); }
  catch (e) { toast(e.message || 'Não foi possível gerar o PDF'); return; }
  finally { if (btn && document.contains(btn)) { btn.disabled = false; btn.textContent = label; } }
  const send = async () => {
    if (navigator.canShare?.({ files: [file] })) return navigator.share({ files: [file], title: file.name.replace(/\.pdf$/, ''), text: areaShareText(d) });
    const a = document.createElement('a'); a.href = URL.createObjectURL(file); a.download = file.name;
    document.body.appendChild(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(a.href), 5000);
    window.open(`https://wa.me/?text=${encodeURIComponent(areaShareText(d) + '\n\n(PDF em anexo)')}`, '_blank', 'noopener');
    toast('PDF baixado — anexe na conversa do WhatsApp');
  };
  try { await send(); }
  catch (e) {
    if (e?.name === 'AbortError') return;
    openModal(`<h2>📄 PDF pronto</h2><p class="muted">${esc(file.name)}</p><button type="button" class="btn wa-btn big" id="arSendNow">📲 Enviar pelo WhatsApp</button>
      <div class="modal-actions"><span class="spacer"></span><button class="btn" value="cancel" formnovalidate>Fechar</button></div>`, () => {},
    () => $('#arSendNow').addEventListener('click', async () => { try { await send(); modal.close(); } catch (er) { if (er?.name !== 'AbortError') toast(er.message); } }));
  }
}

function exportAreaCsv() {
  const d = areaReportData(); if (!d.list.length) return;
  const rows = [['Área', 'Categoria', 'Fornecedor', 'Descrição', 'Data da compra', 'Vencimento', 'Situação', 'Pago em', 'Valor', 'Forma', 'Lançado por', 'Edição']];
  for (const c of d.catList) for (const b of c.bills) {
    rows.push([areaById(effArea(b)).name, c.name, b.supplier, b.description, fmtDate(b.purchase_date), fmtDate(b.due_date), b.status === 'paid' ? 'Pago' : 'A pagar',
      fmtDate(b.paid_at), centsToInput(billAmt(b)), METHODS[b.method]?.label || b.method, memberName(b.created_by), b.edition]);
  }
  rows.push(['TOTAL', '', '', '', '', '', '', '', centsToInput(d.total), '', '', '']);
  const csv = rows.map((r) => r.map((v) => `"${String(v ?? '').replace(/"/g, '""')}"`).join(';')).join('\r\n');
  const blob = new Blob(['﻿' + csv], { type: 'text/csv;charset=utf-8' });
  const a = document.createElement('a'); a.href = URL.createObjectURL(blob);
  a.download = `${areaReportTitle(d).toLowerCase().replace(/[^a-z0-9à-ú]+/gi, '-')}-${todayISO()}.csv`;
  document.body.appendChild(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(a.href), 2000);
}

function bindAreaReport(v) {
  $$('[data-rarea]', v).forEach((b) => b.addEventListener('click', () => { ui.report.area = b.dataset.rarea; render(); }));
  $('#rstatus', v)?.addEventListener('change', (e) => { ui.report.status = e.target.value; render(); });
  $('#arClassify', v)?.addEventListener('click', openClassify);
  $('#arShare', v)?.addEventListener('click', shareAreaReport);
  $('#arPrint', v)?.addEventListener('click', printAreaReport);
  $('#arCsv', v)?.addEventListener('click', exportAreaCsv);
  if ($('#arShare', v)) loadPdfLibs().catch(() => {});
}
