'use strict';

/* =========================================================
   Leitura de boleto: foto, PDF ou código colado → valor, vencimento,
   linha digitável e beneficiário no formulário de conta.
   - Boleto bancário: linha digitável de 47 números (ou código de barras de 44).
   - Contas de consumo/tributos (começam com 8): 48 números; valor, sem vencimento.
   Usa readReceipt/extractPayee (comprovante.js) e as funções globais de app.js.
   ========================================================= */

const onlyNum = (s) => String(s || '').replace(/\D/g, '');
const mod10 = (num) => { let s = 0, w = 2; for (let i = num.length - 1; i >= 0; i--) { let p = Number(num[i]) * w; if (p > 9) p = Math.floor(p / 10) + (p % 10); s += p; w = w === 2 ? 1 : 2; } return (10 - (s % 10)) % 10; };

/** Fator de vencimento → data (o fator recomeçou em 1000 em 22/02/2025; usa a data mais próxima de hoje). */
function fatorToDate(f) {
  if (!f) return '';
  const a = addDaysISO('1997-10-07', f); const b = f >= 1000 ? addDaysISO('2025-02-22', f - 1000) : a;
  const t = todayISO(); return Math.abs(dateDiffDays(a, t)) <= Math.abs(dateDiffDays(b, t)) ? a : b;
}
const fmtLinha = (l) => (l.length === 47 ? `${l.slice(0, 5)}.${l.slice(5, 10)} ${l.slice(10, 15)}.${l.slice(15, 21)} ${l.slice(21, 26)}.${l.slice(26, 32)} ${l[32]} ${l.slice(33)}`
  : l.length === 48 ? `${l.slice(0, 12)} ${l.slice(12, 24)} ${l.slice(24, 36)} ${l.slice(36)}` : l);

/** Interpreta linha digitável (47/48) ou código de barras (44). */
function parseBoleto(code) {
  const d = onlyNum(code);
  if (d.length === 47) {
    const ok = mod10(d.slice(0, 9)) === Number(d[9]) && mod10(d.slice(10, 20)) === Number(d[20]) && mod10(d.slice(21, 31)) === Number(d[31]);
    return { kind: 'bancario', linha: d, ok, due: fatorToDate(Number(d.slice(33, 37))), cents: Number(d.slice(37, 47)), bank: d.slice(0, 3) };
  }
  if (d.length === 44 && d[0] !== '8') {
    const linha = (() => { const c1 = d.slice(0, 4) + d.slice(19, 24), c2 = d.slice(24, 34), c3 = d.slice(34, 44); return c1 + mod10(c1) + c2 + mod10(c2) + c3 + mod10(c3) + d[4] + d.slice(5, 19); })();
    return { kind: 'bancario', linha, ok: true, due: fatorToDate(Number(d.slice(5, 9))), cents: Number(d.slice(9, 19)), bank: d.slice(0, 3) };
  }
  if ((d.length === 48 || d.length === 44) && d[0] === '8') {
    const bc = d.length === 48 ? d.slice(0, 11) + d.slice(12, 23) + d.slice(24, 35) + d.slice(36, 47) : d;
    const valued = ['6', '7'].includes(bc[2]);
    return { kind: 'arrecadacao', linha: d.length === 48 ? d : bc, ok: true, due: '', cents: valued ? Number(bc.slice(4, 15)) : 0 };
  }
  return null;
}

/** Procura a linha digitável no texto lido (PDF ou foto). */
function findBoletoInText(text) {
  const raw = String(text || '');
  const cands = [];
  for (const line of raw.split('\n')) { const n = onlyNum(line); if ([47, 48, 44].includes(n.length)) cands.push(n); }
  for (const m of raw.matchAll(/(\d{5}[.\s]?\d{5}\s+\d{5}[.\s]?\d{6}\s+\d{5}[.\s]?\d{6}\s+\d\s+\d{14})/g)) cands.push(onlyNum(m[1]));
  for (const m of raw.matchAll(/(8\d{10}[\s-]?\d[\s.]+\d{11}[\s-]?\d[\s.]+\d{11}[\s-]?\d[\s.]+\d{11}[\s-]?\d)/g)) cands.push(onlyNum(m[1]));
  const parsed = cands.map(parseBoleto).filter(Boolean);
  return parsed.find((p) => p.ok) || parsed[0] || null;
}

async function readBoletoFile(file) {
  // Android: leitor de código de barras do próprio aparelho, se existir
  if (/^image\//.test(file.type) && 'BarcodeDetector' in window) {
    try {
      const det = new BarcodeDetector({ formats: ['itf'] }); const codes = await det.detect(await createImageBitmap(file));
      const hit = codes.map((c) => parseBoleto(c.rawValue)).find(Boolean); if (hit) return { info: hit, text: '' };
    } catch { /* segue com a leitura do texto */ }
  }
  const text = await readReceipt(file);
  return { info: findBoletoInText(text), text };
}

/** Preenche o formulário de conta com o boleto lido. */
function applyBoleto(b, text = '') {
  const f = modalForm; const filled = [];
  const radio = $('[name="method"][value="boleto"]', f); if (radio && !radio.checked) { radio.checked = true; radio.dispatchEvent(new Event('change', { bubbles: true })); }
  const code = $('[name="boleto_code"]', f); if (code) { code.value = fmtLinha(b.linha); filled.push('código'); }
  if (b.cents > 0) { const a = $('[name="amount"]', f); a.value = centsToInput(b.cents); a.dispatchEvent(new Event('input', { bubbles: true })); filled.push(`valor ${money(b.cents)}`); }
  if (b.due) {
    const c = $('[name="term"][value="custom"]', f); if (c) c.checked = true;
    const due = $('[name="due_date"]', f); if (due) { due.value = b.due; due.dispatchEvent(new Event('change', { bubbles: true })); filled.push(`vencimento ${fmtDate(b.due)}`); }
  }
  const sup = $('[name="supplier"]', f); const payee = text ? extractPayee(text) : '';
  if (sup && !sup.value && payee) { sup.value = payee; sup.dispatchEvent(new Event('change', { bubbles: true })); filled.push(`beneficiário ${payee}`); }
  return filled;
}

function boletoScanField() {
  return `<div class="field full bol-scan"><button type="button" class="btn" id="bolScan">📷 Ler boleto (foto ou PDF)</button><input type="file" id="bolFile" accept="image/*,application/pdf" hidden>
    <small class="calc-hint" id="bolHint">Preenche valor, vencimento e código. Também dá para colar o código no campo "Código do boleto".</small></div>`;
}
function bindBoletoScan() {
  const btn = $('#bolScan', modalForm); if (!btn) return;
  const hint = $('#bolHint', modalForm);
  btn.addEventListener('click', () => $('#bolFile', modalForm).click());
  $('#bolFile', modalForm).addEventListener('change', async (e) => {
    const file = e.target.files[0]; if (!file) return;
    btn.disabled = true; btn.textContent = '⏳ Lendo o boleto…';
    try {
      const { info, text } = await readBoletoFile(file);
      if (!info) { hint.innerHTML = '⚠️ Não consegui achar o código desse boleto. Tente uma foto mais nítida, o PDF, ou cole o código.'; return; }
      const filled = applyBoleto(info, text);
      hint.innerHTML = `✅ Lido: ${filled.map(esc).join(' · ')}${info.ok ? '' : ' — <b>confira os números</b>, a foto pode ter saído com erro'}.`;
    } catch (err) { hint.textContent = '⚠️ ' + err.message; }
    finally { btn.disabled = false; btn.textContent = '📷 Ler boleto (foto ou PDF)'; e.target.value = ''; }
  });
  // código colado ou digitado
  const code = $('[name="boleto_code"]', modalForm);
  code?.addEventListener('change', () => {
    const info = parseBoleto(code.value); if (!info) return;
    const amt = $('[name="amount"]', modalForm); const keepAmount = parseMoney(amt.value) > 0;
    if (keepAmount) info.cents = 0;
    const filled = applyBoleto(info);
    hint.innerHTML = `✅ Código reconhecido: ${filled.map(esc).join(' · ')}${info.ok ? '' : ' — confira os números'}.`;
  });
}
