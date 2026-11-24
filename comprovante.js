'use strict';

/* =========================================================
   Anexar comprovante: escolhe (ou compartilha) o arquivo, o sistema lê
   valor, data e nomes, e sugere as contas que combinam.
   - PDF: texto lido com pdf.js; foto/print: leitura de texto (OCR) com Tesseract.
   - Android (app instalado): aparece no menu "Compartilhar" (share_target do manifest).
   Usa as funções e o estado globais de app.js (chamadas só em tempo de execução).
   ========================================================= */

const PDFJS = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/';
const TESSERACT = 'https://cdn.jsdelivr.net/npm/tesseract.js@5.1.1/dist/tesseract.min.js';

function loadScriptOnce(src) {
  return new Promise((res, rej) => {
    if ([...document.scripts].some((s) => s.src === src && s.dataset.ok)) return res();
    const s = document.createElement('script'); s.src = src;
    s.onload = () => { s.dataset.ok = '1'; res(); };
    s.onerror = () => rej(new Error('Sem internet para ler o comprovante'));
    document.head.appendChild(s);
  });
}

async function ocrImage(img, progress) {
  await loadScriptOnce(TESSERACT);
  const r = await Tesseract.recognize(img, 'por', { logger: (m) => m.status === 'recognizing text' && progress?.(Math.round(m.progress * 100)) });
  return r.data.text || '';
}

async function pdfText(file, progress) {
  await loadScriptOnce(PDFJS + 'pdf.min.js');
  pdfjsLib.GlobalWorkerOptions.workerSrc = PDFJS + 'pdf.worker.min.js';
  const doc = await pdfjsLib.getDocument({ data: await file.arrayBuffer() }).promise;
  let text = '';
  for (let i = 1; i <= Math.min(doc.numPages, 3); i++) {
    const c = await (await doc.getPage(i)).getTextContent();
    text += c.items.map((x) => x.str + (x.hasEOL ? '\n' : ' ')).join('') + '\n';
  }
  if (text.replace(/\s/g, '').length > 30) return text;
  // PDF escaneado (só imagem): desenha a 1ª página e lê como foto
  const page = await doc.getPage(1); const vp = page.getViewport({ scale: 2 });
  const cv = document.createElement('canvas'); cv.width = vp.width; cv.height = vp.height;
  await page.render({ canvasContext: cv.getContext('2d'), viewport: vp }).promise;
  return ocrImage(cv, progress);
}

async function readReceipt(file, progress) {
  if (/pdf/i.test(file.type) || /\.pdf$/i.test(file.name)) return pdfText(file, progress);
  if (/^image\//.test(file.type)) return ocrImage(file, progress);
  return '';
}

/* ---------- O que dá para tirar do texto ---------- */
const MONTHS_PT = { jan: 1, fev: 2, mar: 3, abr: 4, mai: 5, jun: 6, jul: 7, ago: 8, set: 9, out: 10, nov: 11, dez: 12 };
const normR = (s) => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
const STOP = new Set(['ltda', 'eireli', 'epp', 'me', 'mei', 'sa', 's/a', 'da', 'de', 'do', 'das', 'dos', 'e', 'comercio', 'servicos', 'industria', 'conta', 'pagamento', 'casa', 'cor', 'ceara']);

function parseReceipt(text) {
  const t = normR(text).replace(/\s+/g, ' ');
  const amounts = []; const seen = new Set();
  const addAmt = (s, strong) => { const c = parseMoney(s); if (c > 0 && c < 1e10) { if (!seen.has(c)) { seen.add(c); amounts.push({ cents: c, strong }); } else if (strong) amounts.find((a) => a.cents === c).strong = true; } };
  for (const m of t.matchAll(/valor[^0-9]{0,25}(\d{1,3}(?:[.\s]\d{3})*,\d{2})/g)) addAmt(m[1].replace(/\s/g, ''), true);
  for (const m of t.matchAll(/r\s?[$s5]\s*(\d{1,3}(?:[.\s]?\d{3})*,\d{2})/g)) addAmt(m[1].replace(/\s/g, ''), false);
  const dates = new Set();
  for (const m of t.matchAll(/(\d{2})\/(\d{2})\/(\d{4})/g)) dates.add(`${m[3]}-${m[2]}-${m[1]}`);
  for (const m of t.matchAll(/(\d{1,2})\s*(?:de\s+)?(jan|fev|mar|abr|mai|jun|jul|ago|set|out|nov|dez)[a-z]*\.?\s*(?:de\s+)?(\d{4})/g)) dates.add(`${m[3]}-${String(MONTHS_PT[m[2]]).padStart(2, '0')}-${m[1].padStart(2, '0')}`);
  const validDates = [...dates].filter((d) => !Number.isNaN(Date.parse(d)) && d >= '2020-01-01' && d <= addDaysISO(todayISO(), 2)).sort().reverse();
  const AMT = '(\\d{1,3}(?:[.\\s]?\\d{3})*,\\d{2})';
  const grab = (words) => [...t.matchAll(new RegExp(`(?:${words})[^0-9]{0,30}?(?:r\\s?[$s5]\\s*)?${AMT}`, 'g'))].map((m) => parseMoney(m[1].replace(/\s/g, ''))).filter((c) => c > 0);
  const paidList = grab('valor\\s+(?:total\\s+)?pago|total\\s+pago|valor\\s+cobrado|valor\\s+do\\s+pagamento|valor\\s+debitado|valor\\s+total|total\\s+a\\s+pagar');
  const origList = grab('valor\\s+(?:do\\s+)?documento|valor\\s+nominal|valor\\s+original|valor\\s+do\\s+(?:boleto|titulo)|valor\\s+da\\s+fatura');
  const extraCents = grab('juros|multa|mora|encargos|acrescimos?').reduce((s, c) => s + c, 0);
  const discCents = grab('desconto|abatimento').reduce((s, c) => s + c, 0);
  [...paidList, ...origList].forEach((c) => { if (!seen.has(c)) { seen.add(c); amounts.push({ cents: c, strong: true }); } });
  return { text: t, raw: String(text || ''), digits: t.replace(/\D/g, ''), amounts, dates: validDates, payee: extractPayee(text), pix: /\bpix\b/.test(t),
    paidCents: paidList.length ? Math.max(...paidList) : null, origCents: origList[0] || null, extraCents, discCents };
}

/** Nome de quem recebeu (destino / favorecido / para…), para virar o fornecedor. */
function extractPayee(text) {
  const raw = String(text || '').replace(/\r/g, '');
  const stop = /^(cpf|cnpj|chave|institui|banco|ag[eê]ncia|conta|valor|data|tipo|id|autentica|c[oó]digo|documento|\*|r\$)/i;
  const clean = (s) => s.replace(/^(nome|raz[aã]o social)\s*:?\s*/i, '').replace(/\s+(cpf|cnpj|chave|institui[cç][aã]o|banco)\b.*$/i, '').replace(/[•*]+/g, '').trim();
  const lines = raw.split('\n').map((l) => l.trim()).filter(Boolean);
  const head = /^(destino|para|favorecido|recebedor|benefici[aá]rio|quem recebeu|dados do recebedor|pago a|transferido para|enviado para)\b/i;
  for (let i = 0; i < lines.length; i++) {
    if (!head.test(lines[i])) continue;
    const same = clean(lines[i].replace(head, '').replace(/^\s*:?\s*/, ''));
    if (same.length >= 3 && /[a-zà-ú]{2}/i.test(same) && !stop.test(same)) return titleName(same);
    for (let j = i + 1; j < Math.min(lines.length, i + 4); j++) {
      const c = clean(lines[j]);
      if (c.length >= 3 && /[a-zà-ú]{3}/i.test(c) && !stop.test(c) && !head.test(c)) return titleName(c);
    }
  }
  const m = raw.replace(/\s+/g, ' ').match(/(?:destino|favorecido|recebedor|benefici[aá]rio|para)\s*:?\s*(?:nome\s*:?\s*)?([A-ZÀ-Úa-zà-ú][A-ZÀ-Úa-zà-ú0-9.&' -]{2,60}?)(?=\s+(?:cpf|cnpj|chave|institui|banco|ag[eê]ncia|conta|valor|data)\b|$)/i);
  return m ? titleName(clean(m[1])) : '';
}
const titleName = (s) => (s === s.toUpperCase() ? s.toLowerCase().replace(/(^|\s)(\S)/g, (x, a, b) => a + b.toUpperCase()).replace(/\s(D[aeo]s?|E|Ltda|Me|S\/a)\b/gi, (x) => (/ltda|me|s\/a/i.test(x) ? x.toUpperCase() : x.toLowerCase())) : s).slice(0, 80);

/** Quanto foi pago de verdade, pelo comprovante: valor pago informado; senão original + juros − desconto;
 *  senão, se a conta estava atrasada, um valor até 20% maior que o da conta (juros/multa); senão o valor da conta. */
function receiptPaidCents(billCents, info, overdue) {
  if (info.paidCents) return info.paidCents;
  if (info.origCents && (info.extraCents || info.discCents)) return info.origCents + info.extraCents - info.discCents;
  if (overdue) { const up = info.amounts.map((a) => a.cents).filter((c) => c > billCents && c <= billCents * 1.2).sort((x, y) => y - x)[0]; if (up) return up; }
  return info.amounts.find((a) => a.cents === billCents)?.cents ?? info.amounts.find((a) => a.strong)?.cents ?? billCents;
}
/** Texto de juros/multa ou desconto (diferença entre o pago e o valor da conta). */
function paidDiffNote(billCents, paidCents) {
  const d = paidCents - billCents; if (!d) return {};
  return d > 0 ? { hint: `⚠️ Pago com juros/multa: <b>+ ${money(d)}</b> (conta de ${money(billCents)} → pago ${money(paidCents)})`, notes: `Juros/multa de ${money(d)} (valor da conta ${money(billCents)})` }
    : { hint: `💚 Pago com desconto: <b>− ${money(-d)}</b> (conta de ${money(billCents)} → pago ${money(paidCents)})`, notes: `Desconto de ${money(-d)} (valor da conta ${money(billCents)})` };
}

const daysBetween = (a, b) => Math.abs((Date.parse(a) - Date.parse(b)) / 864e5);

function scoreBill(b, info) {
  let score = 0; const why = [];
  const cents = b.status === 'paid' && b.paidCents != null ? b.paidCents : b.cents;
  const exact = info.amounts.find((a) => a.cents === cents);
  if (exact) { score += exact.strong ? 55 : 45; why.push('valor igual'); }
  else if (b.status === 'pending' && info.amounts.some((a) => a.cents > cents && a.cents <= cents * 1.2 && (b.due_date < (info.dates[0] || todayISO())))) { score += 35; why.push('valor + juros (atrasada)'); }
  else if (info.amounts.some((a) => Math.abs(a.cents - cents) <= Math.max(100, cents * 0.02))) { score += 15; why.push('valor parecido'); }
  const words = normR(`${b.supplier}`).split(/[^a-z0-9]+/).filter((w) => w.length >= 3 && !STOP.has(w));
  const hits = words.filter((w) => info.text.includes(w));
  if (hits.length) { score += Math.round(35 * Math.min(1, hits.length / Math.min(words.length, 2))); why.push('nome confere'); }
  const key = String(b.pix_key || '').trim();
  const keyDigits = key.replace(/\D/g, '');
  if ((keyDigits.length >= 8 && info.digits.includes(keyDigits)) || (key.includes('@') && info.text.includes(normR(key)))) { score += 40; why.push('chave Pix confere'); }
  const ref = b.status === 'paid' ? b.paid_at : b.due_date;
  if (ref && info.dates.length) {
    const d = Math.min(...info.dates.map((x) => daysBetween(x, ref)));
    if (d <= 3) { score += 15; why.push(b.status === 'paid' ? 'data do pagamento' : 'vencimento próximo'); } else if (d <= 10) score += 7;
  }
  if (b.status === 'pending') score += 3;
  return { b, score, why };
}

const hasReceipt = (b) => (b.attachments || []).some((a) => a.kind === 'comprovante');
const receiptOpen = (b) => (b.status === 'pending' && b.approval !== 'rejected') || (b.status === 'paid' && !hasReceipt(b));
const receiptCandidates = () => state.bills.filter(receiptOpen);

/** Contas das OUTRAS franquias liberadas (o comprovante pode ser do Piauí com o app no Ceará). */
async function otherUnitReceiptBills() {
  const others = (typeof myUnits === 'function' ? myUnits() : []).map((u) => u.code).filter((c) => c !== state.unit);
  if (!others.length) return [];
  try {
    const rows = await api.select('bills', `select=*&unit=in.(${others.join(',')})&status=in.(pending,paid)&order=due_date`);
    return rows.map(normBill).filter(receiptOpen);
  } catch { return []; }
}
/** Faturas de cartão: compras do mesmo cartão e vencimento viram um candidato só (valor = total da fatura). */
function invoiceCandidates(bills) {
  const g = {};
  for (const b of bills) if (b.method === 'cartao' && b.card_id) (g[`${b.unit || ''}|${b.card_id}|${b.due_date}`] ||= []).push(b);
  return Object.entries(g).filter(([, list]) => list.length > 1).map(([key, list]) => {
    const card = (b) => (String(b.unit || state.unit) === String(state.unit) ? cardById(b.card_id) : null);
    const pend = list.some((b) => b.status === 'pending');
    return { id: 'inv:' + key, invoice: true, bills: list, unit: list[0].unit, supplier: `Fatura ${card(list[0]) ? cardLabel(card(list[0])) : 'do cartão'}`,
      description: `${list.length} compras`, cents: list.reduce((s, b) => s + b.cents, 0), paidCents: pend ? null : list.reduce((s, b) => s + (b.paidCents ?? b.cents), 0),
      status: pend ? 'pending' : 'paid', due_date: list[0].due_date, paid_at: list[0].paid_at, pix_key: '', attachments: [] };
  });
}
function allReceiptCandidates(info) {
  const bills = [...receiptCandidates(), ...(info.others || [])];
  return [...bills, ...invoiceCandidates(bills)];
}

/* ---------- Telas ---------- */
function openReceiptFlow(files) {
  if (!isPayer()) { toast('Só quem paga pode anexar comprovantes de pagamento.'); return; }
  if (files?.length) return analyzeReceipt([...files]);
  openModal(`<h2>📎 Anexar comprovante</h2>
    <p class="muted" style="margin-top:-6px">Escolha a foto, o print ou o PDF do comprovante. O sistema lê o valor, a data e o nome, e mostra as contas que combinam.</p>
    <label class="btn primary big rc-pick">📄 Escolher comprovante<input type="file" id="rcFile" accept="image/*,application/pdf" hidden></label>
    <div class="modal-actions"><span class="spacer"></span><button class="btn" value="cancel" formnovalidate>Cancelar</button></div>`,
  () => false, () => $('#rcFile').addEventListener('change', (e) => e.target.files.length && analyzeReceipt([...e.target.files])));
}

async function analyzeReceipt(files) {
  const file = files[0];
  const show = (pct) => openModal(`<h2>📎 Lendo o comprovante…</h2>
    <p class="muted">${esc(file.name)}</p><div class="rc-loading"><div class="rc-bar" style="width:${pct || 8}%"></div></div>
    <p class="muted small">Procurando valor, data e nome de quem recebeu.</p>
    <div class="modal-actions"><span class="spacer"></span><button class="btn" value="cancel" formnovalidate>Cancelar</button></div>`, () => {});
  show(5);
  let info = { text: '', digits: '', amounts: [], dates: [] }; let failed = '';
  try {
    const text = await readReceipt(file, (p) => { const bar = $('.rc-bar', modalForm); if (bar) bar.style.width = Math.max(8, p) + '%'; });
    info = parseReceipt(text);
  } catch (e) { failed = e.message; }
  info.others = await otherUnitReceiptBills();
  if (!modal.open || !$('.rc-loading', modalForm)) return; // cancelou
  pickBillForReceipt(files, info, failed);
}

function pickBillForReceipt(files, info, failed = '', q = '') {
  const cands = allReceiptCandidates(info);
  const cmap = new Map(cands.map((b) => [String(b.id), b]));
  const ranked = cands.map((b) => scoreBill(b, info)).filter((r) => r.score >= 20).sort((a, b) => b.score - a.score).slice(0, 6);
  const nq = normR(q).trim();
  const searchable = [...state.bills.filter((b) => b.status !== 'cancelled'), ...(info.others || []), ...cands.filter((c) => c.invoice)];
  searchable.forEach((b) => cmap.set(String(b.id), b));
  const list = nq ? searchable.filter((b) => normR(`${b.supplier} ${b.description} ${money(b.cents)} ${centsToInput(b.cents)}`).includes(nq)).slice(0, 12).map((b) => ({ b, why: [] }))
    : ranked.length ? ranked : cands.filter((b) => b.status === 'pending').sort((a, b) => a.due_date.localeCompare(b.due_date)).slice(0, 8).map((b) => ({ b, why: [] }));
  const found = info.amounts.length || info.dates.length;
  const row = ({ b, why }, i) => `<li><button type="button" class="rc-cand ${i === 0 && !nq && ranked.length ? 'best' : ''}" data-rcbill="${b.id}">
      <div class="rc-main"><b>${b.invoice ? '💳 ' : ''}${esc(b.supplier)}${b.unit && b.unit !== state.unit && typeof unitName === 'function' ? ` <span class="badge open">📍 ${esc(unitName(b.unit))}</span>` : ''}</b><span>${esc(b.description || '')}${b.installment ? ' · ' + esc(b.installment) : ''}</span>
        <span class="muted">${b.status === 'paid' ? `paga em ${fmtDate(b.paid_at)} · sem comprovante` : `vence ${fmtDate(b.due_date)}`}</span>
        ${why.length ? `<span class="rc-why">${why.map((w) => '✓ ' + w).join(' · ')}</span>` : ''}</div>
      <div class="rc-amt">${money(b.status === 'paid' && b.paidCents != null ? b.paidCents : b.cents)}</div></button></li>`;
  openModal(`<h2>📎 Qual conta é?</h2>
    <div class="rc-found">${failed ? `⚠️ ${esc(failed)}. Escolha a conta abaixo.`
      : found ? `No comprovante: ${info.amounts.slice(0, 3).map((a) => `<b>${money(a.cents)}</b>`).join(', ')}${info.dates[0] ? ` · ${fmtDate(info.dates[0])}` : ''}`
      : 'Não consegui ler o valor desse arquivo. Escolha a conta abaixo.'}</div>
    ${!nq && !ranked.length ? `<div class="rc-new"><b>Não achei essa conta no sistema.</b> <span class="muted">Quer lançar agora, já como paga, com este comprovante?</span>
      <button type="button" class="btn primary" id="rcNew">➕ Lançar esta conta agora</button></div>` : ''}
    <ul class="rc-list">${list.map(row).join('') || '<li class="muted">Nenhuma conta encontrada.</li>'}</ul>
    <label class="field"><span>Procurar outra conta</span><input id="rcQ" value="${esc(q)}" placeholder="Fornecedor, descrição ou valor" autocomplete="off"></label>
    ${ranked.length || nq ? '<button type="button" class="btn rc-new-link" id="rcNew">➕ Não está na lista — lançar como nova conta paga</button>' : ''}
    <div class="modal-actions"><span class="spacer"></span><button class="btn" value="cancel" formnovalidate>Cancelar</button></div>`,
  () => false, () => {
    $('#rcNew')?.addEventListener('click', () => openNewPaidBill(files, info));
    $$('[data-rcbill]', modalForm).forEach((el) => el.addEventListener('click', () => attachReceiptTo(cmap.get(el.dataset.rcbill), files, info)));
    const inp = $('#rcQ'); let t;
    inp.addEventListener('input', () => { clearTimeout(t); t = setTimeout(() => { const v = inp.value; pickBillForReceipt(files, info, failed, v); const n = $('#rcQ'); n.focus(); n.setSelectionRange(v.length, v.length); }, 250); });
  });
}

async function attachReceiptTo(c, files, info) {
  if (!c) return;
  // Conta da outra franquia: troca de franquia antes (o app só altera contas da franquia aberta)
  if (c.unit && typeof unitsOn === 'function' && unitsOn() && c.unit !== state.unit) {
    state.unit = c.unit; applyUnit(); await loadAll({ quiet: true }); render(); toast(`Agora: CASACOR ${unitName()}`);
  }
  const bills = (c.invoice ? c.bills : [c]).map((x) => state.bills.find((y) => String(y.id) === String(x.id))).filter(Boolean);
  if (!bills.length) { toast('Não encontrei essa conta. Atualize e tente de novo.'); return; }
  if (c.invoice) {
    const pend = bills.filter((x) => x.status === 'pending');
    const paidAt = info.dates.find((d) => d <= todayISO()) || todayISO();
    if (pend.length) return openPay(pend, `Pagar fatura (${pend.length} compras)`, { files, paidAt });
    return openModal(`<h2>📎 Anexar comprovante</h2><p><b>${esc(c.supplier)}</b> · ${bills.length} compras · ${money(bills.reduce((s, x) => s + (x.paidCents ?? x.cents), 0))}</p>
      <p class="muted">O comprovante vai para todas as compras desta fatura.</p>
      <div class="modal-actions"><span class="spacer"></span><button class="btn" value="cancel" formnovalidate>Cancelar</button><button class="btn primary" value="save">Anexar</button></div>`,
    async () => {
      const receipts = await uploadFiles(files, `pagamentos/${uuid()}`, 'comprovante');
      for (const x of bills) await api.update('bills', `id=eq.${x.id}`, { attachments: [...x.attachments, ...receipts] });
      toast('Comprovante anexado à fatura ✅'); await loadAll({ quiet: true }); render();
    });
  }
  const b = bills[0];
  if (b.status === 'pending') {
    const paidAt = info.dates.find((d) => d <= todayISO()) || todayISO();
    const amount = receiptPaidCents(b.cents, info, b.due_date < paidAt);
    return openPay([b], 'Marcar como pago', { files, amountCents: amount, paidAt, notes: paidDiffNote(b.cents, amount).notes || '' });
  }
  // Conta já paga: se o comprovante mostra outro valor (juros/multa ou desconto), oferece corrigir o valor pago
  const nowPaid = b.paidCents ?? b.cents;
  const real = receiptPaidCents(b.cents, info, b.due_date < (b.paid_at || todayISO()));
  const fix = real && real !== nowPaid && Math.abs(real - b.cents) <= b.cents * 0.5 ? paidDiffNote(b.cents, real) : null;
  openModal(`<h2>📎 Anexar comprovante</h2>
    <p><b>${esc(b.supplier)}</b> · ${money(nowPaid)}<br><span class="muted">paga em ${fmtDate(b.paid_at)}</span></p>
    ${fix ? `<div class="rc-diff">${fix.hint || ''}<label class="check"><input type="checkbox" name="fixpaid" checked><span>Atualizar o valor pago para <b>${money(real)}</b></span></label></div>` : ''}
    <p class="muted">Arquivo: ${files.map((f) => esc(f.name)).join(', ')}</p>
    <div class="modal-actions"><span class="spacer"></span><button class="btn" value="cancel" formnovalidate>Cancelar</button><button class="btn primary" value="save">Anexar</button></div>`,
  async (action, fd) => {
    const receipts = await uploadFiles(files, `pagamentos/${uuid()}`, 'comprovante');
    const patch = { attachments: [...b.attachments, ...receipts] };
    if (fix && fd.get('fixpaid') === 'on') { patch.paid_amount = real / 100; patch.payment_notes = [b.payment_notes, fix.notes].filter(Boolean).join(' · '); }
    const rows = await api.update('bills', `id=eq.${b.id}`, patch);
    if (!rows?.length) throw new Error('Não foi possível anexar (permissão).');
    toast('Comprovante anexado ✅'); await loadAll({ quiet: true }); render();
  });
}

/* ---------- Conta que não estava no sistema: lança já paga, com o comprovante ---------- */
async function openNewPaidBill(files, info) {
  const units = typeof myUnits === 'function' && unitsOn() ? myUnits() : [];
  let unit = state.unit; let areas = state.areas;
  const amount = info.amounts.find((a) => a.strong)?.cents ?? info.amounts[0]?.cents ?? 0;
  const date = info.dates.find((d) => d <= todayISO()) || todayISO();
  const catOpts = (areaId, cur = '') => {
    const cats = areas.find((a) => String(a.id) === String(areaId))?.categories || [];
    if (!areaId) return '<option value="">Escolha a área primeiro</option>';
    return `<option value="">${cats.length ? 'Escolha…' : '— (sem categorias)'}</option>${cats.map((c) => `<option ${c === cur ? 'selected' : ''}>${esc(c)}</option>`).join('')}<option value="__new">➕ Criar categoria…</option>`;
  };
  const areaOpts = () => `<option value="">Escolha…</option>${areas.filter((a) => a.active).map((a) => `<option value="${a.id}">${esc(a.name)}</option>`).join('')}`;
  const payers = state.members.filter((m) => ['payer', 'admin'].includes(m.role));
  openModal(`<h2>➕ Lançar conta paga</h2>
    <p class="muted" style="margin-top:-6px">Preenchido com o que li no comprovante. Confira e escolha a área e a categoria.</p>
    <div class="form-grid">
      ${units.length > 1 ? `<label class="field full"><span>Franquia</span><select name="unit">${units.map((u) => `<option value="${u.code}" ${u.code === unit ? 'selected' : ''}>CASACOR ${esc(u.name)}</option>`).join('')}</select></label>` : ''}
      <label class="field full"><span>Fornecedor (quem recebeu) *</span><input name="supplier" value="${esc(info.payee || '')}" required placeholder="Ex.: Depósito São José" autocomplete="off"></label>
      <label class="field"><span>Área *</span><select name="area_id" required>${areaOpts()}</select></label>
      <label class="field"><span>Categoria *</span><select name="category" disabled>${catOpts('')}</select></label>
      <label class="field full"><span>Descrição (opcional)</span><input name="description" placeholder="Ex.: areia e cimento para o contrapiso"></label>
      <label class="field"><span>Valor pago (R$) *</span><input class="amount-input" name="amount" inputmode="decimal" value="${amount ? centsToInput(amount) : ''}" required></label>
      <label class="field"><span>Data do pagamento *</span><input type="date" name="paid_at" value="${date}" required></label>
      <label class="field"><span>Forma</span><select name="method">${['pix', 'transferencia', 'boleto', 'dinheiro'].map((m) => `<option value="${m}" ${(info.pix ? 'pix' : 'transferencia') === m ? 'selected' : ''}>${METHODS[m].label}</option>`).join('')}</select></label>
      <label class="field"><span>Pago por</span><select name="paid_by">${payers.map((p) => `<option value="${p.user_id}" ${p.user_id === state.me.user_id ? 'selected' : ''}>${esc(p.name)}</option>`).join('')}</select></label>
      <div class="field full"><span>Comprovante</span><div class="rc-attached">📎 ${files.map((f) => esc(f.name)).join(', ')}</div></div>
    </div>
    <div class="modal-actions"><button type="button" class="btn" id="rcBack">⬅️ Voltar à lista</button><span class="spacer"></span><button class="btn" value="cancel" formnovalidate>Cancelar</button><button class="btn primary" value="save">Lançar como paga</button></div>`,
  async (action, fd) => {
    const cents = parseMoney(fd.get('amount')); const areaId = fd.get('area_id'); const cat = fd.get('category') === '__new' ? '' : fd.get('category') || '';
    const a = areas.find((x) => String(x.id) === String(areaId));
    if (!fd.get('supplier').trim() || !areaId) { toast('Preencha fornecedor e área'); return false; }
    if (!cat && (a?.categories || []).length) { toast('Escolha a categoria'); return false; }
    if (cents <= 0) { toast('Informe o valor pago'); return false; }
    const paidAt = fd.get('paid_at');
    const receipts = await uploadFiles(files, `pagamentos/${uuid()}`, 'comprovante');
    const editionRow = unit === state.unit ? state.settings : (await api.select('settings', `select=*&unit=eq.${unit}`).catch(() => []))[0];
    const row = { unit, supplier: fd.get('supplier').trim(), description: fd.get('description').trim(), area_id: Number(areaId), category: cat,
      amount: cents / 100, purchase_date: paidAt, due_date: paidAt, method: fd.get('method'), edition: editionRow?.edition || '',
      status: 'paid', paid_at: paidAt, paid_by: fd.get('paid_by'), paid_amount: cents / 100, attachments: receipts };
    if (!catsOn()) delete row.category;
    if (!unitsOn()) delete row.unit;
    await api.insert('bills', row);
    if (unit !== state.unit && unitsOn()) { state.unit = unit; applyUnit(); }
    toast(`Conta lançada como paga ✅ ${row.supplier} · ${money(cents)}`);
    await loadAll({ quiet: true }); render();
  }, () => {
    const areaSel = $('[name=area_id]', modalForm), catSel = $('[name=category]', modalForm);
    areaSel.addEventListener('change', () => { catSel.disabled = !areaSel.value; catSel.innerHTML = catOpts(areaSel.value); });
    catSel.addEventListener('change', async () => {
      if (catSel.value !== '__new') return;
      const name = (prompt(`Nova categoria em ${areas.find((x) => String(x.id) === areaSel.value)?.name}:`) || '').trim();
      if (!name) { catSel.innerHTML = catOpts(areaSel.value); return; }
      try {
        const cats = await api.rpc('add_area_category', { p_area: Number(areaSel.value), p_name: name });
        const a = areas.find((x) => String(x.id) === areaSel.value); if (a && Array.isArray(cats)) a.categories = cats;
        catSel.innerHTML = catOpts(areaSel.value, (cats || []).find((c) => c.toLowerCase() === name.toLowerCase()) || name);
      } catch (e) { toast(e.message); catSel.innerHTML = catOpts(areaSel.value); }
    });
    $('[name=unit]', modalForm)?.addEventListener('change', async (e) => {
      unit = e.target.value;
      areas = unit === state.unit ? state.areas : await api.select('areas', `select=*&unit=eq.${unit}&order=sort,name`).catch(() => []);
      areaSel.innerHTML = areaOpts(); catSel.disabled = true; catSel.innerHTML = catOpts('');
    });
    $('#rcBack').addEventListener('click', () => pickBillForReceipt(files, info));
    if (!info.payee) setTimeout(() => $('[name=supplier]', modalForm)?.focus(), 80);
  });
}

/* ---------- Compartilhado pelo Android (share_target) ---------- */
let sharedBusy = false;
async function takeSharedFiles() {
  // Não depende só do endereço: se o app recarregar no meio (ex.: atualização), o comprovante continua guardado.
  if (sharedBusy) return;
  if (new URLSearchParams(location.search).has('compartilhado')) history.replaceState(null, '', location.pathname);
  try {
    const c = await caches.open('casacor-share'); const keys = await c.keys(); const files = [];
    for (const k of keys) {
      const ts = Number((k.url.match(/shared\/(\d+)-/) || [])[1]) || 0;
      if (ts && Date.now() - ts > 30 * 60000) { await c.delete(k); continue; } // esquecido há mais de 30 min
      const r = await c.match(k); const blob = await r.blob();
      files.push(new File([blob], decodeURIComponent(r.headers.get('x-name') || 'comprovante'), { type: blob.type }));
    }
    if (!files.length) return;
    sharedBusy = true; window.__sharing = true;
    const clear = async () => { for (const k of keys) await c.delete(k).catch(() => {}); sharedBusy = false; window.__sharing = false; };
    openReceiptFlow(files);
    // apaga só quando terminar (anexou, pagou ou cancelou)
    const onClose = () => setTimeout(() => { if (!modal.open) { modal.removeEventListener('close', onClose); clear(); } }, 400);
    modal.addEventListener('close', onClose);
  } catch { sharedBusy = false; window.__sharing = false; toast('Não consegui abrir o arquivo compartilhado'); }
}
