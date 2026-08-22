/**
 * Bloc 2 — Forecast de la semaine.
 *
 * Deux signaux distincts, jamais fusionnés :
 *   1. la **confiance déclarée** dans le Google Sheet, photographiée chaque lundi ;
 *   2. la **Projection Kanban** de Salesforce, état courant.
 *
 * Le bloc compare le dernier snapshot hebdomadaire pertinent (≤ aujourd'hui) à
 * l'état Salesforce d'aujourd'hui, et lit la trajectoire en remontant au
 * snapshot précédent. On ne compare jamais les couleurs Kanban entre elles :
 * leur ordre métier n'est pas connu.
 */

import { FORECAST_THRESHOLDS, THRESHOLDS } from "./config";
import { daysBetween, formatEurShort, formatFrenchDate, mondayOf, MONTH_LABELS } from "./normalize";
import {
  forecastSnapshotDates,
  loadForecastSnapshot,
  loadSnapshot,
  previousSnapshotDate,
  type ForecastLine,
} from "./repository";
import type { StandbyTransition } from "./scoring";
import type { Opportunity } from "./types";

export type ForecastMovement = {
  opportunityId: string | null;
  client: string;
  owner: string;
  /** GMV de référence pour l'affichage : Salesforce si connue, sinon Sheet. */
  gmv: number | null;
  /** Effet sur le projeté du mois, en euros. Négatif = perte. */
  impact: number;
  detail: string;
};

export type ForecastGap = {
  rowKey: string;
  opportunityId: string | null;
  label: string;
  owner: string;
  projectedGmv: number | null;
  reason: string;
};

export type WeekForecast = {
  /** « sheet » dès qu'un snapshot hebdomadaire est exploitable. */
  mode: "sheet" | "salesforce-only";
  forecastMonth: string;
  monthLabel: string;

  /** Snapshot hebdomadaire retenu, et le précédent pour la trajectoire. */
  referenceDate: string | null;
  previousDate: string | null;

  /** Σ des GMV × confiance au snapshot de référence. */
  snapshotGmv: number | null;
  /** Même population, réévaluée avec l'état Salesforce d'aujourd'hui. */
  currentGmv: number;
  variationGmv: number | null;

  strengthened: ForecastMovement[];
  weakened: ForecastMovement[];
  postponed: ForecastMovement[];
  won: ForecastMovement[];

  /** Lignes du Sheet sans correspondance Salesforce : à investiguer, pas perdues. */
  gaps: ForecastGap[];
  /** Au plus trois affaires à challenger ce matin. */
  toChallenge: ForecastMovement[];

  /** Projection Kanban Salesforce, signal indépendant conservé. */
  kanbanGmv: number;
  kanbanCount: number;

  /** Transitions de stand-by détectées entre deux snapshots Salesforce. */
  standbyTransitions: StandbyTransition | null;
};

const clientOf = (o: Opportunity) => o.clientContact ?? o.name ?? o.opportunityId;

/** Écart de GMV jugé significatif : en valeur absolue ou en proportion. */
function isSignificantGmvChange(before: number, after: number): boolean {
  const delta = Math.abs(after - before);
  if (delta >= FORECAST_THRESHOLDS.significantGmvDelta) return true;
  return before > 0 && delta / before >= FORECAST_THRESHOLDS.significantGmvRatio;
}

/**
 * Transitions de stand-by entre le snapshot Salesforce de référence de la
 * semaine et l'état courant. Indépendant du Google Sheet.
 */
function salesforceStandbyTransitions(
  opportunities: Opportunity[],
  referenceDate: string,
): StandbyTransition | null {
  const monday = mondayOf(referenceDate);
  const baselineDate =
    previousSnapshotDate(referenceDate, monday) ?? previousSnapshotDate(referenceDate);
  if (!baselineDate) return null;

  const baseline = loadSnapshot(baselineDate);
  const entered: Opportunity[] = [];
  const exited: Opportunity[] = [];

  for (const o of opportunities) {
    const before = baseline.get(o.opportunityId);
    if (!before) continue;
    if (!before.isStandby && o.isStandby) entered.push(o);
    if (before.isStandby && !o.isStandby) exited.push(o);
  }
  return entered.length > 0 || exited.length > 0 ? { entered, exited } : null;
}

export function computeWeekForecast(
  opportunities: Opportunity[],
  referenceDate: string,
  month: number,
  year: number,
): WeekForecast {
  const forecastMonth = `${year}-${String(month).padStart(2, "0")}`;
  const monthLabel = MONTH_LABELS[month - 1];

  // Projection Kanban Salesforce : signal indépendant, toujours calculé.
  const kanbanProjected = opportunities.filter(
    (o) => o.isActive && o.kanbanMonth === month && o.kanbanYear === year,
  );
  const kanbanGmv = kanbanProjected.reduce((total, o) => total + (o.gmv ?? 0), 0);

  const base = {
    forecastMonth,
    monthLabel,
    kanbanGmv,
    kanbanCount: kanbanProjected.length,
    standbyTransitions: salesforceStandbyTransitions(opportunities, referenceDate),
  };

  // Snapshot hebdomadaire retenu : le plus récent qui ne soit pas dans le futur.
  const dates = forecastSnapshotDates(forecastMonth, referenceDate);
  if (dates.length === 0) {
    return {
      ...base,
      mode: "salesforce-only",
      referenceDate: null,
      previousDate: null,
      snapshotGmv: null,
      currentGmv: kanbanGmv,
      variationGmv: null,
      strengthened: [],
      weakened: [],
      postponed: [],
      won: [],
      gaps: [],
      toChallenge: [],
    };
  }

  const refDate = dates[0];
  const prevDate = dates[1] ?? null;
  const reference = loadForecastSnapshot(forecastMonth, refDate);
  const previous = prevDate
    ? new Map(loadForecastSnapshot(forecastMonth, prevDate).map((l) => [l.rowKey, l]))
    : new Map<string, ForecastLine>();

  const byId = new Map(opportunities.map((o) => [o.opportunityId, o]));

  let snapshotGmv = 0;
  let currentGmv = 0;
  const strengthened: ForecastMovement[] = [];
  const weakened: ForecastMovement[] = [];
  const postponed: ForecastMovement[] = [];
  const won: ForecastMovement[] = [];
  const gaps: ForecastGap[] = [];

  for (const line of reference) {
    const projected = line.projectedGmv ?? 0;
    snapshotGmv += projected;

    const opportunity = line.opportunityId ? byId.get(line.opportunityId) : undefined;
    const label = line.opportunityLabel ?? line.opportunityId ?? line.rowKey;
    const before = previous.get(line.rowKey);

    // --- Ligne sans correspondance Salesforce : écart à investiguer.
    if (!opportunity) {
      gaps.push({
        rowKey: line.rowKey,
        opportunityId: line.opportunityId,
        label,
        owner: line.salesperson,
        projectedGmv: line.projectedGmv,
        reason: line.opportunityId
          ? "présente au forecast, absente du périmètre Salesforce courant"
          : "ligne saisie à la main dans le Sheet, sans identifiant Salesforce",
      });
      continue; // Ne contribue pas au projeté actuel, et n'est PAS comptée perdue.
    }

    const client = clientOf(opportunity);
    const sfGmv = opportunity.gmv ?? 0;
    const confidence = line.confidence ?? 0;

    // --- Contribution au projeté actuel, avec la confiance du snapshot.
    let contribution: number;
    if (opportunity.isSigned) contribution = sfGmv;
    else if (opportunity.isStandby) contribution = 0;
    else if (line.state === "Perdue") contribution = 0;
    else contribution = sfGmv * confidence;
    currentGmv += contribution;

    const impact = contribution - projected;
    const movement = (detail: string): ForecastMovement => ({
      opportunityId: opportunity.opportunityId,
      client,
      owner: opportunity.owner,
      gmv: opportunity.gmv,
      impact,
      detail,
    });

    // --- Un seul mouvement par affaire, par ordre de gravité décroissante.
    if (opportunity.isSigned || line.state === "Gagnée") {
      won.push(movement(opportunity.isSigned ? "signée dans Salesforce" : "déclarée gagnée"));
      continue;
    }

    if (opportunity.isStandby) {
      postponed.push(
        movement(`passée en stand-by jusqu'au ${formatFrenchDate(opportunity.standbyUntil)}`),
      );
      continue;
    }

    if (line.state === "Repoussée") {
      postponed.push(movement("déclarée repoussée dans le forecast"));
      continue;
    }

    // Projection Kanban désormais postérieure au mois forecasté.
    if (
      opportunity.kanbanMonth &&
      opportunity.kanbanYear &&
      opportunity.kanbanYear * 12 + opportunity.kanbanMonth > year * 12 + month
    ) {
      postponed.push(
        movement(
          `Projection Kanban déplacée sur ${MONTH_LABELS[opportunity.kanbanMonth - 1]} ${opportunity.kanbanYear}`,
        ),
      );
      continue;
    }

    if (line.state === "Perdue") {
      weakened.push(movement("déclarée perdue dans le forecast"));
      continue;
    }

    // Trajectoire de confiance entre les deux derniers snapshots.
    const confidenceBefore = before?.confidence ?? null;
    if (confidenceBefore !== null && line.confidence !== null) {
      const delta = line.confidence - confidenceBefore;
      if (delta <= -FORECAST_THRESHOLDS.significantConfidenceDrop) {
        weakened.push(
          movement(
            `confiance ${Math.round(confidenceBefore * 100)} % → ${Math.round(line.confidence * 100)} %`,
          ),
        );
        continue;
      }
      if (delta > 0) {
        strengthened.push(
          movement(
            `confiance ${Math.round(confidenceBefore * 100)} % → ${Math.round(line.confidence * 100)} %`,
          ),
        );
        continue;
      }
    } else if (!before && line.state === "Nouvelle") {
      strengthened.push(movement("entrée dans le forecast cette semaine"));
      continue;
    }

    // Écart de GMV entre le forecast déclaré et Salesforce.
    if (line.gmv !== null && isSignificantGmvChange(line.gmv, sfGmv)) {
      const detail = `GMV ${formatEurShort(line.gmv)} au forecast → ${formatEurShort(sfGmv)} dans Salesforce`;
      if (sfGmv > line.gmv) strengthened.push(movement(detail));
      else weakened.push(movement(detail));
      continue;
    }

    // Affaire projetée mais devenue silencieuse.
    const days = opportunity.lastActivityAt
      ? daysBetween(opportunity.lastActivityAt, referenceDate)
      : null;
    if (days !== null && days > THRESHOLDS.staleDays) {
      weakened.push(movement(`aucune activité depuis ${days} j`));
    }
  }

  // Trois affaires à challenger : les pertes les plus lourdes sur le projeté.
  const byImpact = (a: ForecastMovement, b: ForecastMovement) => a.impact - b.impact;
  const toChallenge = [...weakened, ...postponed]
    .sort(byImpact)
    .slice(0, FORECAST_THRESHOLDS.maxToChallenge);

  const sortByAbsImpact = (list: ForecastMovement[]) =>
    [...list].sort((a, b) => Math.abs(b.impact) - Math.abs(a.impact));

  return {
    ...base,
    mode: "sheet",
    referenceDate: refDate,
    previousDate: prevDate,
    snapshotGmv,
    currentGmv,
    variationGmv: currentGmv - snapshotGmv,
    strengthened: sortByAbsImpact(strengthened),
    weakened: sortByAbsImpact(weakened),
    postponed: sortByAbsImpact(postponed),
    won: sortByAbsImpact(won),
    gaps: gaps.sort((a, b) => (b.projectedGmv ?? 0) - (a.projectedGmv ?? 0)),
    toChallenge,
  };
}
