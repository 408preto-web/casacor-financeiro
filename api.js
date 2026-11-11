'use strict';

/* =========================================================
   Comunicação com o Supabase (login, tabelas e anexos), sem bibliotecas.
   Endereço e chave pública ficam em config.js.
   ========================================================= */

const AUTH_KEY = 'casacor:auth';
const cfg = () => {
  const c = window.SUPABASE_CONFIG || {};
  return c.url && c.key ? { url: c.url.replace(/\/+$/, ''), key: c.key } : null;
};

class ApiError extends Error {}

function authErrorText(d) {
  const m = String(d?.error_description || d?.msg || d?.message || d?.error || 'erro desconhecido');
  if (/invalid login/i.test(m)) return 'E-mail ou senha incorretos.';
  if (/already registered|already exists/i.test(m)) return 'Este e-mail já tem cadastro. Use “Entrar”.';
  if (/password.*(6|short|least)/i.test(m)) return 'A senha precisa ter pelo menos 6 caracteres.';
  if (/not confirmed/i.test(m)) return 'Confirme seu e-mail (veja a caixa de entrada) e tente de novo.';
  if (/signups? not allowed|disabled/i.test(m)) return 'O cadastro de novas pessoas está desativado.';
  if (/rate limit|too many/i.test(m)) return 'Muitas tentativas. Aguarde um pouco e tente de novo.';
  return m;
}
function dbErrorText(d, status) {
  const m = String(d?.message || d?.error || `erro ${status}`);
  if (/row-level security|permission denied/i.test(m)) return 'Você não tem permissão para isso.';
  if (/does not exist|schema cache|could not find/i.test(m)) return 'O banco de dados ainda não foi configurado (rode o supabase.sql).';
  return m;
}

const api = {
  /* ---------- sessão ---------- */
  session() { try { return JSON.parse(localStorage.getItem(AUTH_KEY)); } catch { return null; } },
  setSession(s) { try { s ? localStorage.setItem(AUTH_KEY, JSON.stringify(s)) : localStorage.removeItem(AUTH_KEY); } catch { /* ignora */ } },
  saveSession(d) {
    if (!d.access_token) throw new ApiError('Cadastro feito. Confirme o e-mail recebido e depois entre.');
    this.setSession({ access_token: d.access_token, refresh_token: d.refresh_token, expires_at: Date.now() + (d.expires_in || 3600) * 1000, user: { id: d.user.id, email: d.user.email } });
  },

  async authPost(path, body, token) {
    const c = cfg();
    const headers = { apikey: c.key, 'Content-Type': 'application/json' };
    if (token) headers.Authorization = `Bearer ${token}`;
    let res;
    try { res = await fetch(`${c.url}/auth/v1/${path}`, { method: 'POST', headers, body: JSON.stringify(body) }); }
    catch { throw new ApiError('Sem conexão com a internet.'); }
    const d = await res.json().catch(() => ({}));
    if (!res.ok) throw new ApiError(authErrorText(d));
    return d;
  },
  async signIn(email, password) { this.saveSession(await this.authPost('token?grant_type=password', { email, password })); },
  async signUp(email, password, name) { this.saveSession(await this.authPost('signup', { email, password, data: { name } })); },
  async recover(email) { await this.authPost('recover', { email }); },
  async updatePassword(password, accessToken) {
    const c = cfg();
    const res = await fetch(`${c.url}/auth/v1/user`, { method: 'PUT', headers: { apikey: c.key, Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ password }) });
    const d = await res.json().catch(() => ({}));
    if (!res.ok) throw new ApiError(authErrorText(d));
    return d;
  },
  signOut() { this.setSession(null); },

  async token() {
    const s = this.session();
    if (!s) throw new ApiError('Faça login novamente.');
    if (Date.now() < s.expires_at - 60000) return s.access_token;
    try {
      this.saveSession(await this.authPost('token?grant_type=refresh_token', { refresh_token: s.refresh_token }));
      return this.session().access_token;
    } catch (e) {
      if (!navigator.onLine) throw new ApiError('Sem conexão com a internet.');
      this.setSession(null);
      throw new ApiError('Sua sessão expirou. Entre novamente.');
    }
  },

  /* ---------- tabelas ---------- */
  async rest(method, path, body, extraHeaders = {}) {
    const c = cfg();
    const token = await this.token();
    let res;
    try {
      res = await fetch(`${c.url}/rest/v1/${path}`, {
        method,
        headers: { apikey: c.key, Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', Prefer: 'return=representation', ...extraHeaders },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
    } catch { throw new ApiError('Sem conexão com a internet.'); }
    if (res.status === 204) return null;
    const d = await res.json().catch(() => null);
    if (!res.ok) throw new ApiError(dbErrorText(d, res.status));
    return d;
  },
  select(table, query = '') { return this.rest('GET', `${table}?${query}`); },
  insert(table, rows) { return this.rest('POST', table, rows); },
  update(table, filter, patch) { return this.rest('PATCH', `${table}?${filter}`, patch); },
  remove(table, filter) { return this.rest('DELETE', `${table}?${filter}`); },
  rpc(fn, args) { return this.rest('POST', `rpc/${fn}`, args); },

  /* ---------- anexos (Storage, bucket privado "anexos") ---------- */
  async upload(path, blob, bucket = 'anexos') {
    const c = cfg();
    const token = await this.token();
    let res;
    try {
      res = await fetch(`${c.url}/storage/v1/object/${bucket}/${path}`, {
        method: 'POST', headers: { apikey: c.key, Authorization: `Bearer ${token}`, 'Content-Type': blob.type || 'application/octet-stream', 'x-upsert': 'false' }, body: blob,
      });
    } catch { throw new ApiError('Sem conexão para enviar o arquivo.'); }
    if (!res.ok) {
      const d = await res.json().catch(() => ({}));
      throw new ApiError(/payload too large|exceeded|size/i.test(d.message || d.error || '') ? 'Arquivo grande demais (máximo 10 MB).' : dbErrorText(d, res.status));
    }
  },
  async signedUrl(path, bucket = 'anexos') {
    const c = cfg();
    const token = await this.token();
    const res = await fetch(`${c.url}/storage/v1/object/sign/${bucket}/${path}`, {
      method: 'POST', headers: { apikey: c.key, Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ expiresIn: 3600 }),
    });
    const d = await res.json().catch(() => ({}));
    if (!res.ok || !d.signedURL) throw new ApiError('Não foi possível abrir o anexo.');
    return `${c.url}/storage/v1${d.signedURL.startsWith('/') ? '' : '/'}${d.signedURL}`;
  },
  async deleteFiles(paths, bucket = 'anexos') {
    if (!paths.length) return;
    const c = cfg();
    const token = await this.token();
    await fetch(`${c.url}/storage/v1/object/${bucket}`, {
      method: 'DELETE', headers: { apikey: c.key, Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ prefixes: paths }),
    }).catch(() => {});
  },
};
