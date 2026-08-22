/**
 * Contrôles de l'intégration M+1 (C11 §18, §19, §22).
 *
 *   npm run m1:verify
 *
 * Deux familles de contrôles :
 *
 *   — les tests métier sur les règles de ligne jaune, exécutés sur des cas
 *     fabriqués. Une affaire à 19,9 % n'existe pas forcément dans le pipe du
 *     jour ; attendre qu'elle apparaisse pour vérifier la borne du seuil serait
 *     laisser le contrôle au hasard. La fonction de sélection est donc appelée
 *     directement, avec les cas qui l'intéressent ;
 *   — les contrôles de cohérence sur l'état réel : pas de doublon, pas de
 *     terminale, pas de gelée, séparation stricte des horizons.
 *
 * Aucune écriture.
 */

import path from "node:path";
import { pathToFileURL } from "node:url";

const lib = (n) => pathToFileURL(path.resolve(process.cwd(), `src/lib/${n}.ts`)).href;
const { buildForecastV2 } = await import(lib("forecast-v2"));
const { buildExpectedM1, eligibleM1Suggestions } = await import(lib("expected-m1"));
const { buildExpectedGmvSnapshot } = await import(lib("expected-gmv-live"));
const { EXPECTED_M1 } = await import(lib("config"));

let failures = 0;
let total = 0;
const check = (label, ok, detail = "") => {
  total += 1;
  if (!ok) failures += 1;
  console.log(`  ${ok ? "ok   " : "ÉCHEC"} ${label}${detail ? ` — ${detail}` : ""}`);
};

const m1 = buildExpectedM1();
const boardM = buildForecastV2(0);
const boardM1 = buildForecastV2(1);
const boardM2 = buildForecastV2(2);
const threshold = EXPECTED_M1.probabilityThreshold;

console.log("\n  TESTS MÉTIER — règles de ligne jaune M+1\n");

/** Un candidat de test, avec juste ce dont la règle a besoin. */
const deal = (id, over) => ({
  opportunityId: id,
  owner: "Test",
  client: id,
  city: null,
  gmv: 50_000,
  stage: "Examen devis",
  probability: threshold + 0.05,
  expectedGmv: 10_000,
  isStandby: false,
  standbyUntil: null,
  frozenM1: false,
  kanbanMonth: null,
  ...over,
});

const target = m1?.targetMonth ?? "2026-09";
const fake = {
  targetMonth: target,
  threshold,
  opportunities: [
    deal("T1-non-declaree"),
    deal("T2-kanban"),
    deal("T3-perspective"),
    deal("T4-sous-seuil", { probability: threshold - 0.001 }),
    deal("T5-au-seuil", { probability: threshold }),
    deal("T6-gelee", { isStandby: true, frozenM1: true }),
    deal("T7-standby-dans-horizon", { isStandby: true, frozenM1: false }),
  ],
};
const picked = new Set(
  eligibleM1Suggestions(fake, new Set(["T2-kanban"]), new Set(["T3-perspective"]), threshold).map(
    (o) => o.opportunityId,
  ),
);

check("1. affaire non déclarée au-dessus du seuil → jaune", picked.has("T1-non-declaree"));
check("2. affaire déjà déclarée Kanban M+1 → jamais jaune", !picked.has("T2-kanban"));
check("3. affaire déjà dans Perspective M+1 → jamais jaune", !picked.has("T3-perspective"));
check(
  `4. affaire juste sous le seuil (${((threshold - 0.001) * 100).toFixed(1)} %) → pas jaune`,
  !picked.has("T4-sous-seuil"),
);
check("4b. affaire exactement au seuil → jaune", picked.has("T5-au-seuil"));
check("6. stand-by gelée au-delà du mois cible → jamais jaune", !picked.has("T6-gelee"));
check("6b. stand-by réveillée dans l'horizon → éligible", picked.has("T7-standby-dans-horizon"));

// 5. Terminale : l'exclusion se fait à la lecture, pas dans la règle de sélection.
// C'est volontaire — une affaire terminale ne doit apparaître dans AUCUNE liste,
// pas seulement dans les jaunes. On vérifie donc l'état réel.
//
// Le motif exact n'est pas imposé : depuis le rapprochement des disparitions,
// une affaire peut aussi être écartée parce que la source ne la publie plus.
// Ce qui doit rester vrai est l'absence d'écart INEXPLIQUÉ — toute affaire
// scorée est soit retenue, soit écartée avec un motif écrit.
const dropped = m1 == null ? 0 : m1.issues.filter((i) => i.includes("écartée")).length;
check(
  "5. toute affaire écartée du scoring M+1 est justifiée",
  m1 == null || m1.opportunities.length === m1.scoredCount - dropped,
  m1 == null
    ? "pas de projection"
    : `${m1.opportunities.length} retenues sur ${m1.scoredCount} scorées, ${dropped} écartée(s) avec motif`,
);

console.log("\n  COHÉRENCE DES HORIZONS\n");

check(
  "7. M+1 publie une projection, une fourchette et une confiance",
  m1 != null && m1.projection > 0 && m1.rangeLo < m1.projection && m1.rangeHi > m1.projection && !!m1.confidence,
  m1 == null ? "aucune projection publiée" : `${Math.round(m1.projection / 1000)} k€, confiance ${m1.confidence}`,
);
check("8. M+2 n'affiche aucune ligne jaune", boardM2.examine.length === 0, `${boardM2.examine.length}`);
check(
  "9. M+2 ne revendique aucune projection",
  boardM2.expectedM1 == null && !boardM2.expectedAvailable && boardM2.expectedUnavailableReason != null,
);
for (const [name, b] of [["M", boardM], ["M+1", boardM1], ["M+2", boardM2]]) {
  const ids = b.salespeople.flatMap((s) => s.opportunities.map((o) => o.opportunityId));
  check(`10. ${name} — aucun OpportunityId en double`, new Set(ids).size === ids.length,
    `${ids.length} ligne(s)`);
}

check(
  "11. M continue d'utiliser son propre modèle",
  boardM.expectedM1 == null && (boardM.expected == null || boardM.expected.month === boardM.month),
);
check("12. M+1 n'utilise pas le modèle du mois", boardM1.expected == null);
check(
  "13. M+1 et M+2 portent bien des mois différents",
  boardM1.month !== boardM2.month && boardM1.month !== boardM.month,
  `${boardM.month} · ${boardM1.month} · ${boardM2.month}`,
);

console.log("\n  CONTRÔLES SUR L'ÉTAT RÉEL\n");

const yellowIds = new Set(boardM1.examine.map((e) => e.row.opportunityId));
const rowsM1 = boardM1.salespeople.flatMap((s) => s.opportunities);
const declaredOnTarget = new Set(
  rowsM1.filter((o) => !o.outsideKanban && o.kanbanMonth === boardM1.month).map((o) => o.opportunityId),
);
const inPerspective = new Set(
  rowsM1.filter((o) => o.perspectiveMonth === boardM1.month).map((o) => o.opportunityId),
);

check(
  "14. aucune ligne jaune M+1 déjà déclarée sur le mois",
  [...yellowIds].every((id) => !declaredOnTarget.has(id)),
);
check(
  "15. aucune ligne jaune M+1 déjà dans la Perspective du mois",
  [...yellowIds].every((id) => !inPerspective.has(id)),
);
check(
  "16. toutes les lignes jaunes M+1 atteignent le seuil",
  boardM1.examine.every((e) => (e.row.expectedProbability ?? 0) >= threshold),
  `seuil ${(threshold * 100).toFixed(0)} %`,
);
check(
  "17. aucune ligne jaune M+1 gelée au-delà de l'horizon",
  boardM1.examine.every((e) => !e.row.frozenMonthEnd),
);
check(
  "18. aucun doublon entre lignes normales et lignes jaunes",
  new Set(rowsM1.map((o) => o.opportunityId)).size === rowsM1.length,
);
check(
  "19. le nombre de lignes jaunes n'est pas plafonné",
  boardM1.examine.length === rowsM1.filter((o) => (o.expectedProbability ?? 0) >= threshold
    && !declaredOnTarget.has(o.opportunityId) && !inPerspective.has(o.opportunityId)
    && !o.frozenMonthEnd).length,
  `${boardM1.examine.length} suggestion(s)`,
);

// Non-régression du mois en cours : les totaux Expected M doivent rester ceux du
// service. C'est le contrôle qui attraperait une fuite du câblage M+1 vers M.
const snapM = buildExpectedGmvSnapshot();
if (snapM) {
  const drift = Math.abs(boardM.region.expectedRemaining - snapM.region.expectedRemaining);
  check("20. Expected M inchangé par l'intégration M+1", drift < 0.01,
    `écart ${drift.toFixed(2)} €`);
  check("21. Signé officiel identique entre M et le service",
    Math.abs(boardM.region.signedGmvActual - snapM.region.signedGmv) < 0.01,
    `${boardM.region.signedGmvActual.toFixed(2)} € / ${snapM.region.signedGmv.toFixed(2)} €`);
}

console.log("\n  ÉTAT PUBLIÉ\n");
if (m1) {
  const k = (v) => `${Math.round(v / 1000).toLocaleString("fr-FR").replace(/ /g, " ")} k€`;
  console.log(`  cible                    ${m1.targetMonthLabel}`);
  console.log(`  Projection RM Morning    ${k(m1.projection)}`);
  console.log(`  Fourchette indicative    ${k(m1.rangeLo)} → ${k(m1.rangeHi)}`);
  console.log(`  Confiance                ${m1.confidence}`);
  console.log(`  baseline · force · ×     ${k(m1.baseline)} · ${m1.strength.toFixed(2)} · ${m1.multiplier.toFixed(3)}`);
  console.log(`  plage calibrée           ${m1.calibratedLo?.toFixed(2)} → ${m1.calibratedHi?.toFixed(2)}${m1.strengthInRange ? "" : "  (HORS PLAGE)"}`);
  console.log(`  Kanban ${m1.targetMonth}           ${k(boardM1.region.kanbanGmv)} sur ${boardM1.region.count} affaire(s)`);
  console.log(`  Perspective              ${k(boardM1.region.perspectiveGmv)}`);
  console.log(`  écart Kanban/projection  ${k(boardM1.region.kanbanGmv - m1.projection)}`);
  console.log(`  lignes jaunes            ${boardM1.examine.length} pour ${k(boardM1.examine.reduce((t, e) => t + (e.row.gmv ?? 0), 0))}`);
  if (m1.supersededByImport) console.log("  ATTENTION : un import postérieur à la publication a été appliqué.");
}
if (boardM1.issues.length) {
  console.log("\n  remarques :");
  for (const i of boardM1.issues) console.log(`    ${i}`);
}

console.log(
  failures === 0
    ? `\n  ${total} contrôles au vert.\n`
    : `\n  ${failures} contrôle(s) en échec sur ${total}.\n`,
);
process.exit(failures === 0 ? 0 : 1);
