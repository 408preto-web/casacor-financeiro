'use strict';

/* =========================================================
   Avisos no celular (notificações): cada pessoa ativa no próprio aparelho.
   O envio diário é feito pela função "avisos" no Supabase (supabase/functions/avisos).
   iPhone/iPad: só funciona com o app adicionado à Tela de Início (iOS 16.4 ou mais novo).
   ========================================================= */

const pushSupported = () => 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;
const isIOS = () => /iphone|ipad|ipod/i.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
const isStandalone = () => window.matchMedia?.('(display-mode: standalone)').matches || navigator.standalone === true;
const pushState = { status: 'unknown' };
const fnUrl = (q) => `${cfg().url}/functions/v1/avisos?${q}`;
function b64ToBytes(b64) { const p = '='.repeat((4 - (b64.length % 4)) % 4); const raw = atob((b64 + p).replace(/-/g, '+').replace(/_/g, '/')); return Uint8Array.from(raw, (c) => c.charCodeAt(0)); }

async function refreshPushStatus() {
  if (!pushSupported()) { pushState.status = 'unsupported'; return; }
  try { const reg = await navigator.serviceWorker.ready; const sub = await reg.pushManager.getSubscription(); pushState.status = sub && Notification.permission === 'granted' ? 'on' : Notification.permission === 'denied' ? 'denied' : 'off'; }
  catch { pushState.status = 'off'; }
}

function pushCard() {
  const st = pushState.status;
  const iosHint = isIOS() && !isStandalone() ? '<p class="gate-msg">No iPhone/iPad, os avisos só funcionam abrindo o app <b>pelo ícone na Tela de Início</b> (Compartilhar → Adicionar à Tela de Início), com o iOS 16.4 ou mais novo.</p>' : '';
  return `<div class="card mt"><h2>🔔 Avisos no celular</h2>
    <p class="muted">Todo dia às 8h: contas atrasadas, que vencem hoje e amanhã, compras para aprovar e lembrete da folha — mesmo com o app fechado. Ative em cada aparelho.</p>
    ${iosHint}
    <p>${st === 'on' ? '✅ <b>Ativados neste aparelho.</b>' : st === 'denied' ? '🚫 <b>Bloqueados</b> nas configurações do aparelho/navegador para este app. Libere as notificações lá e tente de novo.' : st === 'unsupported' ? '⚠️ Este navegador não aceita avisos.' : 'Desativados neste aparelho.'}</p>
    <div class="row-actions">${st === 'on' ? '<button class="btn" id="pushTest">Mandar aviso de teste</button><button class="btn" id="pushOff">Desativar</button>' : st !== 'unsupported' ? '<button class="btn primary" id="pushOn">🔔 Ativar avisos neste aparelho</button>' : ''}</div></div>`;
}

async function enablePush() {
  if (!pushSupported()) throw new Error(isIOS() ? 'No iPhone, abra o app pelo ícone na Tela de Início para ativar os avisos.' : 'Este navegador não aceita avisos.');
  const perm = await Notification.requestPermission();
  if (perm !== 'granted') throw new Error('Permissão de notificação não concedida.');
  let key = await api.rpc('push_public_key', {}).catch((e) => { if (/push_public_key|não foi configurado/.test(e.message)) throw new Error('Rode o supabase-avisos.sql no Supabase primeiro.'); return null; });
  if (!key) {
    const r = await fetch(fnUrl('setup=1'), { method: 'POST', headers: { apikey: cfg().key } }).catch(() => null);
    const j = r && r.ok ? await r.json().catch(() => null) : null;
    key = j?.publicKey;
    if (!key) throw new Error('A função "avisos" ainda não foi criada no Supabase (veja o passo a passo).');
  }
  const reg = await navigator.serviceWorker.ready;
  let sub = await reg.pushManager.getSubscription();
  if (sub && sub.options?.applicationServerKey) { /* reaproveita */ } else sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: b64ToBytes(key) });
  const j = sub.toJSON();
  await api.remove('push_subs', `endpoint=eq.${encodeURIComponent(j.endpoint)}`).catch(() => {});
  await api.insert('push_subs', { endpoint: j.endpoint, p256dh: j.keys.p256dh, auth: j.keys.auth, device: navigator.userAgent.slice(0, 140) });
}
async function disablePush() {
  const reg = await navigator.serviceWorker.ready; const sub = await reg.pushManager.getSubscription();
  if (sub) { await api.remove('push_subs', `endpoint=eq.${encodeURIComponent(sub.endpoint)}`).catch(() => {}); await sub.unsubscribe(); }
}
async function testPush() {
  const token = await api.token();
  const r = await fetch(fnUrl('test=1'), { method: 'POST', headers: { apikey: cfg().key, Authorization: `Bearer ${token}` } });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.error || 'Não consegui falar com a função "avisos".');
  return j.sent || 0;
}

function bindPush(v) {
  const run = (fn, ok) => async (e) => { e.target.disabled = true; try { const r = await fn(); toast(ok(r)); } catch (err) { toast(err.message); } await refreshPushStatus(); render(); };
  $('#pushOn', v)?.addEventListener('click', run(enablePush, () => '🔔 Avisos ativados neste aparelho'));
  $('#pushOff', v)?.addEventListener('click', run(disablePush, () => 'Avisos desativados neste aparelho'));
  $('#pushTest', v)?.addEventListener('click', run(testPush, (n) => (n ? 'Aviso de teste enviado — deve chegar em segundos' : 'Nenhum aparelho recebeu. Desative e ative de novo.')));
}
