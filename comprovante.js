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
    text += c.items.map((x) => x.str).join(' ') + '\n';
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
  return { text: t, digits: t.replace(/\D/g, ''), amounts, dates: validDates };
}

const daysBetween = (a, b) => Math.abs((Date.parse(a) - Date.parse(b)) / 864e5);

function scoreBill(b, info) {
  let score = 0; const why = [];
  const cents = b.status === 'paid' && b.paidCents != null ? b.paidCents : b.cents;
  const exact = info.amounts.find((a) => a.cents === cents);
  if (exact) { score += exact.strong ? 55 : 45; why.push('valor igual'); }
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
const receiptCandidates = () => state.bills.filter((b) => b.status === 'pending' || (b.status === 'paid' && !hasReceipt(b)));

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
  if (!modal.open || !$('.rc-loading', modalForm)) return; // cancelou
  pickBillForReceipt(files, info, failed);
}

function pickBillForReceipt(files, info, failed = '', q = '') {
  const cands = receiptCandidates();
  const ranked = cands.map((b) => scoreBill(b, info)).filter((r) => r.score >= 20).sort((a, b) => b.score - a.score).slice(0, 6);
  const nq = normR(q).trim();
  const list = nq ? state.bills.filter((b) => b.status !== 'cancelled' && normR(`${b.supplier} ${b.description} ${money(b.cents)}`).includes(nq)).slice(0, 12).map((b) => ({ b, why: [] }))
    : ranked.length ? ranked : cands.filter((b) => b.status === 'pending').sort((a, b) => a.due_date.localeCompare(b.due_date)).slice(0, 8).map((b) => ({ b, why: [] }));
  const found = info.amounts.length || info.dates.length;
  const row = ({ b, why }, i) => `<li><button type="button" class="rc-cand ${i === 0 && !nq && ranked.length ? 'best' : ''}" data-rcbill="${b.id}">
      <div class="rc-main"><b>${esc(b.supplier)}</b><span>${esc(b.description || '')}${b.installment ? ' · ' + esc(b.installment) : ''}</span>
        <span class="muted">${b.status === 'paid' ? `paga em ${fmtDate(b.paid_at)} · sem comprovante` : `vence ${fmtDate(b.due_date)}`}</span>
        ${why.length ? `<span class="rc-why">${why.map((w) => '✓ ' + w).join(' · ')}</span>` : ''}</div>
      <div class="rc-amt">${money(b.status === 'paid' && b.paidCents != null ? b.paidCents : b.cents)}</div></button></li>`;
  openModal(`<h2>📎 Qual conta é?</h2>
    <div class="rc-found">${failed ? `⚠️ ${esc(failed)}. Escolha a conta abaixo.`
      : found ? `No comprovante: ${info.amounts.slice(0, 3).map((a) => `<b>${money(a.cents)}</b>`).join(', ')}${info.dates[0] ? ` · ${fmtDate(info.dates[0])}` : ''}`
      : 'Não consegui ler o valor desse arquivo. Escolha a conta abaixo.'}</div>
    ${!nq && found && !ranked.length ? '<p class="muted small">Nenhuma conta com esse valor. Veja as contas a pagar ou procure abaixo.</p>' : ''}
    <ul class="rc-list">${list.map(row).join('') || '<li class="muted">Nenhuma conta encontrada.</li>'}</ul>
    <label class="field"><span>Procurar outra conta</span><input id="rcQ" value="${esc(q)}" placeholder="Fornecedor, descrição ou valor" autocomplete="off"></label>
    <div class="modal-actions"><span class="spacer"></span><button class="btn" value="cancel" formnovalidate>Cancelar</button></div>`,
  () => false, () => {
    $$('[data-rcbill]', modalForm).forEach((el) => el.addEventListener('click', () => attachReceiptTo(state.bills.find((b) => String(b.id) === el.dataset.rcbill), files, info)));
    const inp = $('#rcQ'); let t;
    inp.addEventListener('input', () => { clearTimeout(t); t = setTimeout(() => { const v = inp.value; pickBillForReceipt(files, info, failed, v); const n = $('#rcQ'); n.focus(); n.setSelectionRange(v.length, v.length); }, 250); });
  });
}

function attachReceiptTo(b, files, info) {
  if (!b) return;
  if (b.status === 'pending') {
    const amount = info.amounts.find((a) => a.cents === b.cents)?.cents ?? info.amounts.find((a) => a.strong)?.cents ?? b.cents;
    const paidAt = info.dates.find((d) => d <= todayISO()) || todayISO();
    return openPay([b], 'Marcar como pago', { files, amountCents: amount, paidAt });
  }
  openModal(`<h2>📎 Anexar comprovante</h2>
    <p><b>${esc(b.supplier)}</b> · ${money(b.paidCents ?? b.cents)}<br><span class="muted">paga em ${fmtDate(b.paid_at)}</span></p>
    <p class="muted">Arquivo: ${files.map((f) => esc(f.name)).join(', ')}</p>
    <div class="modal-actions"><span class="spacer"></span><button class="btn" value="cancel" formnovalidate>Cancelar</button><button class="btn primary" value="save">Anexar</button></div>`,
  async () => {
    const receipts = await uploadFiles(files, `pagamentos/${uuid()}`, 'comprovante');
    const rows = await api.update('bills', `id=eq.${b.id}`, { attachments: [...b.attachments, ...receipts] });
    if (!rows?.length) throw new Error('Não foi possível anexar (permissão).');
    toast('Comprovante anexado ✅'); await loadAll({ quiet: true }); render();
  });
}

/* ---------- Compartilhado pelo Android (share_target) ---------- */
async function takeSharedFiles() {
  if (!new URLSearchParams(location.search).has('compartilhado')) return;
  history.replaceState(null, '', location.pathname);
  try {
    const c = await caches.open('casacor-share'); const keys = await c.keys(); const files = [];
    for (const k of keys) {
      const r = await c.match(k); const blob = await r.blob();
      files.push(new File([blob], decodeURIComponent(r.headers.get('x-name') || 'comprovante'), { type: blob.type }));
      await c.delete(k);
    }
    if (files.length) openReceiptFlow(files);
  } catch { toast('Não consegui abrir o arquivo compartilhado'); }
}
