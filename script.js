'use strict';

/* =========================================
   État global
   ========================================= */
const etat = {
  solde: 10000,
  soldeInitial: 10000,
  positions: [],
  historique: [],
  pageActuelle: 'marche',
  actifSelectionne: null,
  categorieActuelle: 'crypto',
  typeOrdre: 'achat',
  periodeActuelle: 7,
  cacheDonnees: {},
  cachePrix: {},
  donneesMarches: { crypto: [], forex: [], actions: [] },
  indexFermeture: null,
  promptInstallation: null,
  graphiquePrincipal: null,
};

const URL_API = 'https://api.coingecko.com/api/v3';
const COMMISSION = 0.001;

/* =========================================
   Stockage local
   ========================================= */
function sauvegarder() {
  try {
    localStorage.setItem('alphatrade', JSON.stringify({
      solde: etat.solde,
      soldeInitial: etat.soldeInitial,
      positions: etat.positions,
      historique: etat.historique,
    }));
  } catch(e) {}
}

function charger() {
  try {
    const brut = localStorage.getItem('alphatrade');
    if (!brut) return;
    const d = JSON.parse(brut);
    etat.solde = d.solde ?? 10000;
    etat.soldeInitial = d.soldeInitial ?? 10000;
    etat.positions = d.positions ?? [];
    etat.historique = d.historique ?? [];
  } catch(e) {}
}

/* =========================================
   Formatage
   ========================================= */
function formaterMontant(n, dec = 2) {
  if (n == null || isNaN(n)) return '—';
  return Number(n).toLocaleString('fr-FR', { minimumFractionDigits: dec, maximumFractionDigits: dec }) + '$';
}

function formaterQuantite(n) {
  if (n == null || isNaN(n)) return '—';
  return n >= 1
    ? Number(n).toLocaleString('fr-FR', { minimumFractionDigits: 2, maximumFractionDigits: 4 })
    : Number(n).toPrecision(4);
}

function formaterPourcentage(n) {
  if (n == null || isNaN(n)) return '';
  return (n >= 0 ? '+' : '') + n.toFixed(2) + '%';
}

function formaterDate(ts) {
  return new Date(ts).toLocaleDateString('fr-FR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
}

function classeVariation(v) { return v >= 0 ? 'hausse' : 'baisse'; }

/* =========================================
   Notifications
   ========================================= */
function notifier(message, type = 'info') {
  const c = document.getElementById('conteneur-notifications');
  const el = document.createElement('div');
  el.className = `notification ${type}`;
  el.textContent = message;
  c.appendChild(el);
  setTimeout(() => el.remove(), 3200);
}

function ouvrirModale(id) { document.getElementById(id)?.classList.remove('cache'); }
function fermerModale(id) { document.getElementById(id)?.classList.add('cache'); }

/* =========================================
   Navigation
   ========================================= */
function allerVers(page) {
  etat.pageActuelle = page;
  document.querySelectorAll('.page').forEach(p => p.classList.remove('actif'));
  document.getElementById(`page-${page}`)?.classList.add('actif');
  document.querySelectorAll('.btn-nav').forEach(b => {
    b.classList.toggle('actif', b.dataset.page === page);
  });
  if (page === 'transactions') afficherTransactions();
  if (page === 'wallet') afficherWallet();
}

/* =========================================
   API CoinGecko
   ========================================= */
async function requeteCache(url, cle, ttl = 30000) {
  const maintenant = Date.now();
  const cache = etat.cacheDonnees[cle];
  if (cache && maintenant - cache.ts < ttl) return cache.donnees;
  try {
    const rep = await fetch(url);
    if (!rep.ok) throw new Error(rep.status);
    const donnees = await rep.json();
    etat.cacheDonnees[cle] = { donnees, ts: maintenant };
    return donnees;
  } catch(e) {
    if (cache) return cache.donnees;
    throw e;
  }
}

async function chargerCryptos() {
  const url = `${URL_API}/coins/markets?vs_currency=usd&order=market_cap_desc&per_page=30&page=1&sparkline=false&price_change_percentage=24h`;
  const donnees = await requeteCache(url, 'cryptos', 30000);
  donnees.forEach(c => { etat.cachePrix[c.id] = c.current_price; });
  return donnees;
}

async function chargerHistorique(idCoin, jours) {
  const url = `${URL_API}/coins/${idCoin}/market_chart?vs_currency=usd&days=${jours}`;
  try {
    const donnees = await requeteCache(url, `hist-${idCoin}-${jours}`, 120000);
    return donnees.prices.map(([ts, p]) => ({ temps: new Date(ts), prix: p }));
  } catch(e) {
    return genererHistoriqueSimule(etat.cachePrix[idCoin] || 100, jours);
  }
}

/* Données simulées pour Forex et Actions */
function donneesForex() {
  const paires = [
    { id: 'eurusd', symbole: 'EURUSD', nom: 'Euro / Dollar', base: 1.085 },
    { id: 'gbpusd', symbole: 'GBPUSD', nom: 'Livre / Dollar', base: 1.265 },
    { id: 'usdjpy', symbole: 'USDJPY', nom: 'Dollar / Yen', base: 149.5 },
    { id: 'usdchf', symbole: 'USDCHF', nom: 'Dollar / Franc CH', base: 0.897 },
    { id: 'audusd', symbole: 'AUDUSD', nom: 'AUD / Dollar', base: 0.652 },
    { id: 'usdcad', symbole: 'USDCAD', nom: 'Dollar / CAD', base: 1.364 },
    { id: 'nzdusd', symbole: 'NZDUSD', nom: 'NZD / Dollar', base: 0.598 },
    { id: 'eurgbp', symbole: 'EURGBP', nom: 'Euro / Livre', base: 0.858 },
  ];
  return paires.map(p => ({
    ...p,
    icone: '💱',
    prix: p.base * (1 + (Math.random() - 0.5) * 0.004),
    variation: (Math.random() - 0.48) * 1.2,
    categorie: 'forex',
  }));
}

function donneesActions() {
  const actions = [
    { id: 'cac40', symbole: 'CAC 40', nom: 'CAC 40', base: 7580 },
    { id: 'sp500', symbole: 'S&P 500', nom: 'S&P 500', base: 5240 },
    { id: 'nasdaq', symbole: 'NASDAQ', nom: 'NASDAQ', base: 16420 },
    { id: 'dax', symbole: 'DAX', nom: 'DAX 40', base: 18200 },
    { id: 'apple', symbole: 'AAPL', nom: 'Apple Inc.', base: 178 },
    { id: 'microsoft', symbole: 'MSFT', nom: 'Microsoft', base: 415 },
    { id: 'google', symbole: 'GOOGL', nom: 'Alphabet', base: 165 },
    { id: 'amazon', symbole: 'AMZN', nom: 'Amazon', base: 185 },
  ];
  return actions.map(a => ({
    ...a,
    icone: '📈',
    prix: a.base * (1 + (Math.random() - 0.5) * 0.006),
    variation: (Math.random() - 0.47) * 2.0,
    categorie: 'actions',
  }));
}

function genererHistoriqueSimule(prixBase, jours) {
  const nbPoints = jours <= 1 ? 24 : jours <= 7 ? jours * 8 : jours;
  const prix = [prixBase];
  for (let i = 1; i < nbPoints; i++) {
    prix.push(Math.max(0.001, prix[prix.length - 1] * (1 + (Math.random() - 0.48) * 0.025)));
  }
  const pasMs = (jours * 86400000) / nbPoints;
  const debut = Date.now() - jours * 86400000;
  return prix.map((p, i) => ({ temps: new Date(debut + i * pasMs), prix: p }));
}

/* =========================================
   Graphique
   ========================================= */
function dessinerGraphique(historique) {
  const canvas = document.getElementById('graphique-principal');
  if (!canvas) return;

  if (etat.graphiquePrincipal) {
    etat.graphiquePrincipal.destroy();
    etat.graphiquePrincipal = null;
  }

  const prix = historique.map(h => h.prix);
  const etiquettes = historique.map(h => h.temps);
  const enHausse = prix[prix.length - 1] >= prix[0];
  const couleur = enHausse ? '#22c55e' : '#ef4444';
  const min = Math.min(...prix);
  const max = Math.max(...prix);

  etat.graphiquePrincipal = new Chart(canvas, {
    type: 'line',
    data: {
      labels: etiquettes,
      datasets: [{
        data: prix,
        borderColor: couleur,
        borderWidth: 2,
        fill: true,
        backgroundColor: (ctx) => {
          const g = ctx.chart.ctx.createLinearGradient(0, 0, 0, ctx.chart.height);
          g.addColorStop(0, enHausse ? 'rgba(34,197,94,0.15)' : 'rgba(239,68,68,0.15)');
          g.addColorStop(1, 'rgba(255,255,255,0)');
          return g;
        },
        pointRadius: 0,
        tension: 0.3,
      }]
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      interaction: { mode: 'index', intersect: false },
      plugins: {
        legend: { display: false },
        tooltip: {
          backgroundColor: '#fff',
          titleColor: '#999',
          bodyColor: '#000',
          borderColor: '#e0e0e0',
          borderWidth: 1,
          callbacks: {
            label: ctx => ' ' + formaterMontant(ctx.parsed.y, ctx.parsed.y < 1 ? 4 : 2)
          }
        }
      },
      scales: {
        x: {
          display: true,
          grid: { display: false },
          ticks: {
            maxTicksLimit: 6,
            font: { size: 10, family: "'Inter', sans-serif" },
            color: '#999',
            maxRotation: 0,
            callback: (val, index, ticks) => {
              const d = etiquettes[index];
              if (!d) return '';
              return d instanceof Date
                ? d.toLocaleDateString('fr-FR', { day: 'numeric', month: 'short' })
                : '';
            }
          }
        },
        y: {
          display: true,
          position: 'left',
          grid: { color: '#f0f0f0' },
          ticks: {
            maxTicksLimit: 5,
            font: { size: 10, family: "'Inter', sans-serif" },
            color: '#999',
            callback: val => {
              if (val >= 1000) return '$' + (val / 1000).toFixed(0) + 'K';
              if (val >= 1) return '$' + val.toFixed(0);
              return '$' + val.toPrecision(3);
            }
          }
        }
      }
    }
  });
}

/* =========================================
   Page Marché
   ========================================= */
async function chargerPageMarche(cat = etat.categorieActuelle) {
  etat.categorieActuelle = cat;

  // Mettre à jour onglets
  document.querySelectorAll('.onglet').forEach(b => {
    b.classList.toggle('actif', b.dataset.cat === cat);
  });

  // Placeholder texte recherche
  const placeholders = { crypto: 'Rechercher une crypto', forex: 'Rechercher un change', actions: 'Rechercher une action' };
  const champRecherche = document.getElementById('champ-recherche');
  if (champRecherche) champRecherche.placeholder = placeholders[cat] || 'Rechercher';

  let actifs = [];
  try {
    if (cat === 'crypto') {
      if (!etat.donneesMarches.crypto.length) {
        etat.donneesMarches.crypto = await chargerCryptos();
      }
      actifs = etat.donneesMarches.crypto.map(c => ({
        id: c.id,
        symbole: c.symbol.toUpperCase() + 'USDT',
        nom: c.name,
        prix: c.current_price,
        variation: c.price_change_percentage_24h,
        icone: c.image,
        categorie: 'crypto',
      }));
    } else if (cat === 'forex') {
      if (!etat.donneesMarches.forex.length) etat.donneesMarches.forex = donneesForex();
      actifs = etat.donneesMarches.forex.map(f => ({
        id: f.id, symbole: f.symbole, nom: f.nom,
        prix: f.prix, variation: f.variation, icone: f.icone, categorie: 'forex'
      }));
    } else {
      if (!etat.donneesMarches.actions.length) etat.donneesMarches.actions = donneesActions();
      actifs = etat.donneesMarches.actions.map(a => ({
        id: a.id, symbole: a.symbole, nom: a.nom,
        prix: a.prix, variation: a.variation, icone: a.icone, categorie: 'actions'
      }));
    }
  } catch(e) {
    notifier('Erreur de chargement', 'erreur');
    return;
  }

  // Filtrer par recherche
  const recherche = champRecherche?.value.toLowerCase() || '';
  const filtres = recherche
    ? actifs.filter(a => a.symbole.toLowerCase().includes(recherche) || a.nom.toLowerCase().includes(recherche))
    : actifs;

  // Sélectionner le premier par défaut
  if (filtres.length && (!etat.actifSelectionne || etat.actifSelectionne.categorie !== cat)) {
    await selectionnerActif(filtres[0], false);
  }

  afficherListeActifs(filtres);
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
    const dec = a.prix < 1 ? 4 : 2;
    const estSelectionne = etat.actifSelectionne?.id === a.id ? 'selectionne' : '';
    return `
      <div class="element-actif ${estSelectionne}" data-id="${a.id}">
        <div class="icone-actif">${iconeHtml}</div>
        <div class="info-actif">
          <div class="symbole-actif-liste">${a.symbole}</div>
          <div class="nom-actif-liste">${a.nom}</div>
        </div>
        <div>
          <div class="prix-actif-liste">${formaterMontant(a.prix, dec)}</div>
          <div class="variation-actif-liste ${classeVariation(a.variation)}">${formaterPourcentage(a.variation)}</div>
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

async function selectionnerActif(actif, chargerGraphiqueAuto = true) {
  etat.actifSelectionne = actif;
  const prix = actif.prix || etat.cachePrix[actif.id] || 0;
  const dec = prix < 1 ? 4 : 2;

  document.getElementById('nom-actif').textContent = actif.symbole;
  document.getElementById('prix-actif').textContent = formaterMontant(prix, dec);

  const elVariation = document.getElementById('variation-actif');
  elVariation.textContent = formaterPourcentage(actif.variation);
  elVariation.className = `variation-actif ${classeVariation(actif.variation)}`;

  // Marquer sélectionné dans la liste
  document.querySelectorAll('.element-actif').forEach(el => {
    el.classList.toggle('selectionne', el.dataset.id === actif.id);
  });

  if (chargerGraphiqueAuto) {
    await chargerEtDessinnerGraphique(actif, etat.periodeActuelle);
  }
}

async function chargerEtDessinnerGraphique(actif, jours) {
  etat.periodeActuelle = jours;
  document.querySelectorAll('.btn-periode').forEach(b => {
    b.classList.toggle('actif', +b.dataset.jours === jours);
  });

  let historique;
  if (actif.categorie === 'crypto') {
    historique = await chargerHistorique(actif.id, jours);
  } else {
    historique = genererHistoriqueSimule(actif.prix || 100, jours);
  }

  dessinerGraphique(historique);
}

/* =========================================
   Ordres d'achat / vente
   ========================================= */
function ouvrirFormOrdre(type) {
  if (!etat.actifSelectionne) return notifier('Sélectionnez un actif', 'erreur');
  etat.typeOrdre = type;

  const actif = etat.actifSelectionne;
  const prix = actif.prix || etat.cachePrix[actif.id] || 0;
  const dec = prix < 1 ? 4 : 2;

  document.getElementById('titre-modale-ordre').textContent = type === 'achat' ? 'Acheter' : 'Vendre';
  document.getElementById('ordre-actif-nom').textContent = actif.symbole;
  document.getElementById('ordre-actif-prix').textContent = formaterMontant(prix, dec);
  document.getElementById('solde-disponible').textContent = formaterMontant(etat.solde);
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
    formaterQuantite(montant / prix) + ' ' + actif.symbole;
}

function confirmerOrdre() {
  const actif = etat.actifSelectionne;
  if (!actif) return;

  const montant = parseFloat(document.getElementById('montant-ordre').value);
  if (!montant || montant <= 0) return notifier('Montant invalide', 'erreur');

  const prix = actif.prix || etat.cachePrix[actif.id];
  const quantite = montant / prix;
  const commission = 1/2 * ( montant * COMMISSION );

  if (etat.typeOrdre === 'achat') {
    if (montant + commission > etat.solde) return notifier('Solde insuffisant', 'erreur');
    etat.solde -= montant + commission;
    etat.positions.push({
      id: actif.id,
      symbole: actif.symbole,
      nom: actif.nom,
      icone: actif.icone,
      sens: 'achat',
      quantite,
      prixEntree: prix,
      montant,
      horodatage: Date.now(),
      categorie: actif.categorie,
    });
    etat.historique.push({
      id: actif.id, symbole: actif.symbole, nom: actif.nom,
      type: 'achat', montant, prix, quantite,
      horodatage: Date.now(), pnl: null,
    });
    notifier(`Achat de ${formaterQuantite(quantite)} ${actif.symbole}`, 'succes');
  } else {
    const pos = etat.positions.find(p => p.id === actif.id && p.sens === 'achat');
    if (!pos) return notifier('Aucune position sur cet actif', 'erreur');
    const qtVente = Math.min(quantite, pos.quantite);
    const valeur = qtVente * prix;
    const pnl = (prix - pos.prixEntree) * qtVente - commission;
    etat.solde += valeur - commission;
    pos.quantite -= qtVente;
    if (pos.quantite < 0.000001) {
      etat.positions = etat.positions.filter(p => p !== pos);
    }
    etat.historique.push({
      id: actif.id, symbole: actif.symbole, nom: actif.nom,
      type: 'vente', montant: valeur, prix, quantite: qtVente,
      horodatage: Date.now(), pnl,
    });
    notifier(`Vente — P&L : ${formaterMontant(pnl)}`, pnl >= 0 ? 'succes' : 'erreur');
  }

  fermerModale('modale-ordre');
  sauvegarder();
  afficherWalletSiActif();
}

function afficherWalletSiActif() {
  if (etat.pageActuelle === 'wallet') afficherWallet();
}

/* =========================================
   Page Transactions
   ========================================= */
function afficherTransactions() {
  const liste = document.getElementById('liste-transactions');

  // Positions ouvertes en attente
  if (!etat.positions.length) {
    liste.innerHTML = `<div class="etat-vide">Aucune transaction en attente</div>`;
    return;
  }

  liste.innerHTML = `
    <div class="entete-transactions">
      <span>Quantité</span>
      <span>Actif</span>
      <span>Prix d'achat</span>
      <span></span>
    </div>
    ${etat.positions.map((pos, i) => {
      const dec = pos.prixEntree < 1 ? 4 : 2;
      return `
        <div class="element-transaction" data-index="${i}">
          <span class="qt-transaction">${formaterQuantite(pos.quantite)}</span>
          <span class="symbole-transaction">${pos.symbole}</span>
          <span class="prix-transaction">${formaterMontant(pos.prixEntree, dec)}</span>
          <button class="bouton-fermer-pos" data-index="${i}">Fermer</button>
        </div>`;
    }).join('')}
  `;

  liste.querySelectorAll('.bouton-fermer-pos').forEach(btn => {
    btn.addEventListener('click', () => ouvrirModaleFermeture(+btn.dataset.index));
  });
}

function ouvrirModaleFermeture(index) {
  const pos = etat.positions[index];
  if (!pos) return;
  etat.indexFermeture = index;

  const prixActuel = etat.cachePrix[pos.id] || pos.prixEntree;
  const pnl = (prixActuel - pos.prixEntree) * pos.quantite;
  const dec = prixActuel < 1 ? 4 : 2;

  document.getElementById('fp-actif').textContent = pos.symbole;
  document.getElementById('fp-quantite').textContent = formaterQuantite(pos.quantite);
  document.getElementById('fp-entree').textContent = formaterMontant(pos.prixEntree, dec);
  document.getElementById('fp-actuel').textContent = formaterMontant(prixActuel, dec);

  const elPnl = document.getElementById('fp-pnl');
  elPnl.textContent = (pnl >= 0 ? '+' : '') + formaterMontant(pnl);
  elPnl.style.color = pnl >= 0 ? 'var(--vert)' : 'var(--rouge)';

  ouvrirModale('modale-fermer-position');
}

function executerFermeture() {
  const pos = etat.positions[etat.indexFermeture];
  if (!pos) return;

  const prixActuel = etat.cachePrix[pos.id] || pos.prixEntree;
  const valeur = prixActuel * pos.quantite;
  const commission = valeur * COMMISSION;
  const pnl = (prixActuel - pos.prixEntree) * pos.quantite - commission;

  etat.solde += valeur - commission;
  etat.historique.push({
    id: pos.id, symbole: pos.symbole, nom: pos.nom,
    type: 'fermeture', montant: valeur, prix: prixActuel,
    quantite: pos.quantite, horodatage: Date.now(), pnl,
  });
  etat.positions.splice(etat.indexFermeture, 1);

  sauvegarder();
  fermerModale('modale-fermer-position');
  notifier(`Position fermée — P&L : ${formaterMontant(pnl)}`, pnl >= 0 ? 'succes' : 'erreur');
  afficherTransactions();
}

/* =========================================
   Page Wallet
   ========================================= */
function afficherWallet() {
  const pnlRealise = etat.historique.reduce((s, h) => s + (h.pnl || 0), 0);

  document.getElementById('wallet-solde').textContent = formaterMontant(etat.solde);
  const elBenefice = document.getElementById('wallet-benefice');
  elBenefice.textContent = (pnlRealise >= 0 ? '+' : '') + formaterMontant(pnlRealise);
  elBenefice.style.color = pnlRealise >= 0 ? 'var(--vert)' : 'var(--rouge)';

  const elMonnaies = document.getElementById('wallet-monnaies');
  if (!etat.positions.length) {
    elMonnaies.innerHTML = '<span style="color:var(--texte-leger);font-size:0.875rem">Aucune position</span>';
    return;
  }

  const lignes = etat.positions.map(pos => {
    const dec = pos.prixEntree < 1 ? 4 : 2;
    return `<div class="ligne-monnaie">
      <span class="qt-monnaie">${formaterQuantite(pos.quantite)}</span>
      <span class="nom-monnaie">${pos.symbole}</span>
      <span class="prix-monnaie">${formaterMontant(pos.prixEntree, dec)}</span>
    </div>`;
  }).join('');
  elMonnaies.innerHTML = `<div class="entete-monnaies"><span>Quantité</span><span>Actif</span><span>Prix d'achat</span></div>${lignes}`;
}

/* =========================================
   Configuration du solde
   ========================================= */
function appliquerConfig() {
  const presetActif = document.querySelector('.btn-preset.actif');
  let montant = presetActif ? +presetActif.dataset.montant : 10000;
  const custom = parseFloat(document.getElementById('montant-custom').value);
  if (custom >= 100) montant = custom;

  etat.solde = montant;
  etat.soldeInitial = montant;
  etat.positions = [];
  etat.historique = [];

  sauvegarder();
  fermerModale('modale-config');
  notifier(`Solde configuré : ${formaterMontant(montant)}`, 'succes');
  afficherWallet();
}

/* =========================================
   PWA Installation
   ========================================= */
function afficherGuideInstallation(message) {
  // Supprimer une bulle existante
  document.getElementById('bulle-installation')?.remove();

  const bulle = document.createElement('div');
  bulle.id = 'bulle-installation';
  bulle.innerHTML = `
    <div class="fleche-bulle"></div>
    <p>${message}</p>
    <button onclick="document.getElementById('bulle-installation').remove()">Compris</button>
  `;
  document.getElementById('groupe-boutons-haut')?.appendChild(bulle);

  // Fermer en cliquant ailleurs
  setTimeout(() => {
    document.addEventListener('click', function fermer(e) {
      if (!bulle.contains(e.target)) {
        bulle.remove();
        document.removeEventListener('click', fermer);
      }
    });
  }, 100);
}

function configurerPWA() {
  // Capturer le prompt d'installation natif du navigateur
  window.addEventListener('beforeinstallprompt', e => {
    e.preventDefault();
    etat.promptInstallation = e;
    if (!localStorage.getItem('install-ignore')) {
      setTimeout(() => {
        document.getElementById('banniere-installation')?.classList.remove('cache');
      }, 3000);
    }
  });

  // Fonction commune : déclencher l'installation ou afficher le guide
  async function lancerInstallation() {
    if (navigator.standalone || window.matchMedia('(display-mode: standalone)').matches) {
      notifier('Application déjà installée', 'info');
      return;
    }
    if (etat.promptInstallation) {
      etat.promptInstallation.prompt();
      const { outcome } = await etat.promptInstallation.userChoice;
      if (outcome === 'accepted') notifier('Application installée !', 'succes');
      etat.promptInstallation = null;
      document.getElementById('banniere-installation')?.classList.add('cache');
    } else {
      // Fallback manuel selon le navigateur
      const ua = navigator.userAgent;
      let msg;
      if (/Safari/.test(ua) && !/Chrome/.test(ua)) {
        msg = 'Sur Safari : bouton Partager ↑ → "Sur l\'écran d\'accueil"';
      } else if (/Chrome/.test(ua)) {
        msg = 'Sur Chrome : menu ⋮ (en haut à droite) → "Ajouter à l\'écran d\'accueil"';
      } else if (/Firefox/.test(ua)) {
        msg = 'Sur Firefox : menu ⋮ → "Installer"';
      } else {
        msg = 'Ouvrez le menu du navigateur → "Installer" ou "Ajouter à l\'écran d\'accueil"';
      }
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

/* =========================================
   Service Worker
   ========================================= */
function enregistrerSW() {
  if ('serviceWorker' in navigator) {
    window.addEventListener('load', () => {
      navigator.serviceWorker.register('./sw.js').catch(() => {});
    });
  }
}

/* =========================================
   Événements
   ========================================= */
function configurerEvenements() {
  // Navigation
  document.querySelectorAll('.btn-nav').forEach(btn => {
    btn.addEventListener('click', () => allerVers(btn.dataset.page));
  });

  // Onglets marché
  document.querySelectorAll('.onglet').forEach(btn => {
    btn.addEventListener('click', () => chargerPageMarche(btn.dataset.cat));
  });

  // Recherche
  let minuterieRecherche;
  document.getElementById('champ-recherche')?.addEventListener('input', () => {
    clearTimeout(minuterieRecherche);
    minuterieRecherche = setTimeout(() => chargerPageMarche(etat.categorieActuelle), 300);
  });

  // Boutons période graphique
  document.querySelectorAll('.btn-periode').forEach(btn => {
    btn.addEventListener('click', () => {
      if (etat.actifSelectionne) chargerEtDessinnerGraphique(etat.actifSelectionne, +btn.dataset.jours);
    });
  });

  // Acheter / Vendre
  document.getElementById('bouton-acheter')?.addEventListener('click', () => ouvrirFormOrdre('achat'));
  document.getElementById('bouton-vendre')?.addEventListener('click', () => ouvrirFormOrdre('vente'));

  // Montant ordre
  document.getElementById('montant-ordre')?.addEventListener('input', mettreAJourQuantite);
  document.querySelectorAll('.btn-rapide').forEach(btn => {
    btn.addEventListener('click', () => {
      document.getElementById('montant-ordre').value = (etat.solde * (+btn.dataset.pct / 100)).toFixed(2);
      mettreAJourQuantite();
    });
  });

  // Confirmer ordre
  document.getElementById('bouton-confirmer-ordre')?.addEventListener('click', confirmerOrdre);

  // Fermer position
  document.getElementById('bouton-executer-fermeture')?.addEventListener('click', executerFermeture);

  // Config solde
  document.getElementById('bouton-config')?.addEventListener('click', () => ouvrirModale('modale-config'));
  document.getElementById('bouton-ouvrir-config')?.addEventListener('click', () => ouvrirModale('modale-config'));
  document.getElementById('bouton-appliquer')?.addEventListener('click', appliquerConfig);
  document.querySelectorAll('.btn-preset').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.btn-preset').forEach(b => b.classList.remove('actif'));
      btn.classList.add('actif');
    });
  });

  // Fermetures modales
  document.querySelectorAll('.modale-fermer, [data-modale]').forEach(el => {
    el.addEventListener('click', () => {
      const id = el.dataset.modale;
      if (id) fermerModale(id);
    });
  });
  document.querySelectorAll('.fond-modale').forEach(fond => {
    fond.addEventListener('click', e => {
      if (e.target === fond) fond.classList.add('cache');
    });
  });
}

/* =========================================
   Rafraîchissement des prix (30s)
   ========================================= */
async function rafraichirPrix() {
  try {
    const donnees = await chargerCryptos();
    donnees.forEach(c => { etat.cachePrix[c.id] = c.current_price; });
    etat.donneesMarches.crypto = donnees;
    etat.donneesMarches.forex = donneesForex();
    etat.donneesMarches.actions = donneesActions();

    // Mettre à jour le prix affiché si l'actif sélectionné est une crypto
    if (etat.actifSelectionne?.categorie === 'crypto') {
      const maj = donnees.find(c => c.id === etat.actifSelectionne.id);
      if (maj) {
        etat.actifSelectionne.prix = maj.current_price;
        etat.actifSelectionne.variation = maj.price_change_percentage_24h;
        const dec = maj.current_price < 1 ? 4 : 2;
        document.getElementById('prix-actif').textContent = formaterMontant(maj.current_price, dec);
        const elVar = document.getElementById('variation-actif');
        elVar.textContent = formaterPourcentage(maj.price_change_percentage_24h);
        elVar.className = `variation-actif ${classeVariation(maj.price_change_percentage_24h)}`;
      }
    }
  } catch(e) {}
}

/* =========================================
   Démarrage
   ========================================= */
async function demarrer() {
  charger();
  configurerEvenements();
  configurerPWA();
  enregistrerSW();

  // Ajouter les boutons de période dans la zone graphique
  const zoneGraphique = document.querySelector('.conteneur-graphique');
  if (zoneGraphique) {
    const boutonsDiv = document.createElement('div');
    boutonsDiv.className = 'boutons-periode';
    boutonsDiv.innerHTML = `
      <button class="btn-periode" data-jours="1">1J</button>
      <button class="btn-periode" data-jours="7">7J</button>
      <button class="btn-periode actif" data-jours="30">1M</button>
      <button class="btn-periode" data-jours="90">3M</button>
    `;
    zoneGraphique.parentNode.insertBefore(boutonsDiv, zoneGraphique);
    boutonsDiv.querySelectorAll('.btn-periode').forEach(btn => {
      btn.addEventListener('click', () => {
        if (etat.actifSelectionne) chargerEtDessinnerGraphique(etat.actifSelectionne, +btn.dataset.jours);
      });
    });
  }

  setTimeout(() => {
    document.getElementById('ecran-chargement').classList.add('disparaitre');
    setTimeout(async () => {
      document.getElementById('ecran-chargement').style.display = 'none';
      document.getElementById('application').classList.remove('cache');
      await chargerPageMarche('crypto');
    }, 300);
  }, 1200);

  setInterval(rafraichirPrix, 30000);
}

document.addEventListener('DOMContentLoaded', demarrer);
