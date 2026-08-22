/**
 * Source principale du forecast : lecture directe des onglets du Google Sheet
 * via l'export CSV de gviz, qui accepte le nom de l'onglet.
 *
 * Le classeur doit être partagé « Tout utilisateur disposant du lien — Lecteur ».
 * Aucun OAuth, aucun secret, aucune écriture.
 */

import { forecastSheetCsvUrl } from "../config";
import { parseForecastSheet } from "./forecast-sheet-parser";
import type {
  ForecastFetchResult,
  ForecastSnapshotLine,
  ForecastSnapshotSource,
} from "./forecast-snapshot";
import type { ParseIssue } from "./salesforce";

/** Le classeur n'est pas lisible publiquement : l'interface explique quoi faire. */
export class ForecastAccessError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ForecastAccessError";
  }
}

const SHARING_HINT =
  "Ouvrez le Sheet → Partager → Accès général → « Tout utilisateur disposant du lien », rôle Lecteur.";

export class HttpForecastSnapshotSource implements ForecastSnapshotSource {
  readonly kind = "sheet-http";

  async fetch(months: string[]): Promise<ForecastFetchResult> {
    const lines: ForecastSnapshotLine[] = [];
    const issues: ParseIssue[] = [];
    const readMonths: string[] = [];
    const snapshotDates = new Set<string>();
    let unauthorized = 0;

    for (const month of months) {
      let response: Response;
      try {
        response = await fetch(forecastSheetCsvUrl(month), { cache: "no-store" });
      } catch (error) {
        issues.push({
          message: `Onglet ${month} : échec réseau (${
            error instanceof Error ? error.message : "erreur inconnue"
          }).`,
        });
        continue;
      }

      if (response.status === 401 || response.status === 403) {
        unauthorized++;
        continue;
      }
      if (response.status === 400 || response.status === 404) {
        // Onglet inexistant : normal, la fenêtre de mois ratisse large.
        continue;
      }
      if (!response.ok) {
        issues.push({ message: `Onglet ${month} : réponse HTTP ${response.status}.` });
        continue;
      }

      const csv = await response.text();
      // Google renvoie parfois une page HTML avec un code 200 quand l'accès
      // est refusé : on ne veut pas la faire passer pour un CSV.
      if (/^\s*<!DOCTYPE html/i.test(csv) || /^\s*<html/i.test(csv)) {
        unauthorized++;
        continue;
      }

      const parsed = parseForecastSheet(csv, month);
      if (parsed.lines.length > 0) readMonths.push(month);
      lines.push(...parsed.lines);
      issues.push(...parsed.issues);
      for (const date of parsed.snapshotDates) snapshotDates.add(date);
    }

    if (readMonths.length === 0 && unauthorized > 0) {
      throw new ForecastAccessError(
        `Le Google Sheet de forecast n'est pas lisible par lien (${unauthorized} onglet(s) refusé(s)). ${SHARING_HINT}`,
      );
    }

    return {
      sourceKind: this.kind,
      sourceLabel: "Google Sheet — export CSV par lien",
      fetchedAt: new Date(),
      months: readMonths,
      snapshotDates: [...snapshotDates].sort(),
      lines,
      issues,
    };
  }
}
