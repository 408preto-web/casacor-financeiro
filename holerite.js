'use strict';

/* =========================================================
   Holerite (recibo de pagamento) em PDF, a partir da folha gerada:
   proventos (salário, VA, VT, horas extras, bônus), descontos (faltas,
   adiantamentos, descontos), líquido e assinatura. Dois recibos por folha A4.
   Usa folhaReportData/payBreakdown (rh-relatorio.js) e jsPDF já carregado por lá.
   ========================================================= */

/** Linhas do recibo a partir da composição gravada no pagamento. */
function payslipLines(p) {
  const L = [['Salário' + (p.type === 'M15' ? ' (1ª parte — dia 15)' : p.type === 'M30' ? ' (fechamento — dia 30)' : ' (semana)'), '', p.base, 0]];
  if (p.va) L.push(['Vale-alimentação', p.days ? `${p.days} dia(s)` : '', p.va, 0]);
  if (p.vt) L.push(['Vale-transporte', p.days ? `${p.days} dia(s)` : '', p.vt, 0]);
  for (const it of p.items || []) {
    const m = String(it).match(/^(.*?):\s*([+−-])\s*(R\$\s?[\d.,]+)$/); if (!m) continue;
    const v = parseMoney(m[3]); const plus = m[2] === '+';
    L.push([m[1].replace(/\s+\d{2}\/\d{2}$/, ''), (m[1].match(/\d{2}\/\d{2}$/) || [''])[0], plus ? v : 0, plus ? 0 : v]);
  }
  return L;
}

function drawPayslip(doc, p, y0) {
  const W = doc.internal.pageSize.getWidth(), M = 14, BR = [154, 52, 18];
  const m = (c) => money(c).replace(/ /g, ' ');
  const e = p.e; const b = p.b;
  if (ccLogo) { const h = 4, w = (ccLogo.w / ccLogo.h) * h; doc.addImage(ccLogo.data, 'PNG', M, y0, w, h); doc.setFont('helvetica', 'normal'); doc.setFontSize(10); doc.setTextColor(20); doc.text(unitName(), M + w + 1.6, y0 + 3.6); }
  doc.setFont('helvetica', 'bold'); doc.setFontSize(12); doc.setTextColor(20); doc.text('Recibo de pagamento', W - M, y0 + 3.6, { align: 'right' });
  doc.setFont('helvetica', 'normal'); doc.setFontSize(8.5); doc.setTextColor(90);
  doc.text(`Competência: ${monthName(b.due_date.slice(0, 7))} · Pagamento em ${fmtDate(b.paid_at || b.due_date)}${b.status === 'paid' ? '' : ' (previsto)'}`, W - M, y0 + 8.5, { align: 'right' });
  doc.setDrawColor(...BR); doc.setLineWidth(0.6); doc.line(M, y0 + 11, W - M, y0 + 11);
  doc.setTextColor(20); doc.setFontSize(9.5); doc.setFont('helvetica', 'bold'); doc.text(e.name || b.supplier, M, y0 + 17);
  doc.setFont('helvetica', 'normal'); doc.setFontSize(8.5); doc.setTextColor(80);
  doc.text([e.job_title ? `Cargo: ${e.job_title}` : '', e.cpf ? `CPF: ${String(e.cpf).replace(/(\d{3})(\d{3})(\d{3})(\d{2})/, '$1.$2.$3-$4')}` : '', e.admission_date ? `Admissão: ${fmtDate(e.admission_date)}` : '', areaById(e.area_id).name !== 'Sem área' ? `Área: ${areaById(e.area_id).name}` : ''].filter(Boolean).join('   ·   '), M, y0 + 22);
  const lines = payslipLines(p);
  const prov = lines.reduce((s, l) => s + l[2], 0), desc = lines.reduce((s, l) => s + l[3], 0);
  doc.autoTable({ startY: y0 + 25, margin: { left: M, right: M }, theme: 'plain', styles: { fontSize: 8.5, cellPadding: 1.4, textColor: 20, lineColor: 225, lineWidth: { bottom: 0.2 } },
    headStyles: { fillColor: [243, 240, 238], fontStyle: 'bold' }, footStyles: { fillColor: [250, 248, 246], fontStyle: 'bold' },
    head: [['Descrição', 'Referência', 'Proventos', 'Descontos']],
    body: lines.map((l) => [l[0], l[1], l[2] ? m(l[2]) : '', l[3] ? m(l[3]) : '']),
    foot: [['Totais', '', m(prov), desc ? m(desc) : m(0)]],
    columnStyles: { 1: { cellWidth: 26 }, 2: { halign: 'right', cellWidth: 30 }, 3: { halign: 'right', cellWidth: 30 } },
    didParseCell: (c) => { if (c.column.index >= 2) c.cell.styles.halign = 'right'; } });
  let y = doc.lastAutoTable.finalY + 6;
  doc.setFont('helvetica', 'bold'); doc.setFontSize(11); doc.setTextColor(20); doc.text(`Líquido a receber: ${m(b.cents)}`, W - M, y, { align: 'right' });
  if (prov - desc !== b.cents) { doc.setFont('helvetica', 'normal'); doc.setFontSize(7.5); doc.setTextColor(120); doc.text('(valor ajustado na folha)', W - M, y + 4, { align: 'right' }); }
  doc.setFont('helvetica', 'normal'); doc.setFontSize(8); doc.setTextColor(70);
  doc.text(doc.splitTextToSize(`Declaro ter recebido de CASACOR ${unitName()} a importância líquida de ${m(b.cents)}, referente aos valores discriminados acima.`, 110), M, y);
  y += 16; doc.setDrawColor(120); doc.setLineWidth(0.3); doc.line(M, y, M + 80, y); doc.line(W - M - 60, y, W - M, y);
  doc.text(e.name || b.supplier, M, y + 4); doc.text('Data', W - M - 60, y + 4);
  return y + 8;
}

async function buildPayslips(pays) {
  await loadPdfLibs();
  const { jsPDF } = window.jspdf; const doc = new jsPDF({ orientation: 'portrait', unit: 'mm', format: 'a4' });
  const H = doc.internal.pageSize.getHeight(), W = doc.internal.pageSize.getWidth();
  pays.forEach((p, i) => {
    const top = i % 2 === 0;
    if (i > 0 && top) doc.addPage();
    drawPayslip(doc, p, top ? 12 : H / 2 + 8);
    if (top && i + 1 < pays.length) { doc.setDrawColor(170); doc.setLineDashPattern([1.5, 1.5], 0); doc.line(8, H / 2, W - 8, H / 2); doc.setLineDashPattern([], 0); doc.setFontSize(7); doc.setTextColor(150); doc.text('✂', 4, H / 2 + 1); }
  });
  const who = new Set(pays.map((p) => p.e.id)).size === 1 ? ` - ${pays[0].e.name}` : '';
  return new File([doc.output('blob')], `Holerites ${monthName(pays[0].b.due_date.slice(0, 7))}${who} - CASACOR ${unitName()}.pdf`.replace(/[\\/:*?"<>|]/g, ''), { type: 'application/pdf' });
}

function openPayslips() {
  const d = folhaReportData(); if (!d.pays.length) { toast('Gere a folha do mês primeiro'); return; }
  const emps = [...new Map(d.pays.map((p) => [p.e.id, p.e])).values()];
  openModal(`<h2>🧾 Holerites — ${esc(monthName(d.month))}</h2>
    <p class="muted" style="margin-top:-6px">Recibo de pagamento de cada pagamento gerado na folha (dois por folha A4, para imprimir e assinar, ou mandar para o funcionário).</p>
    <label class="field"><span>De quem</span><select name="emp"><option value="">Todos (${d.pays.length} recibos)</option>${emps.map((e) => `<option value="${e.id}">${esc(e.name)} (${d.pays.filter((p) => p.e.id === e.id).length})</option>`).join('')}</select></label>
    <p class="muted small">É um recibo interno (salário, VA/VT, extras e descontos lançados no sistema). Os encargos oficiais (INSS, FGTS, IR) ficam com a contabilidade.</p>
    <div class="modal-actions"><span class="spacer"></span><button class="btn" value="cancel" formnovalidate>Cancelar</button><button class="btn primary" value="save">Gerar PDF</button></div>`,
  async (action, fd) => {
    const pays = d.pays.filter((p) => !fd.get('emp') || String(p.e.id) === fd.get('emp'));
    const file = await buildPayslips(pays);
    setTimeout(() => {
      openModal(`<h2>🧾 Holerites prontos</h2><p class="muted">${esc(file.name)}</p>
        <button type="button" class="btn wa-btn big" id="psSend">📲 Enviar / salvar</button>
        <div class="modal-actions"><span class="spacer"></span><button class="btn" value="cancel" formnovalidate>Fechar</button></div>`, () => {},
      () => $('#psSend').addEventListener('click', async () => {
        try { if (navigator.canShare?.({ files: [file] })) { await navigator.share({ files: [file], title: file.name }); return; } } catch (e) { if (e?.name === 'AbortError') return; }
        const a = document.createElement('a'); a.href = URL.createObjectURL(file); a.download = file.name; document.body.appendChild(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(a.href), 5000);
      }));
    }, 0);
  });
}
