/**
 * Bloc « Depuis [la dernière photo] » — audit V3.1.
 *
 * Répond à UNE question : qu'est-ce qui a changé depuis la dernière photo
 * fiable du pipe, et qui modifie la lecture commerciale du mois ? Ce n'est ni
 * un flux d'activité Salesforce ni un nouveau moteur de Forecast : tout ce
 * fichier compose des primitives qui existent déjà ailleurs et tournent en
 * production (`previousSnapshotDate`, `loadSnapshot`, `isSignificantGmvChange`,
 * `officialSignedBetween`, l'horloge métier Europe/Paris).
 *
 * Trois étages, volontairement séparés :
 *   1. `computeOpportunityDelta`  — le calcul BRUT des différences d'UNE
 *      opportunité entre deux photos. Pur, sans base de données.
 *   2. `buildBusinessDelta`       — l'agrégation quotidienne : parcourt tout
 *      le pipe, fusionne les signatures officielles, calcule les KPI.
 *   3. `selectSignificantChanges` — la sélection/priorisation pour l'affichage.
 * Cette séparation n'est pas gratuite : la V2 (Performance → Momentum 7 jours)
 * doit pouvoir réutiliser les étages 1 et 3 avec une fenêtre de 7 jours sans
 * toucher à l'étage 2.
 *
 * DOCTRINE, non négociable (audit V3.1, §3-6) :
 *   — jamais de jugement positif/négatif sur un changement de stade : aucun
 *     ordre de stade n'est validé pour ce moteur ;
 *   — une variation de GMV n'entre que si elle franchit le même seuil que le
 *     Forecast (`isSignificantGmvChange`), sans nouveau seuil concurrent ;
 *   — un déplacement Kanban n'entre que si l'ancien ET le nouveau mois sont
 *     connus, et seulement s'il touche le mois métier courant (M) ;
 *   — apparition/disparition d'opportunité entre deux photos : PAS un
 *     événement commercial en V3.1 (signal non fiable, cf. audit §4) ;
 *   — changement de commercial : hors-scope V3.1 (signal jamais observé) ;
 *   — une affaire = une ligne, même si plusieurs dimensions ont bougé.
 */

import { businessMonth } from "./business-time";
import { SINCE_LAST_SNAPSHOT } from "./config";
import { isSignificantGmvChange } from "./forecast";
import { daysBetween, kanbanPeriodLabel } from "./normalize";
import {
  officialSignedBetween,
  travauxFreshnessDate,
  type OfficialSignedLine,
} from "./official-signed";
import { loadSnapshot, previousSnapshotDate, type SnapshotLine } from "./repository";
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

function classifyGmvChange(before: number | null, after: number | null): GmvChange | null {
  if (before == null || after == null) return null;
  if (!isSignificantGmvChange(before, after)) return null;
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

/**
 * Construit le delta métier entre `baselineDate` (la dernière photo
 * antérieure à `today`, ou `null` si aucune n'existe) et l'état courant.
 *
 * `current` est l'état COURANT (table `opportunity`, écrasée à chaque
 * import) — pas une seconde photo datée : c'est la meilleure information
 * disponible à l'instant où Morning s'affiche, exactement comme le fait déjà
 * `salesforceStandbyTransitions` dans `forecast.ts`.
 */
export function buildBusinessDelta(
  today: string,
  baselineDate: string | null,
  current: Opportunity[],
  baseline: Map<string, SnapshotLine>,
): BusinessDelta {
  const title: SinceTitle = !baselineDate
    ? { kind: "unavailable" }
    : (() => {
        const days = daysBetween(baselineDate, today);
        return days === 1 ? { kind: "yesterday" as const } : { kind: "days" as const, date: baselineDate, days };
      })();

  const empty: BusinessDelta = {
    today,
    baselineDate,
    title,
    available: false,
    signed: { available: false, count: 0, gmv: 0, coveredThrough: null, stale: false },
    enteredM: { available: false, count: 0, gmv: 0 },
    exitedM: { available: false, count: 0, gmv: 0 },
    stageChanged: { available: false, count: 0, gmv: 0 },
    changes: [],
  };
  if (!baselineDate) return empty;

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
    today,
    baselineDate,
    title,
    available: true,
    signed: { ...coverage, count: signedCount, gmv: signedGmv },
    enteredM: { available: true, count: enteredMCount, gmv: enteredMGmv },
    exitedM: { available: true, count: exitedMCount, gmv: exitedMGmv },
    stageChanged: { available: true, count: stageChangedCount, gmv: stageChangedGmv },
    changes: [...changes.values()],
  };
}

/** Point d'entrée pratique pour une page : calcule la baseline puis délègue. */
export function buildSinceLastSnapshot(
  today: string,
  current: Opportunity[],
): BusinessDelta {
  const baselineDate = previousSnapshotDate(today);
  const baseline = baselineDate ? loadSnapshot(baselineDate) : new Map<string, SnapshotLine>();
  return buildBusinessDelta(today, baselineDate, current, baseline);
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

// --- Présentation du titre ----------------------------------------------------

const LONG_DATE = new Intl.DateTimeFormat("fr-FR", { day: "numeric", month: "long" });

/** « Depuis hier » / « Depuis le 20 septembre · 2 jours » / titre neutre si indisponible. */
export function formatSinceTitle(title: SinceTitle): string {
  if (title.kind === "unavailable") return "Depuis la dernière photo";
  if (title.kind === "yesterday") return "Depuis hier";
  const label = LONG_DATE.format(new Date(`${title.date}T12:00:00`));
  return `Depuis le ${label} · ${title.days} jours`;
}
