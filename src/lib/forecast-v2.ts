/**
 * Forecast V2 — composition du pilotage déclaratif et de la prévision statistique.
 *
 * Ce fichier ne calcule NI le déclaratif NI la prévision. Il compose deux
 * sources déjà validées, chacune restant seule responsable de ses chiffres :
 *
 *   — `forecast-board`      : Signé, Projection Kanban, Perspective, mouvements ;
 *   — `expected-gmv-live`   : Expected 7 jours et fin de mois, quantiles.
 *
 * Conséquence voulue : il n'existe aucun second calcul d'Expected dans
 * l'application. Si les deux écrans affichaient un jour des Expected
 * différents, ce serait un bug de jointure, pas de modèle (FC8).
 *
 * VOCABULAIRE, jamais mélangé :
 *   Signé = réalisé · Projection Kanban = déclaratif actuel ·
 *   Perspective = dernière photographie hebdomadaire du déclaratif ·
 *   Expected = estimation statistique.
 *
 * TROIS HORIZONS, trois régimes distincts (C11) :
 *
 *   M   — Expected du mois : contributions par affaire, lignes jaunes du mois.
 *   M+1 — projection régionale C8.1 et lignes jaunes au seuil de probabilité.
 *         La projection N'EST PAS la somme des lignes : 46 % du GMV de M+1
 *         viendra d'affaires qui n'existent pas encore. Les probabilités
 *         individuelles ne servent donc qu'à classer, jamais à totaliser.
 *   M+2 — déclaratif SEUL. Aucun modèle, aucune ligne jaune : le ranking M+2 de
 *         C8.1 fait moins bien que le hasard (lift 0,9×), il est rejeté.
 */

import { EXPECTED_M1, FORECAST_DIVERGENCE, FORECAST_VISIBILITY } from "./config";
import {
  buildForecastBoard,
  type ForecastMonthBoard,
  type ForecastRow,
  type ForecastSalespersonBlock,
  type MonthKey,
} from "./forecast-board";
import { buildExpectedGmvSnapshot, type ExpectedGmvSnapshot } from "./expected-gmv-live";
import {
  buildExpectedM1,
  eligibleM1Suggestions,
  type ExpectedM1Snapshot,
} from "./expected-m1";
import { officialSignedGmv } from "./official-signed";
import { clientLabel } from "./vocabulary";

export type DivergenceLevel = "proche" | "prudent" | "fort" | "non_qualifie";

export const DIVERGENCE_LABEL: Record<DivergenceLevel, string> = {
  proche: "Proche",
  prudent: "RM Morning plus prudent",
  fort: "Forte divergence",
  non_qualifie: "Écart non significatif",
};

/**
 * Une lecture d'écart ne condamne personne : elle indique où une conversation
 * de management est probablement utile.
 */
export const DIVERGENCE_HINT: Record<DivergenceLevel, string> = {
  proche: "Déclaratif et estimation se rejoignent.",
  prudent: "RM Morning estime moins que le déclaratif : à confronter.",
  fort: "Écart important : vaut une revue de pipe affaire par affaire.",
  non_qualifie: "Écart trop faible pour être interprété.",
};

export type Divergence = {
  level: DivergenceLevel;
  /** Expected restant − Kanban restant. Négatif = RM Morning en dessous. */
  gap: number;
  /** Expected restant / Kanban restant, ou null si aucun Kanban. */
  coverage: number | null;
  /** Rapport de cette couverture à la couverture régionale. */
  relative: number | null;
};

// `ForecastRow` déclare ces deux champs comme toujours nuls : c'était le
// contrat de Forecast V1, où Expected GMV n'existait pas. Ils sont remplacés,
// pas contournés, pour que le type dise la vérité.
export type ForecastV2Row = Omit<ForecastRow, "expectedProbability" | "expectedGmv"> & {
  /** Probabilité de signature avant la fin du mois, telle que produite par le service. */
  expectedProbability: number | null;
  /** GMV × probabilité, déjà neutralisée si l'affaire est gelée en stand-by. */
  expectedGmv: number | null;
  isStandby: boolean;
  standbyUntil: string | null;
  frozenMonthEnd: boolean;
  /** L'affaire est scorée mais absente du Kanban de ce mois. */
  outsideKanban: boolean;
};

export type ForecastV2Salesperson = Omit<ForecastSalespersonBlock, "opportunities"> & {
  opportunities: ForecastV2Row[];
  expectedGmv: number;
  /** Signé mesuré sur la transition réelle vers une étape post-signature. */
  signedGmvActual: number;
  expectedFinish: number;
  divergence: Divergence;
};

export type ForecastV2Region = ForecastMonthBoard["region"] & {
  /** Affaires portant un Expected. Distinct de `count`, qui compte le Kanban. */
  scoredCount: number;
  expectedRemaining: number;
  signedGmvActual: number;
  expectedFinish: number;
  p10: number;
  p50: number;
  p90: number;
  divergence: Divergence;
  expectedGapToObjective: number | null;
};

/**
 * Une affaire « À challenger ».
 *
 * Définition unique de l'application : Forecast et Expected GMV affichent
 * exactement cette liste, produite ici et nulle part ailleurs. En dupliquer une
 * variante ferait diverger les deux écrans sur la question la plus sensible.
 */
export type { ChallengeKind } from "./forecast-labels";
export { CHALLENGE_LABEL } from "./forecast-labels";
import type { ChallengeKind } from "./forecast-labels";

export type ForecastV2Examine = {
  row: ForecastV2Row;
  kind: ChallengeKind;
  /** Pourquoi RM Morning la surveille, en une phrase lisible. */
  reason: string;
};

export type ForecastV2Board = Omit<ForecastMonthBoard, "salespeople" | "region"> & {
  region: ForecastV2Region;
  salespeople: ForecastV2Salesperson[];
  /** Renseigné sur M seulement : l'Expected du mois ne couvre que le mois scoré. */
  expected: ExpectedGmvSnapshot | null;
  /** Renseigné sur M+1 seulement : projection régionale et scoring C8.1. */
  expectedM1: ExpectedM1Snapshot | null;
  /** Horizon de la vue : 0 = M, 1 = M+1, 2 = M+2. */
  horizon: 0 | 1 | 2;
  expectedAvailable: boolean;
  expectedUnavailableReason: string | null;
  examine: ForecastV2Examine[];
  issues: string[];
};

// --- Ce qui a sa place dans la feuille Forecast ---------------------------
//
// Une seule définition, partagée par l'écran et par les contrôles. La règle est
// délibérément énoncée en trois prédicats séparés plutôt qu'en une expression :
// chacun répond à une question différente, et le rapport de contrôle doit
// pouvoir dire LEQUEL a fait entrer ou sortir une affaire.

/**
 * Le commercial l'a annoncée sur ce mois.
 *
 * Deux déclarations valent engagement, et elles ne se remplacent pas : la
 * Projection Kanban est l'état actuel de son avis dans Salesforce, la
 * Perspective en est la photographie hebdomadaire. Une affaire retirée du
 * Kanban depuis la dernière Perspective reste quelque chose qu'il a annoncé —
 * c'est précisément la conversation que Forecast doit permettre.
 */
export function isDeclaredOnMonth(row: ForecastV2Row, month: MonthKey): boolean {
  return !row.outsideKanban || row.perspectiveMonth === month;
}

/**
 * RM Morning lui donne une chance réelle de signer sur le mois.
 *
 * Le signal est l'Expected GMV, jamais la Probability Salesforce : celle-ci est
 * une propriété de l'ÉTAPE (40 % pour tout « Examen devis »), pas du dossier.
 */
export function isProbableOnMonth(row: ForecastV2Row): boolean {
  return (row.expectedProbability ?? 0) >= FORECAST_VISIBILITY.minProbability;
}

/**
 * Affaires qui n'ont leur place dans aucune vue Forecast.
 *
 * Le stand-by dont la date de réveil est encore devant nous est une décision
 * commerciale explicite : le dossier est mis de côté jusqu'à cette date, et le
 * faire figurer dans la feuille du mois inviterait à le challenger alors que
 * l'arbitrage est déjà rendu.
 *
 * Les affaires signées et abandonnées, elles, ne remontent pas jusqu'ici : le
 * périmètre du mois écarte les affaires terminales (`forecast-board`) et le
 * service Expected écarte les affaires devenues terminales ou disparues de la
 * source (`expected-gmv-live`). L'exclusion est faite à la donnée, pas à
 * l'affichage — c'est ce qui la rend vraie sur tous les écrans à la fois.
 */
export function isFrozenOut(row: ForecastV2Row, today: string): boolean {
  return row.isStandby && row.standbyUntil != null && row.standbyUntil.slice(0, 10) > today;
}

/**
 * LA règle de visibilité du Forecast. Une seule, sans exception ni dépliage.
 *
 *   1. déclarée par le commercial sur ce mois → visible, quelle que soit sa
 *      probabilité. C'est son engagement, il doit pouvoir être confronté ;
 *   2. non déclarée → visible seulement à partir de 25 % de chance de signer
 *      d'ici la fin du mois ;
 *   3. stand-by dont la date de réveil est devant nous → jamais visible.
 *
 * Une affaire non déclarée sous le seuil est ABSENTE de la page : pas de ligne,
 * pas d'accordéon, pas de compteur qui propose de l'afficher. Forecast sert à
 * arbitrer un mois, pas à explorer le pipe faible — celui-ci reste entier dans
 * Expected GMV, dans Monitoring et dans Salesforce.
 *
 * Les affaires signées et abandonnées ne remontent pas jusqu'ici : elles sont
 * écartées à la donnée (`forecast-board` exclut les affaires terminales,
 * `expected-gmv-live` écarte celles devenues terminales ou disparues de la
 * source), ce qui les rend absentes de tous les écrans à la fois.
 */
export function isVisibleInForecast(
  row: ForecastV2Row,
  month: MonthKey,
  today: string,
): boolean {
  if (isFrozenOut(row, today)) return false;
  return isDeclaredOnMonth(row, month) || isProbableOnMonth(row);
}

function qualify(expected: number, kanban: number, reference: number | null): Divergence {
  const gap = expected - kanban;
  const coverage = kanban > 0 ? expected / kanban : null;
  const relative = coverage != null && reference != null && reference > 0 ? coverage / reference : null;

  if (Math.abs(gap) < FORECAST_DIVERGENCE.minGap) {
    return { level: "non_qualifie", gap, coverage, relative };
  }
  if (relative == null) {
    // Expected sans Kanban : l'affaire n'est pas projetée sur le mois. Ce n'est
    // pas une divergence de niveau, c'est une absence — traitée ailleurs.
    return { level: "non_qualifie", gap, coverage, relative };
  }
  if (relative >= FORECAST_DIVERGENCE.closeRatio) return { level: "proche", gap, coverage, relative };
  if (relative >= FORECAST_DIVERGENCE.prudentRatio) return { level: "prudent", gap, coverage, relative };
  return { level: "fort", gap, coverage, relative };
}

/**
 * Construit la vue Forecast V2 d'un mois.
 *
 * `monthOffset` 0 = M, 1 = M+1. L'Expected n'est rattaché qu'au mois que le
 * service a effectivement scoré ; pour tout autre mois il reste absent, et
 * l'interface l'annonce au lieu de l'inventer.
 */
export function buildForecastV2(monthOffset: number, objective?: number | null): ForecastV2Board {
  const horizon = (monthOffset <= 0 ? 0 : monthOffset >= 2 ? 2 : 1) as 0 | 1 | 2;
  const board = buildForecastBoard(monthOffset, objective);
  const issues: string[] = [...board.issues];

  // L'Expected du mois ne vaut QUE pour le mois qu'il a scoré. Le lire sur un
  // autre horizon reviendrait à réutiliser la probabilité d'août pour septembre.
  const snapshot = horizon === 0 ? buildExpectedGmvSnapshot() : null;
  const available = snapshot != null && snapshot.month === board.month;

  // M+1 : projection régionale et scoring dédiés, publiés par `m1:publish`.
  const m1 = horizon === 1 ? buildExpectedM1() : null;
  const m1Available = m1 != null && m1.targetMonth === board.month;
  if (m1 != null && !m1Available) {
    issues.push(
      `Projection M+1 publiée pour ${m1.targetMonthLabel}, pas pour ${board.monthLabel} : non affichée.`,
    );
  }

  let reason: string | null = null;
  if (horizon === 0) {
    if (snapshot == null) reason = "Aucun scoring Expected disponible.";
    else if (!available) {
      reason = `Le modèle estime la signature avant la fin du mois observé. Il a scoré ${snapshot.monthLabel} et ne prédit rien pour ${board.monthLabel}.`;
    }
  } else if (horizon === 1) {
    if (!m1Available) reason = "Aucune projection M+1 publiée. Lancer npm run m1:publish.";
  } else {
    // M+2 : ce n'est pas une indisponibilité technique, c'est une décision. Aucun
    // modèle n'a été validé à cet horizon et le ranking a été explicitement
    // rejeté (PR-AUC 0,044 ; sélection moins bonne que le hasard).
    reason = "Aucune projection suffisamment fiable à cet horizon. Vue déclarative seule.";
  }

  // Index de l'Expected par OpportunityId. Une seule lecture, aucune reprise de
  // calcul : la contribution vient telle quelle du service.
  const byId = new Map(
    available ? snapshot!.opportunities.map((o) => [o.opportunityId, o]) : [],
  );
  // Signé = GMV OFFICIEL du mois, somme des lignes Travaux signées ou réalisées.
  // Indépendant de l'Expected : il vaut pour M comme pour M+1, et il ne dépend
  // pas de la présence d'un scoring.
  const official = officialSignedGmv(board.month);
  const signedByOwner = new Map<string, number>(
    official.bySalesperson.map((s) => [s.salesperson, s.gmv]),
  );

  // Index du scoring M+1, même rôle que `byId` pour le mois : une seule lecture,
  // aucune reprise de calcul.
  const m1ById = new Map(m1Available ? m1!.opportunities.map((o) => [o.opportunityId, o]) : []);

  const attach = (rows: ForecastRow[]): ForecastV2Row[] =>
    rows.map((r) => {
      const e = byId.get(r.opportunityId);
      const p = m1ById.get(r.opportunityId);
      return {
        ...r,
        // Sur M la probabilité est celle de la fin du mois, sur M+1 celle du mois
        // cible. La colonne est la même, la question posée est différente — c'est
        // l'en-tête du tableau qui le dit, jamais un mélange des deux valeurs.
        expectedProbability: horizon === 1 ? (p ? p.probability : null) : e ? e.pMonthEnd : null,
        expectedGmv: horizon === 1 ? (p ? p.expectedGmv : null) : e ? e.expectedMonthEnd : null,
        isStandby: r.isStandby,
        standbyUntil: (horizon === 1 ? p?.standbyUntil : e?.standbyUntil) ?? null,
        frozenMonthEnd: (horizon === 1 ? p?.frozenM1 : e?.frozenMonthEnd) ?? false,
        outsideKanban: false,
      };
    });

  // Affaires scorées absentes du Kanban du mois : elles existent
  // statistiquement mais le commercial ne les projette pas sur M. Elles ne
  // gonflent aucun total Kanban et sont rattachées à leur commercial pour que
  // Σ Expected commerciaux = Expected Région reste vrai (FC1, FC2).
  const inBoard = new Set(board.salespeople.flatMap((s) => s.opportunities.map((o) => o.opportunityId)));
  const extras = new Map<string, ForecastV2Row[]>();

  // --- M+1 : les lignes jaunes, et elles seules.
  //
  // Sur M on ajoute toutes les affaires scorées absentes du Kanban, parce que la
  // somme de leurs contributions doit rester égale à l'Expected Région. Sur M+1
  // il n'y a rien à faire tenir : la projection régionale ne se somme pas depuis
  // les lignes. On n'ajoute donc que ce qui a une utilité mesurée — les affaires
  // qui passent le seuil et que le commercial n'a pas déclarées.
  const declaredOnTarget = new Set<string>();
  const inPerspective = new Set<string>();
  for (const s of board.salespeople) {
    for (const o of s.opportunities) {
      if (o.kanbanMonth === board.month) declaredOnTarget.add(o.opportunityId);
      if (o.perspectiveMonth === board.month) inPerspective.add(o.opportunityId);
    }
  }
  // Le seuil vient de la configuration, pas du snapshot : le faire varier ne doit
  // pas obliger à republier le scoring. Celui inscrit dans le snapshot n'est
  // qu'une trace de ce qui était en vigueur à la publication.
  const m1Suggestions = m1Available
    ? eligibleM1Suggestions(
        m1!,
        declaredOnTarget,
        inPerspective,
        EXPECTED_M1.probabilityThreshold,
      )
    : [];
  const m1SuggestionIds = new Set(m1Suggestions.map((o) => o.opportunityId));
  for (const o of m1Suggestions) {
    if (inBoard.has(o.opportunityId)) continue;
    const row: ForecastV2Row = {
      opportunityId: o.opportunityId,
      client: clientLabel(o.client),
      owner: o.owner,
      stage: o.stage,
      gmv: o.gmv,
      kanbanMonth: o.kanbanMonth,
      kanbanRaw: null,
      isStandby: o.isStandby,
      perspectiveMonth: null,
      perspectiveGmv: null,
      perspectiveRawGmv: null,
      perspectiveConfidence: null,
      movement: "non_comparable",
      nextExpectedEvent: null,
      nextExpectedLabel: null,
      milestoneStatus: null,
      reading: null,
      expectedProbability: o.probability,
      expectedGmv: o.expectedGmv,
      standbyUntil: o.standbyUntil,
      frozenMonthEnd: o.frozenM1,
      outsideKanban: true,
    };
    const list = extras.get(o.owner) ?? [];
    list.push(row);
    extras.set(o.owner, list);
  }

  if (available) {
    for (const e of snapshot!.opportunities) {
      if (inBoard.has(e.opportunityId)) continue;
      const row: ForecastV2Row = {
        opportunityId: e.opportunityId,
        client: clientLabel(e.client),
        owner: e.owner,
        stage: e.stage,
        gmv: e.gmv,
        kanbanMonth: e.kanbanMonth,
        kanbanRaw: null,
        isStandby: e.isStandby,
        perspectiveMonth: null,
        perspectiveGmv: null,
        perspectiveRawGmv: null,
        perspectiveConfidence: null,
        movement: "non_comparable",
        nextExpectedEvent: null,
        nextExpectedLabel: e.nextMilestone,
        milestoneStatus: null,
        reading: null,
        expectedProbability: e.pMonthEnd,
        expectedGmv: e.expectedMonthEnd,
        standbyUntil: e.standbyUntil,
        frozenMonthEnd: e.frozenMonthEnd,
        outsideKanban: true,
      };
      const list = extras.get(e.owner) ?? [];
      list.push(row);
      extras.set(e.owner, list);
    }
  }

  const owners = new Set<string>([
    ...board.salespeople.map((s) => s.salesperson),
    ...extras.keys(),
    ...signedByOwner.keys(),
  ]);

  const reference = available && board.region.kanbanGmv > 0
    ? snapshot!.region.expectedRemaining / board.region.kanbanGmv
    : null;

  const salespeople: ForecastV2Salesperson[] = [...owners]
    .map((owner) => {
      const block = board.salespeople.find((s) => s.salesperson === owner);
      const rows = [...attach(block?.opportunities ?? []), ...(extras.get(owner) ?? [])];
      const expectedGmv = rows.reduce((t, r) => t + (r.expectedGmv ?? 0), 0);
      const signedGmvActual = signedByOwner.get(owner) ?? 0;
      const kanbanGmv = block?.kanbanGmv ?? 0;
      return {
        salesperson: owner,
        firstName: block?.firstName ?? owner.split(" ")[0],
        count: rows.length,
        gmv: rows.reduce((t, r) => t + (r.gmv ?? 0), 0),
        kanbanGmv,
        perspectiveGmv: block?.perspectiveGmv ?? 0,
        perspectiveSnapshotGmv: block?.perspectiveSnapshotGmv ?? 0,
        signedCount: block?.signedCount ?? 0,
        signedGmv: block?.signedGmv ?? 0,
        signedGmvActual,
        opportunities: rows,
        expectedGmv,
        expectedFinish: signedGmvActual + expectedGmv,
        divergence: qualify(expectedGmv, kanbanGmv, reference),
      };
    })
    .filter((s) => s.count > 0 || s.signedGmvActual > 0)
    .sort((a, b) => a.salesperson.localeCompare(b.salesperson, "fr"));

  // Les totaux Région sont resommés depuis les commerciaux, qui sont eux-mêmes
  // sommés depuis leurs lignes. Un seul chemin, donc écart nul par construction.
  const expectedRemaining = salespeople.reduce((t, s) => t + s.expectedGmv, 0);
  const signedGmvActual = salespeople.reduce((t, s) => t + s.signedGmvActual, 0);
  const expectedFinish = signedGmvActual + expectedRemaining;

  // Les quantiles portent sur le restant à signer. Le signé est acquis : il ne
  // se tire pas au sort, il s'ajoute. Le service les livre déjà ainsi.
  const p10 = available ? snapshot!.region.p10 : 0;
  const p50 = available ? snapshot!.region.p50 : 0;
  const p90 = available ? snapshot!.region.p90 : 0;

  if (available) {
    const drift = Math.abs(expectedRemaining - snapshot!.region.expectedRemaining);
    if (drift > 0.01) {
      issues.push(
        `Expected Forecast (${expectedRemaining.toFixed(2)} €) diffère du service (${snapshot!.region.expectedRemaining.toFixed(2)} €).`,
      );
    }
  }

  const region: ForecastV2Region = {
    // `count` reste celui du Kanban : ajouter les affaires scorées mais non
    // projetées ferait dire « Projection Kanban sur N affaires » avec un N qui
    // n'a rien de déclaratif.
    ...board.region,
    scoredCount: salespeople.reduce(
      (t, s) => t + s.opportunities.filter((o) => o.expectedGmv != null).length,
      0,
    ),
    expectedRemaining,
    signedGmvActual,
    expectedFinish,
    p10,
    p50,
    p90,
    // Au niveau Région, la couverture EST la référence : la comparer à
    // elle-même donnerait toujours « proche », ce qui ne veut rien dire. On
    // publie donc l'écart et la couverture, sans qualification.
    divergence: {
      level: "non_qualifie",
      gap: expectedRemaining - board.region.kanbanGmv,
      coverage: board.region.kanbanGmv > 0 ? expectedRemaining / board.region.kanbanGmv : null,
      relative: null,
    },
    expectedGapToObjective:
      board.region.objective == null ? null : board.region.objective - expectedFinish,
  };

  return {
    ...board,
    region,
    salespeople,
    expected: available ? snapshot : null,
    expectedM1: m1Available ? m1 : null,
    horizon,
    expectedAvailable: horizon === 1 ? m1Available : available,
    expectedUnavailableReason: reason,
    // M : les trois règles historiques. M+1 : le seul motif validé. M+2 : rien.
    examine:
      horizon === 0
        ? available
          ? examine(salespeople, board.month)
          : []
        : horizon === 1
          ? examineM1(salespeople, m1SuggestionIds)
          : [],
    issues,
  };
}

/**
 * Lignes jaunes M+1.
 *
 * Aucune règle inventée ici : la sélection a déjà été faite par
 * `eligibleM1Suggestions`, cette fonction ne fait que rattacher le motif aux
 * lignes correspondantes. Un seul motif existe à cet horizon — C8.1 n'a validé
 * aucun seuil permettant de qualifier de fragile une affaire déjà déclarée sur
 * M+1, et le rapport demande explicitement de ne rien inventer dans ce cas.
 */
function examineM1(
  salespeople: ForecastV2Salesperson[],
  suggestionIds: Set<string>,
): ForecastV2Examine[] {
  return salespeople
    .flatMap((s) => s.opportunities)
    .filter((r) => suggestionIds.has(r.opportunityId))
    .sort((a, b) => (b.expectedProbability ?? 0) - (a.expectedProbability ?? 0))
    .map((row) => ({
      row,
      kind: "non_prevue_m1" as const,
      reason: `${((row.expectedProbability ?? 0) * 100).toFixed(0)} % de chance de signer, pas prévue par le commercial`,
    }));
}

/**
 * Liste « À challenger ». Trois règles énoncées en clair, aucun algorithme.
 *
 *   1. l'affaire porte un GMV probable réel mais n'est projetée sur aucun mois ;
 *   2. elle est projetée sur le mois suivant alors qu'elle pourrait signer ce
 *      mois-ci ;
 *   3. elle est prévue sur le mois pour un GMV important alors que sa chance de
 *      signer est très faible.
 *
 * Les stand-by gelés en sont exclus : leur absence du mois est délibérée et déjà
 * expliquée par leur date de réveil.
 */
function examine(salespeople: ForecastV2Salesperson[], month: string): ForecastV2Examine[] {
  const c = FORECAST_DIVERGENCE;
  const rows = salespeople.flatMap((s) => s.opportunities);
  const nextMonth = (() => {
    const [y, m] = month.split("-").map(Number);
    return m === 12 ? `${y + 1}-01` : `${y}-${String(m + 1).padStart(2, "0")}`;
  })();

  const outside = rows
    .filter(
      (r) => r.outsideKanban && !r.frozenMonthEnd && (r.expectedGmv ?? 0) >= c.minExpectedOutsideKanban,
    )
    .sort((a, b) => (b.expectedGmv ?? 0) - (a.expectedGmv ?? 0))
    .map((row): ForecastV2Examine => ({
      row,
      kind: row.kanbanMonth === nextMonth ? "prevue_mois_suivant" : "absente_du_mois",
      reason:
        row.kanbanMonth === nextMonth
          ? "Prévue le mois prochain, mais elle pourrait signer ce mois-ci"
          : row.kanbanMonth
            ? `Prévue sur ${row.kanbanMonth}, pas sur ce mois`
            : "Aucune prévision commerciale sur un mois",
    }));

  const fragile = rows
    .filter(
      (r) =>
        !r.outsideKanban &&
        !r.frozenMonthEnd &&
        (r.gmv ?? 0) >= c.minKanbanFragile &&
        r.expectedProbability != null &&
        r.expectedProbability < c.fragileProbability,
    )
    .sort((a, b) => (b.gmv ?? 0) - (a.gmv ?? 0))
    .map((row): ForecastV2Examine => ({
      row,
      kind: "declaree_fragile",
      reason: `Prévue ce mois, mais ${((row.expectedProbability ?? 0) * 100)
        .toFixed(1)
        .replace(".", ",")} % de chance de signer`,
    }));

  // Alternance, pour qu'une seule catégorie n'occupe pas toute la liste.
  const out: ForecastV2Examine[] = [];
  const max = Math.max(outside.length, fragile.length);
  for (let i = 0; i < max; i += 1) {
    if (outside[i]) out.push(outside[i]);
    if (fragile[i]) out.push(fragile[i]);
  }
  return out;
}
