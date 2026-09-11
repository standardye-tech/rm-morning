/**
 * Stabilité d'étape observée dans les snapshots quotidiens.
 *
 * RM Morning ne lit pas OpportunityHistory en direct : la seule trace du
 * passé d'une étape est la suite des photos quotidiennes, qui ne remonte qu'au
 * 16/08/2026. On ne peut donc PROUVER qu'une immobilité bornée : « l'étape
 * n'a pas changé depuis au moins N jours ». Jamais plus. Une affaire figée
 * depuis six mois et une affaire figée depuis le premier snapshot se lisent
 * pareil, et c'est honnête — le texte affiché dit toujours « au moins ».
 */

import { queryAll } from "./db";
import { daysBetween } from "./normalize";

export type StageStability = {
  opportunityId: string;
  /** Étape du dernier snapshot. */
  stage: string | null;
  /** Premier jour de snapshot où l'étape courante est observée sans interruption. */
  stableSince: string;
  /**
   * Vrai si un snapshot antérieur montre une autre étape. L'immobilité est
   * alors datée par une observation, et non seulement bornée par la profondeur
   * de l'historique.
   */
  changeObserved: boolean;
  /** Jours d'immobilité PROUVÉS à la date de référence. Toujours une borne basse. */
  provenDays: number;
  /** Nombre de snapshots où l'affaire apparaît. */
  observations: number;
};

export type StageRow = { opportunityId: string; snapshotDate: string; stage: string | null };

/** Calcul pur : les lignes doivent être triées par opportunité puis par date. */
export function stabilityFromRows(rows: StageRow[], referenceDate: string): Map<string, StageStability> {
  const out = new Map<string, StageStability>();
  let current: StageStability | null = null;
  let previousStage: string | null | undefined;

  for (const row of rows) {
    if (!current || current.opportunityId !== row.opportunityId) {
      if (current) out.set(current.opportunityId, current);
      current = {
        opportunityId: row.opportunityId,
        stage: row.stage,
        stableSince: row.snapshotDate,
        changeObserved: false,
        provenDays: 0,
        observations: 1,
      };
      previousStage = row.stage;
      continue;
    }
    current.observations += 1;
    if (row.stage !== previousStage) {
      current.stage = row.stage;
      current.stableSince = row.snapshotDate;
      current.changeObserved = true;
      previousStage = row.stage;
    }
  }
  if (current) out.set(current.opportunityId, current);

  for (const s of out.values()) {
    s.provenDays = Math.max(0, daysBetween(s.stableSince, referenceDate));
  }
  return out;
}

/** Stabilité de chaque opportunité photographiée, à la date de référence. */
export function loadStageStability(referenceDate: string): Map<string, StageStability> {
  const rows = queryAll<{ opportunity_id: string; snapshot_date: string; stage: string | null }>(
    `SELECT opportunity_id, snapshot_date, stage
       FROM opportunity_snapshot
      ORDER BY opportunity_id, snapshot_date`,
  );
  return stabilityFromRows(
    rows.map((r) => ({
      opportunityId: String(r.opportunity_id),
      snapshotDate: String(r.snapshot_date),
      stage: r.stage == null ? null : String(r.stage),
    })),
    referenceDate,
  );
}

/** Date du plus ancien snapshot, pour dire jusqu'où la preuve peut remonter. */
export function earliestSnapshotDate(): string | null {
  const row = queryAll<{ d: string | null }>("SELECT MIN(snapshot_date) AS d FROM opportunity_snapshot")[0];
  return row?.d ? String(row.d) : null;
}
