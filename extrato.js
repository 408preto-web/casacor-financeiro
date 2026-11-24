'use strict';

/* =========================================================
   Conferir extrato do banco (OFX ou CSV): cada saída de dinheiro é comparada
   com as contas — já paga (conferida), a pagar (marcar como paga) ou sem conta
   no sistema (lançar já paga). Só para quem paga. Nada é enviado ao banco.
   Usa as funções e o estado globais de app.js e comprovante.js.
   ========================================================= */

const xui = { txs: null, file: '', ignored: new Set(JSON.parse((() => { try { return localStorage.getItem('casacor:extrato:ign') || '[]'; } catch { return '[]'; } })())) };
const saveIgnored = () => { try { localStorage.setItem('casacor:extrato:ign', JSON.stringify([...xui.ignored].slice(-2000))); } catch { /* ignora */ } };

/* ---------- Leitura do arquivo ---------- */
function parseOFX(text) {
  const out = [];
  for (const blk of String(text).split(/<STMTTRN>/i).slice(1)) {
    const g = (tag) => (blk.match(new RegExp(`<${tag}>([^<\\r\\n]*)`, 'i')) || [])[1]?.trim() || '';
    const dt = g('DTPOSTED'); const amt = Number(g('TRNAMT').replace(',', '.'));
    if (!dt || Number.isNaN(amt)) continue;
    out.push({ id: g('FITID') || `${dt}|${amt}|${g('MEMO')}`, date: `${dt.slice(0, 4)}-${dt.slice(4, 6)}-${dt.slice(6, 8)}`, cents: Math.round(amt * 100), text: [g('NAME'), g('MEMO')].filter(Boolean).join(' — ') });
  }
  return out;
}
function parseCSV(text) {
  const lines = String(text).replace(/\r/g, '').split('\n').filter((l) => l.trim());
  if (lines.length < 2) return [];
  const sep = (lines[0].match(/;/g) || []).length >= (lines[0].match(/,/g) || []).length ? ';' : ',';
  const split = (l) => { const r = []; let cur = '', q = false; for (const ch of l) { if (ch === '"') q = !q; else if (ch === sep && !q) { r.push(cur); cur = ''; } else cur += ch; } r.push(cur); return r.map((x) => x.trim()); };
  let hi = lines.findIndex((l) => /data|date/i.test(l) && /valor|amount|quantia/i.test(l)); if (hi < 0) hi = 0;
  const head = split(lines[hi]).map((h) => normR(h));
  const ci = (re) => head.findIndex((h) => re.test(h));
  const iD = ci(/^data|date/), iV = ci(/valor|amount|quantia/), iT = ci(/descri|histor|lancamento|memo|estabelec/), iDeb = ci(/debito|saida/), iCred = ci(/credito|entrada/);
  const out = [];
  for (const l of lines.slice(hi + 1)) {
    const c = split(l); const dRaw = c[iD] || ''; const dm = dRaw.match(/(\d{2})\/(\d{2})\/(\d{2,4})/) || dRaw.match(/(\d{4})-(\d{2})-(\d{2})/);
    if (!dm) continue;
    const date = dm[0].includes('/') ? `${dm[3].length === 2 ? '20' + dm[3] : dm[3]}-${dm[2]}-${dm[1]}` : dm[0];
    const num = (s) => { const t = String(s || '').trim(); if (!t) return null; const neg = /^-|\(|-$|d$/i.test(t); const v = Math.abs(parseMoney(t.replace(/[()]/g, '').replace(/\s*[dc]$/i, ''))); return neg ? -v : v; };
    let cents = iV >= 0 ? num(c[iV]) : null;
    if (cents == null && iDeb >= 0 && num(c[iDeb])) cents = -Math.abs(num(c[iDeb]));
    if (cents == null && iCred >= 0 && num(c[iCred])) cents = Math.abs(num(c[iCred]));
    if (cents == null) continue;
    out.push({ id: `${date}|${cents}|${c[iT] || ''}`, date, cents, text: c[iT] || '' });
  }
  return out;
}

/* ---------- Comparação com as contas ---------- */
function matchTx(t) {
  const amt = -t.cents; if (amt <= 0) return { kind: 'in' };
  const words = (s) => normR(s).split(/[^a-z0-9]+/).filter((w) => w.length >= 4);
  const tw = words(t.text);
  const nameHit = (b) => words(b.supplier).some((w) => tw.includes(w));
  const paid = state.bills.filter((b) => b.status === 'paid' && (b.paidCents ?? b.cents) === amt && Math.abs(dateDiffDays(b.paid_at, t.date)) <= 5)
    .sort((a, b) => nameHit(b) - nameHit(a) || Math.abs(dateDiffDays(a.paid_at, t.date)) - Math.abs(dateDiffDays(b.paid_at, t.date)));
  if (paid.length) return { kind: 'ok', bill: paid[0] };
  const pend = state.bills.filter((b) => b.status === 'pending' && isApproved(b) && (b.cents === amt || (b.due_date < t.date && amt > b.cents && amt <= b.cents * 1.2))
      && dateDiffDays(t.date, b.due_date) <= 15 && dateDiffDays(b.due_date, t.date) <= 60)
    .sort((a, b) => (b.cents === amt) - (a.cents === amt) || nameHit(b) - nameHit(a) || Math.abs(dateDiffDays(a.due_date, t.date)) - Math.abs(dateDiffDays(b.due_date, t.date)));
  if (pend.length) return { kind: 'pay', bill: pend[0], others: pend.slice(1, 4) };
  return { kind: 'new' };
}

function renderExtrato() {
  if (!isPayer()) return '<div class="card"><div class="empty small">A conferência do extrato é para quem paga as contas.</div></div>';
  const head = `<div class="card"><h2>🏦 Conferir extrato do banco</h2>
    <p class="muted">No app ou site do banco, exporte o extrato do período em <b>OFX</b> (o mais comum, às vezes chamado "Money" ou "Quicken") ou <b>CSV/Excel</b>, e escolha o arquivo aqui. O arquivo fica só no seu aparelho.</p>
    <label class="btn primary rc-pick" style="justify-self:start">📄 Escolher extrato (OFX ou CSV)<input type="file" id="xFile" accept=".ofx,.qfx,.csv,.txt,application/x-ofx,text/csv,text/plain" hidden></label>
    ${xui.file ? `<p class="muted small">Arquivo: <b>${esc(xui.file)}</b></p>` : ''}</div>`;
  if (!xui.txs) return head;
  const rows = xui.txs.map((t) => ({ t, m: matchTx(t) })).filter((r) => r.m.kind !== 'in');
  const vis = rows.filter((r) => !xui.ignored.has(r.t.id));
  const cnt = (k) => vis.filter((r) => r.m.kind === k).length;
  const sum = (k) => vis.filter((r) => r.m.kind === k).reduce((s, r) => s - r.t.cents, 0);
  const order = { new: 0, pay: 1, ok: 2 };
  return head + `<div class="grid cols-4 mt">
    <div class="card stat"><div class="label">Saídas no extrato</div><div class="value">${vis.length}</div><div class="sub">${money(vis.reduce((s, r) => s - r.t.cents, 0))}</div></div>
    <div class="card stat"><div class="label">✅ Conferidas</div><div class="value pos">${cnt('ok')}</div><div class="sub">${money(sum('ok'))}</div></div>
    <div class="card stat ${cnt('pay') ? 'stat-warn' : ''}"><div class="label">💳 Marcar como pagas</div><div class="value">${cnt('pay')}</div><div class="sub">${money(sum('pay'))}</div></div>
    <div class="card stat ${cnt('new') ? 'stat-danger' : ''}"><div class="label">➕ Sem conta no sistema</div><div class="value ${cnt('new') ? 'neg' : ''}">${cnt('new')}</div><div class="sub">${money(sum('new'))}</div></div></div>
  <div class="card mt"><ul class="tx-list">${vis.sort((a, b) => order[a.m.kind] - order[b.m.kind] || a.t.date.localeCompare(b.t.date)).map((r) => {
    const i = xui.txs.indexOf(r.t); const v = -r.t.cents;
    const tag = r.m.kind === 'ok' ? `<span class="badge paid">✅ conferida</span> <span class="muted">${esc(r.m.bill.supplier)}</span>`
      : r.m.kind === 'pay' ? `<span class="badge open">💳 a pagar</span> <span class="muted">${esc(r.m.bill.supplier)} · vence ${fmtDate(r.m.bill.due_date)}${r.m.bill.cents !== v ? ` · conta ${money(r.m.bill.cents)} (+${money(v - r.m.bill.cents)} juros)` : ''}</span>`
      : '<span class="badge late">➕ sem conta</span>';
    return `<li class="tx"><div class="tx-main"><div class="tx-title">${esc(r.t.text || 'Saída')}</div><div class="tx-meta">${fmtDate(r.t.date)} · ${tag}</div></div>
      <div class="x-act"><div class="tx-amount neg">${money(v)}</div>
      ${r.m.kind === 'pay' ? `<button class="btn small primary" data-xpay="${i}">Marcar paga</button>` : r.m.kind === 'new' ? `<button class="btn small primary" data-xnew="${i}">Lançar</button>` : `<button class="btn small" data-xopen="${r.m.bill.id}">Ver</button>`}
      ${r.m.kind !== 'ok' ? `<button class="btn small" data-xign="${i}" title="Ex.: transferência entre contas, tarifa">Ignorar</button>` : ''}</div></li>`;
  }).join('')}</ul>
  ${rows.length - vis.length ? `<p class="muted small">${rows.length - vis.length} saída(s) ignorada(s). <button class="link-btn" id="xUnign">mostrar de novo</button></p>` : ''}
  <p class="muted small">"Conferida": conta paga com o mesmo valor em até 5 dias. "A pagar": conta aberta com o mesmo valor (ou com juros, se atrasada). Entradas de dinheiro não aparecem.</p></div>`;
}

function bindExtrato(v) {
  $('#xFile', v)?.addEventListener('change', async (e) => {
    const f = e.target.files[0]; if (!f) return;
    const text = await f.text();
    const txs = /<OFX|<STMTTRN/i.test(text) ? parseOFX(text) : parseCSV(text);
    if (!txs.length) { toast('Não consegui ler esse extrato. Tente o arquivo OFX do banco.'); return; }
    xui.txs = txs; xui.file = f.name; render(); toast(`${txs.length} lançamentos lidos do extrato`);
  });
  $$('[data-xpay]', v).forEach((b) => b.addEventListener('click', () => {
    const t = xui.txs[Number(b.dataset.xpay)]; const m = matchTx(t); const amt = -t.cents;
    openPay([m.bill], 'Marcar como pago (extrato)', { amountCents: amt, paidAt: t.date, notes: paidDiffNote(m.bill.cents, amt).notes || `Conferido no extrato: ${t.text}`.slice(0, 200) });
  }));
  $$('[data-xnew]', v).forEach((b) => b.addEventListener('click', () => {
    const t = xui.txs[Number(b.dataset.xnew)]; const amt = -t.cents;
    const payee = String(t.text || '').replace(/^(pix|ted|doc|pagamento|pagto|pgto|transf\w*|compra|deb\w*)\s*(enviad[oa]|realizad[oa]|para|a|de)?\s*[:-]?\s*/i, '').replace(/\s+\d{2}\/\d{2}.*$/, '').trim();
    openNewPaidBill([], { amounts: [{ cents: amt, strong: true }], dates: [t.date], payee: payee ? titleName(payee) : '', pix: /pix/i.test(t.text), back: () => { modal.close(); render(); } });
  }));
  $$('[data-xopen]', v).forEach((b) => b.addEventListener('click', () => openBill(b.dataset.xopen)));
  $$('[data-xign]', v).forEach((b) => b.addEventListener('click', () => { xui.ignored.add(xui.txs[Number(b.dataset.xign)].id); saveIgnored(); render(); }));
  $('#xUnign', v)?.addEventListener('click', () => { xui.txs.forEach((t) => xui.ignored.delete(t.id)); saveIgnored(); render(); });
}
