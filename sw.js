// Service worker: guarda os arquivos do app para abrir rápido e funcionar com internet instável.
const CACHE = 'casacor-pagamentos-v13';
const ASSETS = ['./', 'index.html', 'styles.css', 'config.js', 'api.js', 'rh.js', 'portaria.js', 'comprovante.js', 'app.js', 'manifest.webmanifest',
  'icons/icon.svg', 'icons/icon-192.png', 'icons/icon-512.png', 'icons/apple-touch-icon.png'];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(ASSETS)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE && k !== 'casacor-share').map((k) => caches.delete(k)))).then(() => self.clients.claim()));
});
// Rede primeiro; cache só para os arquivos do próprio app (nunca para dados do Supabase).
self.addEventListener('fetch', (e) => {
  // Arquivo compartilhado pelo menu "Compartilhar" do Android → guarda e abre o app
  if (e.request.method === 'POST' && new URL(e.request.url).pathname.endsWith('/compartilhar')) {
    e.respondWith((async () => {
      const fd = await e.request.formData();
      const c = await caches.open('casacor-share');
      for (const k of await c.keys()) await c.delete(k);
      let i = 0;
      for (const f of fd.getAll('files')) {
        if (!(f instanceof File)) continue;
        await c.put(`shared/${Date.now()}-${i++}`, new Response(f, { headers: { 'content-type': f.type || 'application/octet-stream', 'x-name': encodeURIComponent(f.name || 'comprovante') } }));
      }
      return Response.redirect(new URL('./?compartilhado=1', self.registration.scope).href, 303);
    })());
    return;
  }
  if (e.request.method !== 'GET' || new URL(e.request.url).origin !== self.location.origin) return;
  e.respondWith(
    fetch(e.request, { cache: 'no-cache' }) // sempre confere se há versão nova (o GitHub Pages guarda por 10 min)
      .then((res) => { const copy = res.clone(); caches.open(CACHE).then((c) => c.put(e.request, copy)); return res; })
      .catch(() => caches.match(e.request, { ignoreSearch: true }).then((r) => r || caches.match('index.html')))
  );
});
