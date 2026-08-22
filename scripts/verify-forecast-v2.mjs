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
const { buildForecastBoard } = await import(lib("forecast-board"));
const v1 = buildForecastBoard(0);
const worst7 = Math.abs(
  v1.salespeople.reduce((t, s) => t + s.perspectiveGmv, 0) -
    M.salespeople.reduce((t, s) => t + s.perspectiveGmv, 0),
);
const matchedV1 = v1.salespeople.flatMap((s) => s.opportunities).filter((o) => o.perspectiveMonth === v1.month).length;
const matchedV2 = rows.filter((o) => o.perspectiveMonth === M.month).length;
check(
  "FC7. Perspective conserve son matching V1",
  worst7 === 0 && matchedV1 === matchedV2,
  `${matchedV2} lignes matchées · écart ${eur(worst7)} · snapshot ${M.perspectiveDate ?? "—"}`,
);

// FC8 — l'Expected de Forecast est exactement celui du service C6.1.
let worst8 = 0;
let mismatched = 0;
for (const r of rows) {
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
check(
  "FC8. Expected de Forecast = Expected du service",
  worst8 === 0 && mismatched === 0,
  `écart max ${eur(worst8)} · ${mismatched} valeur(s) sans source` +
    ` · Région ${eur(Math.abs(M.region.expectedRemaining - service.region.expectedRemaining))}`,
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
