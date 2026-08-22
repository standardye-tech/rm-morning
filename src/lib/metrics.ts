/**
 * Calculs de pipe actif. Aucune règle d'affichage ici, aucune source :
 * uniquement des agrégations sur le modèle métier.
 *
 * Rappel de cadrage : « Date de signature du devis » n'est PAS utilisée comme
 * prévision (la majorité des opportunités ouvertes portent artificiellement la
 * fin du mois courant). Le seul signal de projection est la Projection Kanban.
 */

import { THRESHOLDS } from "./config";
import { daysBetween, isAdvancedStage, stageRank } from "./normalize";
import type { Opportunity } from "./types";

export type StageBreakdown = { stage: string; count: number; gmv: number };

export type OwnerMetrics = {
  owner: string;
  /** Pipe actif : ni terminé, ni en stand-by en cours. */
  activeCount: number;
  activeGmv: number;
  averageGmv: number;
  gmvByStage: StageBreakdown[];
  /** Âge médian du stock actif, en jours depuis la création. */
  medianStockAgeDays: number | null;
  /** Âge du plus vieux dossier actif, en jours. */
  oldestStockAgeDays: number | null;
  /** Activité la plus récente parmi les opportunités actives. */
  lastActivityAt: string | null;
  /** Jours écoulés depuis cette activité. */
  daysSinceLastActivity: number | null;
  /** Opportunités actives projetées sur le mois courant (Kanban). */
  projectedThisMonthCount: number;
  projectedThisMonthGmv: number;
  /** Opportunités actives sans aucune Projection Kanban. */
  withoutProjectionCount: number;
  /** Opportunités actives sans activité depuis plus de `staleDays`. */
  staleCount: number;
  standbyCount: number;
  standbyGmv: number;
  signedCount: number;
  signedGmv: number;
};

export type PipelineMetrics = {
  referenceDate: string;
  currentMonth: number;
  currentYear: number;
  owners: OwnerMetrics[];
  totals: {
    activeCount: number;
    activeGmv: number;
    projectedThisMonthCount: number;
    projectedThisMonthGmv: number;
    withoutProjectionCount: number;
    standbyCount: number;
    standbyGmv: number;
    signedCount: number;
    signedGmv: number;
  };
};

const sum = (values: number[]) => values.reduce((a, b) => a + b, 0);

function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? Math.round((sorted[middle - 1] + sorted[middle]) / 2)
    : sorted[middle];
}

/** L'opportunité est-elle projetée (Kanban) sur le mois de référence ? */
export function isProjectedOn(o: Opportunity, month: number, year: number): boolean {
  return o.kanbanMonth === month && o.kanbanYear === year;
}

/** Jours écoulés depuis la dernière activité. Négatif si l'activité est planifiée. */
export function daysSinceActivity(o: Opportunity, referenceDate: string): number | null {
  if (!o.lastActivityAt) return null;
  return daysBetween(o.lastActivityAt, referenceDate);
}

/** Âge de l'opportunité en jours depuis sa création. */
export function ageInDays(o: Opportunity, referenceDate: string): number | null {
  if (!o.createdAt) return null;
  return daysBetween(o.createdAt, referenceDate);
}

/** Une opportunité est dormante si sa dernière activité dépasse le seuil. */
export function isStale(o: Opportunity, referenceDate: string): boolean {
  const days = daysSinceActivity(o, referenceDate);
  return days !== null && days > THRESHOLDS.staleDays;
}

export function isBigDeal(o: Opportunity): boolean {
  return (o.gmv ?? 0) >= THRESHOLDS.bigDealGmv;
}

export { isAdvancedStage, stageRank };

export function computeMetrics(
  opportunities: Opportunity[],
  referenceDate: string,
): PipelineMetrics {
  const [year, month] = referenceDate.split("-").map(Number);

  const byOwner = new Map<string, Opportunity[]>();
  for (const o of opportunities) {
    const list = byOwner.get(o.owner);
    if (list) list.push(o);
    else byOwner.set(o.owner, [o]);
  }

  const owners: OwnerMetrics[] = [...byOwner.entries()]
    .map(([owner, list]) => {
      const active = list.filter((o) => o.isActive);
      const standby = list.filter((o) => o.isStandby);
      const signed = list.filter((o) => o.isSigned);
      const activeGmv = sum(active.map((o) => o.gmv ?? 0));

      const stageMap = new Map<string, StageBreakdown>();
      for (const o of active) {
        const stage = o.stage ?? "Étape inconnue";
        const entry = stageMap.get(stage) ?? { stage, count: 0, gmv: 0 };
        entry.count++;
        entry.gmv += o.gmv ?? 0;
        stageMap.set(stage, entry);
      }

      const ages = active
        .map((o) => ageInDays(o, referenceDate))
        .filter((v): v is number => v !== null);

      const activities = active
        .map((o) => o.lastActivityAt)
        .filter((v): v is string => v !== null)
        .sort();
      const lastActivityAt = activities.length > 0 ? activities[activities.length - 1] : null;

      const projected = active.filter((o) => isProjectedOn(o, month, year));

      return {
        owner,
        activeCount: active.length,
        activeGmv,
        averageGmv: active.length > 0 ? Math.round(activeGmv / active.length) : 0,
        gmvByStage: [...stageMap.values()].sort(
          (a, b) => stageRank(b.stage) - stageRank(a.stage) || b.gmv - a.gmv,
        ),
        medianStockAgeDays: median(ages),
        oldestStockAgeDays: ages.length > 0 ? Math.max(...ages) : null,
        lastActivityAt,
        daysSinceLastActivity: lastActivityAt ? daysBetween(lastActivityAt, referenceDate) : null,
        projectedThisMonthCount: projected.length,
        projectedThisMonthGmv: sum(projected.map((o) => o.gmv ?? 0)),
        withoutProjectionCount: active.filter((o) => !o.kanbanRaw).length,
        staleCount: active.filter((o) => isStale(o, referenceDate)).length,
        standbyCount: standby.length,
        standbyGmv: sum(standby.map((o) => o.gmv ?? 0)),
        signedCount: signed.length,
        signedGmv: sum(signed.map((o) => o.gmv ?? 0)),
      };
    })
    .sort((a, b) => b.activeGmv - a.activeGmv);

  return {
    referenceDate,
    currentMonth: month,
    currentYear: year,
    owners,
    totals: {
      activeCount: sum(owners.map((o) => o.activeCount)),
      activeGmv: sum(owners.map((o) => o.activeGmv)),
      projectedThisMonthCount: sum(owners.map((o) => o.projectedThisMonthCount)),
      projectedThisMonthGmv: sum(owners.map((o) => o.projectedThisMonthGmv)),
      withoutProjectionCount: sum(owners.map((o) => o.withoutProjectionCount)),
      standbyCount: sum(owners.map((o) => o.standbyCount)),
      standbyGmv: sum(owners.map((o) => o.standbyGmv)),
      signedCount: sum(owners.map((o) => o.signedCount)),
      signedGmv: sum(owners.map((o) => o.signedGmv)),
    },
  };
}
