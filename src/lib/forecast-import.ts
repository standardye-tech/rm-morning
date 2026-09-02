/**
 * Import des snapshots hebdomadaires de forecast dans SQLite.
 *
 * Les snapshots passés ne sont jamais écrasés : la clé porte la date, et un
 * ré-import ne corrige qu'une ligne déjà connue pour cette même date.
 *
 * ORDRE DU TRAITEMENT, et pourquoi il n'est pas négociable :
 *
 *   1. lire la source ;
 *   2. identifier le commercial ;
 *   3. hors équipe → écarter EN SILENCE. Le classeur est celui de toute
 *      l'entreprise : les vingt-quatre commerciaux qu'il contient ne sont pas
 *      des anomalies, ils ne nous concernent pas ;
 *   4. dans l'équipe → appliquer la règle territoriale du membre ;
 *   5. hors territoire → écarter EN SILENCE, pour la même raison ;
 *   6. seulement alors, valider la donnée métier et signaler ce qui cloche.
 *
 * Une ligne volontairement écartée n'est pas une anomalie. Confondre les deux
 * faisait remonter des avertissements qui ne demandaient aucune action, et
 * finissait par rendre le voyant illisible.
 */

import { getDb } from "./db";
import { matchTeamMember, todayIso } from "./normalize";
import { FORECAST_SHEET } from "./config";
import { forecastMonthsAround } from "./sources/forecast-sheet-parser";
import type { ForecastSnapshotSource } from "./sources/forecast-snapshot";
import { loadTeam, recordTeamCandidates } from "./team-store";
import { isInTerritoryScope } from "./territory";

/** Anomalie retenue : elle porte sur une ligne QUI DEVRAIT être dans RM Morning. */
export type ForecastIssue = {
  /** Numéro de ligne dans l'onglet, quand l'anomalie en vise une. */
  row?: number;
  message: string;
};

export type ForecastImportSummary = {
  sourceKind: string;
  sourceLabel: string;
  months: string[];
  snapshotDates: string[];
  /** Lignes lues, toutes équipes confondues. */
  totalLines: number;
  /** Lignes conservées, c'est-à-dire rattachées à l'équipe suivie. */
  teamLines: number;
  /** Lignes écartées faute de commercial dans le périmètre. */
  ignoredLines: number;
  /** Lignes d'équipe écartées parce que le chantier relève d'un autre DR. */
  outOfTerritoryLines: number;
  /** Lignes d'équipe sans identifiant Salesforce (saisies à la main dans le Sheet). */
  withoutId: number;
  /** Lignes d'ÉTAT COURANT conservées (bloc « EN COURS »). */
  currentLines: number;
  /** « MAJ le » annoncé par le classeur pour l'état courant. */
  currentUpdatedAt: string | null;
  /** Mois dont l'état courant a été remplacé à cet import. */
  currentMonths: string[];
  issues: ForecastIssue[];
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
  // Le périmètre est relu ici, et pas capturé au chargement du module : un
  // retrait fait dans l'interface s'applique dès l'actualisation suivante.
  loadTeam();
  const importedAt = result.fetchedAt.toISOString();

  // Tous les commerciaux vus, équipe ou non, alimentent la liste de choix de
  // l'écran d'équipe. Être vu ici n'entre personne dans le périmètre.
  recordTeamCandidates("perspective", result.lines.map((l) => l.salespersonRaw));

  // Code postal Salesforce des opportunités connues : le SEUL champ qui dise
  // vraiment où est le chantier. La colonne « DR » du classeur porte la région
  // du COMMERCIAL, et étiquette « Île-de-France » les dossiers bretons de
  // Valentin Marion — elle ne peut donc pas servir. Voir `territory.ts`.
  const postalById = new Map<string, string | null>(
    (
      db
        .prepare("SELECT opportunity_id, postal_code FROM opportunity")
        .all() as unknown as { opportunity_id: string; postal_code: string | null }[]
    ).map((r) => [r.opportunity_id, r.postal_code]),
  );

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

  // ÉTAT COURANT — remplacé, jamais accumulé.
  //
  // La clé de `forecast_current` ne porte pas de date : réimporter met à jour
  // la même ligne. On purge d'abord les mois relus, pour qu'une affaire retirée
  // du classeur disparaisse aussi de l'état courant au lieu d'y survivre.
  const deleteCurrentMonth = db.prepare("DELETE FROM forecast_current WHERE forecast_month = ?");
  const upsertCurrent = db.prepare(`
    INSERT INTO forecast_current (
      forecast_month, row_key, opportunity_id, salesperson, salesperson_raw,
      region, opportunity_label, confidence, gmv, ca, projected_gmv, state,
      updated_at, source, imported_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(forecast_month, row_key) DO UPDATE SET
      opportunity_id = excluded.opportunity_id,
      salesperson = excluded.salesperson, salesperson_raw = excluded.salesperson_raw,
      region = excluded.region, opportunity_label = excluded.opportunity_label,
      confidence = excluded.confidence, gmv = excluded.gmv, ca = excluded.ca,
      projected_gmv = excluded.projected_gmv, state = excluded.state,
      updated_at = excluded.updated_at, source = excluded.source,
      imported_at = excluded.imported_at
  `);

  let teamLines = 0;
  let ignoredLines = 0;
  let outOfTerritoryLines = 0;
  let withoutId = 0;
  let currentKept = 0;

  /**
   * La ligne est-elle dans le périmètre RM Morning ? Une seule définition,
   * appliquée aussi bien aux lignes de données qu'aux anomalies candidates,
   * pour qu'elles ne puissent jamais diverger.
   */
  const inScope = (
    salespersonRaw: string | null,
    opportunityId: string | null,
  ): "hors-equipe" | "hors-territoire" | "dedans" => {
    const member = matchTeamMember(salespersonRaw);
    if (!member) return "hors-equipe";
    // Sans identifiant, aucun code postal n'est atteignable : on garde la ligne
    // plutôt que de la faire disparaître sur une donnée absente.
    if (!member.territory || !opportunityId) return "dedans";
    return isInTerritoryScope(member.territory, postalById.get(opportunityId) ?? null)
      ? "dedans"
      : "hors-territoire";
  };

  db.exec("BEGIN");
  try {
    for (const line of result.lines) {
      const scope = inScope(line.salespersonRaw, line.opportunityId);
      if (scope === "hors-equipe") {
        ignoredLines++;
        continue; // Commercial hors périmètre : volontairement non importé.
      }
      if (scope === "hors-territoire") {
        outOfTerritoryLines++;
        continue; // Chantier d'un autre DR : volontairement non importé.
      }
      const member = matchTeamMember(line.salespersonRaw)!;
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

    // ÉTAT COURANT — MÊME filtre de périmètre, à la lettre : le bloc « EN
    // COURS » n'est pas une porte dérobée par laquelle un commercial hors
    // équipe ou un chantier d'un autre DR reviendrait dans RM Morning.
    for (const month of result.currentMonths) deleteCurrentMonth.run(month);
    for (const line of result.currentLines) {
      const scope = inScope(line.salespersonRaw, line.opportunityId);
      if (scope !== "dedans") continue;
      const member = matchTeamMember(line.salespersonRaw)!;
      upsertCurrent.run(
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
        // Sans « MAJ le » lisible, l'heure de lecture fait foi : le bloc reste
        // exploitable, on ne prétend simplement pas connaître sa fraîcheur.
        line.updatedAt ?? importedAt,
        result.sourceKind,
        importedAt,
      );
      currentKept++;
    }
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }

  // Les anomalies de STRUCTURE valent pour l'onglet entier : elles sont
  // conservées telles quelles. Les anomalies de LIGNE ne sont retenues que si
  // la ligne appartient au périmètre.
  const issues: ForecastIssue[] = [
    ...result.issues.map((i) => ({ message: i.message })),
    ...result.rowIssues
      .filter((i) => inScope(i.salespersonRaw, i.opportunityId) === "dedans")
      .map((i) => ({
        row: i.row,
        message:
          `Onglet ${i.forecastMonth}, ligne ${i.row}` +
          `${i.salespersonRaw ? ` (${i.salespersonRaw})` : ""} : ${i.message}.`,
      })),
  ];

  return {
    sourceKind: result.sourceKind,
    sourceLabel: result.sourceLabel,
    months: result.months,
    snapshotDates: result.snapshotDates,
    totalLines: result.lines.length,
    teamLines,
    ignoredLines,
    outOfTerritoryLines,
    withoutId,
    currentLines: currentKept,
    currentUpdatedAt: result.currentUpdatedAt,
    currentMonths: result.currentMonths,
    issues,
    durationMs: Date.now() - startedAt,
  };
}
