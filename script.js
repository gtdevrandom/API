'use strict';

/* =====================================================
   CLÉS API — remplacez par les vôtres
   ===================================================== */
const CLES = {
  exchangerate: 'YOUR_EXCHANGERATE_API_KEY', // https://www.exchangerate-api.com
  finnhub: 'YOUR_FINNHUB_API_KEY',           // https://finnhub.io
};

/* =====================================================
   URLs de base
   ===================================================== */
const API = {
  coingecko:    'https://api.coingecko.com/api/v3',
  exchangerate: `https://v6.exchangerate-api.com/v6/${CLES.exchangerate}`,
  finnhub:      'https://finnhub.io/api/v1',
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
  cache: {},       // { cle: { donnees, ts } }
  cachePrix: {},
  marches: { crypto: [], forex: [], actions: [] },
  indexFermeture: null,
  promptInstallation: null,
  graphique: null,
  intervalMaj: null,
};

/* =====================================================
   Stockage local
   ===================================================== */
function sauvegarder() {
  try {
    localStorage.setItem('alphatrade_v2', JSON.stringify({
      solde: etat.solde,
      soldeInitial: etat.soldeInitial,
      positions: etat.positions,
      historique: etat.historique,
    }));
  } catch(_) {}
}

function charger() {
  try {
    const raw = localStorage.getItem('alphatrade_v2');
    if (!raw) return;
    const d = JSON.parse(raw);
    etat.solde        = d.solde        ?? 10000;
    etat.soldeInitial = d.soldeInitial ?? 10000;
    etat.positions    = d.positions    ?? [];
    etat.historique   = d.historique   ?? [];
  } catch(_) {}
}

/* =====================================================
   Cache HTTP générique
   ===================================================== */
async function fetchCache(url, cle, ttl = 60000) {
  const now = Date.now();
  const hit = etat.cache[cle];
  if (hit && now - hit.ts < ttl) return hit.donnees;

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 10000);

  try {
    const rep = await fetch(url, {
      headers: { Accept: 'application/json' },
      signal: ctrl.signal,
    });
    clearTimeout(timer);
    if (!rep.ok) throw new Error(`HTTP ${rep.status}`);
    const donnees = await rep.json();
    etat.cache[cle] = { donnees, ts: now };
    return donnees;
  } catch(e) {
    clearTimeout(timer);
    console.warn(`fetchCache [${cle}]:`, e.message);
    if (hit) return hit.donnees;   // fallback cache périmé
    throw e;
  }
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

function decCryptos(p) { return p < 0.01 ? 6 : p < 1 ? 4 : 2; }

/* =====================================================
   Notifications
   ===================================================== */
function notif(msg, type = 'info') {
  const c = document.getElementById('conteneur-notifications');
  const el = document.createElement('div');
  el.className = `notification ${type}`;
  el.textContent = msg;
  c.appendChild(el);
  setTimeout(() => el.remove(), 3300);
}

function ouvrirModale(id)  { document.getElementById(id)?.classList.remove('cache'); }
function fermerModale(id)  { document.getElementById(id)?.classList.add('cache'); }

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
   ── API COINGECKO ──
   ===================================================== */
async function chargerCryptos() {
  const url = `${API.coingecko}/coins/markets?vs_currency=usd&order=market_cap_desc&per_page=50&page=1&sparkline=false&price_change_percentage=24h`;
  const donnees = await fetchCache(url, 'cg_markets', 60000);
  if (!Array.isArray(donnees)) throw new Error('Réponse CoinGecko invalide');

  donnees.forEach(c => { etat.cachePrix[c.id] = c.current_price || 0; });
  return donnees
    .filter(c => c.current_price > 0)
    .map(c => ({
      id: c.id,
      symbole: (c.symbol || '').toUpperCase() + 'USDT',
      nom: c.name,
      prix: c.current_price,
      variation: c.price_change_percentage_24h || 0,
      icone: c.image || '📊',
      categorie: 'crypto',
    }));
}

async function chargerHistoCrypto(idCoin, jours) {
  const url = `${API.coingecko}/coins/${idCoin}/market_chart?vs_currency=usd&days=${jours}`;
  const donnees = await fetchCache(url, `cg_hist_${idCoin}_${jours}`, 120000);
  if (!donnees?.prices?.length) throw new Error('Pas de données histogramme');
  return donnees.prices
    .filter(([, p]) => p > 0)
    .map(([ts, p]) => ({ temps: new Date(ts), prix: p }));
}

/* =====================================================
   ── API EXCHANGERATE ──
   ===================================================== */
const PAIRES_FOREX = [
  { id: 'eurusd', symbole: 'EUR/USD', nom: 'Euro / Dollar',      base: 'EUR', quote: 'USD' },
  { id: 'gbpusd', symbole: 'GBP/USD', nom: 'Livre / Dollar',     base: 'GBP', quote: 'USD' },
  { id: 'usdjpy', symbole: 'USD/JPY', nom: 'Dollar / Yen',       base: 'USD', quote: 'JPY' },
  { id: 'usdchf', symbole: 'USD/CHF', nom: 'Dollar / Franc CH',  base: 'USD', quote: 'CHF' },
  { id: 'audusd', symbole: 'AUD/USD', nom: 'AUD / Dollar',       base: 'AUD', quote: 'USD' },
  { id: 'usdcad', symbole: 'USD/CAD', nom: 'Dollar / CAD',       base: 'USD', quote: 'CAD' },
  { id: 'nzdusd', symbole: 'NZD/USD', nom: 'NZD / Dollar',       base: 'NZD', quote: 'USD' },
  { id: 'eurgbp', symbole: 'EUR/GBP', nom: 'Euro / Livre',       base: 'EUR', quote: 'GBP' },
];

// Taux de référence pour les calculs de variation et historique
const TAUX_REF = {
  EUR: 1.085, GBP: 1.265, USD: 1, JPY: 0.00667,
  CHF: 1.115, AUD: 0.652, CAD: 0.733, NZD: 0.598,
};

async function chargerForex() {
  // On récupère les taux depuis USD via l'API ExchangeRate
  if (CLES.exchangerate && CLES.exchangerate !== 'YOUR_EXCHANGERATE_API_KEY') {
    try {
      const url = `${API.exchangerate}/latest/USD`;
      const data = await fetchCache(url, 'er_usd', 300000);

      if (data.result === 'success' && data.conversion_rates) {
        const rates = data.conversion_rates;
        return PAIRES_FOREX.map(p => {
          // Calcule le prix de la paire (base en USD / quote en USD)
          const baseEnUsd   = p.base === 'USD'   ? 1 : 1 / (rates[p.base]   || 1);
          const quoteEnUsd  = p.quote === 'USD'  ? 1 : 1 / (rates[p.quote]  || 1);
          const prix = baseEnUsd / (quoteEnUsd > 0 ? quoteEnUsd : 1);

          // Variation simulée légère (l'API ExchangeRate free ne donne pas de variation 24h)
          const variation = (Math.random() - 0.48) * 1.2;

          etat.cachePrix[p.id] = prix;
          return {
            id: p.id, symbole: p.symbole, nom: p.nom,
            prix, variation, icone: '💱', categorie: 'forex',
          };
        });
      }
    } catch(e) {
      console.warn('ExchangeRate API error:', e.message);
    }
  }

  // Fallback : données simulées autour de valeurs réalistes
  return PAIRES_FOREX.map(p => {
    const baseEnUsd  = TAUX_REF[p.base]  || 1;
    const quoteEnUsd = TAUX_REF[p.quote] || 1;
    const prixBase   = baseEnUsd / quoteEnUsd;
    const prix = prixBase * (1 + (Math.random() - 0.5) * 0.003);
    const variation = (Math.random() - 0.48) * 1.2;
    etat.cachePrix[p.id] = prix;
    return {
      id: p.id, symbole: p.symbole, nom: p.nom,
      prix, variation, icone: '💱', categorie: 'forex',
    };
  });
}

async function chargerHistoForex(pairId, jours) {
  // ExchangeRate free ne fournit pas d'historique → simulé à partir du prix actuel
  const prixActuel = etat.cachePrix[pairId] || 1;
  return genererHistoSimule(prixActuel, jours, 0.002);
}

/* =====================================================
   ── API FINNHUB ──
   ===================================================== */
const SYMBOLES_ACTIONS = [
  { id: 'aapl',  symbole: 'AAPL',  nom: 'Apple Inc.',      fh: 'AAPL'  },
  { id: 'msft',  symbole: 'MSFT',  nom: 'Microsoft',       fh: 'MSFT'  },
  { id: 'googl', symbole: 'GOOGL', nom: 'Alphabet',        fh: 'GOOGL' },
  { id: 'amzn',  symbole: 'AMZN',  nom: 'Amazon',          fh: 'AMZN'  },
  { id: 'nvda',  symbole: 'NVDA',  nom: 'NVIDIA',          fh: 'NVDA'  },
  { id: 'meta',  symbole: 'META',  nom: 'Meta Platforms',  fh: 'META'  },
  { id: 'tsla',  symbole: 'TSLA',  nom: 'Tesla',           fh: 'TSLA'  },
  { id: 'nflx',  symbole: 'NFLX',  nom: 'Netflix',         fh: 'NFLX'  },
];

// Prix de référence en fallback
const PRIX_REF_ACTIONS = {
  AAPL: 175, MSFT: 410, GOOGL: 160, AMZN: 185,
  NVDA: 870, META: 480, TSLA: 175, NFLX: 620,
};

async function chargerActions() {
  if (CLES.finnhub && CLES.finnhub !== 'YOUR_FINNHUB_API_KEY') {
    try {
      // On charge les quotes en parallèle (max 8 requêtes)
      const promesses = SYMBOLES_ACTIONS.map(async a => {
        try {
          const url = `${API.finnhub}/quote?symbol=${a.fh}&token=${CLES.finnhub}`;
          const data = await fetchCache(url, `fh_quote_${a.fh}`, 60000);
          const prix = data.c || PRIX_REF_ACTIONS[a.fh] || 100;
          const variation = data.dp || ((Math.random() - 0.47) * 2);
          etat.cachePrix[a.id] = prix;
          return { ...a, prix, variation, icone: '📈', categorie: 'actions' };
        } catch {
          const prix = PRIX_REF_ACTIONS[a.fh] || 100;
          etat.cachePrix[a.id] = prix;
          return {
            ...a, prix,
            variation: (Math.random() - 0.47) * 2,
            icone: '📈', categorie: 'actions',
          };
        }
      });
      return await Promise.all(promesses);
    } catch(e) {
      console.warn('Finnhub error:', e.message);
    }
  }

  // Fallback simulé
  return SYMBOLES_ACTIONS.map(a => {
    const base = PRIX_REF_ACTIONS[a.fh] || 100;
    const prix = base * (1 + (Math.random() - 0.5) * 0.006);
    etat.cachePrix[a.id] = prix;
    return {
      ...a,
      prix, variation: (Math.random() - 0.47) * 2.2,
      icone: '📈', categorie: 'actions',
    };
  });
}

async function chargerHistoAction(id, jours) {
  const actionDef = SYMBOLES_ACTIONS.find(a => a.id === id);
  if (!actionDef) return genererHistoSimule(etat.cachePrix[id] || 100, jours);

  if (CLES.finnhub && CLES.finnhub !== 'YOUR_FINNHUB_API_KEY') {
    try {
      const maintenant = Math.floor(Date.now() / 1000);
      const debut      = maintenant - jours * 86400;
      const res = jours <= 1 ? '60' : jours <= 7 ? 'D' : 'W';
      const url = `${API.finnhub}/stock/candle?symbol=${actionDef.fh}&resolution=${res}&from=${debut}&to=${maintenant}&token=${CLES.finnhub}`;
      const data = await fetchCache(url, `fh_candle_${id}_${jours}`, 180000);

      if (data.s === 'ok' && data.c?.length) {
        return data.t.map((ts, i) => ({ temps: new Date(ts * 1000), prix: data.c[i] }));
      }
    } catch(e) {
      console.warn('Finnhub candle error:', e.message);
    }
  }

  return genererHistoSimule(etat.cachePrix[id] || 100, jours);
}

/* =====================================================
   Historique simulé (fallback)
   ===================================================== */
function genererHistoSimule(prixBase, jours, volatilite = 0.025) {
  const nb = jours <= 1 ? 24 : jours <= 7 ? jours * 8 : jours;
  const prix = [prixBase];
  for (let i = 1; i < nb; i++) {
    prix.push(Math.max(0.001, prix[prix.length - 1] * (1 + (Math.random() - 0.48) * volatilite)));
  }
  const pas = (jours * 86400000) / nb;
  const debut = Date.now() - jours * 86400000;
  return prix.map((p, i) => ({ temps: new Date(debut + i * pas), prix: p }));
}

/* =====================================================
   Graphique Chart.js
   ===================================================== */
function dessinerGraphique(historique) {
  const canvas = document.getElementById('graphique-principal');
  if (!canvas || !historique?.length) return;

  if (etat.graphique) { etat.graphique.destroy(); etat.graphique = null; }

  const prix = historique.map(h => h.prix);
  const etiquettes = historique.map(h => h.temps);
  const enHausse = prix[prix.length - 1] >= prix[0];
  const c = enHausse ? '#22c55e' : '#ef4444';

  etat.graphique = new Chart(canvas, {
    type: 'line',
    data: {
      labels: etiquettes,
      datasets: [{
        data: prix,
        borderColor: c,
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
            color: '#606060',
            maxRotation: 0,
            callback: (_, i) => {
              const d = etiquettes[i];
              if (!d) return '';
              return d instanceof Date
                ? d.toLocaleDateString('fr-FR', { day: 'numeric', month: 'short' })
                : '';
            },
          },
        },
        y: {
          display: true,
          position: 'right',
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

  const placeholders = {
    crypto: 'Rechercher une crypto',
    forex:  'Rechercher un change',
    actions: 'Rechercher une action',
  };
  const champsR = document.getElementById('champ-recherche');
  if (champsR) champsR.placeholder = placeholders[cat] || 'Rechercher';

  // Mettre à jour attribution selon la catégorie
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
  } catch(e) {
    console.error('chargerPageMarche:', e);
    notif('Erreur de chargement des données', 'erreur');
  }

  const recherche = champsR?.value.trim().toLowerCase() || '';
  const filtres = recherche
    ? actifs.filter(a =>
        a.symbole.toLowerCase().includes(recherche) ||
        a.nom.toLowerCase().includes(recherche)
      )
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
    img.src = 'https://static.coingecko.com/s/coingecko-logo-d13d6bcceddbb003f146b33c2f7e8193d72b93bb02229aa0c83734f2fb6a56bb.png';
    img.style.display = '';
    texte.textContent = 'Données fournies par CoinGecko';
  } else if (cat === 'forex') {
    lien.href = 'https://www.exchangerate-api.com';
    img.style.display = 'none';
    texte.textContent = 'Données Forex par ExchangeRate-API';
  } else {
    lien.href = 'https://finnhub.io';
    img.style.display = 'none';
    texte.textContent = 'Données Actions par Finnhub';
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
    const dec = a.categorie === 'crypto' ? decCryptos(a.prix) : 4;
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

  liste.querySelectorAll('.element-actif').forEach(el => {
    el.addEventListener('click', () => {
      const actif = actifs.find(a => a.id === el.dataset.id);
      if (actif) selectionnerActif(actif);
    });
  });
}

async function selectionnerActif(actif, auto = false) {
  etat.actifSelectionne = actif;
  const prix = actif.prix || etat.cachePrix[actif.id] || 0;
  const dec = actif.categorie === 'crypto' ? decCryptos(prix) : 4;

  document.getElementById('nom-actif').textContent = actif.symbole;
  document.getElementById('nom-complet-actif').textContent = actif.nom;
  document.getElementById('prix-actif').textContent = fmt$(prix, dec);

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
  } catch(e) {
    elLoad?.classList.add('cache');
    const fallback = genererHistoSimule(etat.cachePrix[actif.id] || 100, jours);
    dessinerGraphique(fallback);
  }
}

/* =====================================================
   Ordres
   ===================================================== */
function ouvrirFormOrdre(type) {
  if (!etat.actifSelectionne) return notif('Sélectionnez un actif', 'erreur');
  etat.typeOrdre = type;

  const actif = etat.actifSelectionne;
  const prix = actif.prix || etat.cachePrix[actif.id] || 0;
  const dec = actif.categorie === 'crypto' ? decCryptos(prix) : 4;

  const tag = document.getElementById('modale-tag-type');
  if (tag) { tag.textContent = type === 'achat' ? 'ACHAT' : 'VENTE'; }

  document.getElementById('titre-modale-ordre').textContent = type === 'achat' ? 'Acheter' : 'Vendre';
  document.getElementById('ordre-actif-nom').textContent  = actif.symbole;
  document.getElementById('ordre-actif-prix').textContent = fmt$(prix, dec);
  document.getElementById('solde-disponible').textContent = fmt$(etat.solde);
  document.getElementById('montant-ordre').value = '';
  document.getElementById('quantite-estimee').textContent = '—';

  ouvrirModale('modale-ordre');
}

function mettreAJourQuantite() {
  const actif = etat.actifSelectionne;
  if (!actif) return;
  const prix = actif.prix || etat.cachePrix[actif.id] || 0;
  const montant = parseFloat(document.getElementById('montant-ordre').value);
  if (!montant || !prix) {
    document.getElementById('quantite-estimee').textContent = '—';
    return;
  }
  document.getElementById('quantite-estimee').textContent =
    fmtQte(montant / prix) + ' ' + actif.symbole;
}

function confirmerOrdre() {
  const actif = etat.actifSelectionne;
  if (!actif) return;

  const montant = parseFloat(document.getElementById('montant-ordre').value);
  if (!montant || montant <= 0) return notif('Montant invalide', 'erreur');

  const prix = actif.prix || etat.cachePrix[actif.id];
  if (!prix) return notif('Prix indisponible', 'erreur');

  const quantite  = montant / prix;
  const commission = montant * COMMISSION;

  if (etat.typeOrdre === 'achat') {
    const cout = montant + commission;
    if (cout > etat.solde) return notif('Solde insuffisant', 'erreur');

    etat.solde -= cout;
    etat.positions.push({
      id: actif.id, symbole: actif.symbole, nom: actif.nom, icone: actif.icone,
      sens: 'achat', quantite, prixEntree: prix, montant,
      horodatage: Date.now(), categorie: actif.categorie,
    });
    etat.historique.push({
      id: actif.id, symbole: actif.symbole, type: 'achat',
      montant, prix, quantite, horodatage: Date.now(), pnl: null,
    });
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
    if (pos.quantite < 0.000001) {
      etat.positions = etat.positions.filter(p => p !== pos);
    }
    etat.historique.push({
      id: actif.id, symbole: actif.symbole, type: 'vente',
      montant: valeur, prix, quantite: qtVente, horodatage: Date.now(), pnl,
    });
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
      ${etat.positions.map((pos, i) => {
        const dec = pos.categorie === 'crypto' ? decCryptos(pos.prixEntree) : 4;
        return `
          <div class="element-transaction" data-index="${i}">
            <span class="qt-transaction">${fmtQte(pos.quantite)}</span>
            <span class="symbole-transaction">${pos.symbole}</span>
            <span class="prix-transaction">${fmt$(pos.prixEntree, dec)}</span>
            <button class="bouton-fermer-pos" data-index="${i}">Fermer</button>
          </div>`;
      }).join('')}`;

    liste.querySelectorAll('.bouton-fermer-pos').forEach(btn => {
      btn.addEventListener('click', () => ouvrirModaleFermeture(+btn.dataset.index));
    });
  }

  // Historique
  const hist = document.getElementById('liste-historique');
  const entrees = [...etat.historique].reverse().slice(0, 30);
  if (!entrees.length) {
    hist.innerHTML = `<div class="etat-vide">Aucune transaction</div>`;
  } else {
    hist.innerHTML = entrees.map(h => {
      const dec = h.prix < 1 ? 4 : 2;
      const pnlHtml = h.pnl != null
        ? `<div class="historique-pnl" style="color:${h.pnl >= 0 ? 'var(--vert)' : 'var(--rouge)'}">
             P&L : ${h.pnl >= 0 ? '+' : ''}${fmt$(h.pnl)}
           </div>`
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
  const pnl = (prixActuel - pos.prixEntree) * pos.quantite;
  const dec = prixActuel < 1 ? 4 : 2;

  document.getElementById('fp-actif').textContent    = pos.symbole;
  document.getElementById('fp-quantite').textContent = fmtQte(pos.quantite);
  document.getElementById('fp-entree').textContent   = fmt$(pos.prixEntree, dec);
  document.getElementById('fp-actuel').textContent   = fmt$(prixActuel, dec);

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
   Page Wallet — CALCUL DU BÉNÉFICE CORRIGÉ
   
   Logique :
     - bénéfice = solde_actuel_total - solde_initial
     - solde_actuel_total = solde_liquide + valeur_mark_to_market_des_positions
     - Exemple : initial 1000$, solde 995$, bénéfice = -5$
                 puis on gagne 6$, solde 1001$, bénéfice = +1$
   ===================================================== */
function afficherWallet() {
  // Valeur mark-to-market des positions ouvertes
  const valeurPositions = etat.positions.reduce((total, pos) => {
    const prixActuel = etat.cachePrix[pos.id] || pos.prixEntree;
    return total + prixActuel * pos.quantite;
  }, 0);

  const soldeTotal = etat.solde + valeurPositions;
  const benefice   = soldeTotal - etat.soldeInitial;

  document.getElementById('wallet-solde').textContent = fmt$(etat.solde);
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
    const dec = pos.categorie === 'crypto' ? decCryptos(prixActuel) : 4;
    return `<div class="ligne-monnaie">
      <span class="qt-monnaie">${fmtQte(pos.quantite)}</span>
      <span class="nom-monnaie">${pos.symbole}</span>
      <span class="prix-monnaie">${fmt$(prixActuel, dec)}</span>
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
    // Force la mise à jour des marchés actifs
    if (etat.categorieActuelle === 'crypto') {
      const nouveauxCryptos = await chargerCryptos();
      etat.marches.crypto = nouveauxCryptos;
      nouveauxCryptos.forEach(c => { etat.cachePrix[c.id] = c.prix; });
    } else if (etat.categorieActuelle === 'forex') {
      const nouveauxForex = await chargerForex();
      etat.marches.forex = nouveauxForex;
    } else {
      const nouvellesActions = await chargerActions();
      etat.marches.actions = nouvellesActions;
    }

    // Mise à jour du prix affiché si une crypto est sélectionnée
    if (etat.actifSelectionne) {
      const actif = etat.actifSelectionne;
      const liste = etat.marches[actif.categorie] || [];
      const maj = liste.find(a => a.id === actif.id);
      if (maj) {
        actif.prix = maj.prix;
        actif.variation = maj.variation;
        etat.cachePrix[actif.id] = maj.prix;
        const dec = actif.categorie === 'crypto' ? decCryptos(maj.prix) : 4;
        document.getElementById('prix-actif').textContent = fmt$(maj.prix, dec);
        const elVar = document.getElementById('variation-actif');
        elVar.textContent = fmtPct(maj.variation);
        elVar.className   = `variation-actif ${classeVar(maj.variation)}`;
      }
    }

    // Horodatage de mise à jour
    const el = document.getElementById('indicateur-maj');
    if (el) {
      const h = new Date();
      el.textContent = `MAJ ${h.getHours().toString().padStart(2,'0')}:${h.getMinutes().toString().padStart(2,'0')}`;
    }
  } catch(_) {}
}

/* =====================================================
   PWA
   ===================================================== */
function afficherGuideInstallation(msg) {
  document.getElementById('bulle-installation')?.remove();
  const bulle = document.createElement('div');
  bulle.className = 'bulle-installation';
  bulle.id = 'bulle-installation';
  bulle.innerHTML = `
    <div class="fleche-bulle"></div>
    <p>${msg}</p>
    <button onclick="document.getElementById('bulle-installation').remove()">Compris</button>`;
  document.getElementById('groupe-boutons-haut')?.appendChild(bulle);
  setTimeout(() => {
    document.addEventListener('click', function fermeur(e) {
      if (!bulle.contains(e.target)) { bulle.remove(); document.removeEventListener('click', fermeur); }
    });
  }, 100);
}

function configurerPWA() {
  window.addEventListener('beforeinstallprompt', e => {
    e.preventDefault();
    etat.promptInstallation = e;
    if (!localStorage.getItem('install-ignore')) {
      setTimeout(() => {
        document.getElementById('banniere-installation')?.classList.remove('cache');
      }, 4000);
    }
  });

  async function lancerInstallation() {
    if (navigator.standalone || window.matchMedia('(display-mode: standalone)').matches) {
      notif('Application déjà installée', 'info');
      return;
    }
    if (etat.promptInstallation) {
      etat.promptInstallation.prompt();
      const { outcome } = await etat.promptInstallation.userChoice;
      if (outcome === 'accepted') notif('Application installée !', 'succes');
      etat.promptInstallation = null;
      document.getElementById('banniere-installation')?.classList.add('cache');
    } else {
      const ua = navigator.userAgent;
      let msg = 'Ouvrez le menu du navigateur → "Installer"';
      if (/Safari/.test(ua) && !/Chrome/.test(ua))
        msg = 'Sur Safari : bouton Partager ↑ → "Sur l\'écran d\'accueil"';
      else if (/Chrome/.test(ua))
        msg = 'Sur Chrome : menu ⋮ → "Ajouter à l\'écran d\'accueil"';
      else if (/Firefox/.test(ua))
        msg = 'Sur Firefox : menu ⋮ → "Installer"';
      afficherGuideInstallation(msg);
    }
  }

  document.getElementById('bouton-telecharger')?.addEventListener('click', lancerInstallation);
  document.getElementById('bouton-installer')?.addEventListener('click', lancerInstallation);
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
          const newSW = reg.installing;
          newSW?.addEventListener('statechange', () => {
            if (newSW.state === 'installed' && navigator.serviceWorker.controller) {
              newSW.postMessage({ type: 'SKIP_WAITING' });
            }
          });
        });
      })
      .catch(err => console.warn('SW registration failed:', err));
  }
}

/* =====================================================
   Événements
   ===================================================== */
function configurerEvenements() {
  // Navigation
  document.querySelectorAll('.btn-nav').forEach(btn =>
    btn.addEventListener('click', () => allerVers(btn.dataset.page))
  );

  // Onglets marché
  document.querySelectorAll('.onglet').forEach(btn =>
    btn.addEventListener('click', () => chargerPageMarche(btn.dataset.cat))
  );

  // Recherche
  let timerRecherche;
  document.getElementById('champ-recherche')?.addEventListener('input', () => {
    clearTimeout(timerRecherche);
    timerRecherche = setTimeout(() => chargerPageMarche(etat.categorieActuelle), 300);
  });

  // Boutons période
  document.querySelectorAll('.btn-periode').forEach(btn => {
    btn.addEventListener('click', () => {
      if (etat.actifSelectionne) chargerEtDessiner(etat.actifSelectionne, +btn.dataset.jours);
    });
  });

  // Acheter / Vendre
  document.getElementById('bouton-acheter')?.addEventListener('click', () => ouvrirFormOrdre('achat'));
  document.getElementById('bouton-vendre')?.addEventListener('click',  () => ouvrirFormOrdre('vente'));

  // Montant ordre
  document.getElementById('montant-ordre')?.addEventListener('input', mettreAJourQuantite);
  document.querySelectorAll('.btn-rapide').forEach(btn =>
    btn.addEventListener('click', () => {
      document.getElementById('montant-ordre').value =
        (etat.solde * (+btn.dataset.pct / 100)).toFixed(2);
      mettreAJourQuantite();
    })
  );

  // Confirmer ordre
  document.getElementById('bouton-confirmer-ordre')?.addEventListener('click', confirmerOrdre);

  // Fermer position
  document.getElementById('bouton-executer-fermeture')?.addEventListener('click', executerFermeture);

  // Config solde
  document.getElementById('bouton-config')?.addEventListener('click', () => ouvrirModale('modale-config'));
  document.getElementById('bouton-ouvrir-config')?.addEventListener('click', () => ouvrirModale('modale-config'));
  document.getElementById('bouton-appliquer')?.addEventListener('click', appliquerConfig);
  document.querySelectorAll('.btn-preset').forEach(btn =>
    btn.addEventListener('click', () => {
      document.querySelectorAll('.btn-preset').forEach(b => b.classList.remove('actif'));
      btn.classList.add('actif');
    })
  );

  // Fermeture modales
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

  // Rafraîchissement toutes les 30 secondes
  etat.intervalMaj = setInterval(rafraichirPrix, 30000);
}

document.addEventListener('DOMContentLoaded', demarrer);
