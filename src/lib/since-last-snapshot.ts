/**
 * Bloc « Depuis [la dernière photo] » (V3.1) et Momentum 7 jours de
 * Performance (V3.2) — UN SEUL moteur.
 *
 * Répond à deux questions avec le MÊME calcul, juste une fenêtre différente :
 * qu'est-ce qui a changé depuis la dernière photo fiable du pipe (Morning,
 * V3.1), et qu'est-ce que chaque commercial a réellement fait avancer ou
 * perdre sur ~7 jours (Performance, V3.2) ? Ni flux d'activité Salesforce ni
 * nouveau moteur de Forecast : tout ce fichier compose des primitives qui
 * existent déjà ailleurs et tournent en production (`previousSnapshotDate`,
 * `loadSnapshot`, `FORECAST_THRESHOLDS`, `officialSignedBetween`, l'horloge
 * métier Europe/Paris).
 *
 * Quatre étages, volontairement séparés :
 *   1. `computeOpportunityDelta` — le calcul BRUT des différences d'UNE
 *      opportunité entre deux photos. Pur, sans base de données.
 *   2. `computeRawChanges`       — l'agrégation : parcourt tout le pipe,
 *      fusionne les signatures officielles, calcule les KPI. Partagée telle
 *      quelle par `buildBusinessDelta` (V3.1) ET `buildMomentum` (V3.2) —
 *      seuls `today`/`baselineDate` changent d'un appelant à l'autre.
 *   3. `selectSignificantChanges` — la sélection/priorisation pour l'affichage,
 *      réutilisée par les deux blocs.
 *   4. `buildMomentum`           — groupe le résultat de l'étage 2 par
 *      commercial (V3.2 uniquement ; V3.1 reste une liste plate).
 *
 * DOCTRINE, non négociable (audit V3.1, §3-6 ; étendue V3.2 §1, §5) :
 *   — jamais de jugement positif/négatif sur un changement de stade : aucun
 *     ordre de stade n'est validé pour ce moteur ;
 *   — une variation de GMV n'entre que via `isSignificantGmvChangeForDailyDelta`
 *     (décision du 22/09/2026) : ≥20 k€ en valeur absolue comme le Forecast,
 *     OU ≥15 % mais SEULEMENT si l'affaire pèse ≥50 k€ (avant ou après) —
 *     sinon un ≥15 % sur une toute petite affaire (ex. +6 942 % sur 353 €)
 *     remontait comme un mouvement significatif. Seuil propre à CE bloc ;
 *     `isSignificantGmvChange` (forecast.ts) reste inchangée pour le Forecast ;
 *   — un déplacement Kanban n'entre que si l'ancien ET le nouveau mois sont
 *     connus, et seulement s'il touche le mois métier courant (M) ;
 *   — apparition/disparition d'opportunité entre deux photos : PAS un
 *     événement commercial en V3.1 (signal non fiable, cf. audit §4) ;
 *   — changement de commercial : hors-scope V3.1 (signal jamais observé) ;
 *   — une affaire = une ligne, même si plusieurs dimensions ont bougé ;
 *   — Momentum (V3.2) : aucun score, aucun classement, aucune métrique
 *     d'activité (mails, tâches, déclaratif) — uniquement des artefacts
 *     business observables, agrégés depuis les mêmes dimensions que V3.1 ;
 *   — pas de double comptage DANS une dimension (une affaire ne compte
 *     jamais deux fois dans `signed`, `gmvUp`, etc. — garanti par la même
 *     Map par `opportunityId` qu'en V3.1) ; une affaire PEUT légitimement
 *     alimenter plusieurs dimensions différentes (signée ET changement de
 *     stade ET hausse de GMV), ce n'est pas un doublon ;
 *   — aucune métrique « nette » (GMV entrée M + signée − sortie M) : `signed`
 *     vient de Travaux (GMV RÉALISÉE) et `enteredM`/`exitedM` du champ Kanban
 *     de l'Opportunity (GMV DÉCLARÉE) — deux sources que C10 interdit déjà de
 *     sommer comme un même argent. Voir `buildMomentum` ;
 *   — Momentum (V3.2) ne porte que sur les commerciaux/ET PILOTÉS :
 *     `ATTENTION.excluded` (config.ts), la même liste que `morning-priority.ts`,
 *     `week.ts` et `owner-signals.ts` — jamais un second nom en dur. Le
 *     directeur régional peut porter quelques affaires lui-même sans
 *     apparaître comme une ligne de performance personnelle.
 */

import { businessMonth } from "./business-time";
import { ATTENTION, MOMENTUM_SCORE, FORECAST_THRESHOLDS, SINCE_LAST_SNAPSHOT } from "./config";
import { addDays, daysBetween, kanbanPeriodLabel } from "./normalize";
import {
  officialSignedBetween,
  travauxFreshnessDate,
  type OfficialSignedLine,
} from "./official-signed";
import { latestImport, loadSnapshot, previousSnapshotDate, type SnapshotLine } from "./repository";
import { loadTeam } from "./team-store";
import type { Opportunity } from "./types";

// --- Étage 1 : calcul brut ---------------------------------------------------

/** Ce dont une comparaison a besoin — `Opportunity` et `SnapshotLine` conviennent tel quel. */
export type ComparableState = {
  gmv: number | null;
  stage: string | null;
  kanbanMonth: number | null;
  kanbanYear: number | null;
  isStandby: boolean;
};

export type StageChange = { from: string | null; to: string };
export type GmvChange = { from: number; to: number; delta: number; suspicious: boolean };
export type KanbanChange = {
  fromLabel: string;
  toLabel: string;
  /** L'affaire vient d'entrer dans le mois métier courant. */
  enteredM: boolean;
  /** L'affaire vient de sortir du mois métier courant. */
  exitedM: boolean;
};
export type StandbyChange = { enteredStandby: boolean };

/** Différences brutes d'UNE opportunité entre deux photos. `null` = rien de suivable n'a changé. */
export type RawOpportunityChange = {
  stageChange: StageChange | null;
  gmvChange: GmvChange | null;
  kanbanChange: KanbanChange | null;
  standbyChange: StandbyChange | null;
};

/**
 * Variation de GMV significative pour LE DELTA QUOTIDIEN MANAGER (ce bloc)
 * — distincte de `isSignificantGmvChange` (forecast.ts), qu'elle ne touche
 * pas. Réutilise les mêmes constantes `FORECAST_THRESHOLDS` : ≥20 k€ en
 * valeur absolue suffit toujours, comme au Forecast. Mais un ≥15 % seul ne
 * suffit plus : il faut en plus que l'affaire pèse au moins
 * `SINCE_LAST_SNAPSHOT.significantRatioFloor` (avant OU après) — décision du
 * 22/09/2026, verrouillée sur des cas réels de production : Carine de
 * Montgolfier (+5 129 €/+35,2 %, max 19 694 €) et Géraldine Raoul
 * (−7 879 €/−68 %, max 11 593 €) doivent être EXCLUES ; Diana Pasea
 * (+10 822 €/+16,3 %, max 77 097 €) doit rester CONSERVÉE ; Laurence Nédélec
 * (+24 507 €) reste conservée par le seul seuil absolu, quel que soit son
 * pourcentage.
 */
export function isSignificantGmvChangeForDailyDelta(before: number, after: number): boolean {
  const delta = Math.abs(after - before);
  if (delta >= FORECAST_THRESHOLDS.significantGmvDelta) return true;
  if (before <= 0 || delta / before < FORECAST_THRESHOLDS.significantGmvRatio) return false;
  return Math.max(before, after) >= SINCE_LAST_SNAPSHOT.significantRatioFloor;
}

function classifyGmvChange(before: number | null, after: number | null): GmvChange | null {
  if (before == null || after == null) return null;
  if (!isSignificantGmvChangeForDailyDelta(before, after)) return null;
  const delta = after - before;
  const absDelta = Math.abs(delta);
  const suspicious =
    absDelta >= SINCE_LAST_SNAPSHOT.suspiciousGmvDelta ||
    (before >= SINCE_LAST_SNAPSHOT.suspiciousMinGmv &&
      absDelta / before >= SINCE_LAST_SNAPSHOT.suspiciousGmvRatio);
  return { from: before, to: after, delta, suspicious };
}

/**
 * Déplacement Kanban, SEULEMENT connu → connu, et SEULEMENT s'il touche le
 * mois métier `businessMonthKey` (« AAAA-MM »). Un mois qui devient NULL ou
 * qui apparaît depuis NULL n'est jamais une transition : c'est indiscernable
 * d'un artefact d'import (audit V3.1 §6).
 */
function classifyKanbanChange(
  before: ComparableState,
  after: ComparableState,
  businessMonthKey: string,
): KanbanChange | null {
  const knownBefore = before.kanbanMonth != null && before.kanbanYear != null;
  const knownAfter = after.kanbanMonth != null && after.kanbanYear != null;
  if (!knownBefore || !knownAfter) return null;
  if (before.kanbanMonth === after.kanbanMonth && before.kanbanYear === after.kanbanYear) return null;

  const [cy, cm] = businessMonthKey.split("-").map(Number);
  const wasM = before.kanbanMonth === cm && before.kanbanYear === cy;
  const isM = after.kanbanMonth === cm && after.kanbanYear === cy;
  if (!wasM && !isM) return null; // Mouvement réel, mais ne touche pas le mois courant : hors doctrine V3.1.

  return {
    fromLabel: kanbanPeriodLabel(before.kanbanMonth, before.kanbanYear) ?? "—",
    toLabel: kanbanPeriodLabel(after.kanbanMonth, after.kanbanYear) ?? "—",
    enteredM: !wasM && isM,
    exitedM: wasM && !isM,
  };
}

/**
 * Différences brutes entre deux photos d'UNE MÊME opportunité. Pur : aucun
 * accès base, aucune mise en forme. `null` si rien d'observable n'a changé.
 */
export function computeOpportunityDelta(
  before: ComparableState,
  after: ComparableState,
  businessMonthKey: string,
): RawOpportunityChange | null {
  const stageChange: StageChange | null =
    after.stage != null && before.stage !== after.stage ? { from: before.stage, to: after.stage } : null;
  const gmvChange = classifyGmvChange(before.gmv, after.gmv);
  const kanbanChange = classifyKanbanChange(before, after, businessMonthKey);
  const standbyChange: StandbyChange | null =
    before.isStandby !== after.isStandby ? { enteredStandby: after.isStandby } : null;

  if (!stageChange && !gmvChange && !kanbanChange && !standbyChange) return null;
  return { stageChange, gmvChange, kanbanChange, standbyChange };
}

// --- Étage 2 : agrégation quotidienne ----------------------------------------

export type SignedChange = { gmv: number; signatureDate: string };

/** Une ligne affichable : une opportunité, tous ses changements retenus. */
export type OpportunityDelta = RawOpportunityChange & {
  opportunityId: string | null;
  owner: string | null;
  client: string;
  /** GMV courante connue, pour le tri et l'affichage — pas forcément celle du `gmvChange`. */
  gmv: number | null;
  signed: SignedChange | null;
};

export type SinceTitle =
  | { kind: "unavailable" }
  /** Une baseline existe, mais rien de plus récent n'a jamais été importé depuis : PAS « rien n'a changé ». */
  | { kind: "not-refreshed"; date: string }
  | { kind: "yesterday" }
  | { kind: "days"; date: string; days: number };

/** Un KPI du bandeau : jamais un `0` fabriqué quand la donnée est insuffisante. */
export type KpiValue = { available: boolean; count: number; gmv: number };

export type BusinessDelta = {
  today: string;
  baselineDate: string | null;
  title: SinceTitle;
  /** Aucune baseline exploitable : le bloc entier doit se dégrader proprement. */
  available: boolean;

  signed: KpiValue & {
    /** Jour jusqu'auquel le GMV signé est réellement couvert (fraîcheur Travaux). */
    coveredThrough: string | null;
    /** Vrai si `coveredThrough` est antérieur à `today` : afficher la mention de fraîcheur. */
    stale: boolean;
  };
  enteredM: KpiValue;
  exitedM: KpiValue;
  stageChanged: KpiValue;

  /** Toutes les opportunités avec au moins un changement retenu, non triées. */
  changes: OpportunityDelta[];
};

const clientLabelOf = (o: { name: string | null; clientContact: string | null }, fallbackId: string) =>
  o.clientContact ?? o.name ?? fallbackId;

/**
 * `current` (la table `opportunity`) n'est PAS une photo datée : elle est
 * écrasée à chaque import, sans porter elle-même sa date. Sa fraîcheur réelle
 * vient de `import_run` (voir `repository.latestImport`), pas d'une colonne
 * de `Opportunity`. Cette fonction dit si cette fraîcheur dépasse réellement
 * la baseline — le seul cas où comparer `current` à `baseline` constitue une
 * VRAIE comparaison entre deux états distincts.
 *
 * Si `current` provient du même import que la baseline (ou d'un import plus
 * ancien, ce qui ne devrait pas arriver mais reste gardé), il n'y a RIEN à
 * comparer : `current` et `baseline` sont la même photographie. Afficher
 * « rien de significatif » dans ce cas dirait un fait qu'on n'a pas observé —
 * la bonne phrase est « non rafraîchi depuis [baseline] » (audit V3.1, §3).
 */
export function isRefreshedSinceBaseline(baselineDate: string, dataAsOf: string | null): boolean {
  return dataAsOf != null && dataAsOf > baselineDate;
}

export type SignedCoverage = { available: boolean; coveredThrough: string | null; stale: boolean };

/**
 * Décide jusqu'où le GMV signé est réellement couvert, à partir de la seule
 * fraîcheur Travaux — sans toucher la base. `available = false` quand Travaux
 * n'a jamais été réimportée depuis `baselineDate` : dans ce cas précis, « 0 €
 * signé » ne serait pas un fait mais une absence de donnée, et ne doit jamais
 * s'afficher comme si c'en était un (audit V3.1 §3.A / §7).
 */
export function resolveSignedCoverage(
  today: string,
  baselineDate: string,
  travauxFreshness: string | null,
): SignedCoverage {
  if (travauxFreshness == null || travauxFreshness <= baselineDate) {
    return { available: false, coveredThrough: null, stale: false };
  }
  const coveredThrough = travauxFreshness < today ? travauxFreshness : today;
  return { available: true, coveredThrough, stale: coveredThrough < today };
}

/**
 * Fusionne des lignes Travaux officielles dans la map de changements déjà
 * construite depuis les snapshots : une opportunité déjà présente (stade,
 * GMV, Kanban, stand-by) reçoit son `signed` en plus, sans dupliquer la
 * ligne ; une opportunité signée mais absente du delta snapshot (sortie du
 * périmètre actif, par exemple) devient sa propre ligne minimale.
 *
 * Une opportunité peut porter PLUSIEURS lignes Travaux dans la fenêtre —
 * l'originale et un avenant, par exemple (même définition que
 * `officialSignedGmv` : avenants et annulations inclus, montants négatifs
 * compris). Elles sont donc SOMMÉES, jamais la dernière ligne ne remplace les
 * précédentes ; la date affichée est la plus récente des signatures.
 */
export function mergeSignedLines(
  changes: Map<string, OpportunityDelta>,
  rows: OfficialSignedLine[],
): void {
  for (const line of rows) {
    const key = line.opportunityId ?? line.travauxId;
    const prior = changes.get(key)?.signed ?? null;
    const signed: SignedChange = {
      gmv: (prior?.gmv ?? 0) + line.gmv,
      signatureDate: prior && prior.signatureDate > line.signatureDate ? prior.signatureDate : line.signatureDate,
    };
    const existing = changes.get(key);
    if (existing) {
      existing.signed = signed;
    } else {
      changes.set(key, {
        opportunityId: line.opportunityId,
        owner: line.salesperson,
        client: line.client ?? key,
        gmv: line.gmv,
        stageChange: null,
        gmvChange: null,
        kanbanChange: null,
        standbyChange: null,
        signed,
      });
    }
  }
}

const noDataDelta = (
  today: string,
  baselineDate: string | null,
  title: SinceTitle,
): BusinessDelta => ({
  today,
  baselineDate,
  title,
  available: false,
  signed: { available: false, count: 0, gmv: 0, coveredThrough: null, stale: false },
  enteredM: { available: false, count: 0, gmv: 0 },
  exitedM: { available: false, count: 0, gmv: 0 },
  stageChanged: { available: false, count: 0, gmv: 0 },
  changes: [],
});

type RawChanges = {
  changes: Map<string, OpportunityDelta>;
  signed: BusinessDelta["signed"];
  enteredM: KpiValue;
  exitedM: KpiValue;
  stageChanged: KpiValue;
};

/**
 * Calcul BRUT partagé entre `buildBusinessDelta` (Morning, baseline = « la
 * dernière photo ») et `buildMomentum` (Performance, baseline = « il y a
 * ~7 jours ») : parcourt tout le pipe, fusionne les signatures officielles,
 * accumule les KPI. Ni titre ni fenêtre — ces deux notions sont propres à
 * chaque appelant, PAS à ce calcul.
 *
 * Suppose déjà vérifié : `baselineDate` non nul et `current` réellement plus
 * frais qu'elle (voir `isRefreshedSinceBaseline`) — les deux appelants le
 * garantissent avant d'appeler cette fonction.
 */
export function computeRawChanges(
  today: string,
  baselineDate: string,
  current: Opportunity[],
  baseline: Map<string, SnapshotLine>,
): RawChanges {
  const businessMonthKey = businessMonth(new Date(`${today}T12:00:00`));
  const changes = new Map<string, OpportunityDelta>();

  let enteredMCount = 0, enteredMGmv = 0;
  let exitedMCount = 0, exitedMGmv = 0;
  let stageChangedCount = 0, stageChangedGmv = 0;

  for (const opp of current) {
    const before = baseline.get(opp.opportunityId);
    if (!before) continue; // Apparition entre deux photos : hors doctrine V3.1 (audit §4).

    const raw = computeOpportunityDelta(before, opp, businessMonthKey);
    if (raw?.stageChange) { stageChangedCount += 1; stageChangedGmv += opp.gmv ?? 0; }
    if (raw?.kanbanChange?.enteredM) { enteredMCount += 1; enteredMGmv += opp.gmv ?? 0; }
    if (raw?.kanbanChange?.exitedM) { exitedMCount += 1; exitedMGmv += before.gmv ?? 0; }
    if (!raw) continue;

    changes.set(opp.opportunityId, {
      ...raw,
      opportunityId: opp.opportunityId,
      owner: opp.owner,
      client: clientLabelOf(opp, opp.opportunityId),
      gmv: opp.gmv,
      signed: null,
    });
  }

  // Fraîcheur Travaux : la couverture du "signé" s'arrête au dernier import
  // connu, jamais silencieusement à `today` — sinon un Travaux pas rejoué
  // depuis 3 jours se lirait comme « rien n'a été signé ».
  const coverage = resolveSignedCoverage(today, baselineDate, travauxFreshnessDate());

  let signedGmv = 0, signedCount = 0;
  if (coverage.available && coverage.coveredThrough) {
    const range = officialSignedBetween(baselineDate, coverage.coveredThrough);
    signedGmv = range.gmv;
    signedCount = range.opportunities;
    mergeSignedLines(changes, range.rows);
  }

  return {
    changes,
    signed: { ...coverage, count: signedCount, gmv: signedGmv },
    enteredM: { available: true, count: enteredMCount, gmv: enteredMGmv },
    exitedM: { available: true, count: exitedMCount, gmv: exitedMGmv },
    stageChanged: { available: true, count: stageChangedCount, gmv: stageChangedGmv },
  };
}

/**
 * Construit le delta métier entre `baselineDate` (la dernière photo
 * antérieure à `today`, ou `null` si aucune n'existe) et l'état courant.
 *
 * `current` est l'état COURANT (table `opportunity`, écrasée à chaque
 * import) — pas une seconde photo datée : c'est la meilleure information
 * disponible à l'instant où Morning s'affiche, exactement comme le fait déjà
 * `salesforceStandbyTransitions` dans `forecast.ts`. `dataAsOf` est la date
 * (AAAA-MM-JJ) de l'import qui a produit `current` — voir `latestImport()`
 * dans `repository.ts` — et sert UNIQUEMENT à vérifier qu'une comparaison
 * réelle a lieu : si `current` ne date pas d'après `baselineDate`, il n'y a
 * pas de seconde photo à comparer, seulement l'absence de nouvelle donnée
 * (voir `isRefreshedSinceBaseline`).
 */
export function buildBusinessDelta(
  today: string,
  baselineDate: string | null,
  current: Opportunity[],
  baseline: Map<string, SnapshotLine>,
  dataAsOf: string | null,
): BusinessDelta {
  if (!baselineDate) return noDataDelta(today, baselineDate, { kind: "unavailable" });

  if (!isRefreshedSinceBaseline(baselineDate, dataAsOf)) {
    return noDataDelta(today, baselineDate, { kind: "not-refreshed", date: baselineDate });
  }

  const days = daysBetween(baselineDate, today);
  const title: SinceTitle =
    days === 1 ? { kind: "yesterday" } : { kind: "days", date: baselineDate, days };

  const raw = computeRawChanges(today, baselineDate, current, baseline);

  return {
    today,
    baselineDate,
    title,
    available: true,
    signed: raw.signed,
    enteredM: raw.enteredM,
    exitedM: raw.exitedM,
    stageChanged: raw.stageChanged,
    changes: [...raw.changes.values()],
  };
}

/**
 * Point d'entrée pratique pour une page : calcule la baseline, lit la
 * fraîcheur réelle de `current` (`latestImport`), puis délègue.
 */
export function buildSinceLastSnapshot(
  today: string,
  current: Opportunity[],
): BusinessDelta {
  const baselineDate = previousSnapshotDate(today);
  const baseline = baselineDate ? loadSnapshot(baselineDate) : new Map<string, SnapshotLine>();
  const dataAsOf = latestImport()?.snapshotDate ?? null;
  return buildBusinessDelta(today, baselineDate, current, baseline, dataAsOf);
}

// --- Étage 3 : sélection / présentation --------------------------------------

export type ChangeCategory = "signed" | "kanban" | "gmv" | "standby" | "stage";

/** Ordre de priorité déterministe, du §6 de l'audit — pas un scoring. */
const CATEGORY_ORDER: ChangeCategory[] = ["signed", "kanban", "gmv", "standby", "stage"];

function primaryCategory(d: OpportunityDelta): ChangeCategory | null {
  if (d.signed) return "signed";
  if (d.kanbanChange) return "kanban";
  if (d.gmvChange) return "gmv";
  if (d.standbyChange) return "standby";
  if (d.stageChange) return "stage";
  return null;
}

function sortGmvOf(d: OpportunityDelta, category: ChangeCategory): number {
  if (category === "signed" && d.signed) return d.signed.gmv;
  return d.gmv ?? 0;
}

export type SelectedChange = { delta: OpportunityDelta; primaryCategory: ChangeCategory };

/**
 * Trie les changements par priorité déterministe (signature > Kanban > GMV >
 * stand-by > stade), puis par GMV réelle décroissante au sein d'une même
 * catégorie. Aucun scoring : l'ordre est entièrement explicable.
 */
export function selectSignificantChanges(changes: OpportunityDelta[]): SelectedChange[] {
  const out: SelectedChange[] = [];
  for (const d of changes) {
    const category = primaryCategory(d);
    if (!category) continue;
    out.push({ delta: d, primaryCategory: category });
  }
  out.sort((a, b) => {
    const byCategory = CATEGORY_ORDER.indexOf(a.primaryCategory) - CATEGORY_ORDER.indexOf(b.primaryCategory);
    if (byCategory !== 0) return byCategory;
    return sortGmvOf(b.delta, b.primaryCategory) - sortGmvOf(a.delta, a.primaryCategory);
  });
  return out;
}

// --- Étage 4 : Momentum 7 jours (Performance, audit V3.2) -------------------

/**
 * Impact GMV d'un changement, pour classer les mouvements par AMPLEUR plutôt
 * que par catégorie — contrairement à `selectSignificantChanges`, qui trie
 * par priorité déterministe puis GMV. Le Momentum veut « les plus gros
 * mouvements », peu importe leur nature.
 */
function impactOf(d: OpportunityDelta): number {
  if (d.signed) return d.signed.gmv;
  if (d.gmvChange) return Math.abs(d.gmvChange.delta);
  if (d.kanbanChange) return d.gmv ?? 0;
  if (d.standbyChange) return d.gmv ?? 0;
  return 0;
}

/** Nombre maximal d'affaires citées par commercial (§8 de l'audit V3.2). */
const MOMENTUM_TOP_MOVES = 3;

export type OwnerMomentum = {
  owner: string;
  signed: KpiValue;
  enteredM: KpiValue;
  exitedM: KpiValue;
  /** Hausses de GMV qualifiées (règle du delta manager) — jamais mêlées aux baisses. */
  gmvUp: KpiValue;
  /** Baisses de GMV qualifiées ; `gmv` est la somme des deltas négatifs (donc ≤ 0). */
  gmvDown: KpiValue;
  /** Pas de tendance positive/négative : aucun ordre de stade n'est validé (doctrine V3.1 §3). */
  stageChangedCount: number;
  standbyEntered: number;
  standbyReturned: number;
  /** GMV des affaires passées en stand-by / revenues actives sur la fenêtre. */
  standbyEnteredGmv: number;
  standbyReturnedGmv: number;
  /** Au plus 3, triées par ampleur de mouvement — jamais un classement de commercial. */
  topMoves: SelectedChange[];
  /**
   * Toutes les affaires du commercial qui ont bougé sur la fenêtre (une ligne
   * par affaire). Sert à « Ma semaine », qui en tire les sujets à traiter.
   */
  changes: OpportunityDelta[];
};

/**
 * Une affaire = une ligne, ici aussi : chaque opportunité de `changes`
 * n'alimente qu'UNE seule fois chacune de ses dimensions retenues (signée,
 * GMV, Kanban, stade, stand-by), par construction du Map amont — jamais deux
 * fois la même affaire dans un même compteur (audit V3.2 §5). Elle peut en
 * revanche contribuer à PLUSIEURS métriques différentes : une affaire signée
 * qui a aussi changé de stade compte dans `signed` ET dans
 * `stageChangedCount`, ce qui est voulu, pas un doublon.
 */
export function aggregateOwnerMomentum(owner: string, changes: OpportunityDelta[]): OwnerMomentum {
  let signedCount = 0, signedGmv = 0;
  let enteredCount = 0, enteredGmv = 0;
  let exitedCount = 0, exitedGmv = 0;
  let upCount = 0, upSum = 0;
  let downCount = 0, downSum = 0;
  let stageChangedCount = 0;
  let standbyEntered = 0, standbyReturned = 0;
  let standbyEnteredGmv = 0, standbyReturnedGmv = 0;

  for (const c of changes) {
    if (c.signed) { signedCount += 1; signedGmv += c.signed.gmv; }
    if (c.kanbanChange?.enteredM) { enteredCount += 1; enteredGmv += c.gmv ?? 0; }
    if (c.kanbanChange?.exitedM) { exitedCount += 1; exitedGmv += c.gmv ?? 0; }
    if (c.gmvChange) {
      if (c.gmvChange.delta > 0) { upCount += 1; upSum += c.gmvChange.delta; }
      else if (c.gmvChange.delta < 0) { downCount += 1; downSum += c.gmvChange.delta; }
    }
    if (c.stageChange) stageChangedCount += 1;
    if (c.standbyChange) {
      if (c.standbyChange.enteredStandby) { standbyEntered += 1; standbyEnteredGmv += c.gmv ?? 0; }
      else { standbyReturned += 1; standbyReturnedGmv += c.gmv ?? 0; }
    }
  }

  const topMoves = selectSignificantChanges(changes)
    .sort((a, b) => impactOf(b.delta) - impactOf(a.delta))
    .slice(0, MOMENTUM_TOP_MOVES);

  return {
    owner,
    signed: { available: true, count: signedCount, gmv: signedGmv },
    enteredM: { available: true, count: enteredCount, gmv: enteredGmv },
    exitedM: { available: true, count: exitedCount, gmv: exitedGmv },
    gmvUp: { available: true, count: upCount, gmv: upSum },
    gmvDown: { available: true, count: downCount, gmv: downSum },
    stageChangedCount,
    standbyEntered,
    standbyReturned,
    standbyEnteredGmv,
    standbyReturnedGmv,
    topMoves,
    changes,
  };
}

// --- Note de Momentum /20 (lot de simplification, C) ------------------------

export type MomentumScore = {
  /** Note sur 20, au demi-point. 10 = semaine neutre. */
  score: number;
  /** Impact pondéré en euros, avant mise à l'échelle. */
  impact: number;
  /** Les termes de la somme, pour l'explication affichée. */
  parts: { label: string; value: number }[];
};

/**
 * Note de momentum /20 — synthèse de la dynamique business OBSERVABLE des 7
 * derniers jours. Ce n'est ni une note de compétence, ni une note RH, ni une
 * performance annuelle.
 *
 *   impact = signé
 *          + ½ × entrées dans M − ½ × sorties de M
 *          + ½ × hausses GMV    − ½ × baisses GMV
 *          + ¼ × (retours actifs − passages en stand-by)      (GMV, en euros)
 *
 *   note   = 10 + 10 × borne(impact / 100 k€, −1, +1), au demi-point.
 *
 * Le signé (réalisé, Travaux) pèse plein ; les mouvements déclaratifs (Kanban,
 * montant) pèsent moitié ; le stand-by, signal plus faible, un quart. Les
 * changements de stade n'entrent pas (on ne sait pas qualifier progression et
 * régression), ni le volume d'e-mails ou de tâches.
 *
 * Pondération choisie après simulation sur 297 fenêtres de 7 jours de la copie
 * production (27 dates × 11 ET, août-septembre 2026) : quatre variantes testées,
 * classements très proches (Spearman ≥ 0,94) ; l'échelle absolue de 100 k€ est
 * au niveau du 90e centile observé de |impact| (90 k€) et ne sature qu'aux
 * extrêmes (6 % à 20/20, 2 % à 0/20). Réglages : `MOMENTUM_SCORE`.
 */
export function momentumScore(o: OwnerMomentum, rules = MOMENTUM_SCORE): MomentumScore {
  const w = rules.weights;
  const parts = [
    { label: "signé", value: w.signed * o.signed.gmv },
    { label: "entrées dans M", value: w.declared * o.enteredM.gmv },
    { label: "sorties de M", value: -w.declared * o.exitedM.gmv },
    { label: "hausses GMV", value: w.declared * o.gmvUp.gmv },
    { label: "baisses GMV", value: w.declared * o.gmvDown.gmv },
    { label: "stand-by", value: w.standby * (o.standbyReturnedGmv - o.standbyEnteredGmv) },
  ];
  const impact = parts.reduce((t, p) => t + p.value, 0);
  const raw = 10 + 10 * Math.max(-1, Math.min(1, impact / rules.scale));
  return { score: Math.round(raw * 2) / 2, impact, parts };
}

export type MomentumWindow =
  | { available: false }
  | { available: true; baselineDate: string; today: string; days: number };

export type MomentumReport = {
  window: MomentumWindow;
  /** Un commercial par ligne, y compris ceux sans aucun mouvement (liste vide) — jamais omis en silence. */
  owners: OwnerMomentum[];
  /** Affaires distinctes touchées, tous commerciaux confondus. */
  totalOpportunitiesTouched: number;
};

/** Cible de fenêtre, en jours — voir `buildMomentum` pour la méthode exacte. */
const MOMENTUM_TARGET_DAYS = 7;
/** Écart toléré autour de la cible avant de devoir afficher les dates exactes (§3 de l'audit V3.2). */
const MOMENTUM_TOLERANCE_DAYS = 1;

/**
 * MÉTHODE (audit V3.2 §3) : la baseline n'est jamais exigée à J-7 pile. On
 * vise J-7, puis on prend le snapshot RÉELLEMENT disponible le plus proche
 * AVANT OU ÉGAL à cette cible — jamais après, pour ne jamais raccourcir la
 * fenêtre sans le dire. `previousSnapshotDate` ne teste que « strictement
 * avant » : décaler la cible d'un jour la transforme en « avant ou égal ».
 *
 * Exemple réel (22/09/2026) : cible J-7 = 15/09, aucun snapshot ce jour-là →
 * retenu le 14/09 (J-8). C'est le fonctionnement voulu, pas un trou à corriger.
 */
function nearestSnapshotOnOrBefore(targetDate: string): string | null {
  return previousSnapshotDate(addDays(targetDate, 1));
}

/**
 * Momentum 7 jours par commercial (Performance, audit V3.2) — réutilise
 * EXACTEMENT le moteur du bloc « Depuis [la dernière photo] » :
 * `computeRawChanges` (donc `computeOpportunityDelta`, `officialSignedBetween`,
 * la règle GMV du delta manager, Kanban connu→connu) et
 * `selectSignificantChanges`. Seule la fenêtre change — une semaine au lieu
 * d'une photo — et le résultat est groupé par `owner` au lieu de rester une
 * liste plate.
 *
 * PAS de métrique nette (GMV entrée M + signée − sortie M) : volontairement
 * absente. `signed` vient de Travaux (`officialSignedBetween`, GMV RÉALISÉE,
 * avenants compris) tandis que `enteredM`/`exitedM` viennent du champ Kanban
 * de l'Opportunity (GMV DÉCLARÉE, ~25 % de couverture seulement) — deux
 * sources différentes que l'audit C10 interdit déjà de sommer comme si
 * c'était un même argent (voir l'en-tête de `official-signed.ts`). Les
 * additionner produirait un total qui a l'air d'un fait alors que c'est un
 * mélange de deux natures de données.
 */
export function buildMomentum(today: string, current: Opportunity[]): MomentumReport {
  const targetDate = addDays(today, -MOMENTUM_TARGET_DAYS);
  const baselineDate = nearestSnapshotOnOrBefore(targetDate);
  const dataAsOf = latestImport()?.snapshotDate ?? null;

  if (!baselineDate || !isRefreshedSinceBaseline(baselineDate, dataAsOf)) {
    return { window: { available: false }, owners: [], totalOpportunitiesTouched: 0 };
  }

  const baseline = loadSnapshot(baselineDate);
  const raw = computeRawChanges(today, baselineDate, current, baseline);
  const changes = [...raw.changes.values()];

  // Population des commerciaux/ET PILOTÉS — même liste canonique que le Plan
  // du jour (`morning-priority.ts`), « Ma semaine » (`week.ts`) et
  // `owner-signals.ts` : le directeur régional porte parfois quelques
  // affaires lui-même, mais ne s'évalue pas sa propre performance. Jamais de
  // second nom en dur ici : `ATTENTION.excluded` reste la seule liste.
  const excludedOwners = new Set<string>(ATTENTION.excluded);

  // Chaque commercial PILOTÉ apparaît, même sans le moindre mouvement sur la
  // période — silence informatif, jamais une absence muette de la liste
  // (audit V3.2 §4 : « au minimum » ces métriques par commercial).
  const byOwner = new Map<string, OpportunityDelta[]>();
  for (const member of loadTeam()) {
    if (excludedOwners.has(member.name)) continue;
    byOwner.set(member.name, []);
  }
  let touched = 0;
  for (const c of changes) {
    const key = c.owner ?? "(commercial inconnu)";
    if (excludedOwners.has(key)) continue;
    touched += 1;
    const list = byOwner.get(key);
    if (list) list.push(c);
    else byOwner.set(key, [c]);
  }

  const owners = [...byOwner.entries()]
    .map(([owner, list]) => aggregateOwnerMomentum(owner, list))
    .sort((a, b) => a.owner.localeCompare(b.owner, "fr"));

  return {
    window: { available: true, baselineDate, today, days: daysBetween(baselineDate, today) },
    owners,
    totalOpportunitiesTouched: touched,
  };
}

/**
 * « Momentum sur 7 jours » si la fenêtre réelle est à ±1 jour de la cible,
 * sinon les dates exactes — jamais « 7 jours » quand ce n'en est pas
 * (audit V3.2 §3). Contrairement au titre du bloc « Depuis hier » (V3.1), qui
 * tolère zéro écart, cette tolérance est volontaire et demandée telle quelle.
 */
export function formatMomentumWindow(window: MomentumWindow): string {
  if (!window.available) return "Momentum — pas assez de recul";
  if (Math.abs(window.days - MOMENTUM_TARGET_DAYS) <= MOMENTUM_TOLERANCE_DAYS) {
    return "Momentum sur 7 jours";
  }
  const from = LONG_DATE.format(new Date(`${window.baselineDate}T12:00:00`));
  const to = LONG_DATE.format(new Date(`${window.today}T12:00:00`));
  return `Momentum du ${from} au ${to}`;
}

// --- Présentation du titre ----------------------------------------------------

const LONG_DATE = new Intl.DateTimeFormat("fr-FR", { day: "numeric", month: "long" });

/**
 * « Depuis hier » / « Depuis le 20 septembre · 2 jours » / titre neutre si
 * indisponible / « Non rafraîchi depuis le [date] » quand `current` ne date
 * pas d'après la baseline — jamais confondu avec un vrai « rien n'a changé ».
 */
export function formatSinceTitle(title: SinceTitle): string {
  if (title.kind === "unavailable") return "Depuis la dernière photo";
  if (title.kind === "not-refreshed") {
    const label = LONG_DATE.format(new Date(`${title.date}T12:00:00`));
    return `Non rafraîchi depuis le ${label}`;
  }
  if (title.kind === "yesterday") return "Depuis hier";
  const label = LONG_DATE.format(new Date(`${title.date}T12:00:00`));
  return `Depuis le ${label} · ${title.days} jours`;
}
