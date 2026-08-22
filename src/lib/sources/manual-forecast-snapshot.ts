/**
 * Source de secours du forecast : CSV déposés à la main dans un dossier local,
 * un fichier par onglet mensuel (« 2026-08.csv »).
 *
 * Même parseur que la source HTTP : seule la provenance des octets change.
 * Sert quand le classeur n'est pas partageable par lien, ou pour rejouer un
 * état passé hors ligne.
 */

import { readFile, readdir } from "node:fs/promises";
import path from "node:path";

import { FORECAST_SHEET } from "../config";
import { parseForecastSheet } from "./forecast-sheet-parser";
import type {
  ForecastFetchResult,
  ForecastSnapshotLine,
  ForecastSnapshotSource,
} from "./forecast-snapshot";
import type { ParseIssue } from "./salesforce";

export class ManualForecastSnapshotSource implements ForecastSnapshotSource {
  readonly kind = "sheet-file";

  constructor(private readonly dir: string = FORECAST_SHEET.manualDir) {}

  async fetch(months: string[]): Promise<ForecastFetchResult> {
    const root = path.resolve(/* turbopackIgnore: true */ process.cwd(), this.dir);
    const lines: ForecastSnapshotLine[] = [];
    const issues: ParseIssue[] = [];
    const readMonths: string[] = [];
    const snapshotDates = new Set<string>();

    let entries: string[] = [];
    try {
      entries = await readdir(root);
    } catch {
      return {
        sourceKind: this.kind,
        sourceLabel: `CSV locaux — ${this.dir} (dossier absent)`,
        fetchedAt: new Date(),
        months: [],
        snapshotDates: [],
        lines: [],
        issues: [{ message: `Dossier ${root} introuvable : aucun CSV de forecast à lire.` }],
      };
    }

    // On lit les onglets demandés, plus tout CSV « AAAA-MM » déjà présent :
    // un mois archivé hors fenêtre reste ainsi exploitable.
    const available = entries
      .filter((name) => /^\d{4}-\d{2}\.csv$/i.test(name))
      .map((name) => name.slice(0, 7));
    const wanted = [...new Set([...months, ...available])].sort();

    for (const month of wanted) {
      const file = path.join(root, `${month}.csv`);
      let csv: string;
      try {
        csv = await readFile(file, "utf8");
      } catch {
        continue; // Onglet non fourni : normal.
      }

      const parsed = parseForecastSheet(csv, month);
      if (parsed.lines.length > 0) readMonths.push(month);
      lines.push(...parsed.lines);
      issues.push(...parsed.issues);
      for (const date of parsed.snapshotDates) snapshotDates.add(date);
    }

    return {
      sourceKind: this.kind,
      sourceLabel: `CSV locaux — ${this.dir}`,
      fetchedAt: new Date(),
      months: readMonths,
      snapshotDates: [...snapshotDates].sort(),
      lines,
      issues,
    };
  }
}
