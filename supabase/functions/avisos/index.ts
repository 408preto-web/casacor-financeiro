// =====================================================================
// CASACOR — função "avisos" (Supabase Edge Function)
// Manda notificação no celular de quem ativou os avisos no app.
// Como criar: Supabase → Edge Functions → Deploy a new function → Via Editor →
//   nome: avisos → cole este arquivo → Deploy.
//   Depois, em Details/Settings da função, DESLIGUE "Enforce JWT verification" (Verify JWT).
// Ela é chamada: todo dia às 8h pelo agendamento (supabase-avisos.sql), pelo app para
// preparar as chaves (?setup=1) e para o aviso de teste (?test=1).
// =====================================================================
import webpush from 'npm:web-push@3.6.7';
import { createClient } from 'npm:@supabase/supabase-js@2.45.4';

const cors = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'authorization, apikey, content-type, x-cron-secret', 'Access-Control-Allow-Methods': 'POST, GET, OPTIONS' };
const json = (b: unknown, s = 200) => new Response(JSON.stringify(b), { status: s, headers: { ...cors, 'Content-Type': 'application/json' } });
const db = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!, { auth: { persistSession: false } });
const brl = (c: number) => (c / 100).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
const ymd = (d: Date) => new Date(d.getTime() - 3 * 3600e3).toISOString().slice(0, 10); // horário de Fortaleza
const cents = (v: unknown) => Math.round(Number(v || 0) * 100);

async function keys() {
  const { data } = await db.from('push_config').select('*').eq('id', 1).single();
  if (data?.public_key && data?.private_key) return data;
  const k = webpush.generateVAPIDKeys();
  await db.from('push_config').update({ public_key: k.publicKey, private_key: k.privateKey }).eq('id', 1);
  return { ...data, public_key: k.publicKey, private_key: k.privateKey };
}

async function send(cfg: any, sub: any, payload: object) {
  webpush.setVapidDetails('mailto:avisos@casacor.app', cfg.public_key, cfg.private_key);
  try {
    await webpush.sendNotification({ endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } }, JSON.stringify(payload), { TTL: 6 * 3600 });
    return true;
  } catch (e: any) {
    if (e?.statusCode === 404 || e?.statusCode === 410) await db.from('push_subs').delete().eq('id', sub.id); // aparelho desativado
    return false;
  }
}

/** Mensagens do dia para uma pessoa (pela função e pelas franquias dela). */
function noticesFor(m: any, bills: any[], units: any[], employees: any[], today: string) {
  const out: string[] = [];
  const myUnits: string[] = Array.isArray(m.units) && m.units.length ? m.units : ['ce'];
  const uname = (c: string) => units.find((u) => u.code === c)?.name || c;
  const payer = ['payer', 'admin'].includes(m.role);
  const tomorrow = ymd(new Date(Date.parse(today + 'T12:00:00Z') + 864e5));
  for (const u of myUnits) {
    const mine = bills.filter((b) => (b.unit || 'ce') === u && b.status === 'pending');
    const appr = mine.filter((b) => !b.approval || b.approval === 'approved');
    const tag = myUnits.length > 1 ? `${uname(u)}: ` : '';
    if (payer) {
      const late = appr.filter((b) => b.due_date < today), now = appr.filter((b) => b.due_date === today), tom = appr.filter((b) => b.due_date === tomorrow);
      const sum = (l: any[]) => brl(l.reduce((s, b) => s + cents(b.amount), 0));
      const parts = [late.length ? `${late.length} atrasada(s) (${sum(late)})` : '', now.length ? `${now.length} vence(m) hoje (${sum(now)})` : '', tom.length ? `${tom.length} vence(m) amanhã (${sum(tom)})` : ''].filter(Boolean);
      if (parts.length) out.push(`${tag}${parts.join(' · ')}`);
      const req = mine.filter((b) => b.approval === 'requested');
      if (req.length) out.push(`${tag}${req.length} solicitação(ões) de compra para aprovar (${sum(req)})`);
    }
    const hr = m.role === 'admin' || m.can_hr;
    const day = Number(today.slice(8)); const ym = today.slice(0, 7);
    if (hr && [13, 14, 28, 29].includes(day)) {
      const t = day <= 14 ? 'M15' : 'M30'; const ref = t === 'M15' ? `${ym}-15` : `${ym}-${Math.min(30, new Date(Date.UTC(Number(ym.slice(0, 4)), Number(ym.slice(5)), 0)).getUTCDate())}`;
      const monthly = employees.filter((e) => (e.unit || 'ce') === u && e.pay_type === 'monthly' && e.status === 'active' && e.admission_date <= ref);
      const done = new Set(bills.filter((b) => (b.payroll_ref || '').endsWith(`:${t}:${ref}`)).map((b) => b.payroll_ref.split(':')[0]));
      const missing = monthly.filter((e) => !done.has(e.id));
      if (missing.length) out.push(`${tag}folha do dia ${t === 'M15' ? '15' : '30'} ainda não gerada (${missing.length} funcionário(s))`);
    }
  }
  return out;
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
  const url = new URL(req.url);
  const cfg = await keys();

  // Prepara as chaves (o app chama ao ativar os avisos)
  if (url.searchParams.has('setup')) return json({ ok: true, publicKey: cfg.public_key });

  // Aviso de teste para a própria pessoa
  if (url.searchParams.has('test')) {
    const token = (req.headers.get('authorization') || '').replace(/^Bearer\s+/i, '');
    const { data: u } = await db.auth.getUser(token);
    if (!u?.user) return json({ error: 'faça login' }, 401);
    const { data: subs } = await db.from('push_subs').select('*').eq('user_id', u.user.id);
    let n = 0; for (const s of subs || []) if (await send(cfg, s, { title: 'CASACOR — teste', body: 'Os avisos estão funcionando neste aparelho ✅', url: './' })) n++;
    return json({ ok: true, sent: n });
  }

  // Envio diário (agendamento)
  if (req.headers.get('x-cron-secret') !== cfg.cron_secret) return json({ error: 'não autorizado' }, 401);
  const today = ymd(new Date());
  const [{ data: subs }, { data: members }, { data: bills }, { data: units }, { data: employees }] = await Promise.all([
    db.from('push_subs').select('*'), db.from('members').select('*'),
    db.from('bills').select('id,unit,status,approval,amount,due_date,payroll_ref,employee_id').neq('status', 'cancelled'),
    db.from('units').select('*'), db.from('employees').select('id,unit,pay_type,status,admission_date'),
  ]);
  let sent = 0;
  for (const m of members || []) {
    const mySubs = (subs || []).filter((s: any) => s.user_id === m.user_id); if (!mySubs.length) continue;
    const lines = noticesFor(m, bills || [], units || [], employees || [], today); if (!lines.length) continue;
    for (const s of mySubs) if (await send(cfg, s, { title: 'CASACOR — avisos de hoje', body: lines.join('\n'), url: './' })) sent++;
  }
  return json({ ok: true, sent });
});
