/**
 * Contrôles FC1 → FC10 de Forecast V2.
 *
 *   npm run forecast:verify
 *
 * Exécutés hors interface, avant toute construction d'écran. Ils portent sur la
 * composition déclaratif + Expected : les contrôles internes de chaque source
 * restent ceux de `verify-forecast-board` et `verify-expected-gmv`.
 *
 * LECTURE SEULE.
 */

import { DatabaseSync } from "node:sqlite";
import path from "node:path";
import { pathToFileURL } from "node:url";

const lib = (n) => pathToFileURL(path.resolve(process.cwd(), `src/lib/${n}.ts`)).href;
const { buildForecastV2, DIVERGENCE_LABEL, CHALLENGE_LABEL } = await import(lib("forecast-v2"));
const { buildExpectedGmvSnapshot } = await import(lib("expected-gmv-live"));
const { buildExpectedM1 } = await import(lib("expected-m1"));
const { FORECAST_DIVERGENCE } = await import(lib("config"));

const kEur = (v) => `${Math.round((v ?? 0) / 1000).toLocaleString("fr-FR")} k€`;
const eur = (v) => `${(v ?? 0).toFixed(2)} €`;

let failures = 0;
const check = (label, ok, detail = "") => {
  if (!ok) failures += 1;
  console.log(`  ${ok ? "ok   " : "ÉCHEC"} ${label}${detail ? ` — ${detail}` : ""}`);
};

const M = buildForecastV2(0);
const M1 = buildForecastV2(1);
const service = buildExpectedGmvSnapshot();

console.log(`\n════ FORECAST V2 — M : ${M.monthLabel} ════`);
console.log(`  Objectif                 : ${M.region.objective == null ? "non configuré" : kEur(M.region.objective)}`);
console.log(`  Signé à date             : ${kEur(M.region.signedGmvActual)}`);
console.log(`  Projection Kanban        : ${kEur(M.region.kanbanGmv)} (${M.region.count} affaires projetées)`);
console.log(`  Finish Kanban            : ${kEur(M.region.signedGmvActual + M.region.kanbanGmv)}`);
console.log(`  Perspective              : ${kEur(M.region.perspectiveGmv)} (snapshot ${M.perspectiveDate ?? "—"})`);
console.log(`  Expected restant         : ${kEur(M.region.expectedRemaining)}`);
console.log(`  Expected finish          : ${kEur(M.region.expectedFinish)}`);
console.log(`  Zone probable            : ${kEur(M.region.p10)} – ${kEur(M.region.p90)} (médiane ${kEur(M.region.p50)})`);
console.log(`  Expected sur ${M.region.scoredCount} affaires scorées`);
console.log(`  Écart Kanban ↔ Expected  : ${kEur(M.region.divergence.gap)} · l'Expected couvre ${
  M.region.divergence.coverage == null ? "—" : (M.region.divergence.coverage * 100).toFixed(0) + " %"
} du déclaratif — c'est la référence à laquelle chaque commercial est comparé`);

console.log(`\n──── PAR COMMERCIAL ────`);
console.log(
  `  ${"Commercial".padEnd(22)}${"Signé".padStart(8)}${"Kanban".padStart(10)}${"Perspect.".padStart(11)}` +
    `${"Expected".padStart(10)}${"Finish".padStart(10)}${"Écart".padStart(10)}  Lecture`,
);
for (const s of M.salespeople) {
  console.log(
    `  ${s.salesperson.padEnd(22)}${kEur(s.signedGmvActual).padStart(8)}${kEur(s.kanbanGmv).padStart(10)}` +
      `${kEur(s.perspectiveGmv).padStart(11)}${kEur(s.expectedGmv).padStart(10)}` +
      `${kEur(s.expectedFinish).padStart(10)}${kEur(s.divergence.gap).padStart(10)}  ` +
      `${DIVERGENCE_LABEL[s.divergence.level]}${
        s.divergence.relative == null ? "" : ` (${s.divergence.relative.toFixed(2)}× région)`
      }`,
  );
}
console.log(
  `  ${"TOTAL RÉGION".padEnd(22)}${kEur(M.region.signedGmvActual).padStart(8)}${kEur(M.region.kanbanGmv).padStart(10)}` +
    `${kEur(M.region.perspectiveGmv).padStart(11)}${kEur(M.region.expectedRemaining).padStart(10)}` +
    `${kEur(M.region.expectedFinish).padStart(10)}${kEur(M.region.divergence.gap).padStart(10)}`,
);

console.log(`\n──── CONTRÔLES ────`);

// FC1 — Σ Expected opportunités = Expected commercial.
let worst1 = 0;
for (const s of M.salespeople) {
  const sum = s.opportunities.reduce((t, o) => t + (o.expectedGmv ?? 0), 0);
  worst1 = Math.max(worst1, Math.abs(sum - s.expectedGmv));
}
check("FC1. Σ Expected opportunités = Expected commercial", worst1 === 0, `écart max ${eur(worst1)}`);

// FC2 — Σ Expected commerciaux = Expected Région.
const sum2 = M.salespeople.reduce((t, s) => t + s.expectedGmv, 0);
check(
  "FC2. Σ Expected commerciaux = Expected Région",
  Math.abs(sum2 - M.region.expectedRemaining) === 0,
  `écart ${eur(sum2 - M.region.expectedRemaining)}`,
);

// FC3 — identité du finish, Région et chaque commercial.
const d3 = Math.abs(M.region.expectedFinish - (M.region.signedGmvActual + M.region.expectedRemaining));
const bad3 = M.salespeople.filter(
  (s) => Math.abs(s.expectedFinish - (s.signedGmvActual + s.expectedGmv)) > 1e-9,
);
check(
  "FC3. Expected finish = Signé + Expected restant",
  d3 === 0 && bad3.length === 0,
  `Région ${eur(d3)} · ${bad3.length} commercial(aux) en écart`,
);

// FC4 — aucune affaire signée dans l'Expected restant.
const db = new DatabaseSync(path.resolve(process.cwd(), "data/rm-morning.db"), { readOnly: true });
const signedIds = new Set(
  db
    .prepare("SELECT opportunity_id k FROM expected_gmv_signed WHERE scored_at = ?")
    .all(service.scoredAt)
    .map((r) => r.k),
);
const rows = M.salespeople.flatMap((s) => s.opportunities);
const contributing = rows.filter((r) => (r.expectedGmv ?? 0) > 0);
const leaked = contributing.filter((r) => signedIds.has(r.opportunityId));
check(
  "FC4. aucune opportunité signée dans l'Expected restant",
  leaked.length === 0,
  `${contributing.length} affaires contributrices · ${leaked.length} signée(s)`,
);

// FC5 — unicité de l'OpportunityId dans toute la vue.
const ids = rows.map((r) => r.opportunityId);
check("FC5. aucune OpportunityId en double", ids.length === new Set(ids).size, `${ids.length - new Set(ids).size} doublon(s)`);

// FC6 — Kanban M et M+1 disjoints. On ne compare que les lignes réellement
// portées par une projection Kanban : les affaires ajoutées parce qu'elles sont
// scorées sans être projetées n'appartiennent à aucun mois déclaratif.
const kanbanM = new Set(
  M.salespeople.flatMap((s) => s.opportunities.filter((o) => !o.outsideKanban).map((o) => o.opportunityId)),
);
const kanbanM1 = new Set(
  M1.salespeople.flatMap((s) => s.opportunities.filter((o) => !o.outsideKanban).map((o) => o.opportunityId)),
);
const crossover = [...kanbanM].filter((id) => kanbanM1.has(id));
check("FC6. Kanban M et M+1 disjoints", crossover.length === 0, `${crossover.length} intersection(s)`);

// FC7 — le matching Perspective est inchangé : mêmes lignes, mêmes montants
// que ceux produits par Forecast V1.
//
// EXCEPTION assumée depuis la famille « Signé » : Forecast V1 ignore
// entièrement `travaux` et ne sait donc pas qu'une affaire encore active à son
// sens vient de signer. Quand `officialSignedGmv` le sait, la ligne V2 bascule
// en ligne signée — elle sort légitimement du « encore au pipe », exactement
// comme une affaire déjà signée sort des `exits` de V1. Cette divergence est
// donc attendue et bornée aux seules affaires signées dans le mois ; toute
// autre divergence reste une vraie régression.
const { buildForecastBoard } = await import(lib("forecast-board"));
const v1 = buildForecastBoard(0);
const signedRowIds = new Set(rows.filter((r) => r.isSignedRow).map((r) => r.opportunityId));
const worst7 = Math.abs(
  v1.salespeople.reduce((t, s) => t + s.perspectiveGmv, 0) -
    M.salespeople.reduce((t, s) => t + s.perspectiveGmv, 0),
);
const matchedV1 = v1.salespeople
  .flatMap((s) => s.opportunities)
  .filter((o) => o.perspectiveMonth === v1.month && !signedRowIds.has(o.opportunityId)).length;
const matchedV2 = rows.filter((o) => o.perspectiveMonth === M.month).length;
check(
  "FC7. Perspective conserve son matching V1, hors affaires tout juste signées",
  worst7 === 0 && matchedV1 === matchedV2,
  `${matchedV2} lignes matchées · écart ${eur(worst7)} · ${signedRowIds.size} affaire(s) signée(s) sortie(s) du pipe · snapshot ${M.perspectiveDate ?? "—"}`,
);

// FC8 — l'Expected de Forecast est exactement celui du service C6.1.
//
// MÊME EXCEPTION qu'en FC7 : le service Expected note ses probabilités à son
// propre rythme et peut encore scorer une affaire tout juste signée. Une ligne
// signée porte volontairement `expectedGmv: null` — elle est réalisée, plus
// une prévision — donc son écart au service n'est pas une divergence de
// modèle, c'est la correction que ce lot apporte.
let worst8 = 0;
let mismatched = 0;
for (const r of rows) {
  if (r.isSignedRow) continue;
  const e = service.opportunities.find((o) => o.opportunityId === r.opportunityId);
  if (!e) {
    if ((r.expectedGmv ?? 0) !== 0) mismatched += 1;
    continue;
  }
  worst8 = Math.max(
    worst8,
    Math.abs((r.expectedGmv ?? 0) - e.expectedMonthEnd),
    Math.abs((r.expectedProbability ?? 0) - e.pMonthEnd),
  );
}
const signedStillScored = signedRowIds.size
  ? [...signedRowIds].reduce((t, id) => t + (service.opportunities.find((o) => o.opportunityId === id)?.expectedMonthEnd ?? 0), 0)
  : 0;
const regionGap = Math.abs(M.region.expectedRemaining - service.region.expectedRemaining);
check(
  "FC8. Expected de Forecast = Expected du service, hors affaires tout juste signées",
  worst8 === 0 && mismatched === 0 && Math.abs(regionGap - signedStillScored) < 1,
  `écart max ${eur(worst8)} · ${mismatched} valeur(s) sans source` +
    ` · Région ${eur(regionGap)} (dont ${eur(signedStillScored)} encore scorés par le service pour des affaires déjà signées)`,
);

// FC9 — les valeurs M+1 viennent du modèle M+1, jamais du modèle du mois.
//
// RÉÉCRIT en C11. La version de C7 exigeait l'absence totale de valeur Expected
// sur M+1, parce qu'aucun modèle ne couvrait cet horizon. C8.1 en a validé un :
// le contrôle ne vérifie donc plus qu'il n'y a rien, mais que ce qui s'y trouve
// vient bien de la publication M+1, et qu'aucune probabilité de fin de mois n'a
// été recyclée pour le mois suivant.
const m1Service = buildExpectedM1();
const m1ById = new Map((m1Service?.opportunities ?? []).map((o) => [o.opportunityId, o]));
const monthById = new Map((service?.opportunities ?? []).map((o) => [o.opportunityId, o]));
const m1Rows = M1.salespeople.flatMap((s) => s.opportunities);
const scored = m1Rows.filter((o) => o.expectedProbability != null);
// Sans source dans la publication M+1 : la valeur serait sortie de nulle part.
const orphan = scored.filter((o) => !m1ById.has(o.opportunityId));
// Recopiée du modèle du mois : ce serait réutiliser la probabilité d'août pour
// septembre, exactement ce que FC9 interdisait déjà.
const recycled = scored.filter((o) => {
  const m = monthById.get(o.opportunityId);
  return m != null && Math.abs(m.pMonthEnd - o.expectedProbability) < 1e-12 && m.pMonthEnd > 0;
});
const wrongValue = scored.filter(
  (o) => Math.abs((m1ById.get(o.opportunityId)?.probability ?? -1) - o.expectedProbability) > 1e-12,
);
check(
  "FC9. valeurs M+1 issues du modèle M+1, aucune reprise du modèle du mois",
  orphan.length === 0 && recycled.length === 0 && wrongValue.length === 0,
  `${M1.monthLabel} · ${scored.length} valeur(s) · ${orphan.length} sans source` +
    ` · ${recycled.length} recopiée(s) de M · ${wrongValue.length} divergente(s)`,
);

// FC9b — la projection régionale M+1 n'est PAS la somme des lignes. Si un jour
// les deux coïncidaient, ce serait le signe que quelqu'un a remplacé la
// projection par un total de colonne, ce qui la sous-estimerait de moitié.
if (m1Service != null) {
  const sumRows = m1Rows.reduce((t, o) => t + (o.expectedGmv ?? 0), 0);
  check(
    "FC9b. projection M+1 distincte de la somme des lignes",
    Math.abs(m1Service.projection - sumRows) > 1,
    `projection ${eur(m1Service.projection)} · somme des lignes ${eur(sumRows)}`,
  );
}

// FC10 — traitement du stand-by.
const standby = rows.filter((r) => r.isStandby);
const frozen = standby.filter((r) => r.frozenMonthEnd);
const frozenContributing = frozen.filter((r) => (r.expectedGmv ?? 0) !== 0);
const noWake = standby.filter((r) => !r.standbyUntil);
check(
  "FC10. stand-by gelés à contribution nulle",
  frozenContributing.length === 0,
  `${standby.length} stand-by · ${frozen.length} gelé(s) au-delà du mois · ${frozenContributing.length} contribution(s) résiduelle(s)` +
    ` · ${noWake.length} sans date de réveil`,
);

console.log(`\n──── STAND-BY CONSERVÉS SUR LE MOIS ────`);
for (const r of standby.filter((x) => !x.frozenMonthEnd)) {
  console.log(
    `  réveil ${r.standbyUntil?.slice(0, 10) ?? "—"}  ${r.client.slice(0, 26).padEnd(28)}` +
      `${kEur(r.gmv).padStart(9)}  p ${((r.expectedProbability ?? 0) * 100).toFixed(2)} %` +
      `  contribution ${kEur(r.expectedGmv)}`,
  );
}

// FC11 — hygiène de la liste « À challenger ». Aucune affaire ne doit y figurer
// si elle est terminale, gelée au-delà du mois, déjà signée, ou porteuse d'une
// donnée incohérente : une liste d'actions qui contient des affaires mortes se
// fait ignorer en bloc.
const terminalNow = new Set(
  db
    .prepare("SELECT substr(opportunity_id,1,15) k FROM opportunity WHERE is_terminal = 1")
    .all()
    .map((r) => r.k),
);
const badChallenge = [];
for (const e of M.examine) {
  const r = e.row;
  const faults = [];
  if (terminalNow.has(r.opportunityId)) faults.push("terminale");
  if (r.frozenMonthEnd) faults.push("gelée au-delà du mois");
  if (signedIds.has(r.opportunityId)) faults.push("déjà signée");
  if (r.gmv == null || r.gmv <= 0) faults.push("GMV absent ou nul");
  if (r.expectedProbability == null) faults.push("aucune probabilité");
  else if (!(r.expectedProbability >= 0 && r.expectedProbability <= 1))
    faults.push("probabilité hors bornes");
  if (r.expectedGmv == null) faults.push("GMV probable absent");
  if (!r.stage) faults.push("étape absente");
  if (!r.owner) faults.push("commercial absent");
  if (!CHALLENGE_LABEL[e.kind]) faults.push(`motif inconnu (${e.kind})`);
  if (faults.length > 0) badChallenge.push({ id: r.opportunityId, client: r.client, faults });
}
check(
  "FC11. liste À challenger saine",
  badChallenge.length === 0,
  `${M.examine.length} affaire(s) · ${badChallenge.length} anomalie(s)`,
);
for (const b of badChallenge) console.log(`        ${b.id} ${b.client} — ${b.faults.join(", ")}`);

const kinds = {};
for (const e of M.examine) kinds[e.kind] = (kinds[e.kind] ?? 0) + 1;
console.log(`\n──── À CHALLENGER (${M.examine.length}) ────`);
console.log(
  `  par motif : ${Object.entries(kinds)
    .map(([k, v]) => `${CHALLENGE_LABEL[k] ?? k} = ${v}`)
    .join(" · ")}`,
);
for (const e of M.examine) {
  console.log(
    `  ${(CHALLENGE_LABEL[e.kind] ?? e.kind).padEnd(26)}${e.row.client.slice(0, 24).padEnd(26)}` +
      `${e.row.owner.slice(0, 18).padEnd(20)}${kEur(e.row.gmv).padStart(9)}` +
      `${kEur(e.row.expectedGmv).padStart(9)}  ${e.reason}`,
  );
}

// FC12 — Frontière unique à 25 % : l'ajout par RM Morning est STRICTEMENT au-delà.
{
  const { isVisibleInForecast, forecastChallengers, expectedChallengers } = await import(lib("forecast-v2"));
  const month = M.month;
  const today = new Date().toISOString().slice(0, 10);
  const row = (id, p, over = {}) => ({
    opportunityId: id, client: id, owner: "ET Test", gmv: 10_000, expectedProbability: p, expectedGmv: p == null ? null : 10_000 * p,
    isSignedRow: false, outsideKanban: true, perspectiveMonth: null, kanbanMonth: null, isStandby: false, standbyUntil: null,
    frozenMonthEnd: false, ...over,
  });
  const cases = [["p150", 0.15], ["p151", 0.151], ["p249", 0.249], ["p250", 0.25], ["p251", 0.251]];
  const board = { horizon: 0, month, examine: [], salespeople: [{ opportunities: cases.map(([id, p]) => row(id, p)) }] };
  const f = new Set(forecastChallengers(board).map((e) => e.row.opportunityId));
  const x = new Set(expectedChallengers(board).map((e) => e.row.opportunityId));
  const vis = (id, p, over) => isVisibleInForecast(row(id, p, over), month, today);
  check("FC12a. 15,0 % : ni Expected ni Forecast", !x.has("p150") && !f.has("p150") && !vis("v", 0.15));
  check("FC12b. 15,1 % : Expected seulement", x.has("p151") && !f.has("p151") && !vis("v", 0.151));
  check("FC12c. 24,9 % : Expected seulement", x.has("p249") && !f.has("p249") && !vis("v", 0.249));
  check("FC12d. 25,0 % : Expected, ni affichée ni challengée dans Forecast", x.has("p250") && !f.has("p250") && !vis("v", 0.25));
  check("FC12e. 25,1 % : affichée et challengée dans Forecast, absente d'Expected", f.has("p251") && !x.has("p251") && vis("v", 0.251));
  check("FC12f. déclarée au Kanban à 25,0 % ou 10 % : toujours affichée", vis("v", 0.25, { outsideKanban: false }) && vis("v", 0.1, { outsideKanban: false }));
  check("FC12g. déclarée en Perspective M à 25,0 % : toujours affichée", vis("v", 0.25, { perspectiveMonth: month }));
  check("FC12h. signée, quelle que soit la probabilité : toujours affichée", vis("v", 0.25, { isSignedRow: true }) && vis("v", null, { isSignedRow: true }));
}

// FC13 — Pied de la feuille : chaque montant nommé, réconcilié avec la bande.
{
  const { footerItems, groupSummary, signedRowSituation, hasWeightedContribution } = await import(lib("forecast-wording"));
  const { kEur: uiKEur } = await import(lib("vocabulary"));
  const r = M.region;
  const footerSigned = M.salespeople.reduce((t, s) => t + s.signedGmvActual, 0);
  const footerDeclared = M.salespeople.reduce((t, s) => t + s.declaredOpenGmv, 0);
  check("FC13a. Signé à date du pied = Signé à date de la bande", Math.abs(footerSigned - r.signedGmvActual) < 0.005, eur(footerSigned));
  check("FC13b. Reste annoncé du pied = Reste annoncé de la bande", Math.abs(footerDeclared - r.declaredOpenGmv) < 0.005, eur(footerDeclared));
  check(
    "FC13c. Signé à date + Reste annoncé = Atterrissage commercial (euros)",
    Math.abs(footerSigned + footerDeclared - r.commercialLanding) < 0.005,
    `${eur(footerSigned)} + ${eur(footerDeclared)} = ${eur(r.commercialLanding)}`,
  );
  const k = (v) => Math.round(v / 1000);
  check(
    "FC13d. réconciliation à l'arrondi de l'écran (k€)",
    k(r.signedGmvActual) + k(r.declaredOpenGmv) === k(r.commercialLanding),
    `${uiKEur(r.signedGmvActual)} + ${uiKEur(r.declaredOpenGmv)} = ${uiKEur(r.commercialLanding)}`,
  );
  const items = footerItems({ signed: r.signedGmvActual, declaredOpen: r.declaredOpenGmv, kanban: 342_642, expected: 1_800 }, { horizon: 0, showExpected: true });
  check(
    "FC13e. l'atterrissage du pied s'écrit comme celui de la bande",
    items.primary[2] === `Atterrissage commercial : ${uiKEur(r.commercialLanding)}`,
    items.primary[2],
  );
  check("FC13f. aucun montant nu : chaque élément du pied porte un libellé", [...items.primary, ...items.detail].every((t) => /^[A-ZÉ][^:]+ : /.test(t)));
  check("FC13g. Kanban nommé, jamais présenté comme un total de la colonne GMV", items.detail.includes("Projection Kanban des affaires affichées : 343 k€"));
  check(
    "FC13h. petite contribution pondérée à l'euro, pas « 0 k€ »",
    items.detail[0].endsWith(": 2 k€") &&
      footerItems({ signed: 0, declaredOpen: 0, kanban: 0, expected: 420 }, { horizon: 0, showExpected: true }).detail[0].endsWith(": 420 €"),
  );
  const m1Items = footerItems({ signed: 0, declaredOpen: 0, kanban: 0, expected: 5_000 }, { horizon: 1, showExpected: true });
  check("FC13i. M+1 : la somme pondérée est dite distincte de la projection", /pas la projection du mois/.test(m1Items.detail[0]));
  const m2Items = footerItems({ signed: 0, declaredOpen: 0, kanban: 0, expected: 0 }, { horizon: 2, showExpected: false });
  check("FC13j. M+2 : aucune contribution RM chiffrée", !m2Items.detail.some((t) => /Contribution/.test(t)));

  // Résumé par commercial — les cinq situations.
  const g = (over) => ({ signedGmv: 0, declaredOpenGmv: 0, adjustedGmv: null, expectedGmv: 0, rowCount: 1, ...over });
  const s1 = groupSummary(g({ signedGmv: 2_000, expectedGmv: 35_000, rowCount: 5 }), true);
  check("FC14a. signé + potentiel RM : les deux nommés séparément", s1.includes("Signé 2 k€") && s1.includes("5 affaires affichées") && s1.includes("Potentiel RM restant pondéré : 35 k€"), s1);
  const s2 = groupSummary(g({ signedGmv: 60_000, rowCount: 6 }), true);
  check("FC14b. uniquement du signé : signé écrit, « aucun potentiel supplémentaire »", s2.includes("Signé 60 k€") && s2.endsWith("Aucun potentiel supplémentaire identifié"), s2);
  const s3 = groupSummary(g({ declaredOpenGmv: 34_000, expectedGmv: 21_000, rowCount: 1 }), true);
  check("FC14c. uniquement du reste annoncé : pas de « Signé 0 »", !s3.includes("Signé") && s3.includes("Reste annoncé 34 k€") && s3.includes("1 affaire affichée"), s3);
  const s4 = groupSummary(g({ signedGmv: -158, rowCount: 1 }), true);
  check("FC14d. seul mouvement = moins-value : signé négatif écrit à l'euro", s4.includes("Signé −158 €") && s4.includes("Atterrissage −158 €"), s4);
  const s5 = groupSummary(g({ declaredOpenGmv: 10_000, expectedGmv: 0.3, rowCount: 2 }), true);
  check("FC14e. contribution nulle : « aucun potentiel », jamais « 0 k€ »", s5.endsWith("Aucun potentiel supplémentaire identifié") && !/(^|\s)0 k€/.test(s5), s5);
  const s6 = groupSummary(g({ declaredOpenGmv: 10_000, expectedGmv: 420 }), true);
  check("FC14f. petite contribution : à l'euro", s6.includes("Potentiel RM restant pondéré : 420 €"), s6);
  check("FC14g. aucun libellé « GMV probable » dans le résumé", ![s1, s2, s3, s4, s5, s6].some((t) => t.includes("GMV probable")));

  // Lignes signées.
  check("FC15a. moins-value de 158 € : « Moins-value signée »", signedRowSituation({ isSignedRow: true, gmv: -158 })?.label === "Moins-value signée");
  check("FC15b. moins-value de 1 500 € : « Moins-value signée »", signedRowSituation({ isSignedRow: true, gmv: -1_500 })?.label === "Moins-value signée");
  check("FC15c. signé positif : mouvement ordinaire (Signée)", signedRowSituation({ isSignedRow: true, gmv: 5_000 }) === null);
  check("FC15d. ligne non signée négative : jamais « Moins-value signée »", signedRowSituation({ isSignedRow: false, gmv: -500 }) === null);
  check("FC15e. contribution pondérée affichée dès 1 €", hasWeightedContribution(1) && !hasWeightedContribution(0.4) && !hasWeightedContribution(null));
  const negSigned = M.salespeople.flatMap((s) => s.opportunities).filter((o) => o.isSignedRow && (o.gmv ?? 0) < 0);
  console.log(`  (info) lignes signées négatives du mois : ${negSigned.map((o) => `${o.client} ${eur(o.gmv)}`).join(", ") || "aucune"}`);
}

console.log(`\n──── SEUILS DE DIVERGENCE (configurables) ────`);
console.log(`  proche      : couverture ≥ ${FORECAST_DIVERGENCE.closeRatio}× celle de la Région`);
console.log(`  prudent     : entre ${FORECAST_DIVERGENCE.prudentRatio}× et ${FORECAST_DIVERGENCE.closeRatio}×`);
console.log(`  fort        : < ${FORECAST_DIVERGENCE.prudentRatio}×`);
console.log(`  écart minimal qualifié : ${kEur(FORECAST_DIVERGENCE.minGap)}`);

console.log(`\n──── M+1 : ${M1.monthLabel} ────`);
console.log(`  Projection Kanban : ${kEur(M1.region.kanbanGmv)} (${M1.region.count} affaires projetées)`);
console.log(`  Perspective       : ${kEur(M1.region.perspectiveGmv)}`);
console.log(`  Expected          : ${M1.expectedAvailable ? "présent" : "absent — " + M1.expectedUnavailableReason}`);

if (M.issues.length > 0) {
  console.log(`\n  anomalies signalées :`);
  for (const i of M.issues) console.log(`      ${i}`);
}

db.close();
console.log(`\n  ${failures === 0 ? "Tous les contrôles passent." : `${failures} contrôle(s) en échec.`}\n`);
process.exit(failures === 0 ? 0 : 1);
