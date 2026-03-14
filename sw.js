'use strict';

const NOM_CACHE = 'alphatrade-v2';

const RESSOURCES_STATIQUES = [
  './',
  './index.html',
  './style.css',
  './script.js',
  './manifest.json',
  'https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700;800;900&display=swap',
  'https://cdnjs.cloudflare.com/ajax/libs/Chart.js/4.4.1/chart.umd.min.js',
];

self.addEventListener('install', (evenement) => {
  evenement.waitUntil(
    caches.open(NOM_CACHE)
      .then(cache => cache.addAll(RESSOURCES_STATIQUES).catch(() => {}))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (evenement) => {
  evenement.waitUntil(
    caches.keys()
      .then(cles => Promise.all(
        cles.filter(cle => cle !== NOM_CACHE).map(cle => caches.delete(cle))
      ))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (evenement) => {
  const url = new URL(evenement.request.url);
  if (evenement.request.method !== 'GET') return;

  if (url.hostname.includes('coingecko.com')) {
    evenement.respondWith(reseauEnPrioriteAvecDelai(evenement.request, 8000));
    return;
  }

  if (url.hostname.includes('fonts.googleapis.com') ||
      url.hostname.includes('fonts.gstatic.com') ||
      url.hostname.includes('cdnjs.cloudflare.com')) {
    evenement.respondWith(cacheEnPriorite(evenement.request));
    return;
  }

  if (url.origin === location.origin) {
    evenement.respondWith(cacheEtMiseAJour(evenement.request));
    return;
  }

  evenement.respondWith(reseauEnPriorite(evenement.request));
});

async function cacheEnPriorite(requete) {
  const enCache = await caches.match(requete);
  if (enCache) return enCache;
  try {
    const reponse = await fetch(requete);
    if (reponse.ok) {
      const cache = await caches.open(NOM_CACHE);
      cache.put(requete, reponse.clone());
    }
    return reponse;
  } catch (e) {
    return new Response('Hors ligne', { status: 503 });
  }
}

async function reseauEnPriorite(requete) {
  try {
    const reponse = await fetch(requete);
    if (reponse.ok) {
      const cache = await caches.open(NOM_CACHE);
      cache.put(requete, reponse.clone());
    }
    return reponse;
  } catch (e) {
    const enCache = await caches.match(requete);
    return enCache || new Response(JSON.stringify({ erreur: 'hors ligne' }), {
      status: 503, headers: { 'Content-Type': 'application/json' }
    });
  }
}

async function reseauEnPrioriteAvecDelai(requete, delai) {
  const controleur = new AbortController();
  const minuterie = setTimeout(() => controleur.abort(), delai);
  try {
    const reponse = await fetch(requete, { signal: controleur.signal });
    clearTimeout(minuterie);
    if (reponse.ok) {
      const cache = await caches.open(NOM_CACHE);
      cache.put(requete, reponse.clone());
    }
    return reponse;
  } catch (e) {
    clearTimeout(minuterie);
    const enCache = await caches.match(requete);
    if (enCache) return enCache;
    return new Response(JSON.stringify({ erreur: 'hors ligne', prix: {} }), {
      status: 503, headers: { 'Content-Type': 'application/json' }
    });
  }
}

async function cacheEtMiseAJour(requete) {
  const cache = await caches.open(NOM_CACHE);
  const enCache = await cache.match(requete);
  const promesseReseau = fetch(requete).then(reponse => {
    if (reponse.ok) cache.put(requete, reponse.clone());
    return reponse;
  }).catch(() => null);
  return enCache || (await promesseReseau) || new Response('Hors ligne', { status: 503 });
}

self.addEventListener('message', (evenement) => {
  if (evenement.data?.type === 'IGNORER_ATTENTE') self.skipWaiting();
});
