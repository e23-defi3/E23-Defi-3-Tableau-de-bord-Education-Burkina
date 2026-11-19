/* Tableau de bord Défi 3 : salles de classe et enseignants (Burkina Faso).
 * Fonctionne sans serveur : les données précalculées sont dans data/donnees.js (window.D3DATA) et data/geo.js
 * (window.D3GEO). Les recalculs (besoins 2030 selon les normes, PROMETHEE II selon les poids, répartition d'un budget)
 * reprennent EXACTEMENT les formules du pipeline Python (d3/e04_projection.py, d3/promethee.py) ; la concordance est
 * vérifiée par tests/test_tableau_de_bord.py (exécution Node de calculs.js… voir la section CALCULS ci-dessous).
 * Règles d'affichage : absence = N/D (jamais 0) ; chaque chiffre porte sa nature (OBSERVATION, CALCUL, ESTIMATION,
 * HYPOTHÈSE, NORME) ; tous les graphiques, cartes, indicateurs et exports respectent le périmètre filtré.
 */
"use strict";

const D = typeof window !== "undefined" ? window.D3DATA : undefined, G = typeof window !== "undefined" ? window.D3GEO : undefined;
const ND = "N/D";

/* ============================================================== CALCULS (purs, testés contre Python) */
const Calc = {
  /* Besoins 2030 par province : mêmes formules que d3/e04_projection.besoins */
  besoins(provinces, ns, nm, scenario, cible) {
    return provinces.map(p => {
      const couv = p.eleves_total / p.pop_6_11_base;
      const couv30 = scenario === "cible" ? Math.max(couv, cible) : couv;
      const el30 = couv30 * p.pop_6_11_2030;
      const sn = Math.ceil(el30 / ns), mn = Math.ceil(el30 / nm);
      const ds = Math.max(0, sn - p.salles_total), dm = Math.max(0, mn - p.maitres_total);
      const snb = Math.ceil(p.eleves_total / ns), mnb = Math.ceil(p.eleves_total / nm);
      return Object.assign({}, p, {
        couverture_base: couv, couverture_2030: couv30, eleves_2030: el30,
        salles_necessaires_2030: sn, maitres_necessaires_2030: mn,
        deficit_salles_2030: ds, deficit_maitres_2030: dm,
        deficit_salles_base: Math.max(0, snb - p.salles_total), deficit_maitres_base: Math.max(0, mnb - p.maitres_total),
        deficit_salles_2030_pour_1000: 1000 * ds / p.pop_6_11_2030,
        deficit_maitres_2030_pour_1000: 1000 * dm / p.pop_6_11_2030,
        non_couverts_pct: 100 * Math.max(0, 1 - couv),
        croissance_6_11_pct: 100 * (p.pop_6_11_2030 / p.pop_6_11_base - 1),
      });
    });
  },
  /* Fonction de préférence « linear » (V-shape avec indifférence), d3/promethee.preference */
  pref(d, q, p) {
    if (d <= 0) return 0;
    if (p <= q) return d > q ? 1 : 0;
    if (d <= q) return 0;
    if (d <= p) return (d - q) / (p - q);
    return 1;
  },
  /* Seuils automatiques documentés : q = 5 % et p = 30 % de l'étendue (d3/promethee.seuils_auto) */
  seuils(x) {
    const v = x.filter(Number.isFinite);
    const e = v.length ? Math.max(...v) - Math.min(...v) : 0;
    return { q: 0.05 * e, p: 0.30 * e };
  },
  /* Flux unicritère phi_j(a) = 1/(n-1) somme_b [P_j(a,b) - P_j(b,a)] */
  fluxUnicritere(x, sens, q, p) {
    const n = x.length, out = new Array(n).fill(0);
    const s = sens === "min" ? -1 : 1;
    for (let a = 0; a < n; a++) {
      let t = 0;
      for (let b = 0; b < n; b++) {
        if (a === b) continue;
        const d = s * (x[a] - x[b]);
        t += Calc.pref(d, q, p) - Calc.pref(-d, q, p);
      }
      out[a] = n > 1 ? t / (n - 1) : 0;
    }
    return out;
  },
  /* PROMETHEE II : phi = somme_j w_j phi_j (poids normalisés) ; rang 1 = phi le plus élevé = le plus prioritaire */
  promethee(lignes, criteres, poids) {
    const n = lignes.length;
    const total = criteres.reduce((s, c) => s + (poids[c.critere] || 0), 0) || 1;
    const phiJ = {};
    criteres.forEach(c => {
      const x = lignes.map(l => l[c.critere]);
      const { q, p } = Calc.seuils(x);
      phiJ[c.critere] = Calc.fluxUnicritere(x, c.sens, q, p);
    });
    const phi = lignes.map((_, i) => criteres.reduce((s, c) => s + (poids[c.critere] || 0) / total * phiJ[c.critere][i], 0));
    const ordre = phi.map((v, i) => [v, i]).sort((a, b) => b[0] - a[0]);
    const rang = new Array(n);
    ordre.forEach(([, i], k) => { rang[i] = k + 1; });
    return lignes.map((l, i) => Object.assign({}, l, { phi_calc: phi[i], rang_calc: rang[i],
      contributions: Object.fromEntries(criteres.map(c => [c.critere, (poids[c.critere] || 0) / total * phiJ[c.critere][i]])) }));
  },
  /* Valeurs des critères recalculées quand les normes ou le scénario changent (C5 dépend de la norme ; C7, C8 du scénario) */
  criteresDepuisBesoins(b) {
    return b.map(l => Object.assign({}, l, {
      C5_deficit_salles_2030: l.deficit_salles_2030_pour_1000,
      C6_deficit_maitres_2030: l.deficit_maitres_2030_pour_1000,
      C7_croissance_6_11_2030: l.croissance_6_11_pct,
      C8_couverture_inverse: l.non_couverts_pct,
    }));
  },
  /* Répartition d'un budget (salles ou enseignants) entre provinces.
   * equite : une unité à la fois à la province dont le ratio élèves 2030 / stock est le plus élevé (minimise le ratio
   *          maximal : solution exacte du problème min-max pour des unités entières) ;
   * priorite : combler les déficits dans l'ordre du classement multicritère ;
   * proportionnel : au prorata des déficits (plus forts restes). */
  repartir(lignes, regle, budget, stockKey, besoinKey, rangKey) {
    const n = lignes.length, x = new Array(n).fill(0);
    const deficit = lignes.map(l => Math.max(0, l[besoinKey] - l[stockKey]));
    if (budget <= 0 || n === 0) return x;
    if (regle === "equite") {
      for (let k = 0; k < budget; k++) {
        let best = -1, br = -Infinity;
        for (let i = 0; i < n; i++) {
          const r = lignes[i].eleves_2030 / (lignes[i][stockKey] + x[i]);
          if (r > br) { br = r; best = i; }
        }
        x[best]++;
      }
    } else if (regle === "priorite") {
      const ordre = lignes.map((l, i) => i).sort((a, b) => lignes[a][rangKey] - lignes[b][rangKey]);
      let reste = budget;
      for (const i of ordre) { const v = Math.min(reste, deficit[i]); x[i] = v; reste -= v; if (reste <= 0) break; }
    } else {
      const tot = deficit.reduce((s, v) => s + v, 0);
      if (tot === 0) return x;
      const b = Math.min(budget, tot);
      const brut = deficit.map(v => b * v / tot);
      brut.forEach((v, i) => { x[i] = Math.floor(v); });
      let reste = b - x.reduce((s, v) => s + v, 0);
      brut.map((v, i) => [v - Math.floor(v), i]).sort((a, c) => c[0] - a[0]).slice(0, reste).forEach(([, i]) => x[i]++);
    }
    return x;
  },
};
if (typeof module !== "undefined") module.exports = { Calc };
if (typeof window !== "undefined" && !D) { throw new Error("donnees.js absent"); }

/* ============================================================== FORMATS ET OUTILS */
/* Version affichée : changer le numéro et la date à chaque nouvelle soumission. */
const VERSION = { numero: "1", date: "18/11/2026" };
/* Normes des autres niveaux : valeurs de référence utilisées par le pipeline (config/parametres.yaml), affichées pour
 * information ; la page Trois cycles est calculée avec ces valeurs. */
const NORMES_NIVEAUX = [
  ["Préscolaire", "35 enfants par salle d'activités", "NORME", "DGESS, préscolaire 2023"],
  ["Primaire", "50 élèves par maître", "NORME", "DGESS, primaire 2023-24"],
  ["Primaire", "50 élèves par salle", "HYPOTHÈSE", "aucune norme écrite trouvée ; alignée sur le ratio élève/maître"],
  ["Post-primaire", "70 élèves par classe", "NORME", "DGESS, post-primaire et secondaire 2024"],
];
const ico = (n, cls = "ico") => `<svg class="${cls}" aria-hidden="true"><use href="#i-${n}"/></svg>`;
/* Note repliée derrière une icône (pour les explications longues) */
const notePli = (texte, libelle = "Lire la note") => `<details class="note-pli"><summary>${ico("info")}${libelle}</summary><p class="note">${texte}</p></details>`;
const SOURCE_PRIMAIRE = "Source : DGESS, annuaires statistiques du primaire ; limites administratives COD-AB (OCHA/HDX).";
const SOURCE_BESOINS = "Source : DGESS (annuaires 2024-25) ; INSD (projections RGPH 2019) ; calculs E23.";
const source = t => `<p class="source">${t}</p>`;
/* Libellés d'affichage des critères (le calcul utilise les codes, inchangés) */
const LIB_CRITERE = {};
const libCritere = c => LIB_CRITERE[c.critere] || c.libelle;
const NF = {};
function nf(v, dec = 0) {
  if (v === null || v === undefined || !Number.isFinite(v)) return ND;
  const k = String(dec);
  NF[k] = NF[k] || new Intl.NumberFormat("fr-FR", { maximumFractionDigits: dec, minimumFractionDigits: dec });
  return NF[k].format(v);
}
const pct = (v, dec = 1) => (v === null || !Number.isFinite(v)) ? ND : nf(v, dec) + " %";
const $ = (s, r = document) => r.querySelector(s);
const el = (tag, attrs = {}, html = "") => { const e = document.createElement(tag); Object.entries(attrs).forEach(([k, v]) => e.setAttribute(k, v)); e.innerHTML = html; return e; };
const somme = (a, k) => a.reduce((s, l) => s + (Number.isFinite(l[k]) ? l[k] : 0), 0);
const esc = s => String(s ?? "").replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
const NAT_LIB = { OBSERVATION: "SOURCE", CALCUL: "CALCULÉ", ESTIMATION: "ESTIMÉ" };
const badge = nat => `<span class="etiquette ${nat.replace("È", "E")}">${NAT_LIB[nat] || nat}</span>`;
function toast(t) { const e = $("#toast"); e.textContent = t; e.classList.add("visible"); setTimeout(() => e.classList.remove("visible"), 2200); }
function titreCase(s) { return String(s || "").toLowerCase().replace(/(^|[\s'-])(\p{L})/gu, (m, a, b) => a + b.toUpperCase()).replace(/ (Du|De|Des|La|Le|Et) /g, m => m.toLowerCase()); }

/* ============================================================== ÉTAT (partagé par toutes les pages, reflété dans l'URL) */
/* Budget par défaut = 50 % des déficits 2030 nationaux (normes et scénario par défaut), comme les résultats de référence
 * du pipeline (05_interpretation, budget_reference_pct = 50). */
const BUDGET_REF = { pct: 50,
  salles: Math.round(0.5 * D.provinces.reduce((s, p) => s + (p.deficit_salles_2030 || 0), 0)),
  maitres: Math.round(0.5 * D.provinces.reduce((s, p) => s + (p.deficit_maitres_2030 || 0), 0)) };
const DEF = {
  page: "accueil", decoupage: "ancien", region: "", province: "",
  ns: D.meta.normes.salle, nm: D.meta.normes.maitre, scenario: D.meta.scenario, cible: Math.round(D.meta.cible * 100),
  regle: "equite", bs: BUDGET_REF.salles, bm: BUDGET_REF.maitres, ind_diag: "eleves_par_maitre", annee: D.meta.annee_base,
  ind_bes: "deficit_salles_2030", ind_com: "eleves_par_salle", cycle: "prescolaire", vue_bes: "carte",
};
D.criteres.forEach(c => { DEF["w_" + c.critere] = Math.round(c.poids * 100); });
const E = Object.assign({}, DEF);

function lireURL() {
  const h = new URLSearchParams(location.hash.slice(1));
  // valeurs de l'adresse filtrées : nombres finis, textes sans balise ni guillemet (aucun code injecté par un lien)
  for (const [k, v] of h) if (k in DEF) {
    if (typeof DEF[k] === "number") { const n = Number(v); if (Number.isFinite(n)) E[k] = n; }
    else if (/^[\p{L}\p{N} ._’()\/-]{0,80}$/u.test(v)) E[k] = v;
  }
}
function ecrireURL() {
  const h = new URLSearchParams();
  Object.keys(DEF).forEach(k => { if (E[k] !== DEF[k]) h.set(k, E[k]); });
  history.replaceState(null, "", "#" + h.toString());
}
function poids() { return Object.fromEntries(D.criteres.map(c => [c.critere, E["w_" + c.critere]])); }
function reglagesParDefaut() {
  return E.ns === DEF.ns && E.nm === DEF.nm && E.scenario === DEF.scenario && E.cible === DEF.cible &&
    D.criteres.every(c => E["w_" + c.critere] === DEF["w_" + c.critere]);
}

/* ============================================================== RÉFÉRENTIEL (ancien 13/45, nouveau 17/47) */
const P45 = Object.fromEntries(D.provinces.map(p => [p.adm2_pcode_old, p]));
const P47 = D.provinces47;
const REG17 = Object.fromEntries(D.regions17.map(r => [r.adm1_pcode, r.region_nouvelle]));
P47.forEach(p => { p.region17 = REG17[p.adm1_pcode] || p.adm1_name; });
function regionsListe() {
  if (E.decoupage === "ancien") return [...new Set(D.provinces.map(p => p.region_ancienne))].sort().map(r => [r, titreCase(r)]);
  return [...new Set(P47.map(p => p.adm1_pcode))].map(c => [c, REG17[c] || c]).sort((a, b) => a[1].localeCompare(b[1], "fr"));
}
/* codes de l'ANCIEN découpage (unité de calcul) compris dans le périmètre filtré */
function codesFiltres() {
  let c = D.provinces.map(p => p.adm2_pcode_old);
  if (E.region) {
    if (E.decoupage === "ancien") c = c.filter(k => P45[k].region_ancienne === E.region);
    else { const s = new Set(P47.filter(p => p.adm1_pcode === E.region).map(p => p.adm2_pcode_old)); c = c.filter(k => s.has(k)); }
  }
  return new Set(c);
}
function libellePerimetre() {
  if (!E.region) return "Tout le pays";
  const r = regionsListe().find(([k]) => k === E.region);
  return "Région " + (r ? r[1] : E.region) + (E.decoupage === "ancien" ? " (ancien découpage)" : " (nouveau découpage)");
}
const S47 = Object.fromEntries((D.sommes47 || []).map(s => [s.adm2_pcode, s]));
const MAP_S47 = { salles_total: "salles_ensemble", eleves_total: "eleves_ensemble", maitres_total: "enseignants_ensemble",
  eleves_par_salle: "eleves_par_salle", eleves_par_maitre: "ratio_eleve_maitre", pop_6_11_2030: "pop_6_11_2030",
  deficit_salles_2030: "deficit_salles_2030_maintien", deficit_maitres_2030: "deficit_enseignants_2030_maintien" };
/* Lignes à afficher dans le découpage choisi. En 47 provinces, les ratios des provinces scindées (Soum, Tapoa) sont
 * hérités de la province mère ; les effectifs (comptes) ne sont PAS répartis : N/D, avec la mention. */
function lignesAffichees(rows45, champsComptes = []) {
  const f = codesFiltres();
  if (E.decoupage === "ancien") return rows45.filter(r => f.has(r.adm2_pcode_old)).map(r => Object.assign({ code: r.adm2_pcode_old, nom: r.province, region: titreCase(r.region_ancienne), herite: false }, r));
  const idx = Object.fromEntries(rows45.map(r => [r.adm2_pcode_old, r]));
  return P47.filter(p => f.has(p.adm2_pcode_old) && (!E.region || p.adm1_pcode === E.region)).map(p => {
    const r = Object.assign({}, idx[p.adm2_pcode_old]);
    const herite = p.n_filles > 1;
    // Province issue d'une scission (Soum, Tapoa) : les sources ne publient que l'ancienne province ; aucune valeur n'est
    // répartie ni recopiée vers les nouvelles provinces (choix validé) : toutes les valeurs sont N/D.
    const parent = herite ? Object.assign({}, r) : null;
    if (herite) Object.keys(r).forEach(k => { if (typeof r[k] === "number") r[k] = null; });
    // Décision du 18/11 (20h41) : effectifs, ratios et déficits = somme exacte des communes de la province (indicatif) ;
    // tout le reste (critères, rang, équipements, séries) reste N/D. Seulement pour l'année des chiffres communaux.
    const s = herite ? S47[p.adm2_pcode] : null;
    const memeAnnee = s && (!r.annee_scolaire || String(s.annee_communes || "").includes(r.annee_scolaire));
    if (memeAnnee) Object.entries(MAP_S47).forEach(([k, ks]) => { if (k in r || k === "salles_total") r[k] = s[ks] ?? null; });
    // province issue d'une scission : ses ratios sont ceux de la province d'origine (mention visible partout où le nom apparaît)
    const mere = idx[p.adm2_pcode_old]?.province;
    return Object.assign(r, { code: p.adm2_pcode, nom: p.adm2_name + (memeAnnee ? " (somme des communes " + s.annee_communes + ", indicatif)" : ""), region: p.region17, herite, mere, somme: !!memeAnnee, _parent: parent, _parentNom: mere ? "province d'origine " + mere : "" });
  });
}

/* ============================================================== RÉSULTATS (mémorisés selon les réglages) */
let cache = { cle: null };
function resultats() {
  const cle = JSON.stringify([E.ns, E.nm, E.scenario, E.cible, poids()]);
  if (cache.cle === cle) return cache;
  const b = Calc.besoins(D.provinces, E.ns, E.nm, E.scenario, E.cible / 100);
  const crit = Calc.criteresDepuisBesoins(b);
  const pr = Calc.promethee(crit, D.criteres, poids());
  cache = { cle, besoins: pr, parCode: Object.fromEntries(pr.map(r => [r.adm2_pcode_old, r])) };
  return cache;
}
function statutRobustesse(r) {
  if (!reglagesParDefaut() || !Number.isFinite(r.rang_calc)) return "";
  if (r.rang_p95 !== null && r.rang_p95 <= 10) return '<span class="statut sans-regret" title="Dans le top 10 pour 95 % des 2 000 tirages de poids (±20 %)">Priorité robuste</span>';
  if (r.rang_calc <= 10) return '<span class="statut confirmer" title="Dans le top 10 avec les poids par défaut, mais pas dans tous les tirages">Sensible aux poids</span>';
  return "";
}

/* ============================================================== CARTES ET GRAPHIQUES (Plotly, sans fond de carte externe) */
const CONFIG_PLOTLY = { responsive: true, displaylogo: false, modeBarButtonsToRemove: ["select2d", "lasso2d", "toggleHover", "autoScale2d"], toImageButtonOptions: { format: "png", scale: 2 } };
const ECHELLE_BESOIN = [[0, "#fff7ec"], [0.2, "#fdd49e"], [0.45, "#fc8d59"], [0.75, "#d7301f"], [1, "#7f0000"]];
const ECHELLE_RATIO = [[0, "#f7fbff"], [0.35, "#9ecae1"], [0.7, "#3182bd"], [1, "#08306b"]];
const ECHELLE_PHI = [[0, "#2166ac"], [0.5, "#f7f7f7"], [1, "#b2182b"]];

// Fond de carte mondial vide : Plotly n'ira pas chercher world_110m.json sur internet (fonctionne hors ligne).
(function () {
  if (typeof window === "undefined") return;
  const vide = { type: "GeometryCollection", geometries: [] };
  const topo = { type: "Topology", arcs: [], objects: { land: vide, ocean: vide, lakes: vide, rivers: vide, coastlines: vide, countries: vide, subunits: vide } };
  window.PlotlyGeoAssets = window.PlotlyGeoAssets || { topojson: {} };
  window.PlotlyGeoAssets.topojson = window.PlotlyGeoAssets.topojson || {};
  for (const n of ["world_110m", "world_50m", "africa_110m", "africa_50m"]) window.PlotlyGeoAssets.topojson[n] = topo;
})();

function carte(div, lignes, valeur, opts = {}) {
  const geo = opts.geo || (E.decoupage === "ancien" ? G.provinces45 : G.provinces47);
  const tousCodes = geo.features.map(f => f.id);
  const vis = lignes.filter(l => Number.isFinite(l[valeur]));
  const ndl = lignes.filter(l => !Number.isFinite(l[valeur]));
  // Échelle robuste : une valeur extrême isolée (ex. donnée aberrante) ne doit pas écraser toutes les couleurs.
  let zmax;
  if (opts.zmid === undefined && vis.length > 20) {
    const v = vis.map(l => l[valeur]).sort((a, b) => a - b), q98 = v[Math.floor(0.98 * (v.length - 1))];
    if (v[v.length - 1] > 1.5 * q98 && q98 > 0) zmax = q98;
  }
  const traces = [{
    type: "choropleth", geojson: geo, featureidkey: "id", locations: tousCodes, z: tousCodes.map(() => 0),
    colorscale: [[0, "#e9edf1"], [1, "#e9edf1"]], showscale: false, hoverinfo: "skip", marker: { line: { color: "#ffffff", width: 0.6 } },
  }, {
    type: "choropleth", geojson: geo, featureidkey: "id", locations: vis.map(l => l.code), z: vis.map(l => l[valeur]),
    customdata: vis.map(l => l.code), text: vis.map(l => opts.texte ? opts.texte(l) : `${esc(l.nom)}<br>${nf(l[valeur], opts.dec ?? 1)}`),
    hovertemplate: "%{text}<extra></extra>", colorscale: opts.echelle || ECHELLE_BESOIN, zmid: opts.zmid, zmax, zauto: zmax === undefined,
    marker: { line: { color: opts.contour || "#ffffff", width: opts.largeurs || vis.map(l => l.code === E.province ? 3 : 0.8) } },
    colorbar: { title: { text: (opts.titreEchelle || "") + (zmax !== undefined ? " (couleur plafonnée)" : ""), side: "right" }, thickness: 12, len: 0.75, tickformat: opts.tickformat || "" },
  }];
  if (ndl.length) traces.push({
    type: "choropleth", geojson: geo, featureidkey: "id", locations: ndl.map(l => l.code), z: ndl.map(() => 0),
    colorscale: [[0, "#c7ced6"], [1, "#c7ced6"]], showscale: false, customdata: ndl.map(l => l.code),
    text: ndl.map(l => `${esc(l.nom)}<br>N/D${l.herite ? "<br>Données publiées pour l'ancienne province " + esc(l.mere) + " seulement :<br>voir le découpage ancien (45 provinces)" : ""}${l.motifND ? "<br>" + esc(l.motifND) : ""}${l._parent && Number.isFinite(l._parent[valeur]) ? "<br>Pour information, " + esc(l._parentNom) + " : " + nf(l._parent[valeur], opts.dec ?? 1) : ""}`),
    hovertemplate: "%{text}<extra></extra>", marker: { line: { color: "#ffffff", width: 0.8 } },
  });
  const layout = {
    margin: { l: 0, r: 0, t: 0, b: 0 }, paper_bgcolor: "rgba(0,0,0,0)", dragmode: false,
    geo: { fitbounds: "locations", visible: false, projection: { type: "mercator" }, bgcolor: "rgba(0,0,0,0)" },
  };
  if (E.region && lignes.length) traces[0].locations = tousCodes, layout.geo.fitbounds = "locations";
  if (E.region) { traces[0].locations = lignes.map(l => l.code); traces[0].z = traces[0].locations.map(() => 0); }
  Plotly.react(div, traces, layout, CONFIG_PLOTLY);
  div.removeAllListeners && div.removeAllListeners("plotly_click");
  div.on("plotly_click", ev => {
    const c = ev.points[0]?.customdata; if (!c) return;
    const code45 = E.decoupage === "ancien" ? c : (P47.find(p => p.adm2_pcode === c)?.adm2_pcode_old);
    if (opts.surClic) opts.surClic(c); else { E.province = code45 === E.province ? "" : code45; rafraichir(); }
  });
}

function barres(div, lignes, valeur, opts = {}) {
  const t = lignes.filter(l => Number.isFinite(l[valeur])).sort((a, b) => (opts.croissant ? a[valeur] - b[valeur] : b[valeur] - a[valeur])).slice(0, opts.n || 15).reverse();
  const couleurs = t.map(l => (l.code === E.province || l.adm2_pcode_old === E.province) ? "#c0392b" : (opts.couleur ? opts.couleur(l) : "#1e5288"));
  Plotly.react(div, [{
    type: "bar", orientation: "h", y: t.map(l => l.nom), x: t.map(l => l[valeur]), marker: { color: couleurs },
    text: t.map(l => nf(l[valeur], opts.dec ?? 1)), textposition: "outside", cliponaxis: false, customdata: t.map(l => l.code),
    hovertemplate: "%{y} : %{text}<extra></extra>",
  }], {
    margin: { l: 120, r: 50, t: 6, b: 34 }, xaxis: { title: { text: opts.titreX || "" }, zeroline: true, gridcolor: "#eef1f4", tickformat: opts.tickformat || "" },
    yaxis: { automargin: true, tickfont: { size: 11 } }, paper_bgcolor: "rgba(0,0,0,0)", plot_bgcolor: "rgba(0,0,0,0)", bargap: 0.25,
    shapes: opts.ligne !== undefined ? [{ type: "line", x0: opts.ligne, x1: opts.ligne, yref: "paper", y0: 0, y1: 1, line: { color: "#c0392b", dash: "dash", width: 1.5 } }] : [],
    annotations: opts.ligne !== undefined ? [{ x: opts.ligne, y: 1.02, yref: "paper", text: opts.ligneTexte || "", showarrow: false, font: { size: 10, color: "#c0392b" } }] : [],
  }, CONFIG_PLOTLY);
}

/* ============================================================== TABLEAUX ET EXPORTS */
function tableau(cadre, colonnes, lignes, opts = {}) {
  let tri = cadre._tri || opts.tri || null;
  const rendre = () => {
    let L = lignes.slice();
    if (tri) L.sort((a, b) => { const va = a[tri.k], vb = b[tri.k]; const x = (va ?? -Infinity), y = (vb ?? -Infinity); return (typeof x === "string" ? x.localeCompare(y, "fr") : x - y) * tri.s; });
    const th = colonnes.map(c => `<th data-k="${c.k}" title="${esc(c.aide || "")}">${esc(c.t)}${tri && tri.k === c.k ? (tri.s > 0 ? " ▲" : " ▼") : ""}</th>`).join("");
    const tr = L.map(l => `<tr data-code="${esc(l.code)}" class="${(l.code === E.province || l.adm2_pcode_old === E.province) ? "selection" : ""}">${colonnes.map(c => {
      const v = l[c.k];
      if (c.html) return `<td>${c.html(l)}</td>`;
      if (c.f) { const s = c.f(v, l);
        const pv = l._parent && Number.isFinite(l._parent[c.k]) ? ` title="Pour information, ${esc(l._parentNom)} : ${esc(c.f(l._parent[c.k], l._parent))}"` : "";
        return `<td class="${typeof v === "number" ? "n" : ""}">${s === ND ? `<span class="nd"${pv}>N/D${pv ? " ⓘ" : ""}</span>` : s}</td>`; }
      return `<td>${v === null || v === undefined ? '<span class="nd">N/D</span>' : esc(v)}</td>`;
    }).join("")}</tr>`).join("");
    cadre.innerHTML = `<table class="donnees"><thead><tr>${th}</tr></thead><tbody>${tr}</tbody></table>`;
    cadre.querySelectorAll("th").forEach(h => h.onclick = () => { const k = h.dataset.k; tri = (tri && tri.k === k) ? { k, s: -tri.s } : { k, s: -1 }; cadre._tri = tri; rendre(); });
    if (opts.surClic) cadre.querySelectorAll("tbody tr").forEach(r => r.onclick = () => opts.surClic(r.dataset.code));
  };
  rendre();
}
function exporterCSV(nom, colonnes, lignes) {
  const f = v => v === null || v === undefined || (typeof v === "number" && !Number.isFinite(v)) ? ND : (typeof v === "number" ? String(Math.round(v * 100) / 100).replace(".", ",") : String(v).replace(/<[^>]+>/g, "").replace(/;/g, ","));
  const csv = "﻿" + [colonnes.map(c => c.t).join(";"), ...lignes.map(l => colonnes.map(c => f(c.x ? c.x(l) : c.e ? c.e(l[c.k]) : l[c.k])).join(";"))].join("\r\n");
  const a = document.createElement("a");
  a.href = URL.createObjectURL(new Blob([csv], { type: "text/csv;charset=utf-8" }));
  a.download = `${nom}_${E.decoupage}_${new Date().toISOString().slice(0, 10)}.csv`;
  a.click(); URL.revokeObjectURL(a.href);
  toast("Export CSV téléchargé (séparateur « ; », virgule décimale)");
}
function boutonExport(id) { return `<button class="bouton-export" id="${id}" title="Télécharger le tableau du périmètre filtré (CSV : s'ouvre dans un tableur)">${ico("export")}CSV</button>`; }

/* ============================================================== COMPOSANTS DE PAGE */
function enTete(question, chapeau) {
  const avis = E.decoupage === "nouveau" ? `<p class="note">${ico("info")} Nouveau découpage : Djelgodji et Karo-Peli (issues de Soum), Dyamongou et Gobnangou (issues de Tapoa) n'ont pas de tableau DGESS. Leurs effectifs, ratios et déficits 2030 sont la somme exacte de leurs communes (annuaires INSD ${esc([...new Set((D.sommes47 || []).map(s => s.annee_communes))].join(", "))}, calés sur la DGESS), étiquetée « somme des communes, indicatif » ; leurs autres valeurs (critères, rang, équipements) sont N/D. Les valeurs DGESS de Soum et de Tapoa figurent dans le découpage ancien (45 provinces).</p>` : "";
  return `<p class="question">${question}</p><p class="chapeau">${chapeau}</p>${avis}`;
}
function kpi(titre, valeur, detail, nature, classe = "") { return `<div class="kpi ${classe}"><div class="titre">${titre}</div><div class="valeur">${valeur}</div><div class="detail">${detail} ${nature ? badge(nature) : ""}</div></div>`; }
function recit(retenir, attention, agir) {
  return `<div class="recit"><div class="bloc"><span class="bloc-titre">L'essentiel</span>${retenir}</div><div class="bloc attention"><span class="bloc-titre">Vigilance</span>${attention}</div><div class="bloc action"><span class="bloc-titre">Pour décider</span>${agir}</div></div>`;
}
const GLOSSAIRE = [
  ["Ratio élève/maître", "Élèves du primaire divisés par les maîtres chargés de cours (public et privé). Norme : 50 élèves par maître."],
  ["Élèves par salle", "Élèves divisés par les salles de classe. 50 par défaut au primaire : hypothèse, aucune norme écrite trouvée. Préscolaire : 35 par salle d'activités ; post-primaire : 70 par classe."],
  ["Besoin 2030", "Élèves attendus en 2030 divisés par la norme, arrondi à l'unité supérieure."],
  ["Déficit 2030", "Besoin 2030 moins le stock actuel (salles ou maîtres de 2024-25) ; 0 si le stock suffit."],
  ["Taux de couverture", "Élèves du primaire divisés par la population de 6 à 11 ans (proche du taux brut de scolarisation)."],
  ["Scénario « maintien »", "Le taux de couverture de 2024-25 est reconduit en 2030 : là où des écoles sont fermées, la demande reste basse."],
  ["Scénario « cible »", "Le taux de couverture est relevé au moins à la cible choisie (par exemple 100 %) : il mesure le besoin pour scolariser tous les enfants."],
  ["PROMETHEE II", "Méthode multicritère qui compare les provinces deux à deux sur chaque critère. Le flux net (de −1 à +1) résume ces comparaisons ; plus il est élevé, plus la province est prioritaire."],
  ["Règle de répartition", "Façon de distribuer un nombre donné de salles ou d'enseignants : équité (réduire d'abord le ratio le plus élevé), priorité (suivre le classement), ou au prorata des déficits."],
  ["Priorité robuste", "Province classée dans les 10 premières pour au moins 95 % des 2 000 tirages de poids (variation de ±20 %) : la priorité ne dépend pas d'un choix de poids."],
  ["Somme des communes, indicatif", "Pour les 4 provinces issues de la scission de Soum et de Tapoa, qui n'ont pas de tableau DGESS : somme exacte des chiffres de leurs communes (annuaires INSD calés sur la DGESS). Reconstruction à partir de données publiées, pas une estimation."],
  ["N/D", "Donnée non disponible au niveau affiché. Jamais remplacée par 0, ni déduite d'un autre niveau administratif ; la raison s'affiche au survol et figure dans le registre N/D."],
  ["Répartition indicative", "Valeur communale obtenue en répartissant un total de la province (demande 2030, calage sur la DGESS). Elle donne un ordre de grandeur pour choisir où construire ; le chiffre publié par l'INSD figure à côté."],
  ["SOURCE · CALCULÉ · ESTIMÉ · HYPOTHÈSE · NORME", "Nature de chaque chiffre : publié tel quel par la source, calculé à partir de chiffres publiés, estimé par un modèle (projection, répartition), fixé par hypothèse, ou norme officielle écrite."],
];
function glossaire() { return `<details class="glossaire"><summary>${ico("info")} Glossaire : comment lire ces chiffres</summary><dl class="gloss">${GLOSSAIRE.map(([t, d]) => `<dt>${t}</dt><dd>${d}</dd>`).join("")}</dl></details>`; }

/* ============================================================== PAGE : ACCUEIL */
function pageAccueil() {
  const R = resultats(), f = codesFiltres();
  const L = R.besoins.filter(r => f.has(r.adm2_pcode_old));
  const el = somme(L, "eleves_total"), ma = somme(L, "maitres_total"), sa = somme(L, "salles_total");
  const ds = somme(L, "deficit_salles_2030"), dm = somme(L, "deficit_maitres_2030");
  const enDef = L.filter(l => l.deficit_salles_2030 > 0).length;
  const auDessus = L.filter(l => l.eleves_total / l.maitres_total > E.nm);
  const top = L.slice().sort((a, b) => a.rang_calc - b.rang_calc).slice(0, 3);
  const pire = L.slice().sort((a, b) => b.eleves_total / b.maitres_total - a.eleves_total / a.maitres_total)[0];
  const p = $("#p-accueil");
  p.innerHTML = enTete("Combien de salles et d'enseignants manquera-t-il en 2030, et où agir d'abord ?",
    `Périmètre : <b>${libellePerimetre()}</b>. Année de référence ${D.meta.annee_base}, horizon ${D.meta.horizon}. Normes : ${E.ns} élèves par salle (hypothèse), ${E.nm} élèves par maître ; demande : ${E.scenario === "cible" ? "scolarisation relevée à " + E.cible + " %" : "maintien du taux actuel"}. Tout est modifiable dans « Filtres et paramètres ».`) +
    `<div class="resume">
      <div class="carte-resume"><span class="num">1 · BESOIN</span><span class="chiffre">${nf(ds)}</span><span class="libelle">salles de classe à construire d'ici 2030</span><span class="detail">et ${nf(dm)} enseignants à recruter ou redéployer ; ${enDef} province(s) sur ${L.length} en déficit de salles.</span><button data-aller="besoins">Voir les besoins ${ico("fleche")}</button></div>
      <div class="carte-resume"><span class="num">2 · SITUATION</span><span class="chiffre">${nf(el / ma, 1)}</span><span class="libelle">élèves par maître aujourd'hui (ratio élève/maître)</span><span class="detail">${auDessus.length} province(s) au-dessus de la norme de ${E.nm} ; la plus chargée : ${pire ? esc(pire.province) + " (" + nf(pire.eleves_total / pire.maitres_total, 1) + ")" : ND}.</span><button data-aller="diagnostic">Voir le diagnostic ${ico("fleche")}</button></div>
      <div class="carte-resume"><span class="num">3 · PRIORITÉS</span><span class="chiffre" style="font-size:1.25rem">${top.map(t => esc(t.province)).join(", ") || ND}</span><span class="libelle">provinces à traiter en premier</span><span class="detail">Classement multicritère PROMETHEE II sur ${D.criteres.length} critères (${D.criteres.map(c => esc(libCritere(c).replace(/ \(.*$/, "").toLowerCase())).join(", ")}).</span><button data-aller="priorites">Voir les priorités ${ico("fleche")}</button></div>
    </div>
    <div class="grille g6">
      ${kpi("Élèves (primaire)", nf(el), D.meta.annee_base, "OBSERVATION")}
      ${kpi("Maîtres", nf(ma), "chargés de cours", "OBSERVATION")}
      ${kpi("Salles de classe", nf(sa), D.meta.annee_base, "OBSERVATION")}
      ${kpi("Élèves par salle", nf(el / sa, 1), "norme : " + E.ns, "CALCUL")}
      ${kpi("Déficit de salles 2030", nf(ds), "pour " + E.ns + " élèves/salle", "ESTIMATION", "accent")}
      ${kpi("Déficit d'enseignants 2030", nf(dm), "pour " + E.nm + " élèves par maître", "ESTIMATION", "accent")}
    </div>
    <div class="grille g-carte" style="margin-top:14px">
      <div class="panneau"><div class="panneau-entete"><h3>Priorité des provinces (flux net PROMETHEE II)</h3></div><div id="acc-carte" class="graphe"></div><p class="note">Rouge = plus prioritaire, bleu = moins prioritaire. Cliquez sur une province pour la sélectionner sur toutes les pages.</p>${source(SOURCE_BESOINS)}</div>
      <div class="panneau"><div class="panneau-entete"><h3>Les 10 provinces les plus prioritaires</h3></div><div id="acc-barres" class="graphe"></div><p class="note">Rang calculé avec les poids actuels (page Priorités). ${reglagesParDefaut() ? "" : "Paramètres modifiés : statut de robustesse masqué."}</p></div>
    </div>` +
    recit(`Avec ces normes, il manque <b>${nf(ds)}</b> salles et <b>${nf(dm)}</b> enseignants en 2030 dans le périmètre ; ${enDef} province(s) sont en déficit de salles.`,
      `En scénario « maintien », les provinces où des écoles sont fermées gardent une demande basse : leur besoin réel est sous-estimé. Comparez avec le scénario « cible ».`,
      `Commencer par ${top.map(t => esc(t.province)).join(", ")}, puis répartir le budget disponible avec la page Répartition.`) + glossaire();
  p.querySelectorAll("[data-aller]").forEach(b => b.onclick = () => allerA(b.dataset.aller));
  const lg = lignesAffichees(R.besoins).map(l => Object.assign(l, { phi: l.phi_calc }));
  carte($("#acc-carte"), lg, "phi", { echelle: ECHELLE_PHI, zmid: 0, dec: 2, titreEchelle: "flux net", texte: l => `<b>${esc(l.nom)}</b><br>Rang ${l.rang_calc} · flux net ${nf(l.phi_calc, 3)}` });
  const lb = lignesAffichees(R.besoins).map(l => Object.assign(l, { score: -l.rang_calc }));
  barres($("#acc-barres"), lb.map(l => Object.assign(l, { phi: l.phi_calc })), "phi", { n: 10, dec: 3, titreX: "flux net PROMETHEE (plus élevé = plus prioritaire)" });
}

/* ============================================================== PAGE : DIAGNOSTIC */
const IND_DIAG = {
  eleves_par_maitre: ["Ratio élève/maître", 1, "CALCUL", "maitre"], eleves_par_salle: ["Élèves par salle de classe", 1, "CALCUL", "salle"],
  part_sans_eau: ["Écoles sans eau potable (%)", 1, "CALCUL"], part_sans_latrines: ["Écoles sans latrines (%)", 1, "CALCUL"],
  part_sans_electricite: ["Écoles sans électricité (%)", 1, "CALCUL"], ecoles_total: ["Nombre d'écoles", 0, "OBSERVATION", null, true],
  eleves_total: ["Nombre d'élèves", 0, "OBSERVATION", null, true],
};
function pageDiagnostic() {
  const annees = [...new Set(D.series.map(s => s.annee_scolaire))].sort();
  const [lib, dec, nat, norme, compte] = IND_DIAG[E.ind_diag];
  const sAn = D.series.filter(s => s.annee_scolaire === E.annee);
  const rows45 = sAn.map(s => Object.assign({}, P45[s.adm2_pcode_old] ? { province: P45[s.adm2_pcode_old].province, region_ancienne: P45[s.adm2_pcode_old].region_ancienne } : {}, s));
  const L = lignesAffichees(rows45, compte ? [E.ind_diag] : []);
  const nv = norme === "maitre" ? E.nm : norme === "salle" ? E.ns : undefined;
  const p = $("#p-diagnostic");
  const f = codesFiltres(), Lf = rows45.filter(r => f.has(r.adm2_pcode_old));
  const nat_ = (k1, k2) => somme(Lf, k1) / somme(Lf, k2);
  const valNat = E.ind_diag === "eleves_par_maitre" ? nat_("eleves_total", "maitres_total") : E.ind_diag === "eleves_par_salle" ? nat_("eleves_total", "salles_total") : compte ? somme(Lf, E.ind_diag) : null;
  const vals = L.filter(l => Number.isFinite(l[E.ind_diag]));
  const max = vals.slice().sort((a, b) => b[E.ind_diag] - a[E.ind_diag])[0], min = vals.slice().sort((a, b) => a[E.ind_diag] - b[E.ind_diag])[0];
  const auDessus = nv ? vals.filter(l => l[E.ind_diag] > nv).length : null;
  p.innerHTML = enTete("Où les classes et les enseignants sont-ils les plus chargés aujourd'hui ?",
    `Indicateurs par province et par année scolaire (2017-18 à 2024-25), d'après les annuaires statistiques du primaire. Périmètre : <b>${libellePerimetre()}</b>.`) +
    `<div class="panneau"><div class="controles">
      <label>Indicateur <select id="d-ind">${Object.entries(IND_DIAG).map(([k, v]) => `<option value="${k}" ${k === E.ind_diag ? "selected" : ""}>${v[0]}</option>`).join("")}</select></label>
      <label>Année scolaire <select id="d-an">${annees.map(a => `<option ${a === E.annee ? "selected" : ""}>${a}</option>`).join("")}</select></label>
      ${badge(nat)} ${nv ? `<span class="note">Ligne rouge : norme de ${nv}</span>` : ""}</div></div>
    <div class="grille g4" style="margin-top:14px">
      ${kpi(valNat !== null ? (compte ? "Total du périmètre" : "Valeur du périmètre") : "Médiane des provinces", nf(valNat !== null ? valNat : mediane(vals.map(v => v[E.ind_diag])), dec), lib + " · " + esc(E.annee), nat)}
      ${kpi("Valeur la plus élevée", max ? nf(max[E.ind_diag], dec) : ND, max ? esc(max.nom) : "", nat, "accent")}
      ${kpi("Valeur la plus basse", min ? nf(min[E.ind_diag], dec) : ND, min ? esc(min.nom) : "", nat)}
      ${kpi(nv ? "Provinces au-dessus de la norme" : "Provinces renseignées", nv ? `${auDessus} / ${vals.length}` : `${vals.length} / ${L.length}`, nv ? "norme : " + nv : "N/D exclues", "")}
    </div>
    <div class="grille g-carte" style="margin-top:14px">
      <div class="panneau"><h3>${lib} par province · ${esc(E.annee)}</h3><div id="d-carte" class="graphe"></div><p class="note">Cliquez sur une province pour afficher son évolution.</p>${source(SOURCE_PRIMAIRE)}</div>
      <div class="panneau"><h3>${lib} : 15 provinces les plus élevées</h3><div id="d-barres" class="graphe"></div></div>
    </div>
    <div class="grille g2" style="margin-top:14px">
      <div class="panneau"><h3>Évolution 2017-18 à 2024-25 : ${E.province ? esc(P45[E.province]?.province) + " et " : ""}périmètre</h3><div id="d-ligne" class="graphe bas"></div>${notePli("Les creux isolés (Banwa 2022-23, Nayala 2022-23, Loroum 2021-22) viennent des annuaires : non-réponse ou fermetures ; ils sont gardés et signalés.")}</div>
      <div class="panneau"><div class="panneau-entete"><h3>Tableau par province · ${esc(E.annee)}</h3>${boutonExport("d-exp")}</div><div class="table-cadre" id="d-table"></div></div>
    </div>` + glossaire();
  $("#d-ind").onchange = e => { E.ind_diag = e.target.value; rafraichir(); };
  $("#d-an").onchange = e => { E.annee = e.target.value; rafraichir(); };
  carte($("#d-carte"), L, E.ind_diag, { echelle: compte ? ECHELLE_RATIO : ECHELLE_BESOIN, dec, titreEchelle: "" });
  barres($("#d-barres"), L.map(l => Object.assign({}, l)), E.ind_diag, { dec, ligne: nv, ligneTexte: nv ? "norme " + nv : "" });
  // évolution : périmètre (ratio des sommes) et province sélectionnée
  const parAn = annees.map(a => { const s = D.series.filter(x => x.annee_scolaire === a && f.has(x.adm2_pcode_old));
    if (E.ind_diag === "eleves_par_maitre") return somme(s, "eleves_total") / somme(s, "maitres_total");
    if (E.ind_diag === "eleves_par_salle") return somme(s, "eleves_total") / somme(s, "salles_total");
    if (compte) return somme(s, E.ind_diag);
    return mediane(s.map(x => x[E.ind_diag])); });
  const tr = [{ x: annees, y: parAn, name: compte ? "Total du périmètre" : (["eleves_par_maitre", "eleves_par_salle"].includes(E.ind_diag) ? "Périmètre" : "Médiane du périmètre"), mode: "lines+markers", line: { color: "#1e5288", width: 3 } }];
  if (E.province) { const s = D.series.filter(x => x.adm2_pcode_old === E.province).sort((a, b) => a.annee_scolaire.localeCompare(b.annee_scolaire));
    tr.push({ x: s.map(x => x.annee_scolaire), y: s.map(x => x[E.ind_diag]), name: P45[E.province]?.province, mode: "lines+markers", line: { color: "#c0392b", width: 2.5 } }); }
  Plotly.react($("#d-ligne"), tr, { margin: { l: 50, r: 10, t: 10, b: 40 }, legend: { orientation: "h", y: -0.25 }, yaxis: { gridcolor: "#eef1f4", rangemode: "tozero" }, paper_bgcolor: "rgba(0,0,0,0)", plot_bgcolor: "rgba(0,0,0,0)",
    shapes: nv ? [{ type: "line", xref: "paper", x0: 0, x1: 1, y0: nv, y1: nv, line: { color: "#c0392b", dash: "dash", width: 1 } }] : [] }, CONFIG_PLOTLY);
  const cols = [{ k: "nom", t: "Province" }, { k: "region", t: "Région" }, { k: E.ind_diag, t: lib, f: v => nf(v, dec) },
    { k: "eleves_total", t: "Élèves", f: v => nf(v) }, { k: "maitres_total", t: "Maîtres", f: v => nf(v) }, { k: "salles_total", t: "Salles", f: v => nf(v) }, { k: "qualite", t: "Qualité de la donnée" }];
  tableau($("#d-table"), cols, L, { tri: { k: E.ind_diag, s: -1 }, surClic: c => selectionner(c) });
  $("#d-exp").onclick = () => exporterCSV("diagnostic_" + E.ind_diag + "_" + E.annee, cols, L);
}
/* arrondi à 0,1 identique à celui du pipeline Python (numpy : demi vers le pair) */
function arrondi1(x) { if (!Number.isFinite(x)) return null; const r = x * 10, f = Math.floor(r); return (r - f === 0.5 ? (f % 2 === 0 ? f : f + 1) : Math.round(r)) / 10; }
function mediane(a) { const v = a.filter(Number.isFinite).sort((x, y) => x - y); if (!v.length) return null; const m = Math.floor(v.length / 2); return v.length % 2 ? v[m] : (v[m - 1] + v[m]) / 2; }

/* ============================================================== PAGE : BESOINS 2030 */
const IND_BES = {
  deficit_salles_2030: ["Déficit de salles en 2030", 0, true], deficit_maitres_2030: ["Déficit d'enseignants en 2030", 0, true],
  deficit_salles_2030_pour_1000: ["Déficit de salles pour 1 000 enfants de 6-11 ans", 2, false],
  deficit_maitres_2030_pour_1000: ["Déficit d'enseignants pour 1 000 enfants de 6-11 ans", 2, false],
  eleves_2030: ["Élèves attendus en 2030", 0, true], croissance_6_11_pct: ["Croissance des 6-11 ans 2025-2030 (%)", 1, false],
};
function pageBesoins() {
  const R = resultats(), f = codesFiltres();
  const L45 = R.besoins.filter(r => f.has(r.adm2_pcode_old));
  const comptes = ["deficit_salles_2030", "deficit_maitres_2030", "eleves_2030", "salles_total", "maitres_total", "salles_necessaires_2030", "maitres_necessaires_2030", "deficit_salles_base", "deficit_maitres_base"];
  const L = lignesAffichees(R.besoins, comptes).map(l => Object.assign(l, { eps_actuel: l.eleves_total / l.salles_total, epm_actuel: l.eleves_total / l.maitres_total }));
  const [lib, dec] = IND_BES[E.ind_bes];
  const ds = somme(L45, "deficit_salles_2030"), dm = somme(L45, "deficit_maitres_2030"), dsb = somme(L45, "deficit_salles_base");
  const fia = D.fiabilite.filter(x => x.methode === "demographique");
  const top = L45.slice().sort((a, b) => b.deficit_salles_2030 - a.deficit_salles_2030).slice(0, 3);
  const part3 = ds ? 100 * somme(top, "deficit_salles_2030") / ds : null;
  const p = $("#p-besoins");
  p.innerHTML = enTete("Combien de salles et d'enseignants faudra-t-il en 2030, province par province ?",
    `Élèves 2030 = taux de couverture × population de 6-11 ans projetée par l'INSD ; besoin = élèves ÷ norme ; déficit = besoin − stock 2024-25. Changez les normes et le scénario dans le panneau de gauche : tout se recalcule. Périmètre : <b>${libellePerimetre()}</b>.`) +
    `<div class="grille g4">
      ${kpi("Déficit de salles 2030", nf(ds), "aujourd'hui déjà : " + nf(dsb), "ESTIMATION", "accent")}
      ${kpi("Déficit d'enseignants 2030", nf(dm), "norme " + E.nm + " élèves par maître", "ESTIMATION", "accent")}
      ${kpi("Élèves attendus en 2030", nf(somme(L45, "eleves_2030")), "contre " + nf(somme(L45, "eleves_total")) + " en " + D.meta.annee_base, "ESTIMATION")}
      ${kpi("Fiabilité de la projection", fia.length ? fia.map(x => nf(x.erreur_nationale_pct, 1) + " %").join(" / ") : ND, "erreur nationale du rétro-test (" + fia.map(x => x.annee_test).join(", ") + ")", "CALCUL", "ok")}
    </div>
    <div class="panneau" style="margin-top:14px"><div class="controles">
      <label>Indicateur <select id="b-ind">${Object.entries(IND_BES).map(([k, v]) => `<option value="${k}" ${k === E.ind_bes ? "selected" : ""}>${v[0]}</option>`).join("")}</select></label>
      <span class="note">Scénario : ${E.scenario === "cible" ? "couverture relevée à " + E.cible + " %" : "maintien de la couverture 2024-25"} · normes ${E.ns} / ${E.nm}</span></div></div>
    <div class="grille g-carte" style="margin-top:14px">
      <div class="panneau"><h3>${lib} par province</h3><div id="b-carte" class="graphe"></div>${source(SOURCE_BESOINS)}</div>
      <div class="panneau"><h3>Stock actuel et besoin 2030 (15 plus forts déficits de salles)</h3><div id="b-barres" class="graphe"></div></div>
    </div>` +
    recit(`Les 3 provinces au plus fort déficit (${top.map(t => esc(t.province)).join(", ")}) concentrent ${pct(part3, 0)} du déficit de salles du périmètre.`,
      `La norme de ${E.ns} élèves par salle est une hypothèse (aucune norme écrite trouvée) : passez à 45 ou 60 pour voir la sensibilité. Les déficits ne tiennent pas compte des salles sous paillote ni des écoles fermées pour insécurité.`,
      `Le déficit d'enseignants peut être réduit en partie par redéploiement entre provinces (page Répartition) ; le déficit de salles demande un programme de construction ciblé.`) +
    `<div class="panneau" style="margin-top:14px"><div class="panneau-entete"><h3>Tableau des besoins</h3>${boutonExport("b-exp")}</div><div class="table-cadre" id="b-table"></div>
      ${E.decoupage === "nouveau" ? `<p class="note">En 47 provinces, les 4 provinces issues de Soum et Tapoa affichent la somme de leurs communes (indicatif) ; les totaux DGESS sont dans le découpage ancien.</p>` : ""}</div>` + glossaire();
  $("#b-ind").onchange = e => { E.ind_bes = e.target.value; rafraichir(); };
  carte($("#b-carte"), L, E.ind_bes, { dec, texte: l => `<b>${esc(l.nom)}</b><br>${lib} : ${nf(l[E.ind_bes], dec)}<br>Salles : ${nf(l.salles_total)} → besoin ${nf(l.salles_necessaires_2030)}<br>Enseignants : ${nf(l.maitres_total)} → besoin ${nf(l.maitres_necessaires_2030)}` });
  const t = L.filter(l => Number.isFinite(l.deficit_salles_2030)).sort((a, b) => b.deficit_salles_2030 - a.deficit_salles_2030).slice(0, 15).reverse();
  Plotly.react($("#b-barres"), [
    { type: "bar", orientation: "h", name: "Salles actuelles", y: t.map(l => l.nom), x: t.map(l => l.salles_total), marker: { color: "#9ecae1" }, hovertemplate: "%{y} : %{x:,} salles<extra></extra>" },
    { type: "bar", orientation: "h", name: "Déficit 2030", y: t.map(l => l.nom), x: t.map(l => l.deficit_salles_2030), marker: { color: "#d7301f" }, hovertemplate: "%{y} : %{x:,} salles manquantes<extra></extra>" },
  ], { barmode: "stack", margin: { l: 120, r: 10, t: 30, b: 40 }, legend: { orientation: "h", x: 0, y: 1.0, yanchor: "bottom" }, xaxis: { title: { text: "salles de classe" }, gridcolor: "#eef1f4" }, paper_bgcolor: "rgba(0,0,0,0)", plot_bgcolor: "rgba(0,0,0,0)", separators: ", " }, CONFIG_PLOTLY);
  const cols = [{ k: "nom", t: "Province" }, { k: "region", t: "Région" },
    { k: "eleves_total", t: "Élèves " + D.meta.annee_base, f: v => nf(v) }, { k: "eleves_2030", t: "Élèves 2030", f: v => nf(v), e: v => Number.isFinite(v) ? Math.round(v) : v },
    { k: "couverture_base", t: "Couverture actuelle (%)", f: v => Number.isFinite(v) ? pct(v * 100, 0) : ND, e: v => Number.isFinite(v) ? Math.round(v * 1000) / 10 : v },
    { k: "salles_total", t: "Salles", f: v => nf(v) }, { k: "eps_actuel", t: "Élèves par salle " + D.meta.annee_base, f: v => nf(v, 1), aide: "Norme du primaire : " + E.ns + " (hypothèse)" }, { k: "salles_necessaires_2030", t: "Salles nécessaires 2030", f: v => nf(v) }, { k: "deficit_salles_2030", t: "Déficit salles", f: v => nf(v) },
    { k: "maitres_total", t: "Maîtres", f: v => nf(v) }, { k: "epm_actuel", t: "Ratio élève/maître " + D.meta.annee_base, f: v => nf(v, 1), aide: "Norme : " + E.nm + " élèves par maître" }, { k: "maitres_necessaires_2030", t: "Maîtres nécessaires 2030", f: v => nf(v) }, { k: "deficit_maitres_2030", t: "Déficit maîtres", f: v => nf(v) },
    { k: "deficit_salles_2030_pour_1000", t: "Déficit salles / 1 000 enfants", f: v => nf(v, 2) }];
  tableau($("#b-table"), cols, L, { tri: { k: "deficit_salles_2030", s: -1 }, surClic: c => selectionner(c) });
  $("#b-exp").onclick = () => exporterCSV("besoins_2030", cols, L);
}

/* ============================================================== PAGE : PRIORITÉS */
const PRESELECTIONS = {
  "Par défaut": null,
  "Encadrement d'abord": { C1_eleves_par_maitre: 35, C2_eleves_par_salle: 15, C3_ecoles_sans_latrines: 5, C4_ecoles_sans_eau: 5, C5_deficit_salles_2030: 20, C7_croissance_6_11_2030: 10, C8_couverture_inverse: 10 },
  "Conditions d'accueil (eau, latrines)": { C1_eleves_par_maitre: 10, C2_eleves_par_salle: 15, C3_ecoles_sans_latrines: 25, C4_ecoles_sans_eau: 25, C5_deficit_salles_2030: 10, C7_croissance_6_11_2030: 5, C8_couverture_inverse: 10 },
  "Accès des enfants non scolarisés": { C1_eleves_par_maitre: 10, C2_eleves_par_salle: 5, C3_ecoles_sans_latrines: 5, C4_ecoles_sans_eau: 5, C5_deficit_salles_2030: 20, C7_croissance_6_11_2030: 15, C8_couverture_inverse: 40 },
  "Égalité des critères": Object.fromEntries(D.criteres.map(c => [c.critere, Math.round(100 / D.criteres.length)])),
};
function pagePriorites() {
  const R = resultats();
  const L = lignesAffichees(R.besoins);
  const tot = D.criteres.reduce((s, c) => s + E["w_" + c.critere], 0);
  const p = $("#p-priorites");
  const actif = Object.entries(PRESELECTIONS).find(([n, w]) => w ? D.criteres.every(c => E["w_" + c.critere] === (w[c.critere] ?? 0)) : D.criteres.every(c => E["w_" + c.critere] === DEF["w_" + c.critere]))?.[0];
  const sel = E.province ? R.parCode[E.province] : null;
  p.innerHTML = enTete("Quelles provinces traiter en premier, et pourquoi ?",
    `Classement PROMETHEE II sur ${D.criteres.length} critères : chaque province est comparée à chacune des autres, critère par critère. Réglez l'importance des critères : le classement se recalcule aussitôt. Périmètre affiché : <b>${libellePerimetre()}</b> (le classement est toujours calculé sur les 45 provinces).`) +
    `<div class="grille g-carte">
      <div class="panneau"><h3>Importance des critères (poids)</h3>
        <div class="preselections">${Object.keys(PRESELECTIONS).map(n => `<button data-pre="${esc(n)}" class="${n === actif ? "actif" : ""}">${esc(n)}</button>`).join("")}</div>
        ${D.criteres.map(c => `<div class="poids-ligne"><span>${esc(libCritere(c))}</span><input type="range" aria-label="Poids : ${esc(libCritere(c))}" min="0" max="50" step="1" data-w="${c.critere}" value="${E["w_" + c.critere]}"><output>${tot ? nf(100 * E["w_" + c.critere] / tot, 0) : 0} %</output></div>`).join("")}
        <p class="note">Poids par défaut : ${D.criteres.map(c => Math.round(c.poids * 100) + " %").join(", ")} ${badge("HYPOTHÈSE")} à ajuster par les décideurs. Les poids sont ramenés à 100 %.</p>
      </div>
      <div class="panneau"><h3>${sel ? "Pourquoi " + esc(sel.province) + " est au rang " + sel.rang_calc : "Sélectionnez une province (carte ou tableau)"}</h3><div id="pr-contrib" class="graphe bas"></div>
        <p class="note">Contribution de chaque critère au flux net : à droite, le critère pousse la province vers le haut du classement.</p></div>
    </div>
    <div class="grille g-carte" style="margin-top:14px">
      <div class="panneau"><h3>Priorité des provinces (flux net PROMETHEE II)</h3><div id="pr-carte" class="graphe"></div>${source(SOURCE_BESOINS)}</div>
      <div class="panneau"><h3>Les 15 provinces les plus prioritaires</h3><div id="pr-barres" class="graphe"></div><p class="note">Barres rouges : « priorité robuste » (top 10 dans 95 % des tirages de poids).</p></div>
    </div>
    <div class="panneau" style="margin-top:14px"><div class="panneau-entete"><h3>Classement complet et robustesse</h3>${boutonExport("pr-exp")}</div><div class="table-cadre" id="pr-table"></div>
      ${notePli(`Robustesse : 2 000 tirages de poids à ±${Math.round(D.meta.variation_mc * 100)} % autour des poids par défaut (Monte-Carlo). Elle n'est affichée qu'avec les paramètres par défaut.`, "Comment lire la robustesse")}</div>` + glossaire();
  p.querySelectorAll("[data-w]").forEach(i => i.oninput = e => { E["w_" + e.target.dataset.w] = Number(e.target.value); rafraichir(); });
  p.querySelectorAll("[data-pre]").forEach(b => b.onclick = () => { const w = PRESELECTIONS[b.dataset.pre]; D.criteres.forEach(c => { E["w_" + c.critere] = w ? (w[c.critere] ?? 0) : DEF["w_" + c.critere]; }); rafraichir(); });
  carte($("#pr-carte"), L.map(l => Object.assign(l, { phi: l.phi_calc })), "phi", { echelle: ECHELLE_PHI, zmid: 0, dec: 3, titreEchelle: "flux net", texte: l => `<b>${esc(l.nom)}</b><br>Rang ${l.rang_calc} / 45 · flux net ${nf(l.phi_calc, 3)}` });
  barres($("#pr-barres"), L.map(l => Object.assign(l, { phi: l.phi_calc })), "phi", { dec: 3, titreX: "flux net", couleur: l => (reglagesParDefaut() && l.rang_p95 !== null && l.rang_p95 <= 10) ? "#b2182b" : "#1e5288" });
  if (sel) {
    const c = D.criteres.map(k => [libCritere(k), sel.contributions[k.critere]]).sort((a, b) => a[1] - b[1]);
    Plotly.react($("#pr-contrib"), [{ type: "bar", orientation: "h", y: c.map(x => x[0]), x: c.map(x => x[1]), marker: { color: c.map(x => x[1] >= 0 ? "#b2182b" : "#2166ac") }, hovertemplate: "%{y} : %{x:.3f}<extra></extra>" }],
      { margin: { l: 10, r: 10, t: 6, b: 30 }, yaxis: { automargin: true, tickfont: { size: 11 } }, xaxis: { zeroline: true, gridcolor: "#eef1f4" }, paper_bgcolor: "rgba(0,0,0,0)", plot_bgcolor: "rgba(0,0,0,0)" }, CONFIG_PLOTLY);
  } else { $("#pr-contrib").innerHTML = '<p class="note" style="padding:20px">Cliquez sur une province pour voir le détail de son classement.</p>'; }
  const cols = [{ k: "rang_calc", t: "Rang", f: v => nf(v) }, { k: "nom", t: "Province" }, { k: "region", t: "Région" }, { k: "phi_calc", t: "Flux net", f: v => nf(v, 3) },
    { k: "statut", t: "Statut", html: l => statutRobustesse(l), x: l => statutRobustesse(l) },
    { k: "rang_p05", t: "Rang (5 % des tirages)", f: v => reglagesParDefaut() ? nf(v) : ND }, { k: "rang_p95", t: "Rang (95 %)", f: v => reglagesParDefaut() ? nf(v) : ND },
    ...D.criteres.map(c => ({ k: c.critere, t: libCritere(c), f: v => nf(v, 1) }))];
  tableau($("#pr-table"), cols, L, { tri: { k: "rang_calc", s: 1 }, surClic: c => selectionner(c) });
  $("#pr-exp").onclick = () => exporterCSV("priorites_promethee", cols, L);
}

/* ============================================================== PAGE : RÉPARTITION */
const REGLES = { equite: "Équité : réduire d'abord le ratio le plus élevé", priorite: "Priorité multicritère : combler les déficits dans l'ordre du classement", proportionnel: "Au prorata des déficits" };
const REGLES_AIDE = {
  equite: "Chaque salle (ou enseignant) va, une à une, à la province dont le ratio élèves par salle (ou par maître) en 2030 est le plus élevé. Le ratio maximal entre provinces est ainsi le plus bas possible. Rien n'est retiré aux autres provinces : le stock actuel sert de plancher.",
  priorite: "Les déficits sont comblés dans l'ordre du classement multicritère (page Priorités), jusqu'à épuisement du budget. Une province très chargée mais peu prioritaire sur les autres critères peut rester sans dotation.",
  proportionnel: "Le budget est partagé au prorata des déficits 2030 de chaque province. Chaque province reçoit une part, mais les écarts entre provinces se réduisent moins vite qu'avec la règle d'équité.",
};
function pageRepartition() {
  const R = resultats(), f = codesFiltres();
  const base = R.besoins.filter(r => f.has(r.adm2_pcode_old));
  const xs = Calc.repartir(base, E.regle, E.bs, "salles_total", "salles_necessaires_2030", "rang_calc");
  const xm = Calc.repartir(base, E.regle, E.bm, "maitres_total", "maitres_necessaires_2030", "rang_calc");
  const rows = base.map((l, i) => Object.assign({}, l, {
    salles_attribuees: xs[i], maitres_attribues: xm[i],
    eps_avant: l.eleves_2030 / l.salles_total, eps_apres: l.eleves_2030 / (l.salles_total + xs[i]),
    epm_avant: l.eleves_2030 / l.maitres_total, epm_apres: l.eleves_2030 / (l.maitres_total + xm[i]),
    deficit_salles_restant: Math.max(0, l.salles_necessaires_2030 - l.salles_total - xs[i]),
    deficit_maitres_restant: Math.max(0, l.maitres_necessaires_2030 - l.maitres_total - xm[i]) }));
  const idx = Object.fromEntries(rows.map(r => [r.adm2_pcode_old, r]));
  const L = lignesAffichees(R.besoins.filter(r => idx[r.adm2_pcode_old]).map(r => idx[r.adm2_pcode_old]), ["salles_attribuees", "maitres_attribues", "deficit_salles_restant", "deficit_maitres_restant", "salles_total", "maitres_total"]);
  const maxAv = Math.max(...rows.map(r => r.eps_avant)), maxAp = Math.max(...rows.map(r => r.eps_apres));
  const sousNormeAv = rows.filter(r => r.eps_avant <= E.ns).length, sousNormeAp = rows.filter(r => r.eps_apres <= E.ns).length;
  const dsT = somme(rows, "deficit_salles_2030"), dmT = somme(rows, "deficit_maitres_2030");
  // élèves au-delà de la norme d'élèves par salle (somme sur les provinces), avant et après la répartition
  const auDela = k => rows.reduce((s, r) => s + Math.max(0, r.eleves_2030 - E.ns * (r.salles_total + (k ? r.salles_attribuees : 0))), 0);
  const auDelaAv = auDela(false), auDelaAp = auDela(true);
  const sansDotation = rows.filter(r => r.rang_calc <= 10 && r.salles_attribuees === 0 && !(r.deficit_salles_2030 > 0)).map(r => Object.assign({ eps_avant_actuel: r.eleves_total / r.salles_total }, r)).sort((a, b) => a.rang_calc - b.rang_calc);
  const p = $("#p-repartition");
  p.innerHTML = enTete("Avec un budget donné, combien de salles et d'enseignants affecter à chaque province ?",
    `Indiquez le nombre de salles à construire et d'enseignants à affecter d'ici 2030, puis la règle de répartition. Le calcul porte sur le périmètre <b>${libellePerimetre()}</b>. <span class="etiquette ESTIMATION">MODÈLE SIMPLIFIÉ : SANS COÛTS</span>`) +
    `<div class="panneau"><div class="controles">
      <label>Salles à construire <input type="number" id="rp-bs" min="0" step="100" value="${E.bs}" style="width:100px"></label>
      <label>Enseignants à affecter <input type="number" id="rp-bm" min="0" step="100" value="${E.bm}" style="width:100px"></label>
      <label>Règle <select id="rp-regle">${Object.entries(REGLES).map(([k, v]) => `<option value="${k}" ${k === E.regle ? "selected" : ""}>${v}</option>`).join("")}</select></label>
      <span class="note">Déficit total du périmètre (${libellePerimetre()}) : ${nf(dsT)} salles, ${nf(dmT)} enseignants. Budget par défaut : ${BUDGET_REF.pct} % des déficits nationaux (${nf(BUDGET_REF.salles)} salles, ${nf(BUDGET_REF.maitres)} enseignants).</span></div>
      <p class="note"><b>Règle choisie :</b> ${REGLES_AIDE[E.regle]}</p></div>
    <div class="grille g4" style="margin-top:14px">
      ${kpi("Élèves par salle, province la plus chargée", nf(maxAv, 1) + " → " + nf(maxAp, 1), "en 2030, avant → après", "CALCUL", "accent")}
      ${kpi("Élèves au-delà de la norme (salles)", nf(auDelaAv) + " → " + nf(auDelaAp), "en 2030 ; provinces à la norme de " + E.ns + " : " + (sousNormeAp > sousNormeAv ? sousNormeAv + " → " + sousNormeAp : sousNormeAv + ", aucune de plus, mais l'écart maximal baisse de " + nf(maxAv, 1) + " à " + nf(maxAp, 1)), "CALCUL")}
      ${kpi("Déficit de salles comblé", pct(dsT ? 100 * (dsT - somme(rows, "deficit_salles_restant")) / dsT : null, 0), nf(somme(rows, "deficit_salles_restant")) + " salles restent à trouver", "CALCUL", "ok")}
      ${kpi("Déficit d'enseignants comblé", pct(dmT ? 100 * (dmT - somme(rows, "deficit_maitres_restant")) / dmT : null, 0), nf(somme(rows, "deficit_maitres_restant")) + " enseignants restent à trouver", "CALCUL", "ok")}
    </div>
    <div class="grille g-carte" style="margin-top:14px">
      <div class="panneau"><h3>Salles attribuées par province</h3><div id="rp-carte" class="graphe"></div>${source(SOURCE_BESOINS)}</div>
      <div class="panneau"><h3>Élèves par salle en 2030, avant et après (15 plus chargées)</h3><div id="rp-barres" class="graphe"></div></div>
    </div>` +
    recit(`Avec ${nf(E.bs)} salles, le ratio de la province la plus chargée passe de ${nf(maxAv, 1)} à ${nf(maxAp, 1)} élèves par salle.`,
      `La règle « équité » donne la meilleure réduction des écarts ; la règle « priorité » suit le classement multicritère et peut laisser des provinces très chargées si elles sont moins prioritaires sur les autres critères. Le coût et la faisabilité (sécurité, foncier) ne sont pas encore modélisés.`,
      (sansDotation.length ? `${sansDotation.map(r => esc(r.province) + " (rang " + r.rang_calc + ", " + nf(r.eps_avant_actuel, 1) + " élèves par salle aujourd'hui)").join(", ")} : parmi les 10 premières du classement, mais aucune salle attribuée, faute de déficit de salles ; priorité à traiter par les autres leviers (eau, latrines, enseignants, scolarisation). ` : "") +
      `Comparer les trois règles avec le même budget, puis retenir la répartition qui respecte à la fois l'équité et les priorités politiques.`) +
    `<div class="panneau" style="margin-top:14px"><div class="panneau-entete"><h3>Tableau de répartition</h3>${boutonExport("rp-exp")}</div><div class="table-cadre" id="rp-table"></div></div>` + glossaire();
  $("#rp-bs").onchange = e => { E.bs = Math.max(0, Math.round(Number(e.target.value) || 0)); rafraichir(); };
  $("#rp-bm").onchange = e => { E.bm = Math.max(0, Math.round(Number(e.target.value) || 0)); rafraichir(); };
  $("#rp-regle").onchange = e => { E.regle = e.target.value; rafraichir(); };
  carte($("#rp-carte"), L, "salles_attribuees", { dec: 0, texte: l => `<b>${esc(l.nom)}</b><br>Salles attribuées : ${nf(l.salles_attribuees)}<br>Enseignants attribués : ${nf(l.maitres_attribues)}<br>Élèves/salle 2030 : ${nf(l.eps_avant, 1)} → ${nf(l.eps_apres, 1)}` });
  const t = L.filter(l => Number.isFinite(l.eps_avant)).sort((a, b) => b.eps_avant - a.eps_avant).slice(0, 15).reverse();
  Plotly.react($("#rp-barres"), [
    { type: "bar", orientation: "h", name: "Avant", y: t.map(l => l.nom), x: t.map(l => l.eps_avant), marker: { color: "#fc8d59" }, hovertemplate: "%{y} : %{x:.1f} avant<extra></extra>" },
    { type: "bar", orientation: "h", name: "Après", y: t.map(l => l.nom), x: t.map(l => l.eps_apres), marker: { color: "#1e5288" }, hovertemplate: "%{y} : %{x:.1f} après<extra></extra>" },
  ], { barmode: "group", margin: { l: 120, r: 10, t: 30, b: 40 }, legend: { orientation: "h", x: 0, y: 1.0, yanchor: "bottom" }, xaxis: { title: { text: "élèves par salle en 2030" }, gridcolor: "#eef1f4" }, paper_bgcolor: "rgba(0,0,0,0)", plot_bgcolor: "rgba(0,0,0,0)",
    shapes: [{ type: "line", x0: E.ns, x1: E.ns, yref: "paper", y0: 0, y1: 1, line: { color: "#c0392b", dash: "dash", width: 1.5 } }] }, CONFIG_PLOTLY);
  const cols = [{ k: "nom", t: "Province" }, { k: "region", t: "Région" }, { k: "rang_calc", t: "Rang de priorité", f: v => nf(v) },
    { k: "salles_total", t: "Salles", f: v => nf(v) }, { k: "deficit_salles_2030", t: "Déficit salles 2030", f: v => nf(v) }, { k: "salles_attribuees", t: "Salles attribuées", f: v => nf(v) },
    { k: "eps_avant", t: "Élèves/salle avant", f: v => nf(v, 1) }, { k: "eps_apres", t: "Élèves/salle après", f: v => nf(v, 1) },
    { k: "maitres_total", t: "Maîtres", f: v => nf(v) }, { k: "deficit_maitres_2030", t: "Déficit maîtres 2030", f: v => nf(v) }, { k: "maitres_attribues", t: "Enseignants attribués", f: v => nf(v) },
    { k: "epm_avant", t: "Ratio élève/maître avant", f: v => nf(v, 1) }, { k: "epm_apres", t: "Ratio élève/maître après", f: v => nf(v, 1) }];
  tableau($("#rp-table"), cols, L, { tri: { k: "salles_attribuees", s: -1 }, surClic: c => selectionner(c) });
  $("#rp-exp").onclick = () => exporterCSV("repartition_" + E.regle + "_" + E.bs + "salles_" + E.bm + "enseignants", cols, L);
}

/* ============================================================== PAGE : COMMUNES */
const IND_COM = {
  eleves_par_salle: ["Élèves par salle", 1, "OBSERVATION"], eleves_par_enseignant: ["Ratio élève/maître", 1, "OBSERVATION"],
  deficit_salles_2030_maintien: ["Déficit de salles 2030 (maintien)", 0, "ESTIMATION"], deficit_enseignants_2030_maintien: ["Déficit d'enseignants 2030 (maintien)", 0, "ESTIMATION"],
  deficit_salles_2030_couverture_totale: ["Déficit de salles 2030 (tous les enfants scolarisés)", 0, "ESTIMATION"],
  hors_ecole_6_11_pct: ["Enfants de 6-11 ans hors de l'école (%)", 1, "OBSERVATION"], part_salles_sous_paillote_pct: ["Salles sous paillote (%)", 1, "OBSERVATION"],
};
function pageCommunes() {
  const f = codesFiltres();
  let C = D.communes.filter(c => f.has(c.adm2_pcode_old));
  if (E.decoupage === "nouveau" && E.region) C = C.filter(c => c.adm1_pcode === E.region);
  if (E.province) C = C.filter(c => c.adm2_pcode_old === E.province);
  const [lib, dec, nat] = IND_COM[E.ind_com];
  // Les déficits communaux de la base sont des soldes signés (négatif = excédent de salles ou d'enseignants) : on affiche,
  // on additionne et on exporte la partie positive (besoin à couvrir), comme le fichier de résultats de référence.
  const positif = c => Object.fromEntries(Object.keys(IND_COM).filter(k => k.startsWith("deficit")).map(k => [k, Number.isFinite(c[k]) ? Math.max(0, c[k]) : c[k]]));
  const L = C.map(c => Object.assign({ code: c.adm3_pcode, nom: c.adm3_name, estimee: /^commune estimée/i.test(String(c.niveau_offre || "")),
    // contrôle de vraisemblance : plus de 150 élèves par salle ou par enseignant = valeur source à vérifier (saisie, rattachement)
    suspect: (c.eleves_par_salle > 150) || (c.eleves_par_enseignant > 150),
    // chiffres publiés par l'annuaire INSD avant calage sur les totaux DGESS (élèves bruts ÷ enseignants ou salles bruts)
    rem_publie: c.enseignants_brut_annuaire > 0 ? arrondi1(c.eleves_brut_annuaire / c.enseignants_brut_annuaire) : null,
    eps_publie: c.salles_brut_annuaire > 0 ? arrondi1(c.eleves_brut_annuaire / c.salles_brut_annuaire) : null,
    // une absence (N/D) n'est jamais un « petit effectif »
    _parentNom: "province " + (P45[c.adm2_pcode_old]?.province || ""),
    _parent: (pr => pr ? { eleves_par_salle: pr.eleves_total / pr.salles_total, eleves_par_enseignant: pr.eleves_total / pr.maitres_total,
      deficit_salles_2030_maintien: pr.deficit_salles_2030, deficit_enseignants_2030_maintien: pr.deficit_maitres_2030 } : null)(P45[c.adm2_pcode_old]),
    motifND: String(c.niveau_offre || "").includes("N/D") ? c.niveau_offre : (c.drapeau_incoherence_offre || ""),
    petit: (Number.isFinite(c.enseignants_ensemble) && c.enseignants_ensemble < 5) || (Number.isFinite(c.salles_ensemble) && c.salles_ensemble < 5) }, c, positif(c)));
  // Décision : 0 élève publié alors que des salles ou des maîtres sont publiés = ratio N/D (valeur publiée à confirmer), jamais 0.
  // Élèves publiés sans aucune salle ni aucun maître (Kain) = « à vérifier », chiffre gardé.
  L.forEach(l => {
    if (l.eleves_ensemble === 0 && (l.salles_ensemble > 0 || l.enseignants_ensemble > 0)) {
      l.zero = `0 élève inscrit pour ${nf(l.salles_ensemble)} salles et ${nf(l.enseignants_ensemble)} maîtres publiés : valeur publiée à confirmer`;
      if (l.salles_ensemble > 0) { l.eleves_par_salle = null; l.eps_publie = null; }
      if (l.enseignants_ensemble > 0) { l.eleves_par_enseignant = null; l.rem_publie = null; }
      l.motifND = l.zero; l._parent = null;
    }
    if (l.eleves_ensemble > 0 && l.salles_ensemble === 0 && l.enseignants_ensemble === 0) {
      l.suspect = true; l.drapeau_incoherence_offre = `${nf(l.eleves_ensemble)} élèves publiés sans aucune salle ni aucun maître : valeur à vérifier dans la source`;
    }
  });
  const nZero = L.filter(l => l.zero).length;
  const nSuspect = L.filter(l => l.suspect).length;
  const est = L.filter(l => l.estimee).length;
  const p = $("#p-communes");
  const vals = L.filter(l => Number.isFinite(l[E.ind_com]));
  const top = vals.filter(l => !l.suspect).sort((a, b) => b[E.ind_com] - a[E.ind_com]).slice(0, 3);
  p.innerHTML = enTete("Dans quelles communes implanter les nouvelles salles ?",
    `Niveau le plus fin disponible : 351 communes, avec l'offre des annuaires régionaux (2023-24) et la demande 2030. Périmètre : <b>${libellePerimetre()}${E.province ? " · province " + esc(P45[E.province]?.province) : ""}</b>. Les valeurs communales sont calculées avec les normes de référence (50 / 50). <span class="etiquette ESTIMATION">RÉPARTITION INDICATIVE</span> La demande 2030 et les ratios calés sur les totaux DGESS sont répartis depuis la province : ils indiquent un ordre de grandeur, pas un chiffre publié.`) +
    `<div class="panneau"><div class="controles"><label>Indicateur <select id="c-ind">${Object.entries(IND_COM).map(([k, v]) => `<option value="${k}" ${k === E.ind_com ? "selected" : ""}>${v[0]}</option>`).join("")}</select></label> ${badge(nat)}
      <span class="note">${est} commune(s) sur ${L.length} ont une offre ESTIMÉE (contour noir épais) : valeur de la province répartie au prorata de la population, avec une fourchette.</span></div></div>
    <div class="grille g4" style="margin-top:14px">
      ${kpi("Communes", nf(L.length), est ? est + " estimée(s)" : "toutes mesurées", "")}
      ${kpi(E.ind_com.startsWith("deficit") ? "Total du périmètre" : "Médiane des communes", nf(E.ind_com.startsWith("deficit") ? somme(L, E.ind_com) : mediane(vals.map(v => v[E.ind_com])), dec), lib, nat, "accent")}
      ${kpi("Commune la plus touchée", top[0] ? esc(top[0].nom) : ND, (top[0] ? nf(top[0][E.ind_com], dec) : "") + (nSuspect ? ` · ${nSuspect} valeur(s) à vérifier écartée(s)` : ""), nat)}
      ${kpi("Communes prioritaires du ministère", nf(L.filter(l => l.commune_prioritaire_dgess === true).length), "liste DGESS 2017-2021", "OBSERVATION")}
    </div>
    <div class="grille g-carte" style="margin-top:14px">
      <div class="panneau"><h3>${lib} par commune</h3><div id="c-carte" class="graphe haut"></div><p class="note">Cliquez sur une commune pour la retrouver dans le tableau.</p>${source("Source : INSD, annuaires statistiques régionaux 2024 (2023-24) ; INSD, projections ; limites COD-AB (OCHA/HDX).")}</div>
      <div class="panneau"><h3>${lib} : 15 communes les plus élevées</h3><div id="c-barres" class="graphe haut"></div></div>
    </div>
    <div class="panneau" style="margin-top:14px"><div class="panneau-entete"><h3>Tableau des communes</h3><input id="c-rech" placeholder="Rechercher une commune…" aria-label="Rechercher une commune" style="padding:6px 8px;border:1px solid var(--ligne);border-radius:6px">${boutonExport("c-exp")}</div><div class="table-cadre" id="c-table"></div>
      ${notePli(`Mention « 0 élève publié » (${nZero} communes) : la source donne 0 élève alors que des salles ou des maîtres sont publiés ; le ratio est affiché N/D (jamais 0) et la valeur publiée reste à confirmer. ` + "Barres grises et mention « à vérifier » : plus de 150 élèves par salle ou par maître ; selon les cas, effectif publié très élevé (afflux de déplacés internes possible) ou ratio amplifié par le calage sur les totaux DGESS (le détail s'affiche au survol). La valeur est gardée mais signalée et écartée des indicateurs de tête. Drapeaux : population estimée (commune créée après 2019) ; prorata fragile (projection 2030 répartie au prorata de 2019). Fourchettes des communes estimées dans l'export CSV. Les ratios communaux sont calés sur les totaux DGESS de la province ; le ratio publié par l'annuaire INSD figure à côté. « Petits effectifs » : moins de 5 maîtres ou 5 salles, ratio très sensible à une unité. Namissiguima (Yatenga) : scénario « maintien » 2030 en N/D, à confirmer auprès de la DGESS (choix validé). Madjoari : salles non publiées, N/D. Aucune valeur absente n'est estimée : le survol d'un N/D donne, pour information, la valeur de la province (niveau supérieur).", "Lire les avertissements")}</div>` + glossaire();
  $("#c-ind").onchange = e => { E.ind_com = e.target.value; rafraichir(); };
  carte($("#c-carte"), L, E.ind_com, { geo: G.communes, dec, contour: "#1d2733", largeurs: L.filter(l => Number.isFinite(l[E.ind_com])).map(l => l.estimee ? 1.3 : 0.3),
    texte: l => `<b>${esc(l.nom)}</b> (${esc(l.province_ancienne)})<br>${lib} : ${nf(l[E.ind_com], dec)}${l.estimee ? "<br><i>offre estimée</i>" : ""}${l.suspect ? "<br><b>valeur à vérifier</b>" + (l.drapeau_incoherence_offre ? " : " + esc(l.drapeau_incoherence_offre) : "") : ""}`,
    surClic: c => { const r = $("#c-rech"); r.value = L.find(l => l.code === c)?.nom || ""; r.dispatchEvent(new Event("input")); } });
  barres($("#c-barres"), L, E.ind_com, { dec, couleur: l => l.suspect ? "#9aa5b1" : l.estimee ? "#b7791f" : "#1e5288" });
  const cols = [{ k: "nom", t: "Commune" }, { k: "province_ancienne", t: "Province" }, { k: "region_nouvelle", t: "Région (nouvelle)" },
    { k: "niveau_offre", t: "Offre", html: l => (l.estimee ? '<span class="statut estimee">estimée</span>' : "mesurée") + (l.petit ? ' <span class="statut estimee" title="Moins de 5 maîtres ou 5 salles : ratio très sensible à une unité">petits effectifs</span>' : "") + (l.suspect ? ` <span class="statut confirmer" title="${esc(l.drapeau_incoherence_offre || "Plus de 150 élèves par salle ou par maître : valeur à vérifier")}">à vérifier</span>` : "") + (l.zero ? ` <span class="statut confirmer" title="${esc(l.zero)}">0 élève publié</span>` : ""), x: l => l.niveau_offre + (l.zero ? " ; 0 élève publié" : "") + (l.petit ? " ; petits effectifs" : "") + (l.suspect ? " ; à vérifier" : "") },
    { k: "eleves_ensemble", t: "Élèves", f: v => nf(v) }, { k: "salles_ensemble", t: "Salles", f: v => nf(v) }, { k: "enseignants_ensemble", t: "Enseignants", f: v => nf(v) },
    { k: "eleves_par_salle", t: "Élèves par salle", f: v => nf(v, 1), aide: "Après calage sur les totaux DGESS de la province" }, { k: "eps_publie", t: "Élèves par salle publié (INSD)", f: v => nf(v, 1), aide: "Chiffres de l'annuaire INSD, avant calage" },
    { k: "eleves_par_enseignant", t: "Ratio élève/maître", f: v => nf(v, 1), aide: "Après calage sur les totaux DGESS de la province" }, { k: "rem_publie", t: "Ratio élève/maître publié (INSD)", f: v => nf(v, 1), aide: "Chiffres de l'annuaire INSD, avant calage" },
    { k: "pop_6_11_2030", t: "6-11 ans en 2030 (indicatif)", f: v => nf(v) }, { k: "deficit_salles_2030_maintien", t: "Déficit salles 2030 (indicatif)", f: v => nf(v) },
    { k: "deficit_salles_2030_couverture_totale", t: "Déficit salles, tous scolarisés (indicatif)", f: v => nf(v) }, { k: "hors_ecole_6_11_pct", t: "Hors école 6-11 ans (%)", f: v => nf(v, 1) }];
  const colsExp = cols.concat(Object.keys(D.communes[0] || {}).filter(k => k.endsWith("_bas") || k.endsWith("_haut")).map(k => ({ k, t: k })));
  const rendre = q => tableau($("#c-table"), cols, q ? L.filter(l => (l.nom + " " + l.province_ancienne).toLowerCase().includes(q.toLowerCase())) : L, { tri: { k: E.ind_com, s: -1 } });
  rendre("");
  $("#c-rech").oninput = e => rendre(e.target.value);
  $("#c-exp").onclick = () => exporterCSV("communes_" + E.ind_com, colsExp, L);
}

/* ============================================================== PAGE : TROIS CYCLES */
/* Préscolaire et post-primaire : les sources ne publient l'offre (salles, classes, équipements) qu'au niveau de la RÉGION.
 * Résultats affichés par région (13, ancien découpage) ; aucune valeur régionale n'est attribuée aux provinces. */
const sansAccent = t => String(t || "").normalize("NFD").replace(/[\u0300-\u036f]/g, "").toUpperCase().replace(/[^A-Z]/g, "");
function pageCycles() {
  if (E.cycle !== "prescolaire" && E.cycle !== "post_primaire") E.cycle = "prescolaire";
  const CY = {
    prescolaire: ["Préscolaire (3-5 ans)", D.prescolaire_regions || [], "salles d'activités", "norme : 35 enfants par salle d'activités"],
    post_primaire: ["Post-primaire (12-15 ans)", D.post_primaire_regions || [], "classes", "norme : 70 élèves par classe"],
  };
  const [lib, rows, unite, norme] = CY[E.cycle];
  const geoId = Object.fromEntries(G.regions13.features.map(f => [sansAccent(f.id), f.id]));
  const regFiltre = E.decoupage === "ancien" && E.region ? sansAccent(E.region) : "";
  const L = rows.map(r => Object.assign({}, r, { code: geoId[sansAccent(r.region_ancienne)], nom: geoId[sansAccent(r.region_ancienne)] || titreCase(r.region_ancienne),
    inv: Number.isFinite(r.rang) ? rows.length + 1 - r.rang : null })).filter(r => !regFiltre || sansAccent(r.region_ancienne) === regFiltre);
  const classe = L.filter(l => Number.isFinite(l.rang)).sort((a, b) => a.rang - b.rang);
  const p = $("#p-cycles");
  p.innerHTML = enTete("Les priorités changent-elles du préscolaire au post-primaire ?",
    `Pour ces deux cycles, les sources publient l'offre seulement au niveau de la région : les résultats sont donc donnés par région (13, ancien découpage). Aucune valeur régionale n'est attribuée aux provinces, qui restent en N/D. Calcul avec les normes et poids de référence.${E.region && E.decoupage !== "ancien" ? " Le filtre de région du nouveau découpage ne s'applique pas à cette page." : ""}`) +
    `<div class="panneau"><div class="bascule" id="cy-b">${Object.entries(CY).map(([k, v]) => `<button data-c="${k}" class="${k === E.cycle ? "actif" : ""}">${v[0].split(" (")[0]}</button>`).join("")}</div></div>
    <div class="grille g3" style="margin-top:14px">
      ${kpi("Régions les plus prioritaires", classe.slice(0, 3).map(t => esc(t.nom)).join(", ") || ND, lib, "CALCUL", "accent")}
      ${kpi("Déficit 2030 du périmètre", nf(somme(L, "deficit_2030")), unite + " ; " + norme, "ESTIMATION")}
      ${kpi("Niveau de détail", "Région", "les provinces sont en N/D pour ce cycle", "")}
    </div>
    <div class="grille g-carte" style="margin-top:14px">
      <div class="panneau"><h3>Rang de priorité par région · ${esc(lib)}</h3><div id="cy-carte" class="graphe"></div>${source("Source : DGESS (annuaires et tableaux de bord du préscolaire et du post-primaire) ; INSD (projections).")}</div>
      <div class="panneau"><div class="panneau-entete"><h3>Classement des régions · ${esc(lib.split(" (")[0])}</h3>${boutonExport("cy-exp")}</div><div class="table-cadre" id="cy-table"></div></div>
    </div>` + glossaire();
  p.querySelectorAll("[data-c]").forEach(b => b.onclick = () => { E.cycle = b.dataset.c; rafraichir(); });
  carte($("#cy-carte"), L, "inv", { geo: G.regions13, echelle: ECHELLE_BESOIN, dec: 0, titreEchelle: "priorité",
    texte: l => `<b>${esc(l.nom)}</b><br>Rang ${nf(l.rang)} / ${rows.length}<br>Déficit 2030 : ${nf(l.deficit_2030)} ${unite}`, surClic: () => {} });
  const cols = [{ k: "rang", t: "Rang", f: v => nf(v) }, { k: "nom", t: "Région" }, { k: "eleves_2030", t: "Élèves attendus en 2030", f: v => nf(v) },
    { k: "stock", t: "Stock actuel (" + unite + ")", f: v => nf(v) }, { k: "besoin_2030", t: "Besoin 2030", f: v => nf(v) }, { k: "deficit_2030", t: "Déficit 2030", f: v => nf(v) },
    { k: "deficit_2030_pour_1000", t: "Déficit pour 1 000 enfants", f: v => nf(v, 2) }];
  tableau($("#cy-table"), cols, L, { tri: { k: "rang", s: 1 } });
  $("#cy-exp").onclick = () => exporterCSV("cycles_" + E.cycle + "_regions", cols, L);
}

/* ============================================================== PAGE : GUIDE ET MÉTHODE */
function pageMethode() {
  const p = $("#p-methode");
  const fia = D.fiabilite.filter(x => x.methode === "demographique");
  p.innerHTML = enTete("Comment utiliser ce tableau de bord, et comment les résultats sont-ils obtenus ?", "Guide d'utilisation en quatre points, puis sources, formules, règles de qualité et limites.") +
    `<div class="guide">
      <div class="panneau"><h3>${ico("accueil")} 1. Naviguer</h3><ol>
        <li>Les onglets suivent l'ordre d'une décision : situation actuelle (Diagnostic), besoins 2030, provinces à traiter d'abord (Priorités), partage d'un budget (Répartition), implantation fine (Communes), puis préscolaire et post-primaire par région (Trois cycles).</li>
        <li>Choisissez le découpage, une région ou une province dans les <b>Filtres</b> (à gauche ; sur téléphone, bouton « Filtres et paramètres »). Le choix s'applique à toutes les pages.</li>
        <li>Un clic sur une province, sur la carte ou dans un tableau, la sélectionne partout ; un second clic la désélectionne.</li></ol></div>
      <div class="panneau"><h3>${ico("info")} 2. Comprendre</h3><ul>
        <li>Chaque page répond à une question écrite en tête, puis donne trois encadrés : l'essentiel, vigilance, pour décider.</li>
        <li>Chaque chiffre porte sa nature : ${badge("OBSERVATION")} ${badge("CALCUL")} ${badge("ESTIMATION")} ${badge("HYPOTHÈSE")} ${badge("NORME")}. « N/D » signale une donnée absente, jamais remplacée par 0.</li>
        <li>Les explications longues sont repliées derrière l'icône ${ico("info")} ; le glossaire est en bas de chaque page.</li></ul></div>
      <div class="panneau"><h3>${ico("reglages")} 3. Paramétrer</h3><ul>
        <li><b>Normes</b> du primaire (élèves par salle, ratio élève/maître) et <b>demande 2030</b> (maintien du taux actuel ou cible) : panneau de gauche, rubrique Paramètres.</li>
        <li><b>Poids des critères</b> : page Priorités (curseurs ou profils prêts à l'emploi). <b>Budget</b> et <b>règle de répartition</b> : page Répartition.</li>
        <li>Les valeurs par défaut marquées ${badge("HYPOTHÈSE")} sont des choix par défaut, à confirmer par les décideurs avec l'appui des services techniques. « Réinitialiser » revient aux valeurs par défaut.</li></ul></div>
      <div class="panneau"><h3>${ico("export")} 4. Personnaliser et partager</h3><ul>
        <li>Triez un tableau en cliquant sur l'en-tête d'une colonne ; exportez-le avec le bouton ${ico("export")} CSV (séparateur « ; », virgule décimale, ouvrable dans un tableur).</li>
        <li>Les cartes et graphiques s'agrandissent et s'enregistrent en image avec les boutons qui apparaissent au survol.</li>
        <li>« Copier le lien de cette vue » garde les filtres et paramètres dans l'adresse : le destinataire retrouve exactement la même vue.</li></ul></div>
    </div>
    <div class="grille g2 methode">
      <div class="panneau"><h3>Sources</h3><ul>
        <li>MENAPLN/DGESS, annuaires statistiques de l'enseignement primaire 2017-18 à 2024-25 (écoles, salles, maîtres, élèves par province et statut ; équipements).</li>
        <li>MENAPLN/DGESS, annuaires du préscolaire 2023-24 et 2024-25 ; annuaire post-primaire 2019-20 ; tableaux de bord 2023 et 2024 (normes).</li>
        <li>INSD, RGPH 2019 : projections démographiques 2020-2035 par province et âge ; annuaires statistiques régionaux 2024 (offre par commune).</li>
        <li>OCHA/HDX, COD-AB Burkina Faso : limites des 17 régions, 47 provinces et 351 communes, et correspondance avec l'ancien découpage.</li>
        <li>Classeur DGESS du préscolaire et du primaire 2015/16-2024/25 (contrôle des totaux).</li></ul></div>
      <div class="panneau"><h3>Normes utilisées</h3><ul>
        ${NORMES_NIVEAUX.map(([n, v, nat, src]) => `<li><b>${n}</b> : ${v} ${badge(nat)} <span class="note-mini">${src}</span></li>`).join("")}</ul>
        <p class="note">Les normes du primaire sont modifiables dans les Paramètres ; celles des autres niveaux sont les valeurs de référence du calcul de la page Trois cycles.</p></div>
      <div class="panneau"><h3>Formules</h3>
        <span class="formule">couverture = élèves 2024-25 ÷ population 6-11 ans 2025
élèves 2030 = couverture (ou cible) × population 6-11 ans 2030
besoin = ⌈ élèves 2030 ÷ norme ⌉
déficit = max(0 ; besoin − stock 2024-25)</span>
        <span class="formule">PROMETHEE II : π(a,b) = Σ wⱼ Pⱼ(gⱼ(a) − gⱼ(b))
Pⱼ linéaire : 0 sous q, 1 au-delà de p (q = 5 %, p = 30 % de l'étendue)
flux net φ(a) = 1/(n−1) Σ_b [π(a,b) − π(b,a)]</span>
        <p>Répartition « équité » : chaque salle va, une à une, à la province dont le ratio élèves 2030 ÷ salles est le plus élevé ; c'est la solution exacte du problème « réduire le ratio maximal » pour des salles entières, sans rien retirer ailleurs.</p></div>
      <div class="panneau"><h3>Règles de qualité</h3><ul>
        <li>Absence = N/D, jamais 0 ; la raison de chaque N/D est dans le registre N/D.</li>
        <li>Contrôles : public + privé = total ; ratios recalculés = ratios publiés ; somme des provinces = régions et nation ; annuaires = classeur DGESS.</li>
        <li>Rétro-test de la projection : erreur nationale ${fia.map(x => nf(x.erreur_nationale_pct, 1) + " % (" + x.annee_test + ")").join(", ") || ND} ; erreur médiane par province ${fia.map(x => nf(x.mediane_ape, 1) + " %").join(", ") || ND}.</li>
        <li>Les calculs faits dans le navigateur redonnent exactement les résultats du code Python (tests automatiques).</li></ul></div>
      <div class="panneau"><h3>Limites</h3><ul>
        <li>La norme de 50 élèves par salle au primaire est une hypothèse ; 50 élèves par maître est la norme écrite de la DGESS.</li>
        <li>Les écoles fermées pour insécurité ne sont pas modélisées : en scénario « maintien », leur demande reste basse.</li>
        <li>Préscolaire et post-primaire : l'offre n'est publiée qu'au niveau de la région ; les résultats sont donnés par région et les provinces restent en N/D (aucune valeur attribuée).</li>
        <li>Communes : la demande 2030 et les ratios calés sont une répartition indicative des totaux provinciaux ; le ratio publié par l'INSD figure à côté.</li>
        <li>Provinces issues d'une scission (Soum, Tapoa) : aucune valeur n'est recopiée ni répartie depuis la province mère. Leurs effectifs, ratios et déficits 2030 sont la somme exacte de leurs communes, étiquetée « somme des communes, indicatif » : c'est une reconstruction à partir de données officielles publiées (annuaires INSD), différente d'une absence totale de données. Leurs autres valeurs restent N/D.</li>
        <li>Communes : quand la source donne 0 élève alors que des salles ou des maîtres sont publiés, le ratio est N/D (mention « 0 élève publié », valeur à confirmer). Kain (Yatenga) : élèves publiés sans aucune salle ni aucun maître, mention « à vérifier », chiffre gardé.</li>
        <li>Le modèle de répartition ne tient pas compte des coûts, du foncier ni de la sécurité.</li></ul></div>
      <div class="panneau"><h3>Version et reproductibilité</h3>
        <p>Données construites le ${esc(dateFr(D.meta.construit_le))} à partir des sources ci-dessus. Le tableau de bord lit uniquement les fichiers du dossier <code>data/</code> ; ses calculs sont vérifiés par des tests automatiques qui les comparent aux résultats du code d'analyse (dépôt « Code »).</p>
        <p>Code d'équipe : ${esc(D.meta.code_equipe)}. Version ${VERSION.numero} du ${VERSION.date}.</p></div>
    </div>` + glossaire();
}
function dateFr(iso) { const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(iso || "")); return m ? `${m[3]}/${m[2]}/${m[1]}` : String(iso || ND); }

/* ============================================================== NAVIGATION, FILTRES, RENDU */
const PAGES = { accueil: pageAccueil, diagnostic: pageDiagnostic, besoins: pageBesoins, priorites: pagePriorites, repartition: pageRepartition, communes: pageCommunes, cycles: pageCycles, methode: pageMethode };
function allerA(page) { E.page = page; rafraichir(); window.scrollTo({ top: 0, behavior: "smooth" }); }
function selectionner(code) {
  const c45 = P45[code] ? code : (P47.find(p => p.adm2_pcode === code)?.adm2_pcode_old || "");
  E.province = c45 === E.province ? "" : c45; rafraichir();
}
function synchroniserReglages() {
  const sReg = $("#f-region");
  sReg.innerHTML = `<option value="">Tout le pays</option>` + regionsListe().map(([k, v]) => `<option value="${esc(k)}" ${k === E.region ? "selected" : ""}>${esc(v)}</option>`).join("");
  $("#f-decoupage").value = E.decoupage;
  $("#liste-provinces").innerHTML = D.provinces.map(p => `<option value="${esc(p.province)}">`).join("");
  $("#r-ns").value = E.ns; $("#o-ns").value = E.ns;
  $("#r-nm").value = E.nm; $("#o-nm").value = E.nm;
  $("#r-scenario").value = E.scenario; $("#r-cible").value = E.cible; $("#o-cible").value = E.cible + " %";
  $("#bloc-cible").style.display = E.scenario === "cible" ? "block" : "none";
  $("#normes-niveaux").innerHTML = NORMES_NIVEAUX.filter(n => n[0] !== "Primaire").map(([n, v, nat, src]) => `<p class="niveau-norme"><b>${n}</b> : ${v} ${badge(nat)}<br><span class="note-mini">${src}</span></p>`).join("") +
    `<p class="note-mini">Valeurs de référence du calcul de la page Trois cycles.</p>`;
  const poidsDef = D.criteres.every(c => E["w_" + c.critere] === DEF["w_" + c.critere]);
  $("#resume-reglages").innerHTML = `<p class="resume-ligne">Poids des critères : <b>${poidsDef ? "par défaut" : "modifiés"}</b> · <button class="lien-page" data-aller="priorites">régler</button></p>
    <p class="resume-ligne">Budget : <b>${nf(E.bs)} salles, ${nf(E.bm)} enseignants</b><br>Règle : <b>${esc(REGLES[E.regle].split(" :")[0])}</b> · <button class="lien-page" data-aller="repartition">régler</button></p>`;
  $("#resume-reglages").querySelectorAll("[data-aller]").forEach(b => b.onclick = () => allerA(b.dataset.aller));
  const puces = [];
  if (E.region) puces.push(["region", libellePerimetre()]);
  if (E.province) puces.push(["province", "Province : " + (P45[E.province]?.province || E.province)]);
  if (!reglagesParDefaut()) puces.push(["reglages", "Paramètres modifiés"]);
  $("#puces").innerHTML = puces.map(([k, t]) => `<span class="puce">${esc(t)}<button data-k="${k}" aria-label="Retirer">×</button></span>`).join("");
  $("#puces").querySelectorAll("button").forEach(b => b.onclick = () => { if (b.dataset.k === "reglages") reinitialiserReglages(); else E[b.dataset.k] = ""; rafraichir(); });
}
function reinitialiserReglages() { ["ns", "nm", "scenario", "cible"].concat(D.criteres.map(c => "w_" + c.critere)).forEach(k => { E[k] = DEF[k]; }); }
function rafraichir() {
  document.querySelectorAll(".onglets button").forEach(b => { b.classList.toggle("actif", b.dataset.page === E.page); if (b.dataset.page === E.page) b.setAttribute("aria-current", "page"); else b.removeAttribute("aria-current"); });
  document.querySelectorAll(".page").forEach(s => s.classList.toggle("actif", s.id === "p-" + E.page));
  synchroniserReglages();
  try { PAGES[E.page](); } catch (e) { console.error(e); $("#p-" + E.page).insertAdjacentHTML("afterbegin", `<div class="bloc attention"><b>Erreur d'affichage</b>${esc(e.message)}</div>`); }
  ecrireURL();
}
function initialiser() {
  lireURL();
  $("#badge-version").textContent = `Version ${VERSION.numero} · ${VERSION.date}`;
  $("#pied-texte").textContent = `Sources : MENAPLN/DGESS (annuaires statistiques), INSD (RGPH 2019, projections ; annuaires régionaux), OCHA/HDX (COD-AB). Données du ${dateFr(D.meta.construit_le)}. Version ${VERSION.numero}. Outils libres : Python, Plotly.`;
  document.querySelectorAll(".onglets button").forEach(b => b.onclick = () => allerA(b.dataset.page));
  $("#f-decoupage").onchange = e => { E.decoupage = e.target.value; E.region = ""; rafraichir(); };
  $("#f-region").onchange = e => { E.region = e.target.value; E.province = ""; rafraichir(); };
  $("#f-province").onchange = e => { const p = D.provinces.find(x => x.province.toLowerCase() === e.target.value.trim().toLowerCase()); if (p) { E.province = p.adm2_pcode_old; e.target.value = ""; rafraichir(); toast("Province sélectionnée : " + p.province); } };
  const curseur = (id, k, suff = "") => { $(id).oninput = e => { E[k] = Number(e.target.value); $(id.replace("r-", "o-")).value = E[k] + suff; clearTimeout(curseur.t); curseur.t = setTimeout(rafraichir, 120); }; };
  curseur("#r-ns", "ns"); curseur("#r-nm", "nm"); curseur("#r-cible", "cible", " %");
  $("#r-scenario").onchange = e => { E.scenario = e.target.value; rafraichir(); };
  $("#b-reinit").onclick = () => { Object.assign(E, DEF, { page: E.page }); rafraichir(); toast("Filtres et paramètres réinitialisés"); };
  $("#b-partager").onclick = () => { if (!navigator.clipboard) { toast(location.href); return; } navigator.clipboard.writeText(location.href).then(() => toast("Lien copié : il rouvre cette vue avec ses paramètres"), () => toast(location.href)); };
  $("#bouton-tiroir").onclick = () => { const r = $("#reglages"); r.classList.toggle("ouvert"); $("#bouton-tiroir").setAttribute("aria-expanded", r.classList.contains("ouvert")); };
  window.addEventListener("hashchange", () => { lireURL(); rafraichir(); });
  rafraichir();
}
document.addEventListener("DOMContentLoaded", initialiser);
