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

import { EXPECTED_CHALLENGE, EXPECTED_M1, FORECAST_CHALLENGE, FORECAST_DIVERGENCE, FORECAST_VISIBILITY } from "./config";
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
import type { AdjustedPerspective } from "./sources/adjusted-perspective-parser";
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
  /**
   * Affaire signée dans le mois affiché, au sens `official-signed` (réalisé,
   * source unique). Une ligne signée n'est ni projetée, ni probable, ni
   * challengeable : elle est acquise. Voir `isVisibleInForecast`.
   */
  isSignedRow: boolean;
};

export type ForecastV2Salesperson = Omit<ForecastSalespersonBlock, "opportunities"> & {
  opportunities: ForecastV2Row[];
  expectedGmv: number;
  /** Signé mesuré sur la transition réelle vers une étape post-signature. */
  signedGmvActual: number;
  /**
   * Reste annoncé : GMV brut des lignes OUVERTES de la Perspective M de ce
   * commercial, hors affaires déjà signées au sens Travaux. Jamais reconstruit.
   */
  declaredOpenGmv: number;
  declaredOpenCount: number;
  expectedFinish: number;
  divergence: Divergence;
};

export type ForecastV2Region = ForecastMonthBoard["region"] & {
  /** Affaires portant un Expected. Distinct de `count`, qui compte le Kanban. */
  scoredCount: number;
  /** Lignes Travaux du signé officiel (originales, avenants, annulations). `signedCount` compte des affaires. */
  signedLines: number;
  expectedRemaining: number;
  signedGmvActual: number;
  /** Σ reste annoncé des commerciaux (Perspective M, brut, hors signé). */
  declaredOpenGmv: number;
  declaredOpenCount: number;
  /** Atterrissage commercial = Signé à date + reste annoncé. Information secondaire. */
  commercialLanding: number;
  /**
   * Perspective ajustée : analyse manuelle de la Région, onglet du mois affiché.
   * Rattachée par la page (lecture du classeur, asynchrone) ; nulle ici, et nulle
   * si le classeur est illisible — jamais remplacée par une autre valeur.
   */
  adjustedPerspective: AdjustedPerspective | null;
  /** Pourquoi elle est absente, quand elle l'est. */
  adjustedPerspectiveNote: string | null;
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
 * Les affaires abandonnées, elles, ne remontent pas jusqu'ici : le périmètre du
 * mois écarte les affaires terminales non signées (`forecast-board`) et le
 * service Expected écarte les affaires devenues terminales ou disparues de la
 * source (`expected-gmv-live`). L'exclusion est faite à la donnée, pas à
 * l'affichage — c'est ce qui la rend vraie sur tous les écrans à la fois. Les
 * affaires SIGNÉES, elles, sont réintroduites explicitement par
 * `buildForecastV2` (famille A) : voir `isVisibleInForecast`.
 */
export function isFrozenOut(row: ForecastV2Row, today: string): boolean {
  return row.isStandby && row.standbyUntil != null && row.standbyUntil.slice(0, 10) > today;
}

/**
 * LA règle de visibilité du Forecast. Une seule, sans exception ni dépliage.
 *
 *   1. signée dans le mois affiché (réalisé, source `official-signed`) →
 *      toujours visible. C'est un fait acquis, pas une prévision : aucun seuil
 *      de probabilité, aucun stand-by ne peut l'écarter ;
 *   2. déclarée par le commercial sur ce mois → visible, quelle que soit sa
 *      probabilité. C'est son engagement, il doit pouvoir être confronté ;
 *   3. non déclarée → visible seulement à partir de 25 % de chance de signer
 *      d'ici la fin du mois ;
 *   4. stand-by dont la date de réveil est devant nous → jamais visible.
 *
 * Une affaire non déclarée sous le seuil est ABSENTE de la page : pas de ligne,
 * pas d'accordéon, pas de compteur qui propose de l'afficher. Forecast sert à
 * arbitrer un mois, pas à explorer le pipe faible — celui-ci reste entier dans
 * Expected GMV, dans Monitoring et dans Salesforce.
 *
 * Les affaires abandonnées ne remontent pas jusqu'ici : elles sont écartées à
 * la donnée (`forecast-board` exclut les affaires terminales non signées,
 * `expected-gmv-live` écarte celles devenues terminales ou disparues de la
 * source), ce qui les rend absentes de tous les écrans à la fois.
 */
export function isVisibleInForecast(
  row: ForecastV2Row,
  month: MonthKey,
  today: string,
): boolean {
  if (row.isSignedRow) return true;
  if (isFrozenOut(row, today)) return false;
  return isDeclaredOnMonth(row, month) || isProbableOnMonth(row);
}

export type ForecastTableMode = "all" | "remaining";

/**
 * Mode de lecture du TABLEAU. « Reste à signer » masque uniquement les lignes déjà
 * signées ; il ne touche ni le bandeau ni aucun total, qui sont calculés avant.
 */
export function applyTableMode<T extends { isSignedRow: boolean }>(
  rows: T[],
  mode: ForecastTableMode,
): T[] {
  return mode === "remaining" ? rows.filter((r) => !r.isSignedRow) : rows;
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
export function buildForecastV2(
  monthOffset: number,
  objective?: number | null,
  now: Date = new Date(),
): ForecastV2Board {
  const horizon = (monthOffset <= 0 ? 0 : monthOffset >= 2 ? 2 : 1) as 0 | 1 | 2;
  const board = buildForecastBoard(monthOffset, objective ?? null, now);
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
  // Affaires DISTINCTES signées par commercial. Une affaire porte plusieurs
  // lignes Travaux (l'originale, ses avenants, ses annulations) : compter les
  // lignes ferait dire « 33 affaires » pour 28.
  const signedOppsByOwner = new Map<string, Set<string>>();
  for (const line of official.rows) {
    if (!line.salesperson || !line.opportunityId) continue;
    const set = signedOppsByOwner.get(line.salesperson) ?? new Set<string>();
    set.add(line.opportunityId);
    signedOppsByOwner.set(line.salesperson, set);
  }

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
        isSignedRow: false,
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
      isSignedRow: false,
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
        isSignedRow: false,
      };
      const list = extras.get(e.owner) ?? [];
      list.push(row);
      extras.set(e.owner, list);
    }
  }

  // --- Famille A : affaires SIGNÉES dans le mois affiché.
  //
  // Réalisé, jamais prévision : une ligne signée ne porte ni probabilité ni
  // motif de challenge (FC11 et les tests Forecast l'exigent), et son GMV vient
  // de la même source unique que le total « Signé » de la bande au-dessus
  // (`official-signed`), pour que la ligne et le total ne puissent jamais
  // diverger. Un même dossier peut porter plusieurs lignes Travaux dans le mois
  // (avenant, moins-value) : elles sont fusionnées en une seule ligne par
  // affaire, sinon la même OpportunityId apparaîtrait deux fois (FC5).
  const signedRowsByOwner = new Map<string, ForecastV2Row[]>();
  const signedIds = new Set<string>();
  {
    const byOpportunity = new Map<
      string,
      { opportunityId: string; client: string; owner: string; gmv: number }
    >();
    for (const line of official.rows) {
      const key = line.opportunityId ?? `travaux:${line.travauxId}`;
      const existing = byOpportunity.get(key);
      if (existing) existing.gmv += line.gmv;
      else
        byOpportunity.set(key, {
          opportunityId: key,
          client: line.client ?? key,
          owner: line.salesperson ?? "",
          gmv: line.gmv,
        });
    }
    for (const [id, deal] of byOpportunity) {
      if (!deal.owner) continue;
      signedIds.add(id);
      const row: ForecastV2Row = {
        opportunityId: id,
        client: clientLabel(deal.client),
        owner: deal.owner,
        stage: null,
        gmv: deal.gmv,
        kanbanMonth: null,
        kanbanRaw: null,
        isStandby: false,
        perspectiveMonth: null,
        perspectiveGmv: null,
        perspectiveRawGmv: null,
        perspectiveConfidence: null,
        movement: "signee",
        nextExpectedEvent: null,
        nextExpectedLabel: null,
        milestoneStatus: null,
        reading: null,
        expectedProbability: null,
        expectedGmv: null,
        standbyUntil: null,
        frozenMonthEnd: false,
        outsideKanban: true,
        isSignedRow: true,
      };
      const list = signedRowsByOwner.get(deal.owner) ?? [];
      list.push(row);
      signedRowsByOwner.set(deal.owner, list);
    }
  }

  // --- Reste annoncé : lignes ouvertes de la Perspective M, lues telles quelles.
  // Une ligne encore « ouverte » dans le classeur mais déjà signée côté Travaux
  // est retirée : elle est comptée dans Signé, la compter ici l'ajouterait deux
  // fois à l'atterrissage.
  const declaredByOwner = new Map<string, { gmv: number; count: number }>();
  for (const l of board.declaredOpen) {
    if (l.opportunityId && signedIds.has(l.opportunityId)) continue;
    const cur = declaredByOwner.get(l.owner) ?? { gmv: 0, count: 0 };
    declaredByOwner.set(l.owner, { gmv: cur.gmv + l.gmv, count: cur.count + 1 });
  }

  const owners = new Set<string>([
    ...board.salespeople.map((s) => s.salesperson),
    ...extras.keys(),
    ...signedByOwner.keys(),
    ...declaredByOwner.keys(),
  ]);

  const reference = available && board.region.kanbanGmv > 0
    ? snapshot!.region.expectedRemaining / board.region.kanbanGmv
    : null;

  const salespeople: ForecastV2Salesperson[] = [...owners]
    .map((owner) => {
      const block = board.salespeople.find((s) => s.salesperson === owner);
      // Une affaire tout juste signée peut rester un instant dans le Kanban ou
      // dans le scoring Expected, le temps du prochain import : la ligne signée
      // prime toujours, pour qu'aucun dossier ne compte deux fois (FC5) ni ne
      // reste « à challenger » (test F : signée = jamais challengée).
      const notYetSigned = (r: ForecastV2Row) => !signedIds.has(r.opportunityId);
      const rows = [
        ...attach(block?.opportunities ?? []).filter(notYetSigned),
        ...(extras.get(owner) ?? []).filter(notYetSigned),
        ...(signedRowsByOwner.get(owner) ?? []),
      ];
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
        // Le « signé » présenté est UNIQUEMENT le signé officiel (Travaux). Les
        // valeurs par étape Salesforce du tableau de bord interne
        // (`block.signedGmv`, `block.signedCount`) ne sortent plus d'ici : deux
        // chiffres différents ne doivent jamais porter le même nom.
        signedCount: signedOppsByOwner.get(owner)?.size ?? 0,
        signedGmv: signedGmvActual,
        signedGmvActual,
        declaredOpenGmv: declaredByOwner.get(owner)?.gmv ?? 0,
        declaredOpenCount: declaredByOwner.get(owner)?.count ?? 0,
        opportunities: rows,
        expectedGmv,
        expectedFinish: signedGmvActual + expectedGmv,
        divergence: qualify(expectedGmv, kanbanGmv, reference),
      };
    })
    .filter((s) => s.count > 0 || s.signedGmvActual > 0 || s.declaredOpenGmv > 0)
    .sort((a, b) => a.salesperson.localeCompare(b.salesperson, "fr"));

  // Les totaux Région sont resommés depuis les commerciaux, qui sont eux-mêmes
  // sommés depuis leurs lignes. Un seul chemin, donc écart nul par construction.
  const expectedRemaining = salespeople.reduce((t, s) => t + s.expectedGmv, 0);
  const signedGmvActual = salespeople.reduce((t, s) => t + s.signedGmvActual, 0);
  const expectedFinish = signedGmvActual + expectedRemaining;
  const declaredOpenGmv = salespeople.reduce((t, s) => t + s.declaredOpenGmv, 0);
  const declaredOpenCount = salespeople.reduce((t, s) => t + s.declaredOpenCount, 0);

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
    // Signé officiel, seule définition présentée : somme des lignes Travaux
    // signées ou réalisées (`officialSignedGmv`). Le nombre d'affaires compte
    // des affaires distinctes, pas des lignes. Les mêmes clés du tableau interne
    // (par étape Salesforce) sont ÉCRASÉES ici.
    signedGmv: signedGmvActual,
    signedCount: official.opportunities,
    signedLines: official.lines,
    signedPlusKanban: signedGmvActual + board.region.kanbanGmv,
    gapToObjective:
      board.region.objective == null ? null : signedGmvActual + board.region.kanbanGmv - board.region.objective,
    scoredCount: salespeople.reduce(
      (t, s) => t + s.opportunities.filter((o) => o.expectedGmv != null).length,
      0,
    ),
    expectedRemaining,
    signedGmvActual,
    declaredOpenGmv,
    declaredOpenCount,
    commercialLanding: signedGmvActual + declaredOpenGmv,
    adjustedPerspective: null,
    adjustedPerspectiveNote: null,
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
 * « À challenger » dans Forecast — lot de simplification, E1.
 *
 * Forecast ne propose d'ajouter au mois qu'une affaire que RM Morning juge
 * réellement probable : chance de signer sur le mois affiché STRICTEMENT
 * supérieure à 25 % (`FORECAST_CHALLENGE.minProbability`), probabilité RM
 * Morning canonique (`expectedProbability`). Une affaire exactement à 25 % reste
 * visible (règle de visibilité ≥ 25 %) mais n'est pas proposée.
 *
 * Les affaires DÉCLARÉES mais fragiles (`declaree_fragile`) ne sont pas des
 * challengers de Forecast : leur probabilité est par construction très faible.
 * Elles restent dans le moteur (`examine`, Plan du jour) et Expected GMV les
 * explique dans l'écart commerciaux / RM Morning.
 *
 * Source unique : Forecast, Ma semaine et Expected GMV lisent cette liste.
 */
export function forecastChallengers(board: Pick<ForecastV2Board, "examine">): ForecastV2Examine[] {
  return board.examine.filter(
    (e) =>
      e.kind !== "declaree_fragile" &&
      (e.row.expectedProbability ?? 0) > FORECAST_CHALLENGE.minProbability,
  );
}

/**
 * « À challenger » dans Expected GMV, mois en cours — lot de simplification (F9,
 * F10). Plus large que Forecast : pMonthEnd STRICTEMENT > 15 %, et un impact
 * crédible sur l'écart (GMV probable ≥ `EXPECTED_CHALLENGE.minExpectedGap`).
 * Aucune limite de nombre : 3 affaires passent → 3, 11 → 11.
 *
 * Celles qui dépassent aussi 25 % sont déjà proposées dans Forecast : elles
 * restent listées (jamais de disparition silencieuse) mais marquées
 * `inForecast`, pour que l'écran n'en répète pas l'alerte.
 */
export function expectedChallengers(
  board: Pick<ForecastV2Board, "examine">,
): (ForecastV2Examine & { inForecast: boolean })[] {
  const forecast = new Set(forecastChallengers(board).map((e) => e.row.opportunityId));
  return board.examine
    .filter(
      (e) =>
        e.kind !== "declaree_fragile" &&
        (e.row.expectedProbability ?? 0) > EXPECTED_CHALLENGE.minProbability &&
        (e.row.expectedGmv ?? 0) >= EXPECTED_CHALLENGE.minExpectedGap,
    )
    .map((e) => ({ ...e, inForecast: forecast.has(e.row.opportunityId) }))
    .sort((a, b) => (b.row.expectedGmv ?? 0) - (a.row.expectedGmv ?? 0) || a.row.client.localeCompare(b.row.client, "fr"));
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
