/**
 * Import des snapshots hebdomadaires de forecast dans SQLite.
 *
 * Les snapshots passés ne sont jamais écrasés : la clé porte la date, et un
 * ré-import ne corrige qu'une ligne déjà connue pour cette même date.
 * Le filtrage de l'équipe réutilise le mapping d'alias de `config.ts`.
 */

import { getDb } from "./db";
import { matchTeamMember, todayIso } from "./normalize";
import { FORECAST_SHEET } from "./config";
import { forecastMonthsAround } from "./sources/forecast-sheet-parser";
import type { ForecastSnapshotSource } from "./sources/forecast-snapshot";

export type ForecastImportSummary = {
  sourceKind: string;
  sourceLabel: string;
  months: string[];
  snapshotDates: string[];
  /** Lignes lues, toutes équipes confondues. */
  totalLines: number;
  /** Lignes conservées, c'est-à-dire rattachées à l'équipe suivie. */
  teamLines: number;
  /** Lignes écartées faute de commercial reconnu. */
  ignoredLines: number;
  /** Lignes d'équipe sans identifiant Salesforce (saisies à la main dans le Sheet). */
  withoutId: number;
  issues: { row?: number; message: string }[];
  durationMs: number;
};

export async function importForecastSnapshots(
  source: ForecastSnapshotSource,
  options: { referenceDate?: string; months?: string[] } = {},
): Promise<ForecastImportSummary> {
  const startedAt = Date.now();
  const today = options.referenceDate ?? todayIso();
  const months =
    options.months ??
    forecastMonthsAround(today, FORECAST_SHEET.monthsBack, FORECAST_SHEET.monthsForward);

  const result = await source.fetch(months);
  const db = getDb();
  const importedAt = result.fetchedAt.toISOString();

  const upsert = db.prepare(`
    INSERT INTO forecast_snapshot (
      snapshot_date, forecast_month, row_key, opportunity_id,
      salesperson, salesperson_raw, region, opportunity_label,
      confidence, gmv, ca, projected_gmv, state, source, imported_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(snapshot_date, forecast_month, row_key) DO UPDATE SET
      opportunity_id = excluded.opportunity_id,
      salesperson = excluded.salesperson, salesperson_raw = excluded.salesperson_raw,
      region = excluded.region, opportunity_label = excluded.opportunity_label,
      confidence = excluded.confidence, gmv = excluded.gmv, ca = excluded.ca,
      projected_gmv = excluded.projected_gmv, state = excluded.state,
      source = excluded.source, imported_at = excluded.imported_at
  `);

  let teamLines = 0;
  let ignoredLines = 0;
  let withoutId = 0;

  db.exec("BEGIN");
  try {
    for (const line of result.lines) {
      const member = matchTeamMember(line.salespersonRaw);
      if (!member) {
        ignoredLines++;
        continue; // Commercial hors périmètre : volontairement non importé.
      }
      if (!line.opportunityId) withoutId++;

      upsert.run(
        line.snapshotDate,
        line.forecastMonth,
        line.rowKey,
        line.opportunityId,
        member.name,
        line.salespersonRaw,
        line.region,
        line.opportunityLabel,
        line.confidence,
        line.gmv,
        line.ca,
        line.projectedGmv,
        line.state,
        result.sourceKind,
        importedAt,
      );
      teamLines++;
    }
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }

  return {
    sourceKind: result.sourceKind,
    sourceLabel: result.sourceLabel,
    months: result.months,
    snapshotDates: result.snapshotDates,
    totalLines: result.lines.length,
    teamLines,
    ignoredLines,
    withoutId,
    issues: result.issues,
    durationMs: Date.now() - startedAt,
  };
}
