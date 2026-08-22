/**
 * Historique du classement Performance.
 *
 * CADENCE : une photo par JOUR, comme `opportunity_snapshot` et `lead_snapshot`.
 * C'est la cadence naturelle de l'application — les données ne changent qu'à
 * l'actualisation, et celle-ci est quotidienne. Une photo par consultation
 * gonflerait la table sans rien apprendre, et rendrait « depuis la dernière
 * fois » dépendant du nombre de fois où l'on a ouvert la page.
 *
 * COMPARAISON : le rang du jour est confronté à la photo la plus récente d'un
 * jour ANTÉRIEUR. Jamais à celle du jour même, qui est en train d'être écrite.
 * Un premier jour n'affiche donc aucune évolution, et c'est la vérité : il n'y a
 * rien à comparer.
 *
 * Les sous-scores sont historisés avec le score global. Sans eux, une chute de
 * rang serait constatable mais inexplicable trois semaines plus tard.
 */

import { PERFORMANCE_MODEL_VERSION } from "./config";
import { getDb } from "./db";
import type { PerformanceRow } from "./performance";

export type PerformanceHistoryRow = {
  snapshotDate: string;
  salesperson: string;
  rank: number;
  score: number;
  modelVersion: string | null;
  dynamicDelta: number | null;
};

/**
 * Date de la photo la plus récente strictement antérieure au jour demandé, ET
 * calculée par le MÊME modèle.
 *
 * La contrainte de version est le cœur du mécanisme. Une photo produite par une
 * formule différente reste en base — l'historique ne se réécrit pas — mais elle
 * n'est jamais rapprochée d'une autre : sinon la première ouverture de l'écran
 * après une recalibration afficherait treize mouvements de rang spectaculaires
 * qui ne décriraient que le changement de règle. Les photos antérieures à
 * l'introduction du versionnement portent une version nulle et sont, par
 * construction, hors de portée de cette comparaison.
 */
export function previousSnapshotDate(
  before: string,
  version: string = PERFORMANCE_MODEL_VERSION,
): string | null {
  const row = getDb()
    .prepare(
      `SELECT MAX(snapshot_date) AS date FROM performance_snapshot
        WHERE snapshot_date < ? AND model_version = ?`,
    )
    .get(before, version) as { date: string | null } | undefined;
  return row?.date ?? null;
}

/** Rangs d'une photo donnée, indexés par commercial. Même version uniquement. */
export function ranksAt(
  snapshotDate: string,
  version: string = PERFORMANCE_MODEL_VERSION,
): Map<string, number> {
  const rows = getDb()
    .prepare(
      "SELECT salesperson, rank FROM performance_snapshot WHERE snapshot_date = ? AND model_version = ?",
    )
    .all(snapshotDate, version) as { salesperson: string; rank: number }[];
  return new Map(rows.map((r) => [r.salesperson, Number(r.rank)]));
}

/** Versions présentes dans l'historique, avec le nombre de photos de chacune. */
export function snapshotVersions(): { version: string | null; days: number }[] {
  return (
    getDb()
      .prepare(
        `SELECT model_version AS version, COUNT(DISTINCT snapshot_date) AS days
           FROM performance_snapshot GROUP BY model_version ORDER BY days DESC`,
      )
      .all() as { version: string | null; days: number }[]
  ).map((r) => ({ version: r.version, days: Number(r.days) }));
}

/**
 * Écrit la photo du jour.
 *
 * Idempotent : rejouer le même jour corrige la photo du jour courant, jamais
 * celles des jours passés. C'est exactement la règle des autres snapshots de
 * l'application, et c'est ce qui rend l'historique non réécrivable.
 */
export function recordPerformanceSnapshot(
  rows: PerformanceRow[],
  now = new Date(),
): { snapshotDate: string; written: number } {
  const db = getDb();
  const snapshotDate = now.toISOString().slice(0, 10);
  const upsert = db.prepare(
    `INSERT INTO performance_snapshot
       (snapshot_date, salesperson, computed_at, rank, score,
        signed_score, leads_score, deals_score, pipeline_score, metrics,
        model_version, score_recent, score_previous, dynamic_delta)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(snapshot_date, salesperson) DO UPDATE SET
       computed_at = excluded.computed_at, rank = excluded.rank, score = excluded.score,
       signed_score = excluded.signed_score, leads_score = excluded.leads_score,
       deals_score = excluded.deals_score, pipeline_score = excluded.pipeline_score,
       metrics = excluded.metrics, model_version = excluded.model_version,
       score_recent = excluded.score_recent, score_previous = excluded.score_previous,
       dynamic_delta = excluded.dynamic_delta`,
  );

  db.exec("BEGIN");
  try {
    for (const row of rows) {
      upsert.run(
        snapshotDate,
        row.salesperson,
        now.toISOString(),
        row.rank,
        row.score,
        row.pillars.signed.points,
        row.pillars.leads.points,
        row.pillars.deals.points,
        row.pillars.pipeline.points,
        // Les valeurs brutes, pour pouvoir réexpliquer un classement ancien
        // même si les barèmes ont changé entre-temps.
        JSON.stringify(
          Object.fromEntries(
            Object.values(row.pillars)
              .flatMap((p) => p.metrics)
              .map((m) => [m.key, m.value]),
          ),
        ),
        PERFORMANCE_MODEL_VERSION,
        row.dynamic.recent.score,
        row.dynamic.previous.score,
        row.dynamic.delta,
      );
    }
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
  return { snapshotDate, written: rows.length };
}

/** Historique d'un commercial, du plus récent au plus ancien. */
export function historyOf(salesperson: string, limit = 30): PerformanceHistoryRow[] {
  return (
    getDb()
      .prepare(
        `SELECT snapshot_date, salesperson, rank, score, model_version, dynamic_delta
           FROM performance_snapshot
          WHERE salesperson = ? ORDER BY snapshot_date DESC LIMIT ?`,
      )
      .all(salesperson, limit) as {
      snapshot_date: string;
      salesperson: string;
      rank: number;
      score: number;
      model_version: string | null;
      dynamic_delta: number | null;
    }[]
  ).map((r) => ({
    snapshotDate: r.snapshot_date,
    salesperson: r.salesperson,
    rank: Number(r.rank),
    score: Number(r.score),
    modelVersion: r.model_version,
    dynamicDelta: r.dynamic_delta == null ? null : Number(r.dynamic_delta),
  }));
}

/** Nombre de photos enregistrées, toutes dates confondues. */
export function snapshotDates(limit = 30): string[] {
  return (
    getDb()
      .prepare(
        "SELECT DISTINCT snapshot_date FROM performance_snapshot ORDER BY snapshot_date DESC LIMIT ?",
      )
      .all(limit) as { snapshot_date: string }[]
  ).map((r) => r.snapshot_date);
}
