'use strict';

const NOM_CACHE = 'alphatrade-v5';

const RESSOURCES_STATIQUES = [
  '/',
  '/index.html',
  '/style.css',
  '/script.js',
  '/manifest.json',
  '/icones/icone-192.png',
  '/icones/icone-512.png',
];

self.addEventListener('install', evt => {
  evt.waitUntil(
    caches.open(NOM_CACHE).then(cache =>
      Promise.allSettled(RESSOURCES_STATIQUES.map(url =>
        cache.add(url).catch(e => console.warn('Cache miss:', url, e))
      ))
    ).then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', evt => {
  evt.waitUntil(
    caches.keys()
      .then(cles => Promise.all(
        cles.filter(c => c !== NOM_CACHE).map(c => caches.delete(c))
      ))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', evt => {
  const { request } = evt;
  if (request.method !== 'GET') return;
  const url = new URL(request.url);

  // APIs externes : réseau prioritaire, cache en fallback
  const APIS = ['api.coingecko.com', 'api.twelvedata.com', 'static.coingecko.com'];
  if (APIS.some(d => url.hostname.includes(d))) {
    evt.respondWith(reseauPuisCache(request));
    return;
  }

  // CDN : cache prioritaire
  const CDNS = ['fonts.googleapis.com', 'fonts.gstatic.com', 'cdnjs.cloudflare.com'];
  if (CDNS.some(d => url.hostname.includes(d))) {
    evt.respondWith(cachePuisReseau(request));
    return;
  }

  // Fichiers locaux : stale-while-revalidate
  if (url.origin === self.location.origin) {
    evt.respondWith(staleWhileRevalidate(request));
    return;
  }

  evt.respondWith(fetch(request).catch(() =>
    caches.match(request).then(r => r || new Response('Hors ligne', { status: 503 }))
  ));
});

async function reseauPuisCache(req) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 10000);
  try {
    const rep = await fetch(req, { signal: ctrl.signal });
    clearTimeout(timer);
    if (rep.ok) {
      const cache = await caches.open(NOM_CACHE);
      cache.put(req, rep.clone());
    }
    return rep;
  } catch {
    clearTimeout(timer);
    const cached = await caches.match(req);
    return cached || new Response(JSON.stringify({ error: 'offline' }), {
      status: 503, headers: { 'Content-Type': 'application/json' }
    });
  }
}

async function cachePuisReseau(req) {
  const cached = await caches.match(req);
  if (cached) return cached;
  try {
    const rep = await fetch(req);
    if (rep.ok) { const c = await caches.open(NOM_CACHE); c.put(req, rep.clone()); }
    return rep;
  } catch {
    return new Response('Hors ligne', { status: 503 });
  }
}

async function staleWhileRevalidate(req) {
  const cache = await caches.open(NOM_CACHE);
  const cached = await cache.match(req);
  const fetchPromise = fetch(req).then(rep => {
    if (rep.ok) cache.put(req, rep.clone());
    return rep;
  }).catch(() => null);
  return cached || (await fetchPromise) || new Response('Hors ligne', { status: 503 });
}

self.addEventListener('message', evt => {
  if (evt.data?.type === 'SKIP_WAITING') self.skipWaiting();
});
