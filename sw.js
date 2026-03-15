'use strict';

const NOM_CACHE = 'alphatrade-v3';
const VERSION = 3;

const RESSOURCES_STATIQUES = [
  './index.html',
  './style.css',
  './script.js',
  './manifest.json',
  './icones/icone-192.png',
  './icones/icone-512.png',
];

/* Installation : on pré-cache uniquement les ressources locales */
self.addEventListener('install', (evt) => {
  evt.waitUntil(
    caches.open(NOM_CACHE).then(cache => {
      return Promise.allSettled(
        RESSOURCES_STATIQUES.map(url =>
          cache.add(url).catch(err => console.warn('Cache miss:', url, err))
        )
      );
    }).then(() => self.skipWaiting())
  );
});

/* Activation : supprimer les anciens caches */
self.addEventListener('activate', (evt) => {
  evt.waitUntil(
    caches.keys().then(cles =>
      Promise.all(
        cles
          .filter(cle => cle !== NOM_CACHE)
          .map(cle => caches.delete(cle))
      )
    ).then(() => self.clients.claim())
  );
});

/* Stratégie fetch */
self.addEventListener('fetch', (evt) => {
  const { request } = evt;
  if (request.method !== 'GET') return;

  const url = new URL(request.url);

  /* APIs externes : réseau en priorité, cache en fallback */
  const DOMAINES_API = [
    'api.coingecko.com',
    'v6.exchangerate-api.com',
    'finnhub.io',
    'static.coingecko.com',
  ];
  if (DOMAINES_API.some(d => url.hostname.includes(d))) {
    evt.respondWith(reseauPuisCache(request));
    return;
  }

  /* CDN (fonts, chartjs) : cache en priorité */
  const DOMAINES_CDN = [
    'fonts.googleapis.com',
    'fonts.gstatic.com',
    'cdnjs.cloudflare.com',
  ];
  if (DOMAINES_CDN.some(d => url.hostname.includes(d))) {
    evt.respondWith(cachePuisReseau(request));
    return;
  }

  /* Ressources locales : cache stale-while-revalidate */
  if (url.origin === self.location.origin) {
    evt.respondWith(staleWhileRevalidate(request));
    return;
  }

  /* Tout le reste : réseau direct */
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
      status: 503,
      headers: { 'Content-Type': 'application/json' },
    });
  }
}

async function cachePuisReseau(req) {
  const cached = await caches.match(req);
  if (cached) return cached;
  try {
    const rep = await fetch(req);
    if (rep.ok) {
      const cache = await caches.open(NOM_CACHE);
      cache.put(req, rep.clone());
    }
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

self.addEventListener('message', (evt) => {
  if (evt.data?.type === 'SKIP_WAITING') self.skipWaiting();
});
