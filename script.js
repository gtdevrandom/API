'use strict';

/* =====================================================
   CLÉ API — mettez votre clé Twelve Data ici
   Inscription gratuite : https://twelvedata.com
   (800 requêtes/jour, forex + actions + historique)
   ===================================================== */
const CLES = {
  twelvedata: 'YOUR_TWELVEDATA_API_KEY',
};

/* =====================================================
   URLs de base
   ===================================================== */
const API = {
  coingecko:  'https://api.coingecko.com/api/v3',
  twelvedata: 'https://api.twelvedata.com',
};

const COMMISSION = 0.001;

/* =====================================================
   État global
   ===================================================== */
const etat = {
  solde: 10000,
  soldeInitial: 10000,
  positions: [],
  historique: [],
  pageActuelle: 'marche',
  actifSelectionne: null,
  categorieActuelle: 'crypto',
  typeOrdre: 'achat',
  periodeActuelle: 30,
  cache: {},
  cachePrix: {},
  marches: { crypto: [], forex: [], actions: [] },
  indexFermeture: null,
  promptInstallation: null,
  graphique: null,
};

/* =====================================================
   Stockage local
   ===================================================== */
function sauvegarder() {
  try {
    localStorage.setItem('alphatrade_v3', JSON.stringify({
      solde: etat.solde,
      soldeInitial: etat.soldeInitial,
      positions: etat.positions,
      historique: etat.historique,
    }));
  } catch (_) {}
}

function charger() {
  try {
    const raw = localStorage.getItem('alphatrade_v3');
    if (!raw) return;
    const d = JSON.parse(raw);
    etat.solde        = d.solde        ?? 10000;
    etat.soldeInitial = d.soldeInitial ?? 10000;
    etat.positions    = d.positions    ?? [];
    etat.historique   = d.historique   ?? [];
  } catch (_) {}
}

/* =====================================================
   Cache HTTP générique avec TTL
   ===================================================== */
async function fetchCache(url, cle, ttl = 60000) {
  const now = Date.now();
  const hit = etat.cache[cle];
  if (hit && now - hit.ts < ttl) return hit.donnees;

  const ctrl  = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 10000);
  try {
    const rep = await fetch(url, { headers: { Accept: 'application/json' }, signal: ctrl.signal });
    clearTimeout(timer);
    if (!rep.ok) throw new Error(`HTTP ${rep.status}`);
    const donnees = await rep.json();
    etat.cache[cle] = { donnees, ts: now };
    return donnees;
  } catch (e) {
    clearTimeout(timer);
    if (hit) return hit.donnees; // fallback cache périmé
    throw e;
  }
}

/* =====================================================
   Générateur pseudo-aléatoire déterministe (seed)
   Permet d'avoir un graphique fallback STABLE
   pour un actif donné — il ne change pas à chaque clic
   ===================================================== */
function seedRng(seed) {
  let s = seed;
  return function () {
    s = (s * 1664525 + 1013904223) & 0xffffffff;
    return (s >>> 0) / 0xffffffff;
  };
}

function strToSeed(str) {
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    hash = (Math.imul(31, hash) + str.charCodeAt(i)) | 0;
  }
  return Math.abs(hash);
}

/* Génère un historique simulé STABLE basé sur l'id de l'actif */
function genererHistoSimule(id, prixActuel, jours, volatilite = 0.02) {
  const rng = seedRng(strToSeed(id + '_' + jours));
  const nb  = jours <= 1 ? 48 : jours <= 7 ? jours * 24 : jours * 2;

  // On remonte dans le temps depuis le prix actuel
  const inversePrix = [prixActuel];
  for (let i = 1; i < nb; i++) {
    inversePrix.push(Math.max(0.0001, inversePrix[i - 1] * (1 + (rng() - 0.5) * volatilite)));
  }
  const prix = inversePrix.reverse();

  const pas   = (jours * 86400000) / nb;
  const debut = Date.now() - jours * 86400000;
  return prix.map((p, i) => ({ temps: new Date(debut + i * pas), prix: p }));
}

/* =====================================================
   Formatage
   ===================================================== */
function fmt$(n, dec = 2) {
  if (n == null || isNaN(n)) return '—';
  return Number(n).toLocaleString('fr-FR', {
    minimumFractionDigits: dec, maximumFractionDigits: dec,
  }) + '$';
}
function fmtQte(n) {
  if (n == null || isNaN(n)) return '—';
  return n >= 1
    ? Number(n).toLocaleString('fr-FR', { minimumFractionDigits: 2, maximumFractionDigits: 4 })
    : Number(n).toPrecision(4);
}
function fmtPct(n) {
  if (n == null || isNaN(n)) return '';
  return (n >= 0 ? '+' : '') + n.toFixed(2) + '%';
}
function fmtDate(ts) {
  return new Date(ts).toLocaleDateString('fr-FR', {
    day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit',
  });
}
function classeVar(v) { return v >= 0 ? 'hausse' : 'baisse'; }
function decPrix(p)   { return p < 0.01 ? 6 : p < 1 ? 4 : 2; }

/* =====================================================
   Notifications / Modales
   ===================================================== */
function notif(msg, type = 'info') {
  const c  = document.getElementById('conteneur-notifications');
  const el = document.createElement('div');
  el.className  = `notification ${type}`;
  el.textContent = msg;
  c.appendChild(el);
  setTimeout(() => el.remove(), 3300);
}
function ouvrirModale(id) { document.getElementById(id)?.classList.remove('cache'); }
function fermerModale(id) { document.getElementById(id)?.classList.add('cache'); }

/* =====================================================
   Navigation
   ===================================================== */
function allerVers(page) {
  etat.pageActuelle = page;
  document.querySelectorAll('.page').forEach(p => p.classList.remove('actif'));
  document.getElementById(`page-${page}`)?.classList.add('actif');
  document.querySelectorAll('.btn-nav').forEach(b =>
    b.classList.toggle('actif', b.dataset.page === page)
  );
  if (page === 'transactions') afficherTransactions();
  if (page === 'wallet') afficherWallet();
}

/* =====================================================
   ── CoinGecko — Crypto ──
   ===================================================== */
async function chargerCryptos() {
  const url = `${API.coingecko}/coins/markets?vs_currency=usd&order=market_cap_desc&per_page=50&page=1&sparkline=false&price_change_percentage=24h`;
  const donnees = await fetchCache(url, 'cg_markets', 60000);
  if (!Array.isArray(donnees)) throw new Error('Réponse CoinGecko invalide');

  donnees.forEach(c => { etat.cachePrix[c.id] = c.current_price || 0; });
  return donnees
    .filter(c => c.current_price > 0)
    .map(c => ({
      id:        c.id,
      symbole:   (c.symbol || '').toUpperCase() + 'USDT',
      nom:       c.name,
      prix:      c.current_price,
      variation: c.price_change_percentage_24h || 0,
      icone:     c.image || '📊',
      categorie: 'crypto',
    }));
}

async function chargerHistoCrypto(idCoin, jours) {
  const url = `${API.coingecko}/coins/${idCoin}/market_chart?vs_currency=usd&days=${jours}`;
  const donnees = await fetchCache(url, `cg_hist_${idCoin}_${jours}`, 120000);
  if (!donnees?.prices?.length) throw new Error('Pas de données');
  return donnees.prices
    .filter(([, p]) => p > 0)
    .map(([ts, p]) => ({ temps: new Date(ts), prix: p }));
}

/* =====================================================
   ── Twelve Data — Forex ──
   ===================================================== */
const PAIRES_FOREX = [
  { id: 'eurusd', symbole: 'EUR/USD', nom: 'Euro / Dollar',     td: 'EUR/USD' },
  { id: 'gbpusd', symbole: 'GBP/USD', nom: 'Livre / Dollar',    td: 'GBP/USD' },
  { id: 'usdjpy', symbole: 'USD/JPY', nom: 'Dollar / Yen',      td: 'USD/JPY' },
  { id: 'usdchf', symbole: 'USD/CHF', nom: 'Dollar / Franc CH', td: 'USD/CHF' },
  { id: 'audusd', symbole: 'AUD/USD', nom: 'AUD / Dollar',      td: 'AUD/USD' },
  { id: 'usdcad', symbole: 'USD/CAD', nom: 'Dollar / CAD',      td: 'USD/CAD' },
  { id: 'nzdusd', symbole: 'NZD/USD', nom: 'NZD / Dollar',      td: 'NZD/USD' },
  { id: 'eurgbp', symbole: 'EUR/GBP', nom: 'Euro / Livre',      td: 'EUR/GBP' },
];

// Prix de référence pour le fallback
const PRIX_REF_FOREX = {
  eurusd: 1.085, gbpusd: 1.265, usdjpy: 149.5, usdchf: 0.897,
  audusd: 0.652, usdcad: 1.364, nzdusd: 0.598, eurgbp: 0.858,
};

async function chargerForex() {
  if (!CLES.twelvedata || CLES.twelvedata === 'YOUR_TWELVEDATA_API_KEY') {
    return fallbackForex();
  }

  try {
    // Twelve Data accepte plusieurs symboles en une seule requête (économie de quota)
    const symbols = PAIRES_FOREX.map(p => p.td).join(',');
    const url = `${API.twelvedata}/price?symbol=${encodeURIComponent(symbols)}&apikey=${CLES.twelvedata}`;
    const data = await fetchCache(url, 'td_forex_prix', 60000);

    // Récupérer aussi la variation 24h
    const urlChange = `${API.twelvedata}/percent_change?symbol=${encodeURIComponent(symbols)}&interval=1day&apikey=${CLES.twelvedata}`;
    const dataChange = await fetchCache(urlChange, 'td_forex_change', 60000).catch(() => ({}));

    return PAIRES_FOREX.map(p => {
      // Twelve Data retourne un objet par symbole si multi, sinon direct
      const raw    = data[p.td] || data;
      const rawChg = dataChange[p.td] || dataChange;
      const prix   = parseFloat(raw?.price) || PRIX_REF_FOREX[p.id];
      const variation = parseFloat(rawChg?.percent_change) || 0;
      etat.cachePrix[p.id] = prix;
      return { id: p.id, symbole: p.symbole, nom: p.nom, prix, variation, icone: '💱', categorie: 'forex' };
    });
  } catch (e) {
    console.warn('Twelve Data forex error:', e.message);
    return fallbackForex();
  }
}

function fallbackForex() {
  return PAIRES_FOREX.map(p => {
    // Prix stable depuis le cache si dispo, sinon référence
    const prix = etat.cachePrix[p.id] || PRIX_REF_FOREX[p.id];
    etat.cachePrix[p.id] = prix;
    return { id: p.id, symbole: p.symbole, nom: p.nom, prix, variation: 0, icone: '💱', categorie: 'forex' };
  });
}

async function chargerHistoForex(id, jours) {
  const paire = PAIRES_FOREX.find(p => p.id === id);
  if (!paire) return genererHistoSimule(id, etat.cachePrix[id] || 1, jours, 0.003);

  if (!CLES.twelvedata || CLES.twelvedata === 'YOUR_TWELVEDATA_API_KEY') {
    return genererHistoSimule(id, etat.cachePrix[id] || PRIX_REF_FOREX[id], jours, 0.003);
  }

  try {
    const interval   = jours <= 1 ? '15min' : jours <= 7 ? '1h' : '1day';
    const outputsize = jours <= 1 ? 96 : jours <= 7 ? 168 : jours;
    const url = `${API.twelvedata}/time_series?symbol=${encodeURIComponent(paire.td)}&interval=${interval}&outputsize=${outputsize}&apikey=${CLES.twelvedata}`;
    const data = await fetchCache(url, `td_forex_hist_${id}_${jours}`, 180000);

    if (data.status === 'ok' && data.values?.length) {
      return data.values
        .reverse()
        .map(v => ({ temps: new Date(v.datetime), prix: parseFloat(v.close) }));
    }
    throw new Error(data.message || 'Données invalides');
  } catch (e) {
    console.warn('Twelve Data forex historique:', e.message);
    return genererHistoSimule(id, etat.cachePrix[id] || PRIX_REF_FOREX[id], jours, 0.003);
  }
}

/* =====================================================
   ── Twelve Data — Actions ──
   ===================================================== */
const SYMBOLES_ACTIONS = [
  { id: 'aapl',  symbole: 'AAPL',  nom: 'Apple Inc.',     td: 'AAPL'  },
  { id: 'msft',  symbole: 'MSFT',  nom: 'Microsoft',      td: 'MSFT'  },
  { id: 'googl', symbole: 'GOOGL', nom: 'Alphabet',       td: 'GOOGL' },
  { id: 'amzn',  symbole: 'AMZN',  nom: 'Amazon',         td: 'AMZN'  },
  { id: 'nvda',  symbole: 'NVDA',  nom: 'NVIDIA',         td: 'NVDA'  },
  { id: 'meta',  symbole: 'META',  nom: 'Meta Platforms', td: 'META'  },
  { id: 'tsla',  symbole: 'TSLA',  nom: 'Tesla',          td: 'TSLA'  },
  { id: 'nflx',  symbole: 'NFLX',  nom: 'Netflix',        td: 'NFLX'  },
];

const PRIX_REF_ACTIONS = {
  aapl: 175, msft: 415, googl: 160, amzn: 185,
  nvda: 870, meta: 490, tsla: 175,  nflx: 630,
};

async function chargerActions() {
  if (!CLES.twelvedata || CLES.twelvedata === 'YOUR_TWELVEDATA_API_KEY') {
    return fallbackActions();
  }

  try {
    const symbols = SYMBOLES_ACTIONS.map(a => a.td).join(',');
    const url = `${API.twelvedata}/price?symbol=${encodeURIComponent(symbols)}&apikey=${CLES.twelvedata}`;
    const data = await fetchCache(url, 'td_actions_prix', 60000);

    const urlChange = `${API.twelvedata}/percent_change?symbol=${encodeURIComponent(symbols)}&interval=1day&apikey=${CLES.twelvedata}`;
    const dataChange = await fetchCache(urlChange, 'td_actions_change', 60000).catch(() => ({}));

    return SYMBOLES_ACTIONS.map(a => {
      const raw    = data[a.td]    || data;
      const rawChg = dataChange[a.td] || dataChange;
      const prix   = parseFloat(raw?.price) || PRIX_REF_ACTIONS[a.id];
      const variation = parseFloat(rawChg?.percent_change) || 0;
      etat.cachePrix[a.id] = prix;
      return { id: a.id, symbole: a.symbole, nom: a.nom, prix, variation, icone: '📈', categorie: 'actions' };
    });
  } catch (e) {
    console.warn('Twelve Data actions error:', e.message);
    return fallbackActions();
  }
}

function fallbackActions() {
  return SYMBOLES_ACTIONS.map(a => {
    const prix = etat.cachePrix[a.id] || PRIX_REF_ACTIONS[a.id];
    etat.cachePrix[a.id] = prix;
    return { id: a.id, symbole: a.symbole, nom: a.nom, prix, variation: 0, icone: '📈', categorie: 'actions' };
  });
}

async function chargerHistoAction(id, jours) {
  const action = SYMBOLES_ACTIONS.find(a => a.id === id);
  if (!action) return genererHistoSimule(id, etat.cachePrix[id] || 100, jours);

  if (!CLES.twelvedata || CLES.twelvedata === 'YOUR_TWELVEDATA_API_KEY') {
    return genererHistoSimule(id, etat.cachePrix[id] || PRIX_REF_ACTIONS[id], jours);
  }

  try {
    const interval   = jours <= 1 ? '15min' : jours <= 7 ? '1h' : '1day';
    const outputsize = jours <= 1 ? 96 : jours <= 7 ? 168 : jours;
    const url = `${API.twelvedata}/time_series?symbol=${encodeURIComponent(action.td)}&interval=${interval}&outputsize=${outputsize}&apikey=${CLES.twelvedata}`;
    const data = await fetchCache(url, `td_action_hist_${id}_${jours}`, 180000);

    if (data.status === 'ok' && data.values?.length) {
      return data.values
        .reverse()
        .map(v => ({ temps: new Date(v.datetime), prix: parseFloat(v.close) }));
    }
    throw new Error(data.message || 'Données invalides');
  } catch (e) {
    console.warn('Twelve Data action historique:', e.message);
    return genererHistoSimule(id, etat.cachePrix[id] || PRIX_REF_ACTIONS[id], jours);
  }
}

/* =====================================================
   Graphique Chart.js
   ===================================================== */
function dessinerGraphique(historique) {
  const canvas = document.getElementById('graphique-principal');
  if (!canvas || !historique?.length) return;

  if (etat.graphique) { etat.graphique.destroy(); etat.graphique = null; }

  const prix      = historique.map(h => h.prix);
  const etiquettes = historique.map(h => h.temps);
  const enHausse  = prix[prix.length - 1] >= prix[0];
  const couleur   = enHausse ? '#22c55e' : '#ef4444';

  etat.graphique = new Chart(canvas, {
    type: 'line',
    data: {
      labels: etiquettes,
      datasets: [{
        data: prix,
        borderColor: couleur,
        borderWidth: 2,
        fill: true,
        backgroundColor: ctx => {
          const g = ctx.chart.ctx.createLinearGradient(0, 0, 0, ctx.chart.height);
          g.addColorStop(0, enHausse ? 'rgba(34,197,94,0.25)' : 'rgba(239,68,68,0.25)');
          g.addColorStop(1, 'rgba(0,0,0,0)');
          return g;
        },
        pointRadius: 0,
        tension: 0.4,
      }],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      interaction: { mode: 'index', intersect: false },
      plugins: {
        legend: { display: false },
        tooltip: {
          backgroundColor: '#1a1a1a',
          titleColor: '#666',
          bodyColor: '#f0f0f0',
          borderColor: '#2a2a2a',
          borderWidth: 1,
          padding: 10,
          displayColors: false,
          callbacks: {
            label: ctx => {
              const v = ctx.parsed.y;
              return ' ' + fmt$(v, v < 1 ? 4 : 2);
            },
          },
        },
      },
      scales: {
        x: {
          display: true,
          grid: { display: false },
          ticks: {
            maxTicksLimit: 5,
            font: { size: 11, family: "'Inter', sans-serif" },
            color: '#606060', maxRotation: 0,
            callback: (_, i) => {
              const d = etiquettes[i];
              if (!d || !(d instanceof Date)) return '';
              return d.toLocaleDateString('fr-FR', { day: 'numeric', month: 'short' });
            },
          },
        },
        y: {
          display: true, position: 'right',
          grid: { color: 'rgba(255,255,255,0.04)' },
          ticks: {
            maxTicksLimit: 5,
            font: { size: 11, family: "'Inter', sans-serif" },
            color: '#606060',
            callback: v => {
              if (v >= 1000) return '$' + (v / 1000).toFixed(0) + 'K';
              if (v >= 1)    return '$' + v.toFixed(0);
              return '$' + v.toPrecision(3);
            },
          },
        },
      },
    },
  });
}

/* =====================================================
   Page Marché
   ===================================================== */
async function chargerPageMarche(cat = etat.categorieActuelle) {
  etat.categorieActuelle = cat;

  document.querySelectorAll('.onglet').forEach(b =>
    b.classList.toggle('actif', b.dataset.cat === cat)
  );

  const placeholders = { crypto: 'Rechercher une crypto', forex: 'Rechercher un change', actions: 'Rechercher une action' };
  const champR = document.getElementById('champ-recherche');
  if (champR) champR.placeholder = placeholders[cat] || 'Rechercher';

  mettreAJourAttribution(cat);

  let actifs = [];
  try {
    if (cat === 'crypto') {
      if (!etat.marches.crypto.length) etat.marches.crypto = await chargerCryptos();
      actifs = etat.marches.crypto;
    } else if (cat === 'forex') {
      if (!etat.marches.forex.length) etat.marches.forex = await chargerForex();
      actifs = etat.marches.forex;
    } else {
      if (!etat.marches.actions.length) etat.marches.actions = await chargerActions();
      actifs = etat.marches.actions;
    }
  } catch (e) {
    console.error('chargerPageMarche:', e);
    notif('Erreur de chargement des données', 'erreur');
  }

  const recherche = champR?.value.trim().toLowerCase() || '';
  const filtres   = recherche
    ? actifs.filter(a => a.symbole.toLowerCase().includes(recherche) || a.nom.toLowerCase().includes(recherche))
    : actifs;

  if (filtres.length && (!etat.actifSelectionne || etat.actifSelectionne.categorie !== cat)) {
    await selectionnerActif(filtres[0], true);
  }

  afficherListeActifs(filtres);
}

function mettreAJourAttribution(cat) {
  const lien  = document.getElementById('attribution-lien');
  const img   = document.getElementById('attribution-img');
  const texte = document.getElementById('attribution-texte');
  if (!lien) return;

  if (cat === 'crypto') {
    lien.href = 'https://www.coingecko.com';
    img.src   = 'https://static.coingecko.com/s/coingecko-logo-d13d6bcceddbb003f146b33c2f7e8193d72b93bb02229aa0c83734f2fb6a56bb.png';
    img.style.display = '';
    texte.textContent = 'Données fournies par CoinGecko';
  } else {
    lien.href = 'https://twelvedata.com';
    img.style.display = 'none';
    texte.textContent = cat === 'forex' ? 'Données Forex par Twelve Data' : 'Données Actions par Twelve Data';
  }
}

function afficherListeActifs(actifs) {
  const liste = document.getElementById('liste-actifs');
  if (!actifs.length) {
    liste.innerHTML = `<div class="etat-vide">Aucun résultat</div>`;
    return;
  }
  liste.innerHTML = actifs.map(a => {
    const iconeHtml = typeof a.icone === 'string' && a.icone.startsWith('http')
      ? `<img src="${a.icone}" alt="${a.nom}" loading="lazy">`
      : a.icone;
    const dec = decPrix(a.prix);
    const sel = etat.actifSelectionne?.id === a.id ? 'selectionne' : '';
    return `
      <div class="element-actif ${sel}" data-id="${a.id}">
        <div class="icone-actif">${iconeHtml}</div>
        <div class="info-actif">
          <div class="symbole-actif-liste">${a.symbole}</div>
          <div class="nom-actif-liste">${a.nom}</div>
        </div>
        <div style="text-align:right">
          <div class="prix-actif-liste">${fmt$(a.prix, dec)}</div>
          <div class="variation-actif-liste ${classeVar(a.variation)}">${fmtPct(a.variation)}</div>
        </div>
      </div>`;
  }).join('');

  liste.querySelectorAll('.element-actif').forEach(el =>
    el.addEventListener('click', () => {
      const actif = actifs.find(a => a.id === el.dataset.id);
      if (actif) selectionnerActif(actif);
    })
  );
}

async function selectionnerActif(actif, auto = false) {
  etat.actifSelectionne = actif;
  const prix = actif.prix || etat.cachePrix[actif.id] || 0;
  const dec  = decPrix(prix);

  document.getElementById('nom-actif').textContent        = actif.symbole;
  document.getElementById('nom-complet-actif').textContent = actif.nom;
  document.getElementById('prix-actif').textContent       = fmt$(prix, dec);

  const elVar = document.getElementById('variation-actif');
  elVar.textContent = fmtPct(actif.variation);
  elVar.className   = `variation-actif ${classeVar(actif.variation)}`;

  document.querySelectorAll('.element-actif').forEach(el =>
    el.classList.toggle('selectionne', el.dataset.id === actif.id)
  );

  if (auto) await chargerEtDessiner(actif, etat.periodeActuelle);
}

async function chargerEtDessiner(actif, jours) {
  etat.periodeActuelle = jours;
  document.querySelectorAll('.btn-periode').forEach(b =>
    b.classList.toggle('actif', +b.dataset.jours === jours)
  );

  const elLoad = document.getElementById('chargement-graphique');
  elLoad?.classList.remove('cache');

  try {
    let historique;
    if (actif.categorie === 'crypto') {
      historique = await chargerHistoCrypto(actif.id, jours);
    } else if (actif.categorie === 'forex') {
      historique = await chargerHistoForex(actif.id, jours);
    } else {
      historique = await chargerHistoAction(actif.id, jours);
    }
    elLoad?.classList.add('cache');
    dessinerGraphique(historique);
  } catch (e) {
    elLoad?.classList.add('cache');
    // Fallback déterministe : même graphique à chaque clic pour cet actif
    const px = etat.cachePrix[actif.id] || actif.prix || 100;
    dessinerGraphique(genererHistoSimule(actif.id, px, jours));
  }
}

/* =====================================================
   Ordres
   ===================================================== */
function ouvrirFormOrdre(type) {
  if (!etat.actifSelectionne) return notif('Sélectionnez un actif', 'erreur');
  etat.typeOrdre = type;

  const actif = etat.actifSelectionne;
  const prix  = actif.prix || etat.cachePrix[actif.id] || 0;
  const dec   = decPrix(prix);

  const tag = document.getElementById('modale-tag-type');
  if (tag) tag.textContent = type === 'achat' ? 'ACHAT' : 'VENTE';

  document.getElementById('titre-modale-ordre').textContent  = type === 'achat' ? 'Acheter' : 'Vendre';
  document.getElementById('ordre-actif-nom').textContent     = actif.symbole;
  document.getElementById('ordre-actif-prix').textContent    = fmt$(prix, dec);
  document.getElementById('solde-disponible').textContent    = fmt$(etat.solde);
  document.getElementById('montant-ordre').value             = '';
  document.getElementById('quantite-estimee').textContent    = '—';

  ouvrirModale('modale-ordre');
}

function mettreAJourQuantite() {
  const actif  = etat.actifSelectionne;
  if (!actif) return;
  const prix   = actif.prix || etat.cachePrix[actif.id] || 0;
  const montant = parseFloat(document.getElementById('montant-ordre').value);
  document.getElementById('quantite-estimee').textContent =
    (!montant || !prix) ? '—' : fmtQte(montant / prix) + ' ' + actif.symbole;
}

function confirmerOrdre() {
  const actif = etat.actifSelectionne;
  if (!actif) return;

  const montant = parseFloat(document.getElementById('montant-ordre').value);
  if (!montant || montant <= 0) return notif('Montant invalide', 'erreur');

  const prix = actif.prix || etat.cachePrix[actif.id];
  if (!prix)  return notif('Prix indisponible', 'erreur');

  const quantite   = montant / prix;
  const commission = montant * COMMISSION;

  if (etat.typeOrdre === 'achat') {
    if (montant + commission > etat.solde) return notif('Solde insuffisant', 'erreur');
    etat.solde -= montant + commission;
    etat.positions.push({
      id: actif.id, symbole: actif.symbole, nom: actif.nom, icone: actif.icone,
      sens: 'achat', quantite, prixEntree: prix, montant,
      horodatage: Date.now(), categorie: actif.categorie,
    });
    etat.historique.push({ id: actif.id, symbole: actif.symbole, type: 'achat', montant, prix, quantite, horodatage: Date.now(), pnl: null });
    notif(`Achat de ${fmtQte(quantite)} ${actif.symbole}`, 'succes');

  } else {
    const pos = etat.positions.find(p => p.id === actif.id && p.sens === 'achat');
    if (!pos) return notif('Aucune position sur cet actif', 'erreur');

    const qtVente = Math.min(quantite, pos.quantite);
    const valeur  = qtVente * prix;
    const comm2   = valeur * COMMISSION;
    const pnl     = (prix - pos.prixEntree) * qtVente - comm2;

    etat.solde += valeur - comm2;
    pos.quantite -= qtVente;
    if (pos.quantite < 0.000001) etat.positions = etat.positions.filter(p => p !== pos);

    etat.historique.push({ id: actif.id, symbole: actif.symbole, type: 'vente', montant: valeur, prix, quantite: qtVente, horodatage: Date.now(), pnl });
    notif(`Vente — P&L : ${pnl >= 0 ? '+' : ''}${fmt$(pnl)}`, pnl >= 0 ? 'succes' : 'erreur');
  }

  fermerModale('modale-ordre');
  sauvegarder();
  mettreAJourBadgePositions();
  if (etat.pageActuelle === 'wallet') afficherWallet();
}

/* =====================================================
   Page Transactions
   ===================================================== */
function mettreAJourBadgePositions() {
  const badge = document.getElementById('badge-positions');
  if (badge) badge.textContent = etat.positions.length;
}

function afficherTransactions() {
  mettreAJourBadgePositions();
  const liste = document.getElementById('liste-transactions');

  if (!etat.positions.length) {
    liste.innerHTML = `<div class="etat-vide">Aucune position ouverte</div>`;
  } else {
    liste.innerHTML = `
      <div class="entete-transactions">
        <span>Quantité</span><span>Actif</span><span>Entrée</span><span></span>
      </div>
      ${etat.positions.map((pos, i) => `
        <div class="element-transaction">
          <span class="qt-transaction">${fmtQte(pos.quantite)}</span>
          <span class="symbole-transaction">${pos.symbole}</span>
          <span class="prix-transaction">${fmt$(pos.prixEntree, decPrix(pos.prixEntree))}</span>
          <button class="bouton-fermer-pos" data-index="${i}">Fermer</button>
        </div>`).join('')}`;

    liste.querySelectorAll('.bouton-fermer-pos').forEach(btn =>
      btn.addEventListener('click', () => ouvrirModaleFermeture(+btn.dataset.index))
    );
  }

  // Historique
  const hist    = document.getElementById('liste-historique');
  const entrees = [...etat.historique].reverse().slice(0, 30);
  if (!entrees.length) {
    hist.innerHTML = `<div class="etat-vide">Aucune transaction</div>`;
  } else {
    hist.innerHTML = entrees.map(h => {
      const pnlHtml = h.pnl != null
        ? `<div class="historique-pnl" style="color:${h.pnl >= 0 ? 'var(--vert)' : 'var(--rouge)'}">P&L : ${h.pnl >= 0 ? '+' : ''}${fmt$(h.pnl)}</div>`
        : '';
      return `
        <div class="element-historique">
          <div class="historique-gauche">
            <span class="historique-type ${h.type}">${h.type.toUpperCase()}</span>
            <span class="historique-symbole">${h.symbole}</span>
            <span class="historique-date">${fmtDate(h.horodatage)}</span>
          </div>
          <div class="historique-droite">
            <div class="historique-montant">${fmt$(h.montant)}</div>
            ${pnlHtml}
          </div>
        </div>`;
    }).join('');
  }
}

function ouvrirModaleFermeture(index) {
  const pos = etat.positions[index];
  if (!pos) return;
  etat.indexFermeture = index;

  const prixActuel = etat.cachePrix[pos.id] || pos.prixEntree;
  const pnl        = (prixActuel - pos.prixEntree) * pos.quantite;

  document.getElementById('fp-actif').textContent    = pos.symbole;
  document.getElementById('fp-quantite').textContent = fmtQte(pos.quantite);
  document.getElementById('fp-entree').textContent   = fmt$(pos.prixEntree, decPrix(pos.prixEntree));
  document.getElementById('fp-actuel').textContent   = fmt$(prixActuel, decPrix(prixActuel));

  const elPnl = document.getElementById('fp-pnl');
  elPnl.textContent = (pnl >= 0 ? '+' : '') + fmt$(pnl);
  elPnl.style.color = pnl >= 0 ? 'var(--vert)' : 'var(--rouge)';

  ouvrirModale('modale-fermer-position');
}

function executerFermeture() {
  const pos = etat.positions[etat.indexFermeture];
  if (!pos) return;

  const prixActuel = etat.cachePrix[pos.id] || pos.prixEntree;
  const valeur     = prixActuel * pos.quantite;
  const commission = valeur * COMMISSION;
  const pnl        = (prixActuel - pos.prixEntree) * pos.quantite - commission;

  etat.solde += valeur - commission;
  etat.historique.push({
    id: pos.id, symbole: pos.symbole, type: 'fermeture',
    montant: valeur, prix: prixActuel, quantite: pos.quantite,
    horodatage: Date.now(), pnl,
  });
  etat.positions.splice(etat.indexFermeture, 1);

  sauvegarder();
  fermerModale('modale-fermer-position');
  notif(`Position fermée — P&L : ${pnl >= 0 ? '+' : ''}${fmt$(pnl)}`, pnl >= 0 ? 'succes' : 'erreur');
  afficherTransactions();
  if (etat.pageActuelle === 'wallet') afficherWallet();
}

/* =====================================================
   Page Wallet
   Bénéfice = (solde liquide + valeur mark-to-market) - capital initial
   Ex: départ 1000$ → achat → 995$ solde, 10$ en position = -5$ bénéfice
       prix monte → position vaut 16$ → 1001$ total → +1$ bénéfice ✓
   ===================================================== */
function afficherWallet() {
  const valeurPositions = etat.positions.reduce((total, pos) => {
    return total + (etat.cachePrix[pos.id] || pos.prixEntree) * pos.quantite;
  }, 0);

  const soldeTotal = etat.solde + valeurPositions;
  const benefice   = soldeTotal - etat.soldeInitial;

  document.getElementById('wallet-solde').textContent   = fmt$(etat.solde);
  document.getElementById('wallet-initial').textContent = fmt$(etat.soldeInitial);

  const elBen = document.getElementById('wallet-benefice');
  elBen.textContent = (benefice >= 0 ? '+' : '') + fmt$(benefice);
  elBen.style.color = benefice >= 0 ? 'var(--vert)' : 'var(--rouge)';

  const elMonnaies = document.getElementById('wallet-monnaies');
  if (!etat.positions.length) {
    elMonnaies.innerHTML = `<div class="etat-vide" style="padding:20px 0">Aucune position ouverte</div>`;
    return;
  }

  const lignes = etat.positions.map(pos => {
    const prixActuel = etat.cachePrix[pos.id] || pos.prixEntree;
    return `<div class="ligne-monnaie">
      <span class="qt-monnaie">${fmtQte(pos.quantite)}</span>
      <span class="nom-monnaie">${pos.symbole}</span>
      <span class="prix-monnaie">${fmt$(prixActuel, decPrix(prixActuel))}</span>
    </div>`;
  }).join('');

  elMonnaies.innerHTML = `
    <div class="entete-monnaies"><span>Quantité</span><span>Actif</span><span style="text-align:right">Prix actuel</span></div>
    ${lignes}`;
}

/* =====================================================
   Configuration du solde
   ===================================================== */
function appliquerConfig() {
  const presetActif = document.querySelector('.btn-preset.actif');
  let montant = presetActif ? +presetActif.dataset.montant : 10000;
  const custom = parseFloat(document.getElementById('montant-custom').value);
  if (custom >= 100) montant = custom;

  etat.solde        = montant;
  etat.soldeInitial = montant;
  etat.positions    = [];
  etat.historique   = [];

  sauvegarder();
  fermerModale('modale-config');
  notif(`Solde configuré : ${fmt$(montant)}`, 'succes');
  mettreAJourBadgePositions();
  if (etat.pageActuelle === 'wallet') afficherWallet();
}

/* =====================================================
   Rafraîchissement des prix (30s)
   ===================================================== */
async function rafraichirPrix() {
  try {
    let liste = [];
    if (etat.categorieActuelle === 'crypto') {
      liste = await chargerCryptos();
      etat.marches.crypto = liste;
    } else if (etat.categorieActuelle === 'forex') {
      liste = await chargerForex();
      etat.marches.forex = liste;
    } else {
      liste = await chargerActions();
      etat.marches.actions = liste;
    }

    liste.forEach(a => { etat.cachePrix[a.id] = a.prix; });

    // Mettre à jour l'actif affiché
    if (etat.actifSelectionne) {
      const maj = liste.find(a => a.id === etat.actifSelectionne.id);
      if (maj) {
        etat.actifSelectionne.prix      = maj.prix;
        etat.actifSelectionne.variation = maj.variation;
        const dec = decPrix(maj.prix);
        document.getElementById('prix-actif').textContent = fmt$(maj.prix, dec);
        const elVar = document.getElementById('variation-actif');
        elVar.textContent = fmtPct(maj.variation);
        elVar.className   = `variation-actif ${classeVar(maj.variation)}`;
      }
    }

    // Horodatage
    const el = document.getElementById('indicateur-maj');
    if (el) {
      const h = new Date();
      el.textContent = `MAJ ${h.getHours().toString().padStart(2, '0')}:${h.getMinutes().toString().padStart(2, '0')}`;
    }
  } catch (_) {}
}

/* =====================================================
   PWA
   ===================================================== */
function afficherGuideInstallation(msg) {
  document.getElementById('bulle-installation')?.remove();
  const bulle = document.createElement('div');
  bulle.id = 'bulle-installation';
  bulle.innerHTML = `<div class="fleche-bulle"></div><p>${msg}</p><button onclick="document.getElementById('bulle-installation').remove()">Compris</button>`;
  document.getElementById('groupe-boutons-haut')?.appendChild(bulle);
  setTimeout(() => {
    document.addEventListener('click', function f(e) {
      if (!bulle.contains(e.target)) { bulle.remove(); document.removeEventListener('click', f); }
    });
  }, 100);
}

function configurerPWA() {
  window.addEventListener('beforeinstallprompt', e => {
    e.preventDefault();
    etat.promptInstallation = e;
    if (!localStorage.getItem('install-ignore')) {
      setTimeout(() => document.getElementById('banniere-installation')?.classList.remove('cache'), 4000);
    }
  });

  async function lancerInstallation() {
    if (navigator.standalone || window.matchMedia('(display-mode: standalone)').matches) {
      return notif('Application déjà installée', 'info');
    }
    if (etat.promptInstallation) {
      etat.promptInstallation.prompt();
      const { outcome } = await etat.promptInstallation.userChoice;
      if (outcome === 'accepted') notif('Application installée !', 'succes');
      etat.promptInstallation = null;
      document.getElementById('banniere-installation')?.classList.add('cache');
    } else {
      const ua = navigator.userAgent;
      let msg  = 'Ouvrez le menu du navigateur → "Installer"';
      if (/Safari/.test(ua) && !/Chrome/.test(ua)) msg = 'Sur Safari : bouton Partager ↑ → "Sur l\'écran d\'accueil"';
      else if (/Chrome/.test(ua)) msg = 'Sur Chrome : menu ⋮ → "Ajouter à l\'écran d\'accueil"';
      else if (/Firefox/.test(ua)) msg = 'Sur Firefox : menu ⋮ → "Installer"';
      afficherGuideInstallation(msg);
    }
  }

  document.getElementById('bouton-telecharger')?.addEventListener('click', lancerInstallation);
  document.getElementById('bouton-installer')?.addEventListener('click',   lancerInstallation);
  document.getElementById('bouton-ignorer')?.addEventListener('click', () => {
    document.getElementById('banniere-installation')?.classList.add('cache');
    localStorage.setItem('install-ignore', '1');
  });
}

/* =====================================================
   Service Worker
   ===================================================== */
function enregistrerSW() {
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('./sw.js', { scope: './' })
      .then(reg => {
        reg.addEventListener('updatefound', () => {
          reg.installing?.addEventListener('statechange', function () {
            if (this.state === 'installed' && navigator.serviceWorker.controller) {
              this.postMessage({ type: 'SKIP_WAITING' });
            }
          });
        });
      })
      .catch(e => console.warn('SW:', e));
  }
}

/* =====================================================
   Événements
   ===================================================== */
function configurerEvenements() {
  document.querySelectorAll('.btn-nav').forEach(btn =>
    btn.addEventListener('click', () => allerVers(btn.dataset.page))
  );
  document.querySelectorAll('.onglet').forEach(btn =>
    btn.addEventListener('click', () => chargerPageMarche(btn.dataset.cat))
  );

  let timerRecherche;
  document.getElementById('champ-recherche')?.addEventListener('input', () => {
    clearTimeout(timerRecherche);
    timerRecherche = setTimeout(() => chargerPageMarche(etat.categorieActuelle), 300);
  });

  document.querySelectorAll('.btn-periode').forEach(btn =>
    btn.addEventListener('click', () => {
      if (etat.actifSelectionne) chargerEtDessiner(etat.actifSelectionne, +btn.dataset.jours);
    })
  );

  document.getElementById('bouton-acheter')?.addEventListener('click', () => ouvrirFormOrdre('achat'));
  document.getElementById('bouton-vendre')?.addEventListener('click',  () => ouvrirFormOrdre('vente'));

  document.getElementById('montant-ordre')?.addEventListener('input', mettreAJourQuantite);
  document.querySelectorAll('.btn-rapide').forEach(btn =>
    btn.addEventListener('click', () => {
      document.getElementById('montant-ordre').value = (etat.solde * (+btn.dataset.pct / 100)).toFixed(2);
      mettreAJourQuantite();
    })
  );

  document.getElementById('bouton-confirmer-ordre')?.addEventListener('click', confirmerOrdre);
  document.getElementById('bouton-executer-fermeture')?.addEventListener('click', executerFermeture);

  document.getElementById('bouton-config')?.addEventListener('click',        () => ouvrirModale('modale-config'));
  document.getElementById('bouton-ouvrir-config')?.addEventListener('click', () => ouvrirModale('modale-config'));
  document.getElementById('bouton-appliquer')?.addEventListener('click', appliquerConfig);
  document.querySelectorAll('.btn-preset').forEach(btn =>
    btn.addEventListener('click', () => {
      document.querySelectorAll('.btn-preset').forEach(b => b.classList.remove('actif'));
      btn.classList.add('actif');
    })
  );

  document.querySelectorAll('.modale-fermer, [data-modale]').forEach(el =>
    el.addEventListener('click', () => { if (el.dataset.modale) fermerModale(el.dataset.modale); })
  );
  document.querySelectorAll('.fond-modale').forEach(fond =>
    fond.addEventListener('click', e => { if (e.target === fond) fond.classList.add('cache'); })
  );
}

/* =====================================================
   Démarrage
   ===================================================== */
async function demarrer() {
  charger();
  configurerEvenements();
  configurerPWA();
  enregistrerSW();

  setTimeout(async () => {
    const ecran = document.getElementById('ecran-chargement');
    ecran?.classList.add('disparaitre');
    setTimeout(async () => {
      ecran && (ecran.style.display = 'none');
      document.getElementById('application')?.classList.remove('cache');
      mettreAJourBadgePositions();
      await chargerPageMarche('crypto');
    }, 350);
  }, 1000);

  setInterval(rafraichirPrix, 30000);
}

document.addEventListener('DOMContentLoaded', demarrer);
