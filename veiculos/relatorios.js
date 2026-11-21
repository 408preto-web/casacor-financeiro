'use strict';

/* =========================================================
   Garagem — relatórios, planilha e "Histórico do veículo" (PDF
   com as manutenções e os documentos anexados, para mostrar na venda).
   Usa as funções e o estado globais de app.js.
   ========================================================= */

const LIB_JSPDF = 'https://cdnjs.cloudflare.com/ajax/libs/jspdf/2.5.1/jspdf.umd.min.js';
const LIB_TABLE = 'https://cdnjs.cloudflare.com/ajax/libs/jspdf-autotable/3.8.2/jspdf.plugin.autotable.min.js';
const LIB_PDFJS = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/';
const LIB_XLSX = 'https://cdnjs.cloudflare.com/ajax/libs/xlsx/0.18.5/xlsx.full.min.js';

function repRange() {
  const r = ui.rep; return { from: r.from || '0000-01-01', to: r.to || '9999-12-31' };
}
function repData() {
  const { from, to } = repRange(); const vid = ui.rep.vid;
  const inP = (d) => String(d) >= from && String(d) <= to;
  const fuel = state.fuel.filter((f) => (!vid || f.vehicle_id === vid) && inP(f.date));
  const serv = state.services.filter((s) => (!vid || s.vehicle_id === vid) && inP(s.date));
  const fuelT = fuel.reduce((s, f) => s + Number(f.total), 0);
  const maintT = serv.filter((s) => isMaint(s.kind)).reduce((s, x) => s + Number(x.cost), 0);
  const otherT = serv.filter((s) => !isMaint(s.kind)).reduce((s, x) => s + Number(x.cost), 0);
  // km rodados no período e consumo (trechos de tanque cheio que terminam no período)
  let kmRun = 0, segKm = 0, segL = 0;
  for (const v of state.vehicles.filter((x) => !vid || x.id === vid)) {
    const odos = [...state.fuel.filter((f) => f.vehicle_id === v.id && inP(f.date)).map((f) => f.odometer), ...state.services.filter((s) => s.vehicle_id === v.id && inP(s.date) && s.odometer != null).map((s) => s.odometer)];
    if (odos.length > 1) kmRun += Math.max(...odos) - Math.min(...odos);
    const c = fuelCalc(v.id);
    for (const f of c.list) { const p = c.per[f.id]; if (p?.kml && inP(f.date)) { segKm += p.kmSeg; segL += p.kmSeg / p.kml; } }
  }
  const byKind = {}; serv.forEach((s) => { byKind[s.kind] = (byKind[s.kind] || 0) + Number(s.cost); });
  const byMonth = {}; fuel.forEach((f) => { const m = monthOf(f.date); byMonth[m] = (byMonth[m] || 0) + Number(f.total); }); serv.forEach((s) => { const m = monthOf(s.date); byMonth[m] = (byMonth[m] || 0) + Number(s.cost); });
  return { vid, fuel, serv, fuelT, maintT, otherT, total: fuelT + maintT + otherT, kmRun, avg: segL ? segKm / segL : null, liters: fuel.reduce((s, f) => s + Number(f.liters), 0), byKind, byMonth };
}
function barsHTML(rows, total) {
  if (!rows.length) return '<div class="empty small">Sem dados.</div>';
  const max = Math.max(...rows.map((r) => r.v), 1);
  return `<ul class="bars">${rows.map((r) => `<li><div class="bar-top"><span>${r.label}</span><b>${money(r.v)} <span class="muted">${total ? Math.round((r.v / total) * 100) : 0}%</span></b></div><div class="bar"><div style="width:${(r.v / max) * 100}%;background:var(--primary)"></div></div></li>`).join('')}</ul>`;
}
function renderReports() {
  const d = repData(); const v = vById(d.vid); const y = todayISO().slice(0, 4);
  const presets = [['ano', 'Este ano', `${y}-01-01`, ''], ['12m', 'Últimos 12 meses', addDaysISO(todayISO(), -365), ''], ['tudo', 'Tudo', '', '']];
  const kinds = [['⛽ Combustível', d.fuelT], ...Object.entries(d.byKind).map(([k, val]) => [kindLabel(k), val])].filter(([, val]) => val > 0).sort((a, b) => b[1] - a[1]);
  const months = Object.entries(d.byMonth).sort((a, b) => a[0].localeCompare(b[0])).slice(-12);
  return `${vehicleChips(true, ui.rep.vid, 'data-rv')}
  <div class="card"><div class="filters">
    ${presets.map(([k, l, f, t]) => `<button class="v-chip ${ui.rep.from === f && ui.rep.to === t ? 'sel' : ''}" data-rp="${f}|${t}">${l}</button>`).join('')}
    <label class="inline">De <input type="date" id="rFrom" value="${ui.rep.from}"></label><label class="inline">Até <input type="date" id="rTo" value="${ui.rep.to}"></label></div>
    <div class="row-actions">${v ? '<button class="btn primary" id="histBtn">📄 Histórico do veículo (PDF)</button>' : '<span class="muted small">Escolha um veículo para gerar o <b>Histórico do veículo</b> em PDF.</span>'}<button class="btn" id="xlsBtn">📊 Planilha</button></div></div>
  <div class="grid cols-4 mt">
    <div class="card stat"><div class="label">Total gasto</div><div class="value">${money(d.total)}</div><div class="sub">${v ? esc(v.name) : 'todos os veículos'}</div></div>
    <div class="card stat"><div class="label">⛽ Combustível</div><div class="value">${money(d.fuelT)}</div><div class="sub">${nf(d.liters, 0)} L · média ${d.avg ? nf(d.avg, 1) + ' km/l' : '—'}</div></div>
    <div class="card stat"><div class="label">🔧 Manutenção</div><div class="value">${money(d.maintT)}</div><div class="sub">${d.serv.filter((s) => isMaint(s.kind)).length} serviço(s)</div></div>
    <div class="card stat"><div class="label">📄 Outras despesas</div><div class="value">${money(d.otherT)}</div><div class="sub">IPVA, seguro, multas…</div></div>
  </div>
  <div class="grid cols-2 mt">
    <div class="card stat"><div class="label">Km rodados no período</div><div class="value">${nf(d.kmRun)} km</div></div>
    <div class="card stat"><div class="label">Custo por km (tudo)</div><div class="value">${d.kmRun ? money(d.total / d.kmRun) : '—'}</div><div class="sub">combustível + manutenção + despesas ÷ km</div></div>
  </div>
  <div class="grid cols-2 mt"><div class="card"><h2>Onde foi o dinheiro</h2>${barsHTML(kinds.map(([l, val]) => ({ label: esc(l), v: val })), d.total)}</div>
    <div class="card"><h2>Por mês</h2>${barsHTML(months.map(([m, val]) => ({ label: monthName(m), v: val })), d.total)}</div></div>`;
}
function bindReports(v) {
  $$('[data-rv]', v).forEach((b) => b.addEventListener('click', () => { ui.rep.vid = b.dataset.rv; render(); }));
  $$('[data-rp]', v).forEach((b) => b.addEventListener('click', () => { const [f, t] = b.dataset.rp.split('|'); ui.rep.from = f; ui.rep.to = t; render(); }));
  $('#rFrom', v)?.addEventListener('change', (e) => { ui.rep.from = e.target.value; render(); });
  $('#rTo', v)?.addEventListener('change', (e) => { ui.rep.to = e.target.value; render(); });
  $('#histBtn', v)?.addEventListener('click', () => openHistory(vById(ui.rep.vid)));
  $('#xlsBtn', v)?.addEventListener('click', () => exportXlsx(ui.rep.vid));
}

/* ---------- Compartilhar / baixar arquivo ---------- */
async function shareOrDownload(file, text) {
  try { if (navigator.canShare?.({ files: [file] })) { await navigator.share({ files: [file], title: file.name, text }); return; } }
  catch (e) { if (e?.name === 'AbortError') return; }
  const a = document.createElement('a'); a.href = URL.createObjectURL(file); a.download = file.name;
  document.body.appendChild(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(a.href), 8000);
}
function fileReady(file, text) {
  openModal(`<h2>📄 Pronto</h2><p class="muted">${esc(file.name)} · ${nf(file.size / 1024 / 1024, 1)} MB</p>
    <p class="muted small">No iPhone/iPad: <b>Salvar / enviar</b> → WhatsApp, e-mail ou <b>Salvar em Arquivos</b>.</p>
    <button type="button" class="btn primary big" id="frSend" style="width:100%">📤 Salvar / enviar</button>
    <div class="modal-actions"><span class="spacer"></span><button class="btn" value="cancel" formnovalidate>Fechar</button></div>`, () => {},
  () => $('#frSend').addEventListener('click', () => shareOrDownload(file, text)));
}

/* ---------- Planilha ---------- */
async function exportXlsx(vid = '') {
  try { await loadScriptOnce(LIB_XLSX); } catch (e) { toast(e.message); return; }
  const vs = state.vehicles.filter((v) => !vid || v.id === vid);
  const fuel = state.fuel.filter((f) => vs.some((v) => v.id === f.vehicle_id)).sort((a, b) => String(a.date).localeCompare(String(b.date)) || a.odometer - b.odometer);
  const serv = state.services.filter((s) => vs.some((v) => v.id === s.vehicle_id)).sort((a, b) => String(a.date).localeCompare(String(b.date)));
  const calc = {}; vs.forEach((v) => { calc[v.id] = fuelCalc(v.id); });
  const wb = XLSX.utils.book_new();
  const add = (name, rows) => { const ws = XLSX.utils.json_to_sheet(rows.length ? rows : [{ '(vazio)': '' }]); if (rows.length) ws['!cols'] = Object.keys(rows[0]).map((k) => ({ wch: Math.min(40, Math.max(k.length + 2, ...rows.slice(0, 200).map((r) => String(r[k] ?? '').length + 1))) })); XLSX.utils.book_append_sheet(wb, ws, name); };
  add('Veículos', vs.map((v) => ({ Veículo: v.name, Marca: v.brand, Modelo: v.model, Ano: v.year, Placa: v.plate, Cor: v.color, Combustível: VFUELS[v.fuel] || v.fuel, 'Km atual': currentKm(v.id),
    'Consumo médio (km/l)': calc[v.id].avg ? Number(calc[v.id].avg.toFixed(2)) : '', Renavam: v.renavam, Chassi: v.chassis, 'Comprado em': fmtDate(v.purchase_date), 'Valor da compra': v.purchase_price ?? '', 'Em uso': v.active ? 'sim' : 'não' })));
  add('Abastecimentos', fuel.map((f) => { const p = calc[f.vehicle_id].per[f.id] || {}; return { Data: fmtDate(f.date), Veículo: vById(f.vehicle_id)?.name, Km: f.odometer, 'Km rodados': p.ran ?? '', Litros: Number(f.liters),
    'R$/litro': f.price_l ? Number(f.price_l) : '', 'Total (R$)': Number(f.total), Combustível: FUELS[f.fuel] || f.fuel, 'Tanque cheio': f.full_tank ? 'sim' : 'não', 'km/l': p.kml ? Number(p.kml.toFixed(2)) : '', Posto: f.station, 'Lançado por': memberName(f.created_by), Observação: f.notes }; }));
  add('Manutenção e despesas', serv.map((s) => ({ Data: fmtDate(s.date), Veículo: vById(s.vehicle_id)?.name, Tipo: KINDS[s.kind]?.[1] || s.kind, Grupo: isMaint(s.kind) ? 'Manutenção' : 'Outras despesas', Descrição: s.description,
    Oficina: s.shop, Km: s.odometer ?? '', 'Valor (R$)': Number(s.cost), 'Garantia até': fmtDate(s.warranty_until), 'Próxima (km)': s.next_km ?? '', 'Próxima (data)': fmtDate(s.next_date),
    Documentos: (s.attachments || []).map((a) => a.name).join(' | '), 'Lançado por': memberName(s.created_by), Observação: s.notes })));
  const out = XLSX.write(wb, { bookType: 'xlsx', type: 'array' });
  const file = new File([out], `Garagem${vid ? ' - ' + vById(vid).name : ''} - ${todayISO()}.xlsx`, { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
  fileReady(file, 'Planilha da Garagem');
}

/* ---------- Histórico do veículo (PDF) ---------- */
function openHistory(v) {
  if (!v) return;
  const maint = state.services.filter((s) => s.vehicle_id === v.id && isMaint(s.kind));
  const docs = state.services.filter((s) => s.vehicle_id === v.id).reduce((n, s) => n + (s.attachments || []).length, 0);
  openModal(`<h2>📄 Histórico do veículo</h2><p class="muted" style="margin-top:-6px">${esc(vLabel(v))} · ${maint.length} manutenção(ões) · ${docs} documento(s)</p>
    <p class="muted small">Um PDF com os dados do carro, todas as manutenções em ordem e, no final, as notas e fotos anexadas — para mostrar a quem for comprar.</p>
    <div class="hist-opts">
      <label class="check"><input type="checkbox" name="values" checked><span>Mostrar os valores (R$) pagos</span></label>
      <label class="check"><input type="checkbox" name="docs" ${docs ? 'checked' : 'disabled'}><span>Incluir os documentos anexados (notas, recibos, fotos)</span></label>
      <label class="check"><input type="checkbox" name="other"><span>Incluir outras despesas (IPVA, seguro, multas…)</span></label>
      <label class="check"><input type="checkbox" name="fuel"><span>Incluir a lista de abastecimentos</span></label>
    </div>
    <div class="progress-line" hidden><i style="width:0%"></i></div><p id="histStep" class="muted small"></p>
    <div class="modal-actions"><span class="spacer"></span><button class="btn" value="cancel" formnovalidate>Cancelar</button><button class="btn primary" value="save">Gerar PDF</button></div>`,
  async (action, fd) => {
    const bar = $('.progress-line', modalForm); bar.hidden = false;
    const step = (t, p) => { $('#histStep').textContent = t; $('.progress-line i', modalForm).style.width = `${p}%`; };
    const file = await buildHistoryPdf(v, { values: fd.get('values') === 'on', docs: fd.get('docs') === 'on', other: fd.get('other') === 'on', fuel: fd.get('fuel') === 'on' }, step);
    setTimeout(() => fileReady(file, `Histórico do veículo ${v.name}`), 0);
  });
}

async function imgToJpeg(blob, maxSide = 1600) {
  const img = await createImageBitmap(blob); const sc = Math.min(1, maxSide / Math.max(img.width, img.height));
  const c = document.createElement('canvas'); c.width = Math.round(img.width * sc); c.height = Math.round(img.height * sc);
  const g = c.getContext('2d'); g.fillStyle = '#fff'; g.fillRect(0, 0, c.width, c.height); g.drawImage(img, 0, 0, c.width, c.height);
  return { data: c.toDataURL('image/jpeg', 0.8), w: c.width, h: c.height };
}
async function pdfPagesToJpeg(blob, maxPages = 5) {
  await loadScriptOnce(LIB_PDFJS + 'pdf.min.js');
  pdfjsLib.GlobalWorkerOptions.workerSrc = LIB_PDFJS + 'pdf.worker.min.js';
  const doc = await pdfjsLib.getDocument({ data: await blob.arrayBuffer() }).promise; const out = [];
  for (let i = 1; i <= Math.min(doc.numPages, maxPages); i++) {
    const page = await doc.getPage(i); const vp0 = page.getViewport({ scale: 1 }); const vp = page.getViewport({ scale: Math.min(2, 1400 / vp0.width) });
    const c = document.createElement('canvas'); c.width = vp.width; c.height = vp.height;
    const g = c.getContext('2d'); g.fillStyle = '#fff'; g.fillRect(0, 0, c.width, c.height);
    await page.render({ canvasContext: g, viewport: vp }).promise;
    out.push({ data: c.toDataURL('image/jpeg', 0.8), w: c.width, h: c.height });
  }
  return { pages: out, total: doc.numPages };
}

async function buildHistoryPdf(v, opt, step) {
  step('Preparando…', 3);
  await loadScriptOnce(LIB_JSPDF); await loadScriptOnce(LIB_TABLE);
  const { jsPDF } = window.jspdf;
  const doc = new jsPDF({ orientation: 'portrait', unit: 'mm', format: 'a4' });
  const W = doc.internal.pageSize.getWidth(), H = doc.internal.pageSize.getHeight(), M = 14; const BL = [29, 78, 216];
  const m = (x) => money(x).replace(/ /g, ' ');
  const calc = fuelCalc(v.id); const cur = currentKm(v.id);
  const serv = state.services.filter((s) => s.vehicle_id === v.id && (isMaint(s.kind) || opt.other)).sort((a, b) => String(a.date).localeCompare(String(b.date)));
  const fuel = calc.list;
  const firstDate = [v.purchase_date, ...serv.map((s) => s.date), ...fuel.map((f) => f.date)].filter(Boolean).sort()[0];
  // numeração dos anexos
  let n = 0; const attRefs = new Map();
  if (opt.docs) serv.forEach((s) => (s.attachments || []).forEach((a) => { n++; attRefs.set(a.path, `A${n}`); }));

  doc.setFont('helvetica', 'bold'); doc.setFontSize(19); doc.setTextColor(20); doc.text('Histórico do veículo', M, 18);
  doc.setFontSize(13); doc.setTextColor(...BL); doc.text(`${v.name}${v.plate ? '  ·  ' + v.plate : ''}`, M, 26);
  doc.setFont('helvetica', 'normal'); doc.setFontSize(9); doc.setTextColor(90);
  doc.text([v.brand, v.model, v.year, v.color].filter(Boolean).join(' · ') || ' ', M, 32);
  doc.text(`Emitido em ${new Date().toLocaleDateString('pt-BR')}`, W - M, 18, { align: 'right' });
  doc.setDrawColor(...BL); doc.setLineWidth(0.8); doc.line(M, 35, W - M, 35);
  const maintList = serv.filter((s) => isMaint(s.kind));
  const boxes = [['Km atual', `${nf(cur)} km`], ['Registros desde', fmtDate(firstDate) || '—'], ['Manutenções', String(maintList.length)], ['Consumo médio', calc.avg ? `${nf(calc.avg, 1)} km/l` : '—']];
  if (opt.values) boxes.push(['Gasto em manutenção', m(maintList.reduce((s, x) => s + Number(x.cost), 0))]);
  const bw = (W - 2 * M - (boxes.length - 1) * 3) / boxes.length;
  boxes.forEach(([l, val], i) => { const x = M + i * (bw + 3); doc.setDrawColor(210); doc.setLineWidth(0.2); doc.roundedRect(x, 39, bw, 14, 1.5, 1.5);
    doc.setTextColor(100); doc.setFontSize(7.5); doc.text(l, x + 2.5, 43.5); doc.setTextColor(20); doc.setFont('helvetica', 'bold'); doc.setFontSize(10.5); doc.text(val, x + 2.5, 50); doc.setFont('helvetica', 'normal'); });
  const base = { theme: 'plain', margin: { left: M, right: M }, styles: { fontSize: 8.5, cellPadding: 1.7, textColor: 20, lineColor: 225, lineWidth: { bottom: 0.2 } }, headStyles: { fillColor: [235, 240, 252], fontStyle: 'bold', fontSize: 8 } };
  const title = (t, y) => { if (y > H - 30) { doc.addPage(); y = 18; } doc.setTextColor(...BL); doc.setFont('helvetica', 'bold'); doc.setFontSize(11.5); doc.text(t, M, y); doc.setDrawColor(...BL); doc.setLineWidth(0.5); doc.line(M, y + 1.5, W - M, y + 1.5); doc.setFont('helvetica', 'normal'); return y + 4; };
  const dados = [['Marca / modelo', [v.brand, v.model].filter(Boolean).join(' ') || '—'], ['Ano', v.year || '—'], ['Placa', v.plate || '—'], ['Cor', v.color || '—'], ['Combustível', VFUELS[v.fuel] || v.fuel], ['Renavam', v.renavam || '—'], ['Chassi', v.chassis || '—']];
  doc.autoTable({ ...base, startY: title('Dados do veículo', 62), body: dados, columnStyles: { 0: { fontStyle: 'bold', cellWidth: 40 } }, tableWidth: 120 });
  const head = ['Data', 'Km', 'Serviço', 'Descrição', 'Oficina / loja', ...(opt.values ? ['Valor'] : []), ...(opt.docs ? ['Docs'] : [])];
  doc.autoTable({ ...base, startY: title(opt.other ? 'Manutenções, serviços e despesas' : 'Manutenções e serviços', doc.lastAutoTable.finalY + 9), head: [head],
    body: serv.length ? serv.map((s) => [fmtDate(s.date), s.odometer != null ? nf(s.odometer) : '', KINDS[s.kind]?.[1] || s.kind, s.description + (s.warranty_until ? ` (garantia até ${fmtDate(s.warranty_until)})` : ''), s.shop,
      ...(opt.values ? [m(s.cost)] : []), ...(opt.docs ? [(s.attachments || []).map((a) => attRefs.get(a.path)).join(', ')] : [])]) : [['', '', 'Nenhuma manutenção registrada', '', '', ...(opt.values ? [''] : []), ...(opt.docs ? [''] : [])]],
    columnStyles: { 0: { cellWidth: 19 }, 1: { cellWidth: 17, halign: 'right' }, 2: { cellWidth: 32 }, ...(opt.values ? { [head.indexOf('Valor')]: { halign: 'right', cellWidth: 22 } } : {}) } });
  if (opt.fuel && fuel.length) {
    doc.autoTable({ ...base, startY: title(`Abastecimentos (${fuel.length}) · média ${calc.avg ? nf(calc.avg, 1) + ' km/l' : '—'}`, doc.lastAutoTable.finalY + 9),
      head: [['Data', 'Km', 'Litros', ...(opt.values ? ['Total'] : []), 'km/l', 'Posto']],
      body: fuel.map((f) => [fmtDate(f.date), nf(f.odometer), nf(f.liters, 2), ...(opt.values ? [m(f.total)] : []), calc.per[f.id]?.kml ? nf(calc.per[f.id].kml, 1) : '', f.station]), styles: { ...base.styles, fontSize: 7.5 } });
  }
  // Documentos anexados
  if (opt.docs && n) {
    let done = 0;
    for (const s of serv) for (const a of s.attachments || []) {
      done++; step(`Anexando documento ${done} de ${n}…`, 10 + Math.round((done / n) * 85));
      const cap = `${attRefs.get(a.path)} — ${fmtDate(s.date)} · ${KINDS[s.kind]?.[1] || s.kind}${s.shop ? ' · ' + s.shop : ''}${s.odometer != null ? ' · ' + nf(s.odometer) + ' km' : ''}`;
      let imgs = []; let note = '';
      try {
        const blob = await (await fetch(await fileUrl(a.path))).blob();
        if (/pdf/i.test(a.type) || /\.pdf$/i.test(a.name)) { const r = await pdfPagesToJpeg(blob); imgs = r.pages; if (r.total > r.pages.length) note = `(mostrando ${r.pages.length} de ${r.total} páginas)`; }
        else imgs = [await imgToJpeg(blob)];
      } catch { note = 'Não foi possível incluir este arquivo (sem internet?).'; }
      if (!imgs.length) imgs = [null];
      imgs.forEach((im, i) => {
        doc.addPage();
        doc.setFont('helvetica', 'bold'); doc.setFontSize(10.5); doc.setTextColor(...BL); doc.text(doc.splitTextToSize(cap + (imgs.length > 1 ? `  (página ${i + 1})` : ''), W - 2 * M), M, 14);
        doc.setFont('helvetica', 'normal'); doc.setFontSize(8); doc.setTextColor(110); doc.text(doc.splitTextToSize(`${a.name}${note ? '  ' + note : ''}`, W - 2 * M), M, 20);
        if (im) { const maxW = W - 2 * M, maxH = H - 34; const sc = Math.min(maxW / im.w, maxH / im.h); doc.addImage(im.data, 'JPEG', M + (maxW - im.w * sc) / 2, 26, im.w * sc, im.h * sc); }
      });
    }
  }
  step('Finalizando…', 98);
  const pages = doc.getNumberOfPages();
  for (let i = 1; i <= pages; i++) { doc.setPage(i); doc.setFontSize(7.5); doc.setTextColor(140); doc.text(`${v.name}${v.plate ? ' · ' + v.plate : ''} — Histórico do veículo · página ${i} de ${pages}`, W / 2, H - 6, { align: 'center' }); }
  return new File([doc.output('blob')], `Historico ${v.name}${v.plate ? ' ' + v.plate : ''}.pdf`.replace(/[\\/:*?"<>|]/g, ''), { type: 'application/pdf' });
}
